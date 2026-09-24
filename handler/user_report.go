package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
)

// 用户问题反馈：用户提交（含操作日志与现场快照），管理员在后台查看处理。

// SubmitMyReport POST /api/my/reports —— 用户提交一条问题反馈。
func SubmitMyReport(w http.ResponseWriter, r *http.Request) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录")
		return
	}
	var input service.UserReportInput
	if !decodeJSON(w, r, &input) {
		return
	}
	id, err := service.SubmitUserReport(me, input)
	if err != nil {
		// 这里的错误都是给用户看的（描述为空、太长、限流），直接回原文
		Fail(w, err.Error())
		return
	}
	log.Printf("user report submitted: id=%d user=%s category=%s", id, me.ID, input.Category)
	OK(w, map[string]any{"id": id})
}

// myReportDTO 用户看自己反馈时的出参：不含任何管理侧字段。
type myReportDTO struct {
	ID          int64  `json:"id"`
	Category    string `json:"category"`
	Description string `json:"description"`
	CanvasTitle string `json:"canvasTitle"`
	Status      string `json:"status"`
	// 管理员的处理结论要给用户看到——不然用户永远不知道自己反馈的事有没有人管。
	AdminNote string `json:"adminNote"`
	HandledAt string `json:"handledAt"`
	CreatedAt string `json:"createdAt"`
}

// MyReports GET /api/my/reports —— 用户看自己提过的反馈。
func MyReports(w http.ResponseWriter, r *http.Request) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录")
		return
	}
	q := parseQuery(r)
	q.Keyword = ""
	items, total, err := repository.ListMyUserReports(me.ID, q)
	if err != nil {
		FailError(w, err)
		return
	}
	// 白名单 DTO：handlerId / groupId / env / server 这些不该出现在用户侧。
	out := make([]myReportDTO, 0, len(items))
	for _, item := range items {
		out = append(out, myReportDTO{
			ID: item.ID, Category: item.Category, Description: item.Description,
			CanvasTitle: item.CanvasTitle, Status: item.Status,
			AdminNote: item.AdminNote, HandledAt: item.HandledAt, CreatedAt: item.CreatedAt,
		})
	}
	OK(w, map[string]any{"items": out, "total": total})
}

// adminReportScope 解析管理员能看到哪些用户的反馈。
// 返回 nil 表示不限（超管）；返回空切片表示一条都不该看到。
func adminReportScope(me model.AuthUser) ([]string, error) {
	if me.Role != model.UserRoleAdminL2 {
		return nil, nil
	}
	// 二级管理员只看自己下辖用户 —— 与「生成统计」同一套归属口径。
	users, err := repository.SubordinateUsers(me.ID)
	if err != nil {
		return []string{}, err
	}
	ids := make([]string, 0, len(users)+1)
	for _, user := range users {
		ids = append(ids, user.ID)
	}
	// 把自己也算进去：二级管理员自己也会提反馈。
	ids = append(ids, me.ID)
	return ids, nil
}

// AdminReports GET /api/admin/reports —— 后台列出反馈。
func AdminReports(w http.ResponseWriter, r *http.Request) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	scope, err := adminReportScope(me)
	if err != nil {
		FailError(w, err)
		return
	}
	query := r.URL.Query()
	q := parseQuery(r)
	filter := repository.UserReportFilter{
		UserIDs:  scope,
		Status:   query.Get("status"),
		Category: query.Get("category"),
		Keyword:  q.Keyword,
		Start:    query.Get("start"),
		End:      query.Get("end"),
	}
	items, total, err := repository.ListUserReports(filter, q)
	if err != nil {
		FailError(w, err)
		return
	}
	open, _ := repository.CountOpenUserReports(scope)
	OK(w, map[string]any{"items": items, "total": total, "openCount": open})
}

// AdminReportDetail GET /api/admin/reports/:id —— 反馈详情，含解开的操作日志。
func AdminReportDetail(w http.ResponseWriter, r *http.Request, idStr string) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	id, err := strconv.ParseInt(strings.TrimSpace(idStr), 10, 64)
	if err != nil || id <= 0 {
		Fail(w, "反馈 ID 不合法")
		return
	}
	report, found, err := repository.GetUserReport(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !found {
		Fail(w, "反馈不存在")
		return
	}
	if !adminCanSeeReport(w, me, report) {
		return
	}

	// 日志解不开不算致命：其余现场信息仍然有用，标注一下让管理员知道少了什么。
	entries, uerr := service.UnpackUserReportLog(report.LogGzip)
	logError := ""
	if uerr != nil {
		logError = uerr.Error()
		entries = nil
	}
	OK(w, map[string]any{
		"report":   report,
		"log":      entries,
		"logError": logError,
		// env / local / server 在库里是 JSON 字符串，原样给前端自己 parse，
		// 避免服务端来回 unmarshal/marshal 白烧 CPU（这几块加起来可能上百 KB）。
	})
}

func adminCanSeeReport(w http.ResponseWriter, me model.AuthUser, report model.UserReport) bool {
	if me.Role != model.UserRoleAdminL2 {
		return true
	}
	if report.UserID == me.ID {
		return true
	}
	target, found, err := repository.GetUserByID(report.UserID)
	if err != nil || !found || target.CreatorID != me.ID {
		Fail(w, "无权查看该反馈")
		return false
	}
	return true
}

// AdminUpdateReport POST /api/admin/reports/:id —— 改状态、写处理备注。
func AdminUpdateReport(w http.ResponseWriter, r *http.Request, idStr string) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	id, err := strconv.ParseInt(strings.TrimSpace(idStr), 10, 64)
	if err != nil || id <= 0 {
		Fail(w, "反馈 ID 不合法")
		return
	}
	var body struct {
		Status    string `json:"status"`
		AdminNote string `json:"adminNote"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	switch model.UserReportStatus(body.Status) {
	case model.UserReportStatusOpen, model.UserReportStatusHandling, model.UserReportStatusClosed:
	default:
		Fail(w, "状态不合法")
		return
	}
	report, found, err := repository.GetUserReport(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !found {
		Fail(w, "反馈不存在")
		return
	}
	if !adminCanSeeReport(w, me, report) {
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := repository.UpdateUserReportStatus(id, body.Status, strings.TrimSpace(body.AdminNote), me.ID, now); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"id": id, "status": body.Status})
}

// AdminReportLogDownload GET /api/admin/reports/:id/log —— 直接下原始日志（JSON）。
// 后台表格看几千条不现实，排查时导出来用编辑器搜更快。
func AdminReportLogDownload(w http.ResponseWriter, r *http.Request, idStr string) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	id, err := strconv.ParseInt(strings.TrimSpace(idStr), 10, 64)
	if err != nil || id <= 0 {
		Fail(w, "反馈 ID 不合法")
		return
	}
	report, found, err := repository.GetUserReport(id)
	if err != nil || !found {
		Fail(w, "反馈不存在")
		return
	}
	if !adminCanSeeReport(w, me, report) {
		return
	}
	entries, uerr := service.UnpackUserReportLog(report.LogGzip)
	if uerr != nil {
		FailError(w, uerr)
		return
	}
	payload := map[string]any{
		"report": map[string]any{
			"id": report.ID, "user": report.Username, "category": report.Category,
			"description": report.Description, "createdAt": report.CreatedAt,
		},
		"env":    json.RawMessage(orEmptyJSON(report.Env)),
		"client": json.RawMessage(orEmptyJSON(report.Local)),
		"server": json.RawMessage(orEmptyJSON(report.Server)),
		"log":    entries,
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=\"report-"+idStr+".json\"")
	_ = json.NewEncoder(w).Encode(payload)
}

func orEmptyJSON(s string) string {
	if strings.TrimSpace(s) == "" {
		return "null"
	}
	return s
}
