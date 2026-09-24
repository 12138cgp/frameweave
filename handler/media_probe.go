package handler

import (
	"net/http"
	"strings"

	"aicanvas/service"
)

// ProbeMedia POST /api/v1/media/probe
//
// 浏览器解不了的视频（最常见是 iPhone 默认的 H.265）在前端读不到宽高，
// 节点框只能瞎猜，9:16 会被画成 16:9 带黑边。这里用服务端的 ffprobe 给出真实规格。
//
// ⚠️ 只收 storageKey、不收任意 URL：收 URL 等于把服务端变成任人驱使的抓取器（SSRF）。
// storageKey 走 ResolveMediaSourceURL，复用既有的媒体归属校验，不另开一条判据。
func ProbeMedia(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		FailAuth(w)
		return
	}
	var payload struct {
		StorageKey string `json:"storageKey"`
	}
	if !decodeJSON(w, r, &payload) {
		return
	}
	key := strings.TrimSpace(payload.StorageKey)
	if key == "" || !syncStorageKeyPattern.MatchString(key) {
		Fail(w, "存储标识不合法")
		return
	}
	src, err := service.ResolveMediaSourceURL(user.ID, key)
	if err != nil {
		FailError(w, err)
		return
	}
	result, err := service.ProbeVideo(src)
	if err != nil {
		Fail(w, "读不到这个视频的规格")
		return
	}
	OK(w, result)
}
