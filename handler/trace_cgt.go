package handler

import (
	"net/http"

	"aicanvas/repository"
	"aicanvas/service"
)

// TraceCgt GET /api/v1/trace-cgt/:traceId —— 按 trace_id 查这次 AI 调用对应的上游火山 cgt 任务号（限本人）。
// 视频节点用它把「追踪码」显示替换成更有用的 cgt 任务号。
func TraceCgt(w http.ResponseWriter, r *http.Request, traceID string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	cgt, err := repository.GetTaskIDByTraceID(user.ID, traceID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"cgt": cgt})
}
