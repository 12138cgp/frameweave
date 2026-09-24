package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"aicanvas/repository"
	"aicanvas/service"
)

// ClaimVideoTask POST /api/v1/videos/:id/claimed —— 客户端确认「视频已成功保存到我这边」。
//
// 为什么需要这个接口：
// video_refunds 里的退款候选，在客户端正常走完（轮询到成功 → 取字节 → 存进桶 → 落节点）之后
// 从来没有任何人清理，导致服务端无法区分下面两种情况：
//   - 客户端已经拿到了（正常完成，节点上的 videoTaskId 收尾时被清掉，服务端再也找不到线索）
//   - 客户端根本没拿到（用户在 3 秒同步防抖窗口内关页/崩溃/断网，节点从没上过云）
//
// 但认领【不是】客户端说了算：本接口只在服务端亲眼看到成片已出现在用户已同步的数据里时才删候选，
// 否则一律保留、交给兜底扫描继续盯。理由见下面函数体里的说明。
//
// 语义：幂等；只允许本人认领自己的任务；claimed=false 表示「还没核实到，候选先留着」，客户端无需处理。
func ClaimVideoTask(w http.ResponseWriter, r *http.Request, taskID string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		Fail(w, "缺少视频任务 ID")
		return
	}

	// 成片永久地址回填（可选参数 storageKey，纯观测 + 让下面的送达核实有据可依）。
	//
	// 背景：result_url 原先只有一条回填路径——前端 /media/persist（服务端去下载上游临时 URL 再转存）。
	// 但那条路只对「上游返回 URL」的渠道成立。走 OpenAI 方言的视频渠道取片拿到的是【二进制 blob】，
	// 前端 uploadMediaFile 直接上传，压根不经过 /media/persist，于是 result_url 恒为空。后果有两个：
	//   ① 后台「任务日志」判成功的唯一依据就是 result_url 非空 → 这类任务永远显示「生成中」，
	//      15 分钟后变橙色「未拿到成片」，而视频其实早就好了，运营会被误导；
	//   ② 下面 videoAlreadyDelivered 的判据2 读的也是 result_url → 认领核实几乎必然落空，
	//      退款候选不被清理，兜底扫描每轮都要重查一遍。
	//
	// 🔴 绝不采信客户端传来的 URL：那会让任何人往管理员会点开的字段里塞任意地址。
	//    这里只收 storageKey（服务端自己登记的凭据），再由服务端按 user_id + storage_key
	//    查出【我们自己记下的】path 回填。查不到就什么都不做——纯 best-effort，绝不影响认领结果。
	// ⚠️ 只回填 http(s) 的公网地址：落本地磁盘的那种是服务器绝对路径，填进去后台点了也打不开。
	if key := readClaimStorageKey(r); key != "" {
		if file, ferr := repository.GetSyncFile(user.ID, key); ferr == nil {
			if p := strings.TrimSpace(file.Path); strings.HasPrefix(p, "http://") || strings.HasPrefix(p, "https://") {
				if uerr := repository.UpdateUpstreamLogResultURL(user.ID, taskID, p); uerr != nil {
					log.Printf("claim backfill result_url failed: task=%s user=%s err=%v", taskID, user.ID, uerr)
				}
			}
		}
	}

	record, found, err := repository.GetVideoRefund(taskID)
	if err != nil {
		FailError(w, err)
		return
	}
	// 已被兜底扫描处理掉、或本来就没有候选：都视为已认领，直接成功（幂等）。
	if !found {
		OK(w, map[string]any{"taskId": taskID, "claimed": true})
		return
	}
	// 只能认领自己的任务：防止别人拿 task id 来清掉他人的退款候选（那会绕过失败退款）。
	if record.UserID != user.ID {
		Fail(w, "无权操作该视频任务")
		return
	}
	// 已退款的候选不动：那是失败任务的账，删了会丢失退款记录。
	if strings.TrimSpace(record.RefundedAt) != "" {
		OK(w, map[string]any{"taskId": taskID, "claimed": true})
		return
	}

	// ⚠️ 关键：客户端说「我拿到了」不算数，必须服务端自己在用户已同步的数据里看见这个成片才删候选。
	//
	// 原先是无条件删。可客户端调这个接口的时刻，是【转存进桶之后、写回画布之前】——
	// 此后还要落节点、等防抖、推同步，任何一步挂掉视频就永久消失，
	// 而唯一能救它的退款候选已经被这次认领亲手删掉了。
	// 成批的成片就是这么丢的：桶里有，用户的画布和素材里一个都没有。
	//
	// 现在核实不过就把候选留着：兜底扫描 15 分钟后再看，
	// 那时数据同步上来了就静默删候选（不下载、零成本），没同步上来就转存回写——这才是候选存在的意义。
	delivered, derr := service.VideoDeliveredToUser(user.ID, taskID)
	if derr != nil {
		// 查不动就保守留着候选：多扫一轮的代价远小于漏掉一个成片。
		log.Printf("claim video task verify failed(保留候选): task=%s user=%s err=%v", taskID, user.ID, derr)
		OK(w, map[string]any{"taskId": taskID, "claimed": false})
		return
	}
	if !delivered {
		OK(w, map[string]any{"taskId": taskID, "claimed": false})
		return
	}
	if err := repository.DeleteVideoRefund(taskID); err != nil {
		log.Printf("claim video task failed: task=%s user=%s err=%v", taskID, user.ID, err)
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"taskId": taskID, "claimed": true})
}

// readClaimStorageKey 从请求体里取可选的 storageKey。
// 请求体本来就允许是空的（老客户端发 {}），所以任何解析失败都只当「没带」，不报错。
func readClaimStorageKey(r *http.Request) string {
	if r.Body == nil {
		return ""
	}
	var payload struct {
		StorageKey string `json:"storageKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return ""
	}
	return strings.TrimSpace(payload.StorageKey)
}
