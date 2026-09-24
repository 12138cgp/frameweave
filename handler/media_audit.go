package handler

import (
	"net/http"
	"strconv"
	"strings"

	"aicanvas/service"
)

// AdminMediaAudit GET /api/admin/media-audit —— 素材对账：
// 列出各用户「画布引用了、但服务端没有任何登记」的素材数量。
//
// 这类丢失以前在服务端完全不可见（客户端同步遇到本地没字节的素材会静默跳过），
// 只能等用户换设备发现白框来报，那时本机唯一副本往往也没了。这个接口把它变成可主动巡检的数字。
//
// 可选 ?userId= 只查单个用户；?samples= 控制返回的样例 key 数量（默认 20）。
// 纯只读，不修改任何数据。
func AdminMediaAudit(w http.ResponseWriter, r *http.Request) {
	samples := 20
	if raw := strings.TrimSpace(r.URL.Query().Get("samples")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 0 && n <= 200 {
			samples = n
		}
	}
	if userID := strings.TrimSpace(r.URL.Query().Get("userId")); userID != "" {
		item, err := service.AuditUserMedia(userID, samples)
		if err != nil {
			FailError(w, err)
			return
		}
		OK(w, []service.MediaAuditUser{item})
		return
	}
	items, err := service.AuditAllUsersMedia(samples)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, items)
}
