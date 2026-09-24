package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
)

const (
	videoSweepInterval = 5 * time.Minute  // 扫描周期
	videoSweepGrace    = 15 * time.Minute // 候选创建后至少 15min 才扫（给正常轮询路径时间、避免抢跑）
	videoSweepMaxAge   = 6 * time.Hour    // 超龄仍未判定失败/成功的候选放弃扫描并删除（任务早该终态、避免无限重扫）
	videoSweepBatch    = 100
	// videoSweepQueryTimeout 查一次上游任务状态的【整体】超时。
	//
	// 必须自带 client：service.UpstreamHTTPClient 刻意不设整体 Timeout（怕砍断流式响应和长时生成），
	// 它只有 ResponseHeaderTimeout —— 那只管到响应头，读 body 卡住就是永久卡住。
	// 扫描是单协程串行的，第 1 条卡死 = 整个兜底机制停摆：
	// 没有这个超时时，候选会一路积压，最老的一条可以停住几周一动不动，
	// 而从外面完全看不出扫描其实早就停摆了。
	// 查任务状态就是个几百字节的 GET，20 秒足够宽裕。
	videoSweepQueryTimeout = 20 * time.Second
	// videoSweepRoundBudget 单轮扫描的时间预算。超了就收工、下轮接着扫。
	// 光有单次超时还不够：100 条 × 20 秒最坏也要 33 分钟，会把 5 分钟周期堆叠成一条越拖越长的队。
	videoSweepRoundBudget = 90 * time.Second
	// videoSweepRescueCap 单轮扫描最多转存几个孤儿视频。视频动辄几十 MB，
	// 不设上限时一轮扫描可能同时拉几十个、打爆带宽与内存；超出的留到下一轮（5 分钟后）。
	videoSweepRescueCap = 10
)

// videoTaskSucceeded 判断视频状态轮询响应体是否为「明确成功态」（与 videoTaskFailed 对偶）。
// 兜底扫描用它识别成功任务以删候选停止重扫；不参与退款决策（退款只认 videoTaskFailed）。
func videoTaskSucceeded(body []byte) bool {
	var p struct {
		Status string `json:"status"`
		Data   struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return false
	}
	status := p.Status
	if status == "" {
		status = p.Data.Status
	}
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded", "success", "completed", "complete", "done":
		return true
	}
	return false
}

// StartVideoRefundSweeper 启动视频退款兜底扫描后台协程。
// 背景：视频失败退款依赖前端持续轮询命中 failed 才退；客户端提交后关页/掉线/提前停止轮询，
// 失败任务就永不触发退款（VideoRefund 候选已落库但无人补退）。本协程定期主动查上游状态补退。
// 安全性：退款经 service.RefundVideoAtomic 的原子幂等闸，与正常轮询路径并发「至多退一次」；
// 且**只在上游明确返回 failed 时退**（查询 4xx/5xx/超时一律不退，保守、绝不误退可能成功的任务）。
func StartVideoRefundSweeper() {
	go func() {
		time.Sleep(videoSweepGrace) // 启动后先等一个 grace，避免与恢复逻辑/正常流量抢跑
		sweepVideoRefunds()
		ticker := time.NewTicker(videoSweepInterval)
		defer ticker.Stop()
		for range ticker.C {
			sweepVideoRefunds()
		}
	}()
}

// sweepStats 一轮扫描的记账。每轮结束固定打一行，哪怕什么都没干。
//
// 为什么坚持「空转也打」：不出声的后台扫描可以卡死几周而无人察觉，
// 原因就是没日志——既可能是「没事干」，也可能是「卡死了」，从外面分不出来。
// 一行/5 分钟 = 288 行/天，代价可以忽略，换来的是「它还活着」这件事随时可证。
type sweepStats struct {
	candidates int // 本轮取到的候选数
	processed  int // 实际处理到的（可能被时间预算截断）
	refunded   int // 判定失败并退款
	rescued    int // 真的下载并转存了（占 videoSweepRescueCap 配额）
	notOrphan  int // 客户端自己接住了，静默销案
	gaveUp     int // ⚠️ 超龄放弃：这些成片今后永远不会交付
	failed     int // 救援报错但还没超龄，保留候选下轮重试
}

// giveUpAgedCandidate 超龄放弃一个候选：删候选行，并且【必须留下明确记录】。
//
// 这一步的真实含义是「宣布这个成片永远不会再交付给用户了」——积分已扣、文件可能还在桶里，
// 但从此没有任何机制会去找它。原先四处放弃点里有三处是静默 delete，
// 静默 delete 会让成片就这么无声消失，事后完全无法追溯原因
// （容器一重建 docker logs 就没了，见 applog.go 为什么要落盘）。
//
// 返回是否真的放弃了（没超龄就什么都不做，让调用方保留候选下轮再试）。
func giveUpAgedCandidate(vr model.VideoRefund, maxAgeCutoff string, reason string, st *sweepStats) bool {
	if vr.CreatedAt > maxAgeCutoff {
		return false
	}
	log.Printf("⚠️ 视频兜底放弃交付: task=%s user=%s model=%s 提交于=%s 原因=%s"+
		" —— 此成片今后不再有任何交付机制，人工找回请查 upstream_logs.result_url",
		vr.TaskID, vr.UserID, vr.Model, vr.CreatedAt, reason)
	_ = repository.DeleteVideoRefund(vr.TaskID)
	st.gaveUp++
	return true
}

func sweepVideoRefunds() {
	now := time.Now()
	graceCutoff := now.Add(-videoSweepGrace).Format(time.RFC3339)
	maxAgeCutoff := now.Add(-videoSweepMaxAge).Format(time.RFC3339)
	cands, err := repository.ListUnrefundedVideoRefunds(graceCutoff, videoSweepBatch)
	if err != nil {
		log.Printf("video sweeper list failed: err=%v", err)
		return
	}
	st := &sweepStats{candidates: len(cands)}
	defer func() {
		// 无论从哪个出口离开都打这一行。gaveUp 非零时额外标注，方便 grep 报警。
		mark := ""
		if st.gaveUp > 0 {
			mark = "  ⚠️ 有成片被永久放弃"
		}
		log.Printf("视频兜底一轮: 候选=%d 处理=%d 退款=%d 救回=%d 客户端已接=%d 放弃=%d 待重试=%d 用时=%s%s",
			st.candidates, st.processed, st.refunded, st.rescued, st.notOrphan, st.gaveUp, st.failed,
			time.Since(now).Round(time.Millisecond), mark)
	}()
	deadline := now.Add(videoSweepRoundBudget)
	for _, vr := range cands {
		// 超预算就收工：候选按 created_at 升序取，下轮从同一个位置接着扫，不会漏。
		if time.Now().After(deadline) {
			log.Printf("视频兜底：本轮时间预算用尽，剩下的下轮接着扫 processed=%d/%d", st.processed, len(cands))
			return
		}
		st.processed++
		status, body, ok := fetchVideoTaskStatus(vr)
		if ok && status == http.StatusOK && videoTaskFailed(body) {
			if _, err := service.RefundVideoAtomic(vr.TaskID, "/videos/sweeper"); err != nil {
				log.Printf("video sweeper refund failed: task=%s err=%v", vr.TaskID, err)
			} else {
				st.refunded++
				log.Printf("video sweeper refunded abandoned failed task: task=%s user=%s", vr.TaskID, vr.UserID)
			}
			continue
		}
		if ok && status == http.StatusOK && videoTaskSucceeded(body) {
			// 任务其实成功了、只是客户端没接住：先把产物转存进用户的桶（上游临时链会过期，
			// 过期即永久丢失），成功后再删候选；救援失败则保留候选、下轮重试（受 maxAge 兜底）。
			rescueSucceededOrphan(vr, extractVideoOutputURL(body), maxAgeCutoff, st)
			continue
		}
		// 运行中 / 查询失败 / 状态未知：超龄则放弃扫描并删候选（任务早该终态、保守不退），否则下轮再查。
		// 上游查询失败也会落到这里，所以原因要带上 ok/status，否则事后分不清是「还在跑」还是「查不动」。
		giveUpAgedCandidate(vr, maxAgeCutoff,
			fmt.Sprintf("超过 %s 仍未判定终态(查询可达=%t http=%d)", videoSweepMaxAge, ok, status), st)
	}
}

// rescueSucceededOrphan 处理「已成功的孤儿视频」：转存保住产物，然后删候选。
// videoURL 为空（上游响应里没有产物地址）或救援失败时保留候选下轮再试；超龄才放弃。
func rescueSucceededOrphan(vr model.VideoRefund, videoURL string, maxAgeCutoff string, st *sweepStats) {
	if videoURL == "" {
		giveUpAgedCandidate(vr, maxAgeCutoff, "上游说成功但响应里没有产物地址", st)
		return
	}
	if st.rescued >= videoSweepRescueCap {
		// 本轮转存已达上限，留到下轮（避免一次扫描拉爆带宽/内存）。
		// 但仍要走一次老化判定，否则长期排不上队的候选会永远留在表里堆积。
		giveUpAgedCandidate(vr, maxAgeCutoff,
			fmt.Sprintf("本轮转存配额(%d)已满且已超龄，一直没排上队", videoSweepRescueCap), st)
		return
	}
	url, err := service.RescueOrphanVideo(vr, videoURL)
	if errors.Is(err, service.ErrVideoNotOrphan) {
		// 客户端自己接住并收尾了（正常成功路径不会清理候选行，绝大多数候选都走这里）：
		// 清掉候选即可，绝不能重复转存，否则每个成功视频都会在桶里多存一份垃圾。
		// 注意：这条路径没有下载、不占转存配额，否则一堆正常视频会把配额吃光、真孤儿反而排不上队。
		st.notOrphan++
		_ = repository.DeleteVideoRefund(vr.TaskID)
		return
	}
	st.rescued++ // 只对「确实下载过」的计数
	if err != nil {
		log.Printf("video sweeper rescue failed: task=%s user=%s err=%v", vr.TaskID, vr.UserID, err)
		// 超龄放弃（多为临时链已过期，救不回来了）；没超龄就保留候选下轮重试。
		if !giveUpAgedCandidate(vr, maxAgeCutoff, fmt.Sprintf("救援连续失败直到超龄，最后一次: %v", err), st) {
			st.failed++
		}
		return
	}
	log.Printf("video sweeper rescued orphan video: task=%s user=%s url=%s", vr.TaskID, vr.UserID, url)
	_ = repository.DeleteVideoRefund(vr.TaskID)
}

// extractVideoOutputURL 从上游「查询视频任务」响应里取产物地址。
// 兼容几种常见形态：顶层 content.video_url（火山方舟）、data.content.video_url、裸 video_url。
func extractVideoOutputURL(body []byte) string {
	var p struct {
		VideoURL string `json:"video_url"`
		Content  struct {
			VideoURL string `json:"video_url"`
		} `json:"content"`
		Data struct {
			VideoURL string `json:"video_url"`
			Content  struct {
				VideoURL string `json:"video_url"`
			} `json:"content"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return ""
	}
	for _, candidate := range []string{p.Content.VideoURL, p.Data.Content.VideoURL, p.VideoURL, p.Data.VideoURL} {
		if strings.TrimSpace(candidate) != "" {
			return strings.TrimSpace(candidate)
		}
	}
	return ""
}

// fetchVideoTaskStatus 据候选重建上游 GET（与代理轮询同语义）查任务状态。返回 (httpStatus, body, ok)。
// videoSweepHTTPClient 专供兜底扫描查任务状态：带整体超时，绝不允许拖死扫描协程。
var videoSweepHTTPClient = &http.Client{
	Timeout:   videoSweepQueryTimeout,
	Transport: service.UpstreamHTTPClient.Transport,
}

func fetchVideoTaskStatus(vr model.VideoRefund) (int, []byte, bool) {
	channel, err := service.SelectModelChannelForUser(vr.UserID, vr.Model)
	if err != nil {
		return 0, nil, false
	}
	path := resolveAIProxyPath(channel.BaseURL, vr.Model, "/videos/"+vr.TaskID)
	req, err := http.NewRequest(http.MethodGet, service.BuildModelChannelURL(channel, path), nil)
	if err != nil {
		return 0, nil, false
	}
	req.Header.Set("Authorization", "Bearer "+channel.APIKey)
	resp, err := videoSweepHTTPClient.Do(req)
	if err != nil {
		return 0, nil, false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	return resp.StatusCode, body, true
}
