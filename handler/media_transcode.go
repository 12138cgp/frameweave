package handler

import (
	"net/http"
	"strings"

	"aicanvas/repository"
	"aicanvas/service"
)

// SubmitMediaTranscode POST /api/v1/media/transcode
//
// 给一个「浏览器放不了」的源片排一份 H.264 预览版，只用于画布里播放。
// ⚠️ 与 /media/probe 同样只收 storageKey：收任意 URL 等于把服务端变成任人驱使的抓取器。
func SubmitMediaTranscode(w http.ResponseWriter, r *http.Request) {
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
	job, err := service.StartMediaTranscodeJob(user.ID, key)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, job)
}

// GetMediaTranscode GET /api/v1/media/transcode/:id
func GetMediaTranscode(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		FailAuth(w)
		return
	}
	job, found, err := repository.GetMediaTranscodeJob(strings.TrimSpace(id))
	if err != nil {
		FailError(w, err)
		return
	}
	// 查不到与不属于本人一律回同一个 404：不泄露任务是否存在。
	if !found || job.UserID != user.ID {
		Fail(w, "任务不存在")
		return
	}
	OK(w, job)
}
