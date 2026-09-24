package handler

import (
	"net/http"
	"strconv"
	"strings"

	"aicanvas/repository"
)

// 「用户操作审计」查询接口。仅超管可见——这张表能看出全平台谁动过谁，
// 二级管理员看得到就等于能侦察别的管理员，所以挂在 admin 组而不是 anyAdmin。
//
// 写入侧见 service/user_audit.go。那里有三条红线，其中最重要的一条是：
// 密码和渠道 Key 只记「改过」、绝不记值——所以本接口原样下发 Changes 是安全的。

// MyUserAuditLogs GET /api/admin/user-audit-logs?targetUserId=&operatorId=&keyword=&page=&pageSize=
//
//	targetUserId  只看某个用户被改的历史（排查「他密码是谁改的」用这个）
//	operatorId    只看某个管理员干过什么
//	keyword       模糊匹配 被改用户名 / 操作人名 / 变更字段
func AdminUserAuditLogs(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	page, _ := strconv.Atoi(strings.TrimSpace(query.Get("page")))
	pageSize, _ := strconv.Atoi(strings.TrimSpace(query.Get("pageSize")))
	items, total, err := repository.ListUserAuditLogs(
		strings.TrimSpace(query.Get("targetUserId")),
		strings.TrimSpace(query.Get("operatorId")),
		strings.TrimSpace(query.Get("keyword")),
		page, pageSize,
	)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"items": items, "total": total})
}
