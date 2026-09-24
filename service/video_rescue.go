package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"

	"aicanvas/model"
	"aicanvas/repository"
)

// 孤儿视频救援。
//
// 背景：视频产物在上游只有「带签名的临时链」（火山 24h 过期，其它上游同理）。
// 正常路径是浏览器轮询到成功后取回字节、再存进我们自己的桶；但用户在生成期间
// 离开画布 / 关页 / 掉线时这一步永远不会发生：节点停在「生成中」，临时链一过期
// 视频就永久丢失（已发生多起，且积分已扣、任务确实成功，属于纯损失）。
//
// 本模块给兜底扫描（handler.sweepVideoRefunds）提供「捞回来」的能力：确认某任务
// 确实是孤儿（画布节点仍在 loading）后，服务端把产物转存进用户所属组的桶（永久、
// 公共读），登记 sync_files，并把结果直接回写到那个还在转圈的画布节点上——
// 用户下次打开画布就是「已生成好」，不需要任何手工操作。
//
// 边界：本模块只负责「保住并交付产物」，不碰扣费/退款（任务成功本就该扣费），
// 也不写团队共享素材（那是组内全员可见的，用户没同意过，不能替他决定）。

const (
	// videoRescueMaxBytes 单个视频最大转存体积。整段读进内存，故不能开太大：
	// 本平台常见成片 6~15 秒、2~30MB，256MB 已极宽裕；超出即放弃（宁可不救，也不能把
	// sweeper 所在进程的内存打爆——同一台机器上还跑着前端容器和其它常驻任务）。
	videoRescueMaxBytes = 256 << 20
	// videoRescueFetchTimeout 从上游临时链拉取产物的超时。救援是串行跑在扫描循环里的，
	// 超时设太长会把同一轮的「失败退款」（钱的路径）一起拖住，故取 120s。
	videoRescueFetchTimeout = 120 * time.Second
	// 画布节点状态字面量（与前端 canvas-client-page.tsx 的 NODE_STATUS_* 保持一致）。
	canvasNodeStatusLoading = "loading"
	canvasNodeStatusSuccess = "success"
)

// rescueObjectID 由「用户 + 任务」确定性推导出 32 位十六进制的对象名/存储键后缀。
//
// 为什么不用 uuid：救援必须可重试（下载完成之后的任何一步都可能失败——登记 sync_files、
// 回写画布 CAS 撞车、写「我的素材」撞车），而重试是整个函数从头再来一遍，包含重新上传。
// 随机名 = 每重试一轮就在用户桶里多一份几十 MB 的孤儿对象，且系统里没有任何清理机制。
// 确定性名 = 重试覆盖同一个对象，桶里永远只有一份。
//
// 掺 userID 是防串桶：不同用户各自的桶虽然隔离，但 objectKey 里已含 userID 目录，
// 名字本身再掺一次可以保证即便将来改成共用桶也不会互相覆盖。
// 取 sha256 前 16 字节 = 32 个十六进制字符，和原先 uuid 去横杠后的长度一致，
// 下游（storageKey "video:xxx"、sync_files、前端自愈）对长度的既有假设都不受影响。
func rescueObjectID(userID, taskID string) string {
	sum := sha256.Sum256([]byte(userID + "\x00" + taskID))
	return hex.EncodeToString(sum[:16])
}

// ErrVideoNotOrphan 表示该任务其实已被客户端接住，无需救援：调用方应直接清理候选、不做任何转存。
//
// 判据（按可靠度从高到低）：
//  1. 候选已被 POST /videos/:id/claimed 删除 —— 那样根本进不到这里（最可靠，前端转存成功后才调）
//  2. 成片地址能在用户【已同步到云端】的数据里找到（画布 / 我的素材 / 视频生成）
//  3. 画布上存在带此 taskId 且状态非 loading 的节点 —— 客户端自己收尾过（辅助，命中率极低）
//
// 三条都不成立时，才认定「客户端确实没拿到」并救援。
//
// 判据 2 曾经写作「upstream_logs.result_url 非空」，那是错的：
// result_url 只由 /media/persist 回填，只能证明【字节进了桶】，而转存发生在写回画布【之前】。
// 客户端在那之后崩溃/关页/同步失败，视频就永远停在桶里，用户一个都看不到——
// 兜底扫描却据此判定「已送达」转身就走，唯一能救他的机制被自己关掉了。
// 一个用户的成片可以就这样全军覆没。所以「送达」只有一个定义：用户自己的数据里能找到它。
var ErrVideoNotOrphan = errors.New("视频任务已被客户端接住，无需救援")

// RescueOrphanVideo 把「已成功但客户端没接住」的视频转存进用户的桶，并直接回写画布节点。
// 返回转存后的公网 URL。
//   - 非孤儿：返回 ErrVideoNotOrphan（调用方应删候选、不重试）
//   - 其它 error：调用方保留候选、下轮再试
func RescueOrphanVideo(vr model.VideoRefund, videoURL string) (string, error) {
	userID := strings.TrimSpace(vr.UserID)
	taskID := strings.TrimSpace(vr.TaskID)
	modelName := strings.TrimSpace(vr.Model)
	videoURL = strings.TrimSpace(videoURL)
	if userID == "" || videoURL == "" {
		return "", fmt.Errorf("孤儿视频救援缺少 userID 或产物地址")
	}
	if !IsPublicHTTPURL(videoURL) {
		return "", fmt.Errorf("孤儿视频救援：产物地址不是 http(s) 链接")
	}

	// ① 先确认客户端确实没拿到，再花代价下载。
	delivered, err := videoAlreadyDelivered(userID, taskID)
	if err != nil {
		return "", err
	}
	if delivered {
		return "", ErrVideoNotOrphan
	}

	cfg, err := loadTOSConfigForUser(userID)
	if err != nil {
		return "", err
	}

	// ② 拉取产物字节。走 SafeHTTPClient（与其它「拉外部 URL」路径一致，防 SSRF）。
	response, err := SafeHTTPClient(videoRescueFetchTimeout).Get(videoURL)
	if err != nil {
		return "", fmt.Errorf("拉取孤儿视频失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// 常见于临时链已过期（403/404）——此时视频已不可救，调用方据此放弃。
		return "", fmt.Errorf("拉取孤儿视频失败(HTTP %d)", response.StatusCode)
	}
	// 体积预检：上游给了 Content-Length 就先挡一道，省得白下。
	if response.ContentLength > videoRescueMaxBytes {
		return "", fmt.Errorf("孤儿视频过大(%d 字节 > 上限 %d)，跳过转存", response.ContentLength, int64(videoRescueMaxBytes))
	}
	// 多读 1 字节用于判断是否被上限截断——截断的是半截损坏 mp4，绝不能当成功存下并删候选，
	// 那等于用一个坏文件顶掉原片、且原片链接过期后再也救不回来。
	data, err := io.ReadAll(io.LimitReader(response.Body, videoRescueMaxBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > videoRescueMaxBytes {
		return "", fmt.Errorf("孤儿视频超过上限 %d 字节，跳过转存（避免存下被截断的损坏文件）", int64(videoRescueMaxBytes))
	}
	if len(data) == 0 {
		return "", fmt.Errorf("孤儿视频产物为空")
	}

	mimeType := response.Header.Get("Content-Type")
	if strings.TrimSpace(mimeType) == "" || strings.Contains(mimeType, "octet-stream") {
		mimeType = "video/mp4"
	}

	// ③ 存进用户所属组的桶（与正常视频落桶同一命名规则）。
	//
	// 对象名由 用户+任务 确定性推导，不用随机 uuid —— 这是幂等的关键。
	// 救援会因为后面任何一步失败而整轮重来（见 handler/video_sweeper.go 保留候选的逻辑），
	// 5 分钟一轮、最长 6 小时 = 最多 72 轮。用随机名的话每一轮都在用户桶里留下一份
	// 几十 MB 的孤儿对象，没有任何机制会清理它们，直接变成存储和流量账单。
	// 确定性名字让重试覆盖同一个对象：重试多少次，桶里始终只有一份。
	shortID := rescueObjectID(userID, taskID)
	objectKey := fmt.Sprintf("media/%s/video/%s.mp4", userID, shortID)
	publicURL, err := uploadToTOSWithConfig(cfg, objectKey, data, mimeType)
	if err != nil {
		return "", fmt.Errorf("孤儿视频转存失败: %w", err)
	}

	// ④ 登记 sync_files：让画布的文件自愈/取用链路认得这个对象。
	storageKey := "video:" + shortID
	if err := repository.SaveSyncFile(model.SyncFile{
		UserID:     userID,
		StorageKey: storageKey,
		Path:       publicURL,
		MimeType:   mimeType,
		Bytes:      int64(len(data)),
	}); err != nil {
		// 文件已在桶里，登记失败不算致命：产物保住了，交给调用方记日志。
		return publicURL, fmt.Errorf("孤儿视频已转存但登记 sync_files 失败: %w", err)
	}

	// ⑤ 回填任务日志的 result_url —— 这一步决定「以后节点还能不能自己领回来」。
	//
	// 客户端对还在 loading 且带 videoTaskId 的节点会自动续查（见 resetInterruptedGeneration），
	// 但续查是去问上游；火山的产物链只活 24 小时，过期后节点就永远填不上了——哪怕成片明明已经
	// 被救进我们自己的桶。回填后，续查可以直接拿这个永久地址交付（见 handler 里的 result_url 优先）。
	// 失败不致命：产物已经在桶里，交付路径还有画布回写/我的素材两条。
	if err := repository.UpdateUpstreamLogResultURL(userID, taskID, publicURL); err != nil {
		log.Printf("孤儿视频已转存但回填 result_url 失败 user=%s task=%s err=%v", userID, taskID, err)
	}

	// ⑥ 交付给用户，两条路：
	//   a) 画布上那个还在转圈的节点还在 → 直接回写它，用户打开画布就是「已生成好」
	//   b) 节点根本没同步上云（用户在同步防抖窗口内关页/崩溃/断网）→ 放进「我的素材」，
	//      否则这个视频虽然存进桶了、用户却没有任何入口能看到它。
	//      有了上面的 result_url 回填，即使走了 b，节点后来同步上来并续查时也能领回同一段视频。
	// a) 画布上那个还在转圈的节点还在 → 直接补它
	patched, perr := patchCanvasVideoNode(userID, taskID, publicURL, storageKey, mimeType, int64(len(data)))
	if perr != nil {
		return publicURL, fmt.Errorf("孤儿视频已转存但回写画布失败: %w", perr)
	}
	if patched {
		return publicURL, nil
	}
	// b) 节点没同步上云（用户点完就关页/关机）→ 用提交时记下的画布 id + 节点 id + 位置，
	//    在【原画布原位】新建一个已完成的节点。用原节点 id 是关键：用户回来同步时，
	//    合并看到同一个节点，服务端这份会覆盖他本地那个「失败重试」。
	if created, cerr := createCanvasVideoNode(vr, publicURL, storageKey, mimeType, int64(len(data))); cerr != nil {
		log.Printf("孤儿视频放回画布失败，改放「我的素材」 user=%s task=%s err=%v", userID, taskID, cerr)
	} else if created {
		return publicURL, nil
	}
	// c) 连画布上下文都没有（老候选）/ 画布或节点已被删 → 放「我的素材」，
	//    至少用户有入口能拿到，不至于人间蒸发。
	if aerr := addRescuedVideoToMyAssets(userID, taskID, modelName, publicURL, storageKey, mimeType, int64(len(data))); aerr != nil {
		return publicURL, fmt.Errorf("孤儿视频已转存但入库「我的素材」失败: %w", aerr)
	}
	return publicURL, nil
}

// addRescuedVideoToMyAssets 把救回的视频放进用户【私有】的「我的素材」(sync_data 的 assets 域)。
//
// 注意与「团队素材」(group_assets 表)的区别：那个是同组全员可见的共享区，用户没同意过、不能替他放。
// 这里写的是他自己的素材库，和前端 useAssetStore 同源；条目形状照抄 VideoAsset：
// {id,kind:"video",title,coverUrl,tags,createdAt,updatedAt,data:{url,storageKey,width,height,bytes,mimeType}}。
// 合并规则是按 id 取 updatedAt 较新者（app-sync.ts mergeById），故新条目天然会被客户端接受。
func addRescuedVideoToMyAssets(userID, taskID, modelName, publicURL, storageKey, mimeType string, size int64) error {
	item, err := repository.GetSyncData(userID, model.SyncDomainAssets)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	var root map[string]any
	if strings.TrimSpace(item.Data) == "" {
		// 该用户还没有素材域数据：按前端同款清单形状新建一份。
		root = map[string]any{
			"app": "aicanvas", "version": 1, "domain": model.SyncDomainAssets,
			"exportedAt": now, "data": map[string]any{"assets": []any{}},
		}
	} else if err := json.Unmarshal([]byte(item.Data), &root); err != nil {
		return err
	}

	dataNode, _ := root["data"].(map[string]any)
	if dataNode == nil {
		dataNode = map[string]any{}
		root["data"] = dataNode
	}
	assets, _ := dataNode["assets"].([]any)

	// 幂等：同一任务已放过就不再重复（兜底扫描可能重试）。
	for _, raw := range assets {
		if a, ok := raw.(map[string]any); ok {
			if meta, ok := a["metadata"].(map[string]any); ok {
				if id, _ := meta["videoTaskId"].(string); id == taskID {
					return nil
				}
			}
		}
	}

	title := "【自动找回】" + strings.TrimSpace(modelName)
	if taskID != "" {
		title += " " + taskID
	}
	assets = append(assets, map[string]any{
		"id":        "asset-rescued-" + strings.ReplaceAll(uuid.NewString(), "-", ""),
		"kind":      "video",
		"title":     title,
		"coverUrl":  "",
		"tags":      []any{},
		"source":    "video-rescue",
		"note":      "生成完成时画布未同步（关页/刷新/断网），由服务端自动找回",
		"createdAt": now,
		"updatedAt": now,
		"metadata":  map[string]any{"videoTaskId": taskID, "model": modelName},
		"data": map[string]any{
			"url": publicURL, "storageKey": storageKey,
			"width": 0, "height": 0, "bytes": size, "mimeType": mimeType,
		},
	})
	dataNode["assets"] = assets
	root["exportedAt"] = now

	encoded, err := json.Marshal(root)
	if err != nil {
		return err
	}
	// CAS：期间客户端推过新版本就放弃（下轮重试），绝不整块覆盖用户的素材库。
	if strings.TrimSpace(item.Data) == "" {
		if _, err := repository.SaveSyncData(userID, model.SyncDomainAssets, string(encoded)); err != nil {
			return err
		}
	} else {
		written, err := repository.SaveSyncDataIfUnchanged(userID, model.SyncDomainAssets, string(encoded), item.UpdatedAt)
		if err != nil {
			return err
		}
		if !written {
			return fmt.Errorf("写入「我的素材」时与客户端推送撞车，下轮重试")
		}
	}
	log.Printf("孤儿视频已放入「我的素材」: user=%s task=%s", userID, taskID)
	return nil
}

// VideoDeliveredToUser 供认领接口用：这个成片是否真的已经出现在用户自己的数据里。
// 「认领」不能凭客户端一句话就删掉退款候选——候选是唯一的兜底凭据，见 handler.ClaimVideoTask。
func VideoDeliveredToUser(userID string, taskID string) (bool, error) {
	return videoAlreadyDelivered(strings.TrimSpace(userID), strings.TrimSpace(taskID))
}

// videoAlreadyDelivered 判断客户端是否已经拿到并保存了这个视频。见 ErrVideoNotOrphan 的判据说明。
// 注意：能走到这里说明候选还在（判据1已不成立），所以只需再验判据 2、3。
func videoAlreadyDelivered(userID string, taskID string) (bool, error) {
	if taskID == "" {
		return true, nil // 没有任务号无从救起，当已送达处理，避免空转
	}
	// 判据2：成片地址是否真的出现在用户【已同步到云端】的数据里。
	//
	// ⚠️ 这里原先是「upstream_logs.result_url 非空 → 判定已送达」，那是错的：
	// result_url 只证明字节进了桶（/media/persist 干的事），而转存发生在写回画布【之前】。
	// 客户端在 persist 之后、同步之前挂掉/失败，视频就永远停在桶里、用户完全看不见——
	// 而扫描据此认定「已送达」转身就走，兜底彻底失效。
	// 表现是某个用户的成片全军覆没：桶里有、数据库有地址，他的画布和素材里一个都没有。
	//
	// 正确的「送达」定义只有一个：用户自己的数据里能找到它。这里就按这个查，
	// 画布 / 我的素材 / 视频生成都算——工作台生成的视频本来就不进画布（那是正常用法，
	// 只查画布会把它们全误判成丢失）。
	url, uerr := repository.VideoResultURLByTask(userID, taskID)
	if uerr == nil && strings.TrimSpace(url) != "" {
		if found, ferr := userDataContainsMediaURL(userID, url); ferr == nil && found {
			return true, nil
		}
	}
	// 判据3：画布上存在带此 taskId 但状态已非 loading 的节点 —— 客户端自己收尾过了。
	// 注意这条命中率很低：实测成片写回后 taskId 会被清掉（上万个已出片视频里，
	// 仍带 taskId 的只有几十个），所以它只能覆盖「还在 loading 就被扫到」这一小段，
	// 不能当主判据用——主判据是上面的「用户数据里能不能找到」。
	item, err := repository.GetSyncData(userID, model.SyncDomainCanvas)
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(item.Data) == "" {
		return false, nil // 云端没有画布数据 → 更像是「从没同步上来」，按未送达处理
	}
	settled := false
	forEachCanvasVideoNode(item.Data, taskID, func(_ map[string]any, meta map[string]any) {
		if status, _ := meta["status"].(string); status != canvasNodeStatusLoading {
			settled = true
		}
	})
	return settled, nil
}

// userDataContainsMediaURL 在用户已同步到云端的各数据域里找这个媒体地址。
//
// 只比对 URL 的路径部分（media/{用户}/video/{id}.mp4），不带查询串——
// 同一个对象在不同地方可能带不同的签名参数，整串比对会漏。
func userDataContainsMediaURL(userID, rawURL string) (bool, error) {
	needle := rawURL
	if i := strings.Index(needle, "?"); i >= 0 {
		needle = needle[:i]
	}
	if i := strings.Index(needle, "/media/"); i >= 0 {
		needle = needle[i+len("/media/"):]
	} else if i := strings.LastIndex(needle, "/"); i >= 0 {
		needle = needle[i+1:]
	}
	if strings.TrimSpace(needle) == "" {
		return false, nil
	}
	// 工作台也要查：用工作台生成的视频不进画布，那是正常用法，漏查会把它们全当成孤儿重复救援。
	for _, domain := range []string{
		model.SyncDomainCanvas,
		model.SyncDomainAssets,
		model.SyncDomainVideoWorkbench,
	} {
		item, err := repository.GetSyncData(userID, domain)
		if err != nil {
			return false, err
		}
		if strings.Contains(item.Data, needle) {
			return true, nil
		}
	}
	return false, nil
}

// nextCanvasRev 复刻前端 services/hlc.ts 的 tick(seen)：返回严格大于「墙钟毫秒」与「seen」的新 rev。
//
// 为什么必须推进 rev：前端 sync-merge.ts 的 entityNewer 先比 rev、相等时退化为
// `local.updatedAt >= remote.updatedAt`（取本地）。服务端若只改 metadata 不动 rev，
// 用户用原设备回来时本地那份仍在 loading 的旧节点会判胜，回写被丢弃、还会被推回覆盖云端——
// 也就是对「原设备回来」这个主力场景完全无效。
func nextCanvasRev(seen float64) int64 {
	next := int64(seen) + 1
	if wall := time.Now().UnixMilli(); wall > next {
		next = wall
	}
	return next
}

// canvasNodeTombstones 取出画布清单顶层 nodeTombstones 里的节点 id 集合（用户已删除的节点）。
func canvasNodeTombstones(canvasJSON string) map[string]bool {
	out := map[string]bool{}
	var root struct {
		NodeTombstones map[string]json.RawMessage `json:"nodeTombstones"`
	}
	if err := json.Unmarshal([]byte(canvasJSON), &root); err != nil {
		return out
	}
	for id := range root.NodeTombstones {
		out[id] = true
	}
	return out
}

// forEachCanvasVideoNode 遍历画布 JSON 里所有 metadata.videoTaskId == taskID 的节点，
// 对每个命中节点（整个 node 对象，含 rev/updatedAt）调用 fn。解析失败返回 nil。
func forEachCanvasVideoNode(canvasJSON string, taskID string, fn func(node map[string]any, meta map[string]any)) map[string]any {
	var root map[string]any
	if err := json.Unmarshal([]byte(canvasJSON), &root); err != nil {
		return nil
	}
	dataNode, _ := root["data"].(map[string]any)
	projects, _ := dataNode["projects"].([]any)
	for _, rawProject := range projects {
		project, ok := rawProject.(map[string]any)
		if !ok {
			continue
		}
		nodes, _ := project["nodes"].([]any)
		for _, rawNode := range nodes {
			node, ok := rawNode.(map[string]any)
			if !ok {
				continue
			}
			meta, ok := node["metadata"].(map[string]any)
			if !ok {
				continue
			}
			if id, _ := meta["videoTaskId"].(string); strings.TrimSpace(id) != taskID {
				continue
			}
			fn(node, meta)
		}
	}
	return root
}

// patchCanvasVideoNode 把救回的视频直接写回画布里那个仍在「生成中」的视频节点。
//
// 为什么服务端敢改画布：sync_data 是「整块 JSON、后写覆盖(LWW)」，没有 rev 列；本函数
// 只改命中节点 metadata 的几个字段，绝不增删节点/项目，因此不会触发收缩护栏、也不会动别人的数据。
// 写前照例打一次快照（与客户端推送同一套 CaptureCanvasSnapshot），出问题可回溯。
//
// 竞争窗口：若此刻用户正在别处开着同一画布且随后推送了「仍在 loading」的旧状态，会把本次
// 回写覆盖掉——但那台客户端自己的孤儿续查会再把结果补上，且产物已在桶里，不会丢。
// 返回 (是否命中并写入, error)。找不到匹配节点返回 (false, nil)（节点可能刚被用户删掉）。
func patchCanvasVideoNode(userID string, taskID string, publicURL string, storageKey string, mimeType string, size int64) (bool, error) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return false, nil
	}
	// CAS 撞车时重读重补（产物已在桶里，重试不重新下载）。并发推送是瞬时的，几次足够。
	for attempt := 0; attempt < canvasPatchMaxAttempts; attempt++ {
		ok, err := tryPatchCanvasVideoNode(userID, taskID, publicURL, storageKey, mimeType, size)
		if ok {
			return true, nil
		}
		if errors.Is(err, errCanvasNodeGone) {
			return false, nil // 没有待补的节点：正常情况（用户删了 / 客户端已收尾），不重试也不报错
		}
		if err != nil {
			return false, err // 真错误：交调用方记日志
		}
		// err == nil && !ok ⇒ CAS 撞车，下一轮重读重补
	}
	return false, fmt.Errorf("回写画布连续 %d 次与客户端推送撞车，本轮放弃", canvasPatchMaxAttempts)
}

// errCanvasNodeGone 画布上已找不到可补的 loading 节点（用户删了 / 客户端已收尾），属正常情况。
var errCanvasNodeGone = errors.New("画布上没有待回写的视频节点")

const canvasPatchMaxAttempts = 3

func tryPatchCanvasVideoNode(userID string, taskID string, publicURL string, storageKey string, mimeType string, size int64) (bool, error) {
	item, err := repository.GetSyncData(userID, model.SyncDomainCanvas)
	if err != nil || strings.TrimSpace(item.Data) == "" {
		return false, err
	}

	// 墓碑名单：用户已删除的节点。必须先取出来，见下方「绝不复活已删节点」。
	tombstoned := canvasNodeTombstones(item.Data)

	patched := false
	root := forEachCanvasVideoNode(item.Data, taskID, func(node map[string]any, meta map[string]any) {
		// 只补「还在转圈」的节点：已 success/error 的说明客户端自己收尾过了，不覆盖。
		if status, _ := meta["status"].(string); status != canvasNodeStatusLoading {
			return
		}
		// 绝不复活已删节点：前端墓碑仲裁规则是「节点 rev > 墓碑 rev 就复活并作废墓碑」
		// （sync-merge.ts）。我们下面会把 rev 顶到毫秒时间戳，必然大于墓碑 rev——
		// 若用户此刻已删掉这个节点（删除可能还没同步上来），回写就会把它硬生生复活。
		// 宁可不补：产物已在桶里，用户本来也不想要这个节点了。
		if nodeID, _ := node["id"].(string); tombstoned[nodeID] {
			log.Printf("孤儿视频回写画布：节点已被用户删除(有墓碑)，跳过回写 user=%s node=%s", userID, nodeID)
			return
		}
		meta["status"] = canvasNodeStatusSuccess
		meta["content"] = publicURL // 直接给公网永久地址，比客户端的 blob: 更耐刷新
		meta["storageKey"] = storageKey
		meta["mimeType"] = mimeType
		meta["bytes"] = size
		delete(meta, "videoTaskId") // 与客户端收尾同语义：清掉任务标记，避免下次又被当孤儿续查
		delete(meta, "videoTaskProvider")
		// 关键：推进节点级 rev/updatedAt，否则客户端深合并会判「本地那份 loading」更新而丢弃本次回写。
		seen, _ := node["rev"].(float64)
		node["rev"] = nextCanvasRev(seen)
		node["updatedAt"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z") // 与前端 toISOString() 同形
		patched = true
	})
	if root == nil || !patched {
		return false, errCanvasNodeGone // 没命中：不是错误，但要让外层区分于 CAS 撞车、别再重试
	}

	encoded, err := json.Marshal(root)
	if err != nil {
		return false, err
	}
	// 写前快照（best-effort，与客户端推送同一套机制）
	if serr := repository.CaptureCanvasSnapshot(userID, model.SyncDomainCanvas, item.Data); serr != nil {
		log.Printf("孤儿视频回写画布：写前快照失败（已忽略）user=%s err=%v", userID, serr)
	}
	// CAS 写入：期间若客户端推过新版本就放弃本次回写（下轮扫描会重来），
	// 绝不把整块画布回滚到我们读取的那一刻、抹掉用户的并发编辑。
	written, err := repository.SaveSyncDataIfUnchanged(userID, model.SyncDomainCanvas, string(encoded), item.UpdatedAt)
	if err != nil {
		return false, err
	}
	if !written {
		log.Printf("孤儿视频回写画布：期间画布已被客户端更新，本次放弃(下轮重试) user=%s task=%s", userID, taskID)
		return false, nil
	}
	log.Printf("孤儿视频已回写画布节点: user=%s task=%s", userID, taskID)
	return true, nil
}

// createCanvasVideoNode 在【原画布、原位置、用原节点 id】新建一个已完成的视频节点。
//
// 用在什么时候：按 taskID 在云端画布里找不到那个转圈的节点时。最常见的成因是
// 用户点完生成就关电脑/关页，节点只存在于他浏览器里、从没同步上云 ——
// 这时服务端翻遍云端也找不到，原先只能退到「我的素材」，用户还得自己去翻。
//
// 为什么敢新建：提交那一刻客户端把画布 id、节点 id、位置尺寸都带上来了
// （见 model.VideoRefund 的字段说明），所以放哪、放哪个位置、用什么 id 都是确定的。
//
// ⚠️ 用【原节点 id】是这件事成立的关键：用户浏览器下次同步上来时，
// 合并看到的是同一个节点 id，服务端这份（rev 更高）会覆盖他本地那个失败节点，
// 于是他看到的直接从「失败重试」变成成片，而不是画布上多出一个重复节点。
//
// 返回 (true, nil) 表示已放回画布；(false, nil) 表示不该放（调用方退回「我的素材」）。
func createCanvasVideoNode(vr model.VideoRefund, publicURL, storageKey, mimeType string, size int64) (bool, error) {
	canvasID := strings.TrimSpace(vr.CanvasID)
	nodeID := strings.TrimSpace(vr.NodeID)
	if canvasID == "" || nodeID == "" {
		return false, nil // 老候选没有这两个字段：走原来的「我的素材」路径
	}
	for attempt := 0; attempt < canvasPatchMaxAttempts; attempt++ {
		ok, err := tryCreateCanvasVideoNode(vr, canvasID, nodeID, publicURL, storageKey, mimeType, size)
		if ok {
			return true, nil
		}
		if err != nil {
			return false, err
		}
		// ok=false 且无错：CAS 撞车，重读重试
	}
	return false, nil // 连续撞车：本轮放弃，退「我的素材」，产物不会丢
}

func tryCreateCanvasVideoNode(vr model.VideoRefund, canvasID, nodeID, publicURL, storageKey, mimeType string, size int64) (bool, error) {
	item, err := repository.GetSyncData(vr.UserID, model.SyncDomainCanvas)
	if err != nil || strings.TrimSpace(item.Data) == "" {
		return false, err
	}

	// 绝不复活已删节点：用户看到失败后可能已经把那个节点删了（删除还没同步上来也算）。
	// 我们下面会把 rev 顶到毫秒时间戳、必然大于墓碑 rev，一旦硬写就会把它复活。
	if canvasNodeTombstones(item.Data)[nodeID] {
		log.Printf("孤儿视频放回画布：节点已被用户删除(有墓碑)，改放「我的素材」 user=%s node=%s", vr.UserID, nodeID)
		return false, nil
	}

	var root map[string]any
	if err := json.Unmarshal([]byte(item.Data), &root); err != nil {
		return false, err
	}
	dataNode, _ := root["data"].(map[string]any)
	if dataNode == nil {
		return false, nil
	}
	projects, _ := dataNode["projects"].([]any)

	for _, raw := range projects {
		project, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := project["id"].(string); id != canvasID {
			continue
		}
		// 画布已被用户删除：别往墓碑里塞东西。
		if deletedAt, _ := project["deletedAt"].(string); strings.TrimSpace(deletedAt) != "" {
			return false, nil
		}
		nodes, _ := project["nodes"].([]any)
		// 节点已经在了（客户端后来同步上来了）：交给按 taskID 的补丁路径，这里不重复插。
		for _, nraw := range nodes {
			if n, ok := nraw.(map[string]any); ok {
				if id, _ := n["id"].(string); id == nodeID {
					return false, nil
				}
			}
		}

		x, y, w, h := parseNodeGeom(vr.NodeGeom)
		now := time.Now()
		node := map[string]any{
			"id":       nodeID,
			"type":     "video",
			"title":    "【自动找回】" + strings.TrimSpace(vr.Model),
			"position": map[string]any{"x": x, "y": y},
			"width":    w,
			"height":   h,
			"metadata": map[string]any{
				"status":     canvasNodeStatusSuccess,
				"model":      vr.Model,
				"content":    publicURL,
				"storageKey": storageKey,
				"mimeType":   mimeType,
				"bytes":      size,
				"note":       "生成完成时画布未同步（关页/刷新/断网），由服务端自动放回",
			},
			// rev 必须顶到毫秒时间戳：否则用户本地那个失败节点（rev 更高或相等）会在合并时赢，
			// 这次回写直接作废。见 nextCanvasRev 的说明。
			"rev":       nextCanvasRev(0),
			"updatedAt": now.UTC().Format("2006-01-02T15:04:05.000Z"),
		}
		project["nodes"] = append(nodes, node)

		encoded, err := json.Marshal(root)
		if err != nil {
			return false, err
		}
		if serr := repository.CaptureCanvasSnapshot(vr.UserID, model.SyncDomainCanvas, item.Data); serr != nil {
			log.Printf("孤儿视频放回画布：写前快照失败（已忽略）user=%s err=%v", vr.UserID, serr)
		}
		written, err := repository.SaveSyncDataIfUnchanged(vr.UserID, model.SyncDomainCanvas, string(encoded), item.UpdatedAt)
		if err != nil {
			return false, err
		}
		if !written {
			return false, nil // CAS 撞车，外层重试
		}
		log.Printf("孤儿视频已放回画布原位: user=%s canvas=%s node=%s task=%s", vr.UserID, canvasID, nodeID, vr.TaskID)
		return true, nil
	}
	// 云端没有这个画布（用户删了整个画布 / 画布本身还没同步上来）→ 退「我的素材」
	return false, nil
}

// parseNodeGeom 解析提交时记下的位置尺寸；缺失或异常时给一组安全默认值。
// 尺寸兜底用 640x360：与前端视频节点默认一致，不会把画布撑变形。
func parseNodeGeom(raw string) (x, y, w, h float64) {
	x, y, w, h = 0, 0, 640, 360
	if strings.TrimSpace(raw) == "" {
		return
	}
	var g struct{ X, Y, W, H float64 }
	if json.Unmarshal([]byte(raw), &g) != nil {
		return
	}
	x, y = g.X, g.Y
	if g.W > 0 {
		w = g.W
	}
	if g.H > 0 {
		h = g.H
	}
	return
}
