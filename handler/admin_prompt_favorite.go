package handler

import (
	"net/http"
	"strconv"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
)

// 「收藏提示词」管理端接口。**仅超管**——挂在 router 的 admin 组，不是 anyAdmin。
//
// 为什么不给二级管理员：这两个接口能读到全平台任意用户的提示词原文和素材副本。
// 提示词是用户的创作内容，二级管理员没有跨组查看别人创作的业务理由；
// 而且下面那个文件下发接口是**跨用户**的（超管要能提取任何人的素材），
// 一旦放开给 L2，等于给了跨组读取素材的通道。fail-closed，只给超管。

// AdminPromptFavorites GET /api/admin/prompt-favorites?userId=&groupId=&kind=&keyword=&page=&pageSize=&all=1
//
// all=1 时把每页顶到上限，供前端分批拉全量做 ZIP 导出（与短信记录/点数日志的导出口径一致）。
// 注意上限是 500，全站收藏可能远多于此——前端必须按 total 循环翻页，不能只拉第一页就当全量。
func AdminPromptFavorites(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	page, _ := strconv.Atoi(strings.TrimSpace(query.Get("page")))
	pageSize, _ := strconv.Atoi(strings.TrimSpace(query.Get("pageSize")))
	if strings.TrimSpace(query.Get("all")) == "1" {
		if page <= 0 {
			page = 1
		}
		pageSize = model.MaxPageSize
	}
	items, total, err := repository.ListPromptFavorites(
		strings.TrimSpace(query.Get("userId")),
		strings.TrimSpace(query.Get("groupId")),
		strings.TrimSpace(query.Get("kind")),
		strings.TrimSpace(query.Get("keyword")),
		page, pageSize,
	)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"items": sanitizeFavorites(items), "total": total})
}

// AdminPromptFavoriteFile GET /api/admin/prompt-favorites/:id/files/:key
//
// 跨用户下发收藏副本，给后台的 ZIP 批量导出用。
//
// 为什么必须单开这个接口：用户侧的同步文件接口按账号隔离，只服务本人的 key
// （handler/sync.go 的 GetSyncFileContent），超管拿不到别人的素材——
// 而「管理员能把收藏连同参考图、音频一起提取出来」正是本功能的硬需求。
//
// 这里**故意不做归属校验**（调用方已由 AdminAuth 限定为超管），
// 但仍严格校验 fileKey 格式并且只认这条记录里登记过的 key，防止拿它当任意文件读取的口子。
func AdminPromptFavoriteFile(w http.ResponseWriter, r *http.Request, id, fileKey string) {
	item, err := repository.GetPromptFavorite(id)
	if err != nil || item.ID == "" {
		http.NotFound(w, r)
		return
	}
	serveFavoriteFile(w, r, item, fileKey)
}
