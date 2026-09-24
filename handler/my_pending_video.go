package handler

import (
	"net/http"
	"strings"

	"aicanvas/repository"
	"aicanvas/service"
)

// 「这块画布上还有哪些视频任务在等着交付」——画布载入时由前端问一次。
//
// 为什么需要它：前端判「页面刷新后生成已中断」只看本地节点有没有 videoTaskId，
// 从不问服务端（见 canvas-client-page.tsx 的 resetInterruptedGeneration）。
// 而本地那份任务号有两条路会丢：
//   ① 持久化被吞——skipNextPersistRef 是「盲吞下一拍」，任务号写入正好落在那一拍就没了
//      （发生频度可由 handler/diag.go 的埋点观测，并不罕见）；
//   ② 用户在提交请求返回之前就刷新了，任务号压根还没生成。
//
// 任务号一丢，明明在正常生成的任务就被判死，用户以为白扣了钱又重新点一遍——
// 一分钟内连发三次、白扣三笔点数，
// 而那三个任务其实全部生成成功，是这条链路最典型的表现。
//
// 服务端其实一直知道答案：提交那一刻就把 canvasId + nodeId 记进了退款候选
// （见 model.VideoRefund 的那三个字段）。所以与其在前端想办法保住任务号，
// 不如载入时直接来问一次——任务号无论因为什么原因丢的，都能接回来。

// myPendingVideoTask 白名单出参。
// 只给前端「哪个节点在等哪个任务」这一件事所需的字段：
// credits / projectId / chargedToProject / canvasId / nodeGeom 都是内部记账与救援用的，不出后端。
type myPendingVideoTask struct {
	NodeID    string `json:"nodeId"`
	TaskID    string `json:"taskId"`
	Model     string `json:"model"`
	CreatedAt string `json:"createdAt"`
}

// MyPendingVideoTasks GET /api/my/pending-video-tasks?canvasId=xxx
// 纯读，SQL 层锁死本人 user_id，不接受任何 userId 入参。
func MyPendingVideoTasks(w http.ResponseWriter, r *http.Request) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录")
		return
	}
	canvasID := strings.TrimSpace(r.URL.Query().Get("canvasId"))
	if canvasID == "" {
		// 没带画布 id 就当没有在途任务，不报错——这是兜底路径，绝不能因为它让画布载入报错。
		OK(w, map[string]any{"items": []myPendingVideoTask{}})
		return
	}
	rows, err := repository.ListPendingVideoTasksForCanvas(me.ID, canvasID, myPendingVideoTaskLimit)
	if err != nil {
		FailError(w, err)
		return
	}
	items := make([]myPendingVideoTask, 0, len(rows))
	for _, vr := range rows {
		items = append(items, myPendingVideoTask{
			NodeID:    vr.NodeID,
			TaskID:    vr.TaskID,
			Model:     vr.Model,
			CreatedAt: vr.CreatedAt,
		})
	}
	OK(w, map[string]any{"items": items})
}

// myPendingVideoTaskLimit 单块画布最多回这么多条。
// 正常情况下同时在途的视频不会超过个位数；设上限只是防止异常数据把响应撑爆。
const myPendingVideoTaskLimit = 200
