package handler

import (
	"net/http"

	"aicanvas/model"
	"aicanvas/service"
)

// AdminSmsLogs GET /api/admin/sms-logs?start=&end=&keyword=&type=&ip=&page=&pageSize=&all=
// 短信发送记录：支持时间范围、状态（type 复用）、关键词（手机号/模板）、客户端 IP 筛选 + 分页。
// all=1 时不分页返回筛选后的全部（导出用），并附带汇总。
func AdminSmsLogs(w http.ResponseWriter, r *http.Request) {
	q := parseQuery(r) // keyword/type/ip/page/pageSize
	query := r.URL.Query()
	q.Start = query.Get("start")
	q.End = query.Get("end")
	// q.Type 复用为状态筛选（success/failed/skipped）
	// q.Keyword 模糊匹配 phone 或 template_id
	// q.IP 精确匹配客户端 IP
	if query.Get("all") == "1" {
		q.Page = 1
		q.PageSize = model.MaxPageSize
	}

	logs, total, err := service.AdminListSmsLogs(q)
	if err != nil {
		FailError(w, err)
		return
	}

	summary, _ := service.AdminGetSmsLogSummary(q.Start, q.End, q.Type, q.Keyword, q.IP)
	OK(w, map[string]any{"items": logs, "total": total, "summary": summary})
}
