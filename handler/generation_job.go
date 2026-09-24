package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"aicanvas/service"
)

var generationJobPaths = map[string]string{
	"images":      "/images/generations",
	"image-edits": "/images/edits",
}

// CreateGenerationJob POST /api/v1/generation-jobs?kind=images|image-edits
// 请求体与直连代理完全一致（JSON 或 multipart）；立即返回任务 ID，
// 上游调用在服务端后台执行，浏览器刷新/关闭不影响生成。
func CreateGenerationJob(w http.ResponseWriter, r *http.Request) {
	path, supported := generationJobPaths[strings.TrimSpace(r.URL.Query().Get("kind"))]
	if !supported {
		Fail(w, "不支持的任务类型")
		return
	}
	body, contentType, modelName, err := readAIRequest(r)
	if err != nil {
		log.Printf("generation job read request failed: %v", err)
		Fail(w, "AI 接口请求失败")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	// 这条路只跑图片（generationJobPaths 只有 /images/generations 与 /images/edits），
	// 所以一律按画质档取价：1K/2K/4K 各自的价，没配该档就回落模型的一口价。
	count, imageQuality, imageSize := readAIImageBilling(body, contentType)
	unitCredits, err := service.ImageModelCostForUser(user.ID, modelName, service.ImageQualityTierFor(imageQuality, imageSize))
	if err != nil {
		log.Printf("generation job read model cost failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	credits := unitCredits * count
	// 渠道在执行时才真正使用；这里先验一次，配置类问题（未分组/缺渠道 key）立刻反馈而不是落库后失败
	if _, err := service.SelectModelChannelForUser(user.ID, modelName); err != nil {
		FailError(w, err)
		return
	}
	projectID := strings.TrimSpace(r.Header.Get("X-Project-ID"))
	canvasID := strings.TrimSpace(r.Header.Get("X-Canvas-ID"))
	// unitCredits 落库：缺额退款（部分图被审核拒）要按下单时这一档的原价退，不能事后重新查价。
	job, err := service.CreateGenerationJob(user.ID, projectID, canvasID, path, modelName, body, contentType, credits, unitCredits)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"id": job.ID, "status": job.Status, "credits": job.Credits})
}

// GetGenerationJob GET /api/v1/generation-jobs/:id（轮询；succeeded 时内联上游响应体）
func GetGenerationJob(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	job, ok, err := service.GetGenerationJobForUser(user.ID, strings.TrimSpace(id))
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "任务不存在或已过期（结果保留 48 小时）")
		return
	}
	payload := map[string]any{"id": job.ID, "status": job.Status, "model": job.Model, "createdAt": job.CreatedAt}
	if job.Status == service.GenerationJobFailed {
		message := job.Error
		if message == "" {
			// 上游错误体延迟到查询时翻译，复用代理的中文化逻辑
			message = aiUpstreamStatusMessage(job.UpstreamStatus, job.Result)
		}
		payload["error"] = message
	}
	if job.Status == service.GenerationJobSucceeded && len(job.Result) > 0 {
		payload["result"] = json.RawMessage(job.Result)
	}
	OK(w, payload)
}
