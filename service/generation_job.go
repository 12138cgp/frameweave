package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
)

// 异步生成任务：上游调用用独立 context（与浏览器连接生死无关），
// 刷新/切页/关页后前端凭任务 ID 轮询领回结果。

// UpstreamLogID 从上游响应头取火山计费/排查用的 LogID：
// 主取 X-Tt-Logid，为空再依次回退 X-Request-Id、x-tt-logid（Header.Get 大小写不敏感，多候选更稳）。
func UpstreamLogID(h http.Header) string {
	for _, name := range []string{"X-Tt-Logid", "X-Request-Id", "x-tt-logid"} {
		if v := h.Get(name); v != "" {
			return v
		}
	}
	return ""
}

const (
	GenerationJobPending   = "pending"
	GenerationJobRunning   = "running"
	GenerationJobSucceeded = "succeeded"
	GenerationJobFailed    = "failed"
)

const generationJobTTL = 12 * time.Hour    // 整行删除：12h 后任务连同 blob 一并清（原 48h；每任务存 ~5MB 输入图 + ~5MB 输出图 blob，48h 累积曾让库胀到 5.4GB）
const generationJobBlobTTL = 6 * time.Hour // 大 blob 清理：终态(成功/失败)任务 6h 后清 payload/result，保留 6h 供断点恢复/重取结果；整行仍到 12h 再删
const generationJobTimeout = 15 * time.Minute

// 并发上限：防止恢复重跑或用户狂点把上游打爆。
// 默认 16；可用环境变量 GENERATION_JOB_CONCURRENCY 覆盖（改 .env 重启即生效、无需重建镜像），夹到 [1,256]。
// 调大能减少高峰排队，但同时向上游发更多并发——上游承压有限时调太高可能触发其限流/失败率上升，按需渐进上调。
var generationJobSlots = make(chan struct{}, generationJobConcurrency())

// generationJobConcurrency 解析 GENERATION_JOB_CONCURRENCY；缺省/非法回退 16，并夹到 [1,256]。
func generationJobConcurrency() int {
	const def = 16
	raw := strings.TrimSpace(os.Getenv("GENERATION_JOB_CONCURRENCY"))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return def
	}
	if n > 256 {
		return 256
	}
	return n
}

// unitCredits = 单价快照（1 张图的点数），落在 job 上供缺额退款按原价退；不分档的模型传与 credits 同源的单价即可。
func CreateGenerationJob(userID, projectID, canvasID, path, modelName string, payload []byte, contentType string, credits, unitCredits int) (model.GenerationJob, error) {
	// 入口顺手回收，无需独立定时器：① 整行删除 >12h 的任务；② 清除终态任务 >6h 的大 blob（payload/result）。
	_ = repository.PurgeGenerationJobsBefore(time.Now().Add(-generationJobTTL).Format(time.RFC3339))
	_ = repository.ClearGenerationJobBlobsBefore(time.Now().Add(-generationJobBlobTTL).Format(time.RFC3339))
	// 扣费路由：优先项目积分池。命中项目但池不足 → 直接报错（不回退个人）；
	// 无项目/非成员/项目不存在/非 active → charged=false，回退个人积分。
	charged, err := ConsumeProjectCredits(userID, projectID, modelName, credits, path)
	if err != nil {
		return model.GenerationJob{}, err
	}
	if charged {
		job, jerr := saveGenerationJobWithRefund(userID, projectID, canvasID, path, modelName, payload, contentType, credits, unitCredits)
		if jerr != nil {
			return job, jerr
		}
		go runGenerationJob(job.ID)
		return job, nil
	}
	if err := ConsumeUserCredits(userID, modelName, credits, path); err != nil {
		return model.GenerationJob{}, err
	}
	job, err := saveGenerationJobWithRefund(userID, "", canvasID, path, modelName, payload, contentType, credits, unitCredits)
	if err != nil {
		return job, err
	}
	go runGenerationJob(job.ID)
	return job, nil
}

// saveGenerationJobWithRefund 落库 job；失败时按 projectID 把已预扣的积分退回对应来源。
func saveGenerationJobWithRefund(userID, projectID, canvasID, path, modelName string, payload []byte, contentType string, credits, unitCredits int) (model.GenerationJob, error) {
	job, err := repository.SaveGenerationJob(model.GenerationJob{
		UserID:      userID,
		ProjectID:   projectID,
		CanvasID:    canvasID,
		Path:        path,
		Model:       modelName,
		Status:      GenerationJobPending,
		Payload:     payload,
		ContentType: contentType,
		Credits:     credits,
		UnitCredits: unitCredits,
	})
	if err != nil {
		if refundErr := refundForJob(projectID, userID, modelName, credits, path); refundErr != nil {
			log.Printf("generation job refund after save failure: user=%s project=%s err=%v", userID, projectID, refundErr)
		}
		return job, err
	}
	return job, nil
}

// refundForJob 按 projectID 把一笔扣费退回对应来源（项目池 / 个人）。
func refundForJob(projectID, userID, modelName string, credits int, path string) error {
	if projectID != "" {
		return RefundProjectCredits(projectID, userID, modelName, credits, path)
	}
	return RefundUserCredits(userID, modelName, credits, path)
}

// imageShortfallCredits 计算图像任务的「缺额退款」金额：成功响应里实际产出的图片数若少于请求数
// （部分图被上游内容审核拒/单图失败、但整体返回 200），应退回未产出部分的钱。
// charged=已扣总额(=单价×请求数)，unit=单价(ModelCost)。result 必须能解析出 data 数组才计算；
// 解析不到（格式异常/无 data 字段）返回 0=不退（保守、维持现状、绝不超退）。返回值 clamp 到 [0, charged]。
func imageShortfallCredits(result []byte, charged, unit int) int {
	if unit <= 0 || charged <= 0 {
		return 0
	}
	var parsed struct {
		Data *[]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(result, &parsed); err != nil || parsed.Data == nil {
		return 0
	}
	produced := len(*parsed.Data)
	shortfall := charged - produced*unit
	if shortfall <= 0 {
		return 0
	}
	if shortfall > charged {
		return charged
	}
	return shortfall
}

// refundImageShortfall 图像任务成功但产出图片数 < 请求数时按缺额退款。
// 在 job 成功落库后调用、每个 job 成功只跑一次（成功与失败互斥、失败走 fail() 退全款），无重复退风险。
func refundImageShortfall(job model.GenerationJob) {
	// 单价一律用下单时落在任务上的快照：图片按画质档定价后，事后重新查价既不知道当时选的是哪档、
	// 也可能查到管理员中途改过的新价。只有本列上线前创建的老任务（UnitCredits=0）才回退旧的事后查价。
	unit := job.UnitCredits
	if unit <= 0 {
		queried, err := ModelCostForUser(job.UserID, job.Model)
		if err != nil {
			return
		}
		unit = queried
	}
	shortfall := imageShortfallCredits(job.Result, job.Credits, unit)
	if shortfall <= 0 {
		return
	}
	if err := refundForJob(job.ProjectID, job.UserID, job.Model, shortfall, job.Path); err != nil {
		log.Printf("generation job partial refund failed: id=%s shortfall=%d err=%v", job.ID, shortfall, err)
		return
	}
	log.Printf("generation job partial refund: id=%s charged=%d refunded=%d", job.ID, job.Credits, shortfall)
}

func GetGenerationJobForUser(userID, id string) (model.GenerationJob, bool, error) {
	job, ok, err := repository.GetGenerationJob(id)
	if err != nil || !ok {
		return job, ok, err
	}
	if job.UserID != userID {
		return model.GenerationJob{}, false, nil
	}
	return job, true, nil
}

// StartGenerationJobWorker 服务启动时恢复进程被杀遗留的 running 任务，按是否已发起上游分两类处理：
//   - 已发起上游：结果丢失且无法判断上游成败，重跑会重复调用上游 → 标失败 + 退款，让用户自行重试。
//   - 未发起上游：回退 pending 安全重跑（与原有 pending 一起 requeue）。
func StartGenerationJobWorker() {
	log.Printf("generation job worker: concurrency=%d (env GENERATION_JOB_CONCURRENCY, default 16)", cap(generationJobSlots))
	interrupted, err := repository.ListInterruptedDispatchedJobs()
	if err != nil {
		log.Printf("generation job recover list interrupted failed: %v", err)
	}
	for _, job := range interrupted {
		job.Status = GenerationJobFailed
		job.Error = "服务重启导致任务中断，请重新生成"
		if _, e := repository.SaveGenerationJob(job); e != nil {
			log.Printf("generation job mark interrupted failed: id=%s err=%v", job.ID, e)
			continue
		}
		if e := refundForJob(job.ProjectID, job.UserID, job.Model, job.Credits, job.Path); e != nil {
			log.Printf("generation job refund interrupted failed: id=%s err=%v", job.ID, e)
		}
	}
	if len(interrupted) > 0 {
		log.Printf("generation job recover: %d interrupted (dispatched) jobs failed+refunded", len(interrupted))
	}

	if err := repository.MarkUndispatchedRunningJobsPending(); err != nil {
		log.Printf("generation job recover failed: %v", err)
		return
	}
	ids, err := repository.ListGenerationJobIDsByStatus([]string{GenerationJobPending})
	if err != nil {
		log.Printf("generation job recover list failed: %v", err)
		return
	}
	for _, id := range ids {
		go runGenerationJob(id)
	}
	if len(ids) > 0 {
		log.Printf("generation job recover: %d pending jobs requeued", len(ids))
	}
}

func runGenerationJob(id string) {
	generationJobSlots <- struct{}{}
	defer func() { <-generationJobSlots }()
	// 兜底：worker 在请求 goroutine 之外运行，gin.Recovery 覆盖不到；panic 不能崩进程，
	// 且要把卡在 running 的任务标失败并退款（避免用户被扣费却卡住）。
	defer func() {
		if r := recover(); r != nil {
			log.Printf("generation job panic recovered: id=%s err=%v", id, r)
			if job, ok, e := repository.GetGenerationJob(id); e == nil && ok && job.Status == GenerationJobRunning {
				job.Status = GenerationJobFailed
				job.Error = "内部错误"
				if _, saveErr := repository.SaveGenerationJob(job); saveErr != nil {
					log.Printf("generation job save panic-failed error: id=%s err=%v", id, saveErr)
				}
				if refundErr := refundForJob(job.ProjectID, job.UserID, job.Model, job.Credits, job.Path); refundErr != nil {
					log.Printf("generation job refund after panic failed: id=%s err=%v", id, refundErr)
				}
			}
		}
	}()

	job, ok, err := repository.GetGenerationJob(id)
	if err != nil || !ok || (job.Status != GenerationJobPending && job.Status != GenerationJobRunning) {
		return
	}
	job.Status = GenerationJobRunning
	if job, err = repository.SaveGenerationJob(job); err != nil {
		log.Printf("generation job mark running failed: id=%s err=%v", id, err)
		return
	}

	fail := func(upstreamStatus int, body []byte, message string) {
		job.Status = GenerationJobFailed
		job.UpstreamStatus = upstreamStatus
		job.Result = body
		// job.Error 会原样返回前端显示在画布节点上，出口统一脱敏，防止上游域名/URL 漏给用户。
		job.Error = scrubUpstreamIdentity(message)
		if _, saveErr := repository.SaveGenerationJob(job); saveErr != nil {
			log.Printf("generation job save failed-state error: id=%s err=%v", id, saveErr)
		}
		if refundErr := refundForJob(job.ProjectID, job.UserID, job.Model, job.Credits, job.Path); refundErr != nil {
			log.Printf("generation job refund failed: id=%s err=%v", id, refundErr)
		}
	}

	// markDispatched 在真正向上游发起请求前持久化"已发起"标记：本任务若随后遇进程崩溃，
	// 重启恢复逻辑不会重跑它（避免重复调用上游），而是标失败 + 退款让用户重试。
	markDispatched := func() bool {
		job.DispatchedAt = now()
		if _, err := repository.SaveGenerationJob(job); err != nil {
			log.Printf("generation job mark dispatched failed: id=%s err=%v", id, err)
			fail(0, nil, "任务状态保存失败，积分已退回")
			return false
		}
		return true
	}

	// 渠道在执行时解析（与直连代理同语义：取分组按渠道密钥）
	channel, err := SelectModelChannelForUser(job.UserID, job.Model)
	if err != nil {
		fail(0, nil, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), generationJobTimeout)
	defer cancel()

	// 按渠道改写请求：方舟无 /images/edits（404），图生图需转 generations + image 参数。
	// gpt-image-2 图生图只做图片字段归一化（image[]），模型不改写（adaptGenerationJobForChannel 已处理）。
	payload, path, contentType, err := adaptGenerationJobForChannel(channel, job)
	if err != nil {
		fail(0, nil, err.Error())
		return
	}

	// doUpstream 发一次上游请求并读回结果：sendErr=传输层失败（网络/超时/构造失败），readErr=2xx 但响应体读取失败。
	// 它不调用 fail/退费——由下方按最终结果统一处理，保证「成功不退、仅最终失败退一次」的计费不变量。
	type upstreamResult struct {
		status  int
		body    []byte
		sendErr error
		readErr error
	}
	doUpstream := func(p []byte, reqPath, ct, logTag string) upstreamResult {
		req, rerr := http.NewRequestWithContext(ctx, http.MethodPost, BuildModelChannelURL(channel, reqPath), bytes.NewReader(p))
		if rerr != nil {
			return upstreamResult{sendErr: rerr}
		}
		req.Header.Set("Authorization", "Bearer "+channel.APIKey)
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		resp, derr := UpstreamHTTPClient.Do(req)
		if derr != nil {
			log.Printf("generation job upstream request failed: id=%s tag=%s url=%s err=%v", id, logTag, req.URL.String(), derr)
			return upstreamResult{sendErr: derr}
		}
		defer resp.Body.Close()
		// 捕获上游 LogID（火山计费/排查）并持久化到独立表，便于事后对账。即使为空也写一行确认本次有无 LogID。
		logid := UpstreamLogID(resp.Header)
		if logid != "" {
			log.Printf("upstream logid: trace=%s tag=%s model=%s status=%d logid=%s", job.ID, logTag, job.Model, resp.StatusCode, logid)
		}
		// 图片 job 用时:此刻(上游同步返回后)距 DispatchedAt(发起上游)即生成耗时。Request 记 sanitized payload(JSON 剥 base64 / multipart 解析出 prompt)。
		durationMs := 0
		if job.DispatchedAt != "" {
			if dt, e := time.Parse(time.RFC3339, job.DispatchedAt); e == nil {
				durationMs = int(time.Since(dt).Milliseconds())
			}
		}
		if lerr := repository.SaveUpstreamLog(model.UpstreamLog{
			TraceID:        job.ID,
			UserID:         job.UserID,
			Model:          job.Model,
			Path:           job.Path,
			Kind:           "image",
			Request:        SanitizeAIRequestBody(job.Payload, job.ContentType),
			LogID:          logid,
			UpstreamStatus: resp.StatusCode,
			Source:         "job",
			DurationMs:     durationMs,
			ChannelID:      channel.ID, // 埋点:记录本次选中的渠道,便于按渠道归集用量
		}); lerr != nil {
			log.Printf("save upstream log failed: trace=%s err=%v", job.ID, lerr)
		}
		if resp.StatusCode >= http.StatusBadRequest {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			log.Printf("AI upstream error: tag=%s url=%s status=%d job=%s", logTag, req.URL.String(), resp.StatusCode, id)
			return upstreamResult{status: resp.StatusCode, body: body}
		}
		body, berr := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		if berr != nil {
			return upstreamResult{status: resp.StatusCode, readErr: berr}
		}
		return upstreamResult{status: resp.StatusCode, body: body}
	}

	if !markDispatched() {
		return
	}
	// gpt-image-2 图生图曾在 400/5xx/超时时自动回退 gpt-image-2-pool 重试一次
	//（-pool 对含人像的输入更宽松，加强版当时会 400「图像编辑失败」）。
	// 该回退已去掉：加强版现已能正常处理这类输入，实测 2.5 天只触发 3 次，
	// 留着反而让失败原因变得不透明——用户看到的是第二次请求的结果，排查时对不上第一次的真实错误。
	// 图片字段归一化（部分中转站的多图编辑要 image[]）仍保留在 adaptGenerationJobForChannel，不受影响。
	res := doUpstream(payload, path, contentType, "primary")

	if res.sendErr != nil {
		fail(0, nil, "AI 接口请求失败（网络错误或超时），积分已退回")
		return
	}
	if res.readErr != nil {
		fail(0, nil, "AI 响应读取失败，积分已退回")
		return
	}
	if res.status >= http.StatusBadRequest {
		fail(res.status, res.body, "")
		return
	}
	job.Status = GenerationJobSucceeded
	job.Result = res.body
	job.Error = ""
	if _, err := repository.SaveGenerationJob(job); err != nil {
		log.Printf("generation job save result failed: id=%s err=%v", id, err)
	}
	refundImageShortfall(job)
}
