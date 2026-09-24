package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
)

// blockedUpstreamHeaders 不向客户端透传的上游响应头：敏感凭证头 + hop-by-hop 头。
// 其余头（含 Content-Type / SSE 流式相关）原样透传，避免破坏正常代理。
var blockedUpstreamHeaders = map[string]bool{
	"content-length":     true,
	"set-cookie":         true,
	"authorization":      true,
	"www-authenticate":   true,
	"proxy-authenticate": true,
	"connection":         true,
	"keep-alive":         true,
	"transfer-encoding":  true,
	"upgrade":            true,
	"trailer":            true,
}

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/generations")
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/edits")
}

func AIChatCompletions(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/chat/completions")
}

func AIAudioSpeech(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/audio/speech")
}

func AIVideos(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/videos")
}

func AIVideo(w http.ResponseWriter, r *http.Request, id string) {
	// 传 task id:轮询到任务失败(含输出内容审核)时据此幂等退款
	proxyAIGetRequest(w, r, "/videos/"+id, id)
}

func AIVideoContent(w http.ResponseWriter, r *http.Request, id string) {
	// 取视频字节流,必须流式转发(不 buffer)、不涉退款,故 taskID 传空
	proxyAIGetRequest(w, r, "/videos/"+id+"/content", "")
}

// videoUsage 视频完成响应里的 token 用量(火山 ark: total_tokens/completion_tokens/output_tokens)。
type videoUsage struct {
	TotalTokens      int `json:"total_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	OutputTokens     int `json:"output_tokens"`
}

func (u videoUsage) total() int {
	if u.TotalTokens > 0 {
		return u.TotalTokens
	}
	if u.CompletionTokens > 0 {
		return u.CompletionTokens
	}
	return u.OutputTokens
}

// recordVideoTokenUsage 视频轮询到成功且响应带 usage 时,旁路把真实 token 回填到提交时创建的 token_logs。
// 纯观测、best-effort、不参与任何扣费/退款;幂等回填一次。
func recordVideoTokenUsage(taskID string, body []byte) {
	var p struct {
		Usage videoUsage `json:"usage"`
		Data  struct {
			Usage videoUsage `json:"usage"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return
	}
	total := p.Usage.total()
	if total == 0 {
		total = p.Data.Usage.total()
	}
	if total <= 0 {
		return
	}
	if err := repository.BackfillVideoTokenUsage(taskID, total); err != nil {
		log.Printf("video token backfill failed: task=%s err=%v", taskID, err)
	}
}

func proxyAIGetRequest(w http.ResponseWriter, r *http.Request, path string, videoTaskID string) {
	traceID := newTraceID()
	w.Header().Set("X-Request-Id", traceID)
	modelName := r.URL.Query().Get("model")
	if strings.TrimSpace(modelName) == "" {
		modelName = "grok-imagine-video"
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	// 轮询视频状态时：本任务若已有永久成片地址（客户端此前转存过，或被孤儿视频救援救回并回填），
	// 直接按「已完成」交付，不再去问上游。
	//
	// 这一步是为了让【离开画布导致的孤儿视频】还能回到生成它的那个节点：节点重新加载时会自动续查
	// （带 videoTaskId 的 loading 节点保持 loading），但上游产物链只活 24 小时，过期后就永远填不上了——
	// 哪怕成片早已被救进我们自己的桶。有了这条，续查随时都能领回同一段视频。
	if strings.TrimSpace(videoTaskID) != "" {
		if url, uerr := repository.VideoResultURLByTask(user.ID, videoTaskID); uerr == nil && strings.TrimSpace(url) != "" {
			OK(w, map[string]any{
				"id":      videoTaskID,
				"status":  "succeeded",
				"model":   modelName,
				"content": map[string]any{"video_url": url},
			})
			return
		}
	}
	channel, err := service.SelectModelChannelForUser(user.ID, modelName)
	if err != nil {
		log.Printf("AI proxy select channel failed: trace=%s model=%s err=%v", traceID, modelName, err)
		FailError(w, err)
		return
	}

	path = resolveAIProxyPath(channel.BaseURL, modelName, path)
	request, err := http.NewRequest(http.MethodGet, service.BuildModelChannelURL(channel, path), nil)
	if err != nil {
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	// 视频状态轮询(videoTaskID 非空):上游 4xx/5xx 走 onFailure、HTTP 200 但任务 status=failed 走 captureBody,
	// 都经 refundVideoIfNeeded 的原子幂等闸退款(前端反复轮询同一 failed 任务只退一次)。视频内容字节流 videoTaskID 为空→nil→流式转发。
	var onFailure func()
	var captureBody func([]byte)
	if videoTaskID != "" {
		onFailure = func() { refundVideoIfNeeded(videoTaskID, traceID) }
		captureBody = func(body []byte) {
			if videoTaskFailed(body) {
				refundVideoIfNeeded(videoTaskID, traceID)
				return
			}
			if videoTaskSucceeded(body) {
				recordVideoTokenUsage(videoTaskID, body)
				_ = repository.BackfillVideoDuration(videoTaskID)
			}
		}
	}
	copyAIResponse(w, request, traceID, onFailure, nil, captureBody, nil, false)
}

func proxyAIRequest(w http.ResponseWriter, r *http.Request, path string) {
	traceID := newTraceID()
	w.Header().Set("X-Request-Id", traceID)
	body, contentType, modelName, err := readAIRequest(r)
	if err != nil {
		log.Printf("AI proxy request read failed: trace=%s err=%v", traceID, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	// 画布助手的轮次闸门。挂在扣费之前——被闸住的请求一分钱都不该花。
	// ⚠️ 轮次由服务端自己数，不信 X-Agent-Round 那个头（它是前端给的，可以随便改）。
	agentTurnID := strings.TrimSpace(r.Header.Get("X-Agent-Turn-Id"))
	if agentTurnID != "" {
		allowed, round, reason := service.AgentTurnAdmit(user.ID, agentTurnID)
		if !allowed {
			log.Printf("agent gate blocked: trace=%s user=%s turn=%s reason=%s", traceID, user.ID, agentTurnID, reason)
			Fail(w, reason)
			return
		}
		log.Printf("agent turn: trace=%s user=%s turn=%s round=%d", traceID, user.ID, agentTurnID, round)
	}
	// originalPath / kind 在 path 被 resolveAIProxyPath 覆盖前记下，供 token 观测日志归类。
	originalPath := path
	kind := classifyAIKind(path)
	reqCount, imageQuality, imageSize := readAIImageBilling(body, contentType)
	// 图片按画质档取价（1K/2K/4K）；非图片请求 tier 传空 = 一口价，行为与分档上线前完全一致。
	qualityTier := ""
	if kind == "image" {
		qualityTier = service.ImageQualityTierFor(imageQuality, imageSize)
	}
	credits, err := service.ImageModelCostForUser(user.ID, modelName, qualityTier)
	if err != nil {
		log.Printf("AI proxy read model cost failed: trace=%s model=%s err=%v", traceID, modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	credits *= reqCount
	// 助手发的生成请求：先过单回合预算闸。挂在这里是因为 credits 刚算完、还没扣费——
	// 超预算的请求一分钱都不该花。
	if agentTurnID != "" && credits > 0 {
		allowed, spent, reason := service.AgentTurnSpend(user.ID, agentTurnID, credits)
		if !allowed {
			log.Printf("agent budget blocked: trace=%s user=%s turn=%s want=%d spent=%d", traceID, user.ID, agentTurnID, credits, spent)
			Fail(w, reason)
			return
		}
		log.Printf("agent spend: trace=%s user=%s turn=%s credits=%d total=%d", traceID, user.ID, agentTurnID, credits, spent)
	}
	// 音频计价三选一，优先级：按字数 > 按秒 > 按次一口价。
	//   按字数：字数提交时就已知 → 一次扣准，没有预扣/结算/透支敞口。**默认配置用的是这个。**
	//   按秒　：上游没有时长参数、秒数事前不可知 → 预扣 + 按 original_duration 结算差额。
	//   按次　：两者都没配时回退，走上面算好的 ImageModelCostForUser。
	audioTargetSeconds := 0
	audioByChars := false
	if kind == "audio" && service.IsDoubaoAudioGenModel(modelName) {
		chars := readAIAudioChars(body)
		if charCredits, configured, cerr := service.AudioCharCreditsForUser(user.ID, modelName, chars); cerr == nil && configured {
			credits = charCredits
			audioByChars = true
			log.Printf("audio char billing: trace=%s model=%s chars=%d units=%d credits=%d", traceID, modelName, chars, service.AudioCharUnits(chars), credits)
		} else if cerr != nil {
			log.Printf("AI proxy read audio char cost failed: trace=%s model=%s err=%v", traceID, modelName, cerr)
		}
	}
	if kind == "audio" && !audioByChars && service.IsDoubaoAudioGenModel(modelName) {
		audioTargetSeconds = readAIAudioBilling(body)
		if audioCredits, configured, aerr := service.AudioModelCreditsForUser(user.ID, modelName, audioTargetSeconds); aerr == nil && configured {
			credits = audioCredits
		} else if aerr != nil {
			log.Printf("AI proxy read audio model cost failed: trace=%s model=%s err=%v", traceID, modelName, aerr)
		}
	}
	isVideoSubmit := path == "/videos" // path 稍后会被 resolveAIProxyPath 覆盖,提前记下
	var videoSeconds int
	var videoResolution string
	if isVideoSubmit {
		var videoHasInput bool
		var videoBillingErr error
		videoSeconds, videoResolution, videoHasInput, videoBillingErr = readAIVideoBilling(user.ID, body, contentType)
		if videoBillingErr != nil {
			// 目前只有「视频编辑」(omni_reference_task_type=="edit") 会走到这里：它的计费秒数必须
			// 从源视频探出来，探不到就没有任何诚实的收法（详见 readAIVideoBilling 里那段说明）。
			// ⚠️ 拦的位置很关键：这里在 ConsumeProjectCredits / ConsumeUserCredits【之前】，
			//    一分钱都还没扣，直接拒绝即可，不存在要退的钱、也不会留下待退款的孤儿记录。
			// 用 Fail 而不是 FailError：这些文案都是我们自己写的（不含上游原文/URL），可以原样给用户看；
			// aiError 没实现 SafeMessage，交给 FailError 只会得到一句没用的「操作失败」。
			log.Printf("video billing rejected: trace=%s user=%s model=%s err=%v", traceID, user.ID, modelName, videoBillingErr)
			Fail(w, videoBillingErr.Error())
			return
		}
		if videoCredits, configured, err := service.VideoModelCreditsForUser(user.ID, modelName, videoSeconds, videoResolution, videoHasInput); err == nil && configured {
			credits = videoCredits
		} else if err != nil {
			log.Printf("AI proxy read video model cost failed: trace=%s model=%s err=%v", traceID, modelName, err)
		}
	}
	channel, err := service.SelectModelChannelForUser(user.ID, modelName)
	if err != nil {
		log.Printf("AI proxy select channel failed: trace=%s model=%s user=%s err=%v", traceID, modelName, user.ID, err)
		FailError(w, err)
		return
	}
	path = resolveAIProxyPath(channel.BaseURL, modelName, path)
	// 文本流式：注入 stream_options.include_usage=true，确保上游在尾 chunk 回传 usage（前端可能没带）。
	// 非文本 / multipart 一律不动 body；prepareChatStreamBody 内部再判 stream:true 才真注入，非流式原样返回。
	isStream := false
	if kind == "text" && !strings.HasPrefix(contentType, "multipart/form-data") {
		body, isStream = prepareChatStreamBody(body)
	}
	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelURL(channel, path), bytes.NewReader(body))
	if err != nil {
		log.Printf("AI proxy build request failed: trace=%s url=%s err=%v", traceID, service.BuildModelChannelURL(channel, path), err)
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	// 扣费路由：优先项目积分池（镜像 CreateGenerationJob）。命中项目但池不足 → 直接报错（不回退个人）；
	// 无 X-Project-ID / 非成员 / 项目不存在 / 非 active → charged=false，回退原有个人积分扣费，行为与之前完全一致。
	projectID := r.Header.Get("X-Project-ID")
	// 画布上下文：救援时用来把成片放回原画布原位（见 model.VideoRefund 的字段说明）。
	// 图片那条路（handler/generation_job.go）早就在读 X-Canvas-ID 了，视频这条一直没读，
	// 于是提交那一刻明明拿得到的信息被丢掉，救援时只能退到「我的素材」。
	canvasID := strings.TrimSpace(r.Header.Get("X-Canvas-ID"))
	nodeCtxRaw := strings.TrimSpace(r.Header.Get("X-Canvas-Node"))
	canvasNodeID, canvasNodeGeom := parseCanvasNodeHeader(nodeCtxRaw)
	// 人像资产前置校验：分组换过火山密钥/项目后，旧账号下认证的资产在新账号里不存在，
	// 但库里还写着 active、界面也看不出来，一直到上游把请求顶回来才暴露，而那个报错
	// 用户根本看不懂（见 service/portrait_asset_guard.go 的说明）。
	// 放在扣费【之前】：命中就直接拒绝，压根不扣，而不是扣了再退。
	if err := service.CheckPortraitAssetsFresh(user.ID, body); err != nil {
		FailError(w, err)
		return
	}
	chargedToProject, err := service.ConsumeProjectCredits(user.ID, projectID, modelName, credits, path)
	if err != nil {
		FailError(w, err)
		return
	}
	if !chargedToProject {
		if err := service.ConsumeUserCredits(user.ID, modelName, credits, path); err != nil {
			FailError(w, err)
			return
		}
	}
	// 火山音频(豆包语音)渠道：原生协议，不走 OpenAI 转发；用渠道凭证直连，失败按同款逻辑退款。
	if channel.Protocol == "volc-audio" {
		refund := func() {
			if chargedToProject {
				if err := service.RefundProjectCredits(projectID, user.ID, modelName, credits, path); err != nil {
					log.Printf("volc-audio refund project failed: trace=%s err=%v", traceID, err)
				}
				return
			}
			if err := service.RefundUserCredits(user.ID, modelName, credits, path); err != nil {
				log.Printf("volc-audio refund failed: trace=%s err=%v", traceID, err)
			}
		}
		settle := func(actualSeconds float64) int {
			// 按字数计价时价格在提交时就算准了，不存在"多退少补"。
			// 若仍去结算，会拿「秒数×每秒价」重算一个完全不同口径的数，把账算乱。
			if audioByChars {
				return credits
			}
			return settleAudioCredits(audioSettlement{
				TraceID: traceID, UserID: user.ID, ProjectID: projectID, Model: modelName, Path: path,
				ChargedToProject: chargedToProject, Prepaid: credits,
				TargetSeconds: audioTargetSeconds, ActualSeconds: actualSeconds,
			})
		}
		// 任务日志。音频这条路在下方通用 SaveUpstreamLog 之前就 return 了，不补的话
		// 后台「任务日志」、「我的消耗」、「生成统计」里音频一条都看不到。
		// finalCredits 取【结算后的真实扣费】，否则「我的消耗」的点数会和点数日志对不上。
		record := func(status int, finalCredits int) {
			if finalCredits == recordUsePrepaidCredits {
				finalCredits = credits
			}
			if err := repository.SaveUpstreamLog(model.UpstreamLog{
				TraceID:        traceID,
				UserID:         user.ID,
				Model:          modelName,
				Kind:           kind,
				Path:           path,
				Request:        service.SanitizeAIRequestBody(body, contentType),
				UpstreamStatus: status,
				Source:         "proxy",
				ChannelID:      channel.ID,
			}); err != nil {
				log.Printf("save upstream log failed (audio): trace=%s err=%v", traceID, err)
			}
			entry := model.TokenLog{
				TraceID: traceID, UserID: user.ID, GroupID: user.GroupID,
				ProjectID: projectID, ChargedToProject: chargedToProject,
				Model: modelName, Path: originalPath, Kind: kind,
				ChargedCredits: finalCredits, UpstreamStatus: status,
				EstimatedQuota: float64(finalCredits),
			}
			go func() {
				if err := repository.SaveTokenLog(entry); err != nil {
					log.Printf("save token log failed (audio): trace=%s err=%v", traceID, err)
				}
			}()
		}
		serveVolcAudioSpeech(w, body, modelName, user.ID, channel, traceID, refund, settle, record)
		return
	}

	// 视频提交：扣费已成功，但还没发出请求、更没有 task id。这一小段窗口里进程若被杀
	// （部署、OOM、宿主机重启），那笔钱就成了无主孤儿——退费机制整个是按 task id 索引的，
	// 没有 task id 就没有任何东西负责退，后台也查不到记录。
	// 先用 trace id 落一条占位候选，拿到真 task id 或同步退过费后立刻清掉；
	// 万一没走到那一步，下次启动由 RecoverInterruptedVideoSubmits 兜底退回。
	if isVideoSubmit {
		service.MarkVideoSubmitPending(traceID, user.ID, projectID, modelName, credits, chargedToProject)
	}

	// 任务日志:请求体摘要(prompt/参数;base64 参考图剥成占位符,避免日志暴涨),随下面的 SaveUpstreamLog 一并落库。
	reqSummary := service.SanitizeAIRequestBody(body, contentType)
	// 视频提交:抓上游返回的 task id,落退款候选(含扣费来源),供轮询失败时按 task id 幂等退款。
	var captureBody func([]byte)
	if isVideoSubmit {
		captureBody = func(body []byte) {
			taskID := extractVideoTaskID(body)
			if taskID == "" {
				return
			}
			if err := repository.SaveVideoRefundCandidate(model.VideoRefund{
				TaskID: taskID, UserID: user.ID, ProjectID: projectID, Model: modelName, Credits: credits, ChargedToProject: chargedToProject,
				CanvasID: canvasID, NodeID: canvasNodeID, NodeGeom: canvasNodeGeom,
			}); err != nil {
				log.Printf("video refund candidate save failed: trace=%s task=%s err=%v", traceID, taskID, err)
			}
			// 已经有真 task id 接管，占位使命完成
			service.ClearVideoSubmitPending(traceID)
			// 把上游 cgt 任务号回填到任务日志行(best-effort、幂等:只填空的)。
			if err := repository.UpdateUpstreamLogTaskID(traceID, taskID); err != nil {
				log.Printf("update upstream log task id failed: trace=%s task=%s err=%v", traceID, taskID, err)
			}
		}
	}
	copyAIResponse(w, request, traceID, func() {
		// 这里已经同步退过费，占位必须清掉，否则下次启动的中断恢复会再退一次
		service.ClearVideoSubmitPending(traceID)
		if chargedToProject {
			if err := service.RefundProjectCredits(projectID, user.ID, modelName, credits, path); err != nil {
				log.Printf("AI proxy refund project credits failed: trace=%s project=%s user=%s model=%s credits=%d err=%v", traceID, projectID, user.ID, modelName, credits, err)
			}
			return
		}
		if err := service.RefundUserCredits(user.ID, modelName, credits, path); err != nil {
			log.Printf("AI proxy refund credits failed: trace=%s user=%s model=%s credits=%d err=%v", traceID, user.ID, modelName, credits, err)
		}
	}, func(response *http.Response) {
		// 捕获上游 LogID（火山计费/排查）并持久化；写库失败只记 log、不阻断响应流式转发。
		logid := service.UpstreamLogID(response.Header)
		if logid != "" {
			log.Printf("upstream logid: trace=%s model=%s status=%d logid=%s", traceID, modelName, response.StatusCode, logid)
		}
		if err := repository.SaveUpstreamLog(model.UpstreamLog{
			TraceID:        traceID,
			UserID:         user.ID,
			Model:          modelName,
			Kind:           kind,
			Path:           path,
			Request:        reqSummary,
			LogID:          logid,
			UpstreamStatus: response.StatusCode,
			Source:         "proxy",
			ChannelID:      channel.ID, // 埋点:记录本次实际选中的渠道,便于按渠道归集用量
		}); err != nil {
			log.Printf("save upstream log failed: trace=%s err=%v", traceID, err)
		}
	}, captureBody, func(tail []byte, status int) {
		// token 观测（best-effort、纯旁路记录、不参与任何扣费/退款）：文本抓真实 usage，
		// 图像/视频/音频无 token，记张数/秒数/分辨率 + 实扣积分。estimated_quota 文本走粗略倍率、其余=实扣积分。
		entry := model.TokenLog{
			TraceID: traceID, UserID: user.ID, GroupID: user.GroupID,
			ProjectID: projectID, ChargedToProject: chargedToProject,
			Model: modelName, Path: originalPath, Kind: kind, IsStream: isStream,
			VideoSeconds: videoSeconds, Resolution: videoResolution,
			ChargedCredits: credits, UpstreamStatus: status,
		}
		if kind == "image" {
			entry.ImageCount = reqCount
		}
		if kind == "text" {
			if u := extractUsageFromTail(tail); u != nil {
				entry.PromptTokens = u.PromptTokens
				entry.CompletionTokens = u.CompletionTokens
				entry.CachedTokens = u.PromptTokensDetails.CachedTokens
				entry.ReasoningTokens = u.CompletionTokensDetails.ReasoningTokens
				entry.TotalTokens = u.TotalTokens
				entry.EstimatedQuota = service.EstimateTokenQuota(modelName, u.PromptTokens, u.CompletionTokens, u.PromptTokensDetails.CachedTokens)
			}
		} else {
			entry.EstimatedQuota = float64(credits)
		}
		go func() {
			if err := repository.SaveTokenLog(entry); err != nil {
				log.Printf("save token log failed: trace=%s err=%v", traceID, err)
			}
		}()
	}, kind == "text")
}

// recordUsePrepaidCredits 传给 onRecord 表示「这条没有结算过程，实扣就是提交时的预扣额」。
// 用哨兵值而不是让被调方去猜预扣是多少：预扣额只有 proxyAIRequest 那层知道。
const recordUsePrepaidCredits = -1

// audioSpeechRequest 音频请求体。前四个字段是 OpenAI /audio/speech 的原样字段（老的 TTS 路继续用）；
// 后面几个是我们自己为「音频生成(seed-audio)」扩展的——中间没有第三方，扩展自家协议比新开一条
// 带扣费的路安全得多（扣费/退款/项目池/upstream_logs/trace 全在 proxyAIRequest 里现成）。
type audioSpeechRequest struct {
	Input          string  `json:"input"`
	Voice          string  `json:"voice"`
	ResponseFormat string  `json:"response_format"`
	Speed          float64 `json:"speed"`
	// TargetSeconds 目标时长（秒）：上游没有时长参数，这个值一是写进提示词控时长(前端做)、
	// 二是按秒计价的预扣依据。真实秒数以上游返回的 original_duration 为准。
	TargetSeconds int `json:"target_seconds,omitempty"`
	LoudnessRate  int `json:"loudness_rate,omitempty"`
	PitchRate     int `json:"pitch_rate,omitempty"`
	SampleRate    int `json:"sample_rate,omitempty"`
	// References 参考素材。音频参考的顺序【必须】与提示词里的 @音频N 编号严格对应。
	References []audioSpeechReference `json:"references,omitempty"`
}

// audioSpeechReference 一条参考素材。前端只传地址，字节由后端自己去取——
// 桶不一定公共读、上游能否访问我们的地址也没有保证，后端取字节是唯一稳的做法。
type audioSpeechReference struct {
	Kind       string `json:"kind"` // audio | image
	URL        string `json:"url,omitempty"`
	StorageKey string `json:"storageKey,omitempty"`
	Speaker    string `json:"speaker,omitempty"`
}

// readAIAudioChars 读本次要合成的文本字数，用于按字数计价。
//
// ⚠️ 数的是【字符（rune）】不是字节，与上游的口径一致：实测发 3001 个中文字，
// 上游报的是 "text_prompt length 3001 exceeds maximum of 3000"——它数的也是字符。
// 用 len(string) 的话中文会被算成 3 倍，用户写 1000 字就被收 30 档的钱。
func readAIAudioChars(body []byte) int {
	var payload struct {
		Input string `json:"input"`
	}
	_ = json.Unmarshal(body, &payload)
	return len([]rune(payload.Input))
}

// readAIAudioBilling 从音频请求体里读「目标时长」(秒)，作为按秒计价的预扣依据。
// 音频请求一律是 JSON（不像图片还有 multipart 那条路），所以这里不用管 contentType。
// 读不到 / 没带 → 0，由 service.NormalizeAudioBillingSeconds 落到默认预扣秒数。
func readAIAudioBilling(body []byte) int {
	var payload struct {
		TargetSeconds int `json:"target_seconds"`
	}
	_ = json.Unmarshal(body, &payload)
	if payload.TargetSeconds < 0 {
		return 0
	}
	return payload.TargetSeconds
}

// audioSettlement 一次音频生成的结算上下文。
type audioSettlement struct {
	TraceID          string
	UserID           string
	ProjectID        string
	Model            string
	Path             string
	ChargedToProject bool
	// Prepaid 提交时已经扣掉的点数（按目标时长算的预扣）。
	Prepaid       int
	TargetSeconds int
	// ActualSeconds 上游返回的 original_duration，**上游明确这是计费依据**。
	ActualSeconds float64
}

// settleAudioCredits 音频按秒计价的「多退少补」。
//
// 为什么必须有这一步：seed-audio 上游没有时长参数，提交时只能按用户填的【目标时长】预扣，
// 真实秒数要等出片才知道（详见 model.AudioModelCost 的说明）。
//
// 三条自我约束：
//  1. 只结算「配了按秒价」的模型。没配按秒价时 Prepaid 是按次一口价，跟秒数没有换算关系，
//     硬结算会算出离谱的差额——老的 doubao-tts 因此完全不受影响。
//  2. 上游没给时长(<=0)就不动钱。宁可不结算，也不能拿一个不知道对不对的数去扣用户的钱。
//  3. 补扣走【允许透支】的路径，且失败也不把请求判失败：音频已经交付给用户了，
//     这时候再报错，用户会看到「生成失败」但钱照扣、片子照拿，比什么都糟。
//     所以余额不够时不是放弃扣费（那等于白送，见下方 diff>0 分支的说明），
//     而是如实扣成负数；只有数据库层面真出错时才只剩记日志这一条路。
func settleAudioCredits(s audioSettlement) int {
	if s.ActualSeconds <= 0 {
		log.Printf("audio settle skipped (no duration): trace=%s model=%s prepaid=%d", s.TraceID, s.Model, s.Prepaid)
		return s.Prepaid
	}
	// 不足 1 秒按 1 秒：上游 original_duration 是浮点，0.4 秒的音效也得收钱。
	actual := int(math.Ceil(s.ActualSeconds))
	final, configured, err := service.AudioModelCreditsForUser(s.UserID, s.Model, actual)
	if err != nil {
		log.Printf("audio settle read cost failed: trace=%s model=%s err=%v", s.TraceID, s.Model, err)
		return s.Prepaid
	}
	if !configured {
		return s.Prepaid // 按次一口价，不存在结算
	}
	diff := final - s.Prepaid
	if diff == 0 {
		return final
	}
	log.Printf("audio settle: trace=%s model=%s target=%ds actual=%ds prepaid=%d final=%d diff=%+d", s.TraceID, s.Model, s.TargetSeconds, actual, s.Prepaid, final, diff)
	if diff < 0 {
		// ⚠️ 用 Settle* 版本而不是普通退款：普通退款的流水备注写死「模型调用失败返还」，
		// 而这里退的是预扣多出来的差额、生成本身是成功的。用错会让用户在点数日志里
		// 看到一连串「调用失败」，以为音频一直没生成出来。
		refund := -diff
		if s.ChargedToProject {
			if err := service.SettleRefundProjectCredits(s.ProjectID, s.UserID, s.Model, refund, s.Path); err != nil {
				log.Printf("audio settle refund project failed: trace=%s credits=%d err=%v", s.TraceID, refund, err)
			}
			return final
		}
		if err := service.SettleRefundUserCredits(s.UserID, s.Model, refund, s.Path); err != nil {
			log.Printf("audio settle refund failed: trace=%s credits=%d err=%v", s.TraceID, refund, err)
		}
		return final
	}
	// 补扣走「允许透支」的结算路径，不是普通扣费。
	//
	// 普通扣费在余额不足时会拒绝，而音频【已经交付给用户了】——此时放弃扣费等于平台白送，
	// 且可被反复利用：目标时长选 1 秒（预扣 1×单价），提示词里要一段 120 秒的音频，
	// 每次都只付 1 秒的钱。让余额/池子变负是唯一诚实的记法，欠账写进流水，
	// 下一次生成会被扣费入口的余额校验自然挡住，直到补平。
	if s.ChargedToProject {
		if err := service.SettleConsumeProjectCredits(s.ProjectID, s.UserID, s.Model, diff, s.Path); err != nil {
			log.Printf("audio settle charge project failed: trace=%s project=%s credits=%d err=%v", s.TraceID, s.ProjectID, diff, err)
		}
		return final
	}
	if err := service.SettleConsumeUserCredits(s.UserID, s.Model, diff, s.Path); err != nil {
		log.Printf("audio settle charge failed: trace=%s credits=%d err=%v", s.TraceID, diff, err)
	}
	return final
}

// serveDoubaoAudioGen 音频生成(seed-audio)：取参考素材字节 → 调上游 → 结算 → 写音频回客户端。
// 参考素材的顺序原样保留，因为提示词里的 @音频N 是按这个顺序编号的，错位等于引用错素材。
func serveDoubaoAudioGen(w http.ResponseWriter, req audioSpeechRequest, modelName, userID string, channel model.ModelChannel, traceID string, onFailure func(), onSettle func(actualSeconds float64) int, onRecord func(status int, finalCredits int)) {
	refs := make([]service.DoubaoAudioReference, 0, len(req.References))
	for index, item := range req.References {
		if speaker := strings.TrimSpace(item.Speaker); speaker != "" {
			refs = append(refs, service.DoubaoAudioReference{Speaker: speaker})
			continue
		}
		data, err := service.ReadUserMediaBytes(userID, item.StorageKey, item.URL, service.DoubaoAudioMaxRefBytes)
		if err != nil {
			onFailure()
			// 失败也记一条：任务日志里「查得到这次尝试」比「什么都没有」有用得多。
			// 扣费已全额退回，所以实扣记 0。
			onRecord(http.StatusBadGateway, 0)
			log.Printf("audio gen read reference failed: trace=%s index=%d err=%v", traceID, index, err)
			FailError(w, err)
			return
		}
		if strings.EqualFold(strings.TrimSpace(item.Kind), "image") {
			refs = append(refs, service.DoubaoAudioReference{ImageData: data})
			continue
		}
		refs = append(refs, service.DoubaoAudioReference{AudioData: data})
	}

	result, err := service.RunDoubaoAudioGen(service.DoubaoTTSConfigFromChannel(channel), service.DoubaoAudioGenParams{
		Model:        modelName,
		TextPrompt:   req.Input,
		References:   refs,
		Format:       service.DoubaoFormatFromOpenAI(req.ResponseFormat),
		SampleRate:   req.SampleRate,
		SpeechRate:   service.DoubaoSpeechRateFromSpeed(req.Speed),
		LoudnessRate: req.LoudnessRate,
		PitchRate:    req.PitchRate,
	})
	if err != nil {
		onFailure()
		onRecord(http.StatusBadGateway, 0)
		FailError(w, err)
		return
	}
	// 先结算再写响应：客户端中途断开也不影响账已经算对。
	// 任务日志记的是【结算后的真实扣费】，这样「我的消耗」里的点数才与点数日志对得上。
	final := recordUsePrepaidCredits
	if onSettle != nil {
		final = onSettle(result.OriginalDuration)
	}
	onRecord(http.StatusOK, final)
	w.Header().Set("Content-Type", result.MimeType)
	w.Header().Set("X-Request-Id", traceID)
	// 时长走响应头：响应体是音频字节，塞不下 JSON；前端拿它显示时长、对账。
	w.Header().Set("X-Audio-Duration", strconv.FormatFloat(result.Duration, 'f', 3, 64))
	w.Header().Set("X-Audio-Billed-Duration", strconv.FormatFloat(result.OriginalDuration, 'f', 3, 64))
	w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id, X-Audio-Duration, X-Audio-Billed-Duration")
	_, _ = w.Write(result.Audio)
}

// serveVolcAudioSpeech 火山音频渠道(protocol=volc-audio)：把音频请求体翻译成豆包参数调上游，
// 写完整音频字节回客户端；失败时 onFailure 退款 + 报错。
// 按模型名分流：seed-audio 走「音频生成」(支持参考)，其余走原有 TTS，两条路互不影响。
// onSettle 只在音频生成成功后调用，参数是上游返回的计费秒数(original_duration)。
// onSettle 返回结算后的真实扣费点数；onRecord 写任务日志（成功=200，失败=502）。
func serveVolcAudioSpeech(w http.ResponseWriter, body []byte, modelName, userID string, channel model.ModelChannel, traceID string, onFailure func(), onSettle func(actualSeconds float64) int, onRecord func(status int, finalCredits int)) {
	var req audioSpeechRequest
	_ = json.Unmarshal(body, &req)
	if service.IsDoubaoAudioGenModel(modelName) {
		serveDoubaoAudioGen(w, req, modelName, userID, channel, traceID, onFailure, onSettle, onRecord)
		return
	}
	if strings.TrimSpace(req.Input) == "" {
		onFailure()
		onRecord(http.StatusBadRequest, 0)
		Fail(w, "请输入要合成的文本")
		return
	}
	if strings.TrimSpace(req.Voice) == "" {
		onFailure()
		onRecord(http.StatusBadRequest, 0)
		Fail(w, "请选择音色")
		return
	}
	audio, mimeType, err := service.RunDoubaoTTS(service.DoubaoTTSConfigFromChannel(channel), service.DoubaoTTSParams{
		Text:       req.Input,
		Speaker:    req.Voice,
		Format:     service.DoubaoFormatFromOpenAI(req.ResponseFormat),
		SpeechRate: service.DoubaoSpeechRateFromSpeed(req.Speed),
	})
	if err != nil {
		onFailure()
		onRecord(http.StatusBadGateway, 0)
		FailError(w, err)
		return
	}
	// 老的 TTS 是按次一口价、不走结算，实扣就等于预扣额。
	onRecord(http.StatusOK, recordUsePrepaidCredits)
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("X-Request-Id", traceID)
	_, _ = w.Write(audio)
}

// captureBody 非 nil 时(仅用于视频提交/状态轮询等「小 JSON」响应):成功响应体整体读出后交回调处理(抓 task id / 判失败退款),再原样回写,
// 不走流式 io.Copy——故绝不能用于 SSE(/chat/completions 流式)或视频内容字节流(/videos/:id/content),那些场景必须传 nil。
func copyAIResponse(w http.ResponseWriter, request *http.Request, traceID string, onFailure func(), onResponse func(*http.Response), captureBody func([]byte), onComplete func(tail []byte, status int), sniffTail bool) {
	// 用 Transport 级超时的上游客户端（连接/TLS/响应头），不设总超时以兼容流式与长时生成
	response, err := service.UpstreamHTTPClient.Do(request)
	if err != nil {
		log.Printf("AI proxy request failed: trace=%s url=%s err=%v", traceID, request.URL.String(), err)
		if onFailure != nil {
			onFailure()
		}
		Fail(w, "AI 接口请求失败")
		return
	}
	defer response.Body.Close()
	// 捕获上游 LogID 并持久化（写库失败只记 log、不阻断转发）；放在状态分支与流式转发之前，只多读 header。
	if onResponse != nil {
		onResponse(response)
	}

	if response.StatusCode >= http.StatusBadRequest {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		log.Printf("AI upstream error: trace=%s url=%s status=%d", traceID, request.URL.String(), response.StatusCode)
		if onFailure != nil {
			onFailure()
		}
		Fail(w, aiUpstreamStatusMessage(response.StatusCode, body))
		return
	}

	for key, values := range response.Header {
		if blockedUpstreamHeaders[strings.ToLower(key)] {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.Header().Set("X-Request-Id", traceID)
	if captureBody != nil {
		body, err := io.ReadAll(response.Body)
		if err != nil {
			log.Printf("AI proxy read body failed: trace=%s url=%s err=%v", traceID, request.URL.String(), err)
			w.WriteHeader(response.StatusCode)
			return
		}
		captureBody(body)
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(body)
		if onComplete != nil {
			onComplete(body, response.StatusCode)
		}
		return
	}
	w.WriteHeader(response.StatusCode)
	// token 观测：sniffTail（文本 SSE）时旁路嗅探尾部 usage，io.MultiWriter 同步实时转发、不破坏 SSE、不 buffer 整流；
	// 图像/音频 sniffTail=false 纯转发，转发完以 nil tail 触发 onComplete（estimated_quota 取实扣积分）；
	// onComplete==nil（视频内容字节流 / GET 轮询）维持原纯 io.Copy，零额外开销、行为不变。
	dst := io.Writer(w)
	var sniffer *tailSniffer
	if sniffTail {
		sniffer = &tailSniffer{max: 16 << 10}
		dst = io.MultiWriter(w, sniffer)
	}
	if _, err := io.Copy(dst, response.Body); err != nil {
		// 上游已计费但响应传输中断（客户端断开/上游 reset）；先记审计便于排查，是否退款见 todo（需区分客户端主动断开，避免误退）
		log.Printf("AI proxy stream copy interrupted: trace=%s url=%s err=%v", traceID, request.URL.String(), err)
	}
	if onComplete != nil {
		var tail []byte
		if sniffer != nil {
			tail = sniffer.Bytes()
		}
		onComplete(tail, response.StatusCode)
	}
}

func newTraceID() string {
	return uuid.NewString()[:8]
}

// classifyAIKind 按原始代理路径粗分调用类型，供 token 观测日志归类。
func classifyAIKind(path string) string {
	switch {
	case path == "/chat/completions":
		return "text"
	case path == "/videos":
		return "video"
	case strings.HasPrefix(path, "/images"):
		return "image"
	case strings.HasPrefix(path, "/audio"):
		return "audio"
	default:
		return "other"
	}
}

// prepareChatStreamBody 仅针对文本流式请求：注入 stream_options.include_usage=true，让上游在尾 chunk 回传 usage。
// 用 map[string]json.RawMessage 透传其余字段原值（不改数值精度）。非流式 / 解析失败则原样返回、isStream=false。
func prepareChatStreamBody(body []byte) ([]byte, bool) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body, false
	}
	isStream := false
	if raw, ok := m["stream"]; ok {
		_ = json.Unmarshal(raw, &isStream)
	}
	if !isStream {
		return body, false
	}
	opts := map[string]json.RawMessage{}
	if raw, ok := m["stream_options"]; ok {
		_ = json.Unmarshal(raw, &opts)
	}
	opts["include_usage"] = json.RawMessage("true")
	optsBytes, err := json.Marshal(opts)
	if err != nil {
		return body, true
	}
	m["stream_options"] = optsBytes
	out, err := json.Marshal(m)
	if err != nil {
		return body, true
	}
	return out, true
}

// aiUsage 上游返回的 token 用量（OpenAI / 火山豆包 形态）。
type aiUsage struct {
	PromptTokens        int `json:"prompt_tokens"`
	CompletionTokens    int `json:"completion_tokens"`
	TotalTokens         int `json:"total_tokens"`
	PromptTokensDetails struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

// extractUsageFromTail 从响应尾部字节里取最后一个 "usage" 对象并解析。
// 兼容流式尾 chunk（{"choices":[],...,"usage":{...}}）与非流式整体 JSON 末尾的 usage 片段；
// 用括号配平扫描而非整体 Unmarshal，故对被截断的非流式响应尾段同样有效。流式中间 chunk 的 "usage":null 会被最后的真 usage 覆盖。
func extractUsageFromTail(tail []byte) *aiUsage {
	s := string(tail)
	idx := strings.LastIndex(s, "\"usage\"")
	if idx < 0 {
		return nil
	}
	rest := s[idx+len("\"usage\""):]
	open := strings.IndexByte(rest, '{')
	if open < 0 {
		return nil
	}
	depth := 0
	inStr := false
	esc := false
	end := -1
loop:
	for i := open; i < len(rest); i++ {
		c := rest[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				end = i
				break loop
			}
		}
	}
	if end < 0 {
		return nil
	}
	var u aiUsage
	if err := json.Unmarshal([]byte(rest[open:end+1]), &u); err != nil {
		return nil
	}
	return &u
}

// tailSniffer 只保留写入流尾部 max 字节，用于从 SSE 尾 chunk / 大响应末尾嗅探 usage，不破坏实时转发。
type tailSniffer struct {
	max int
	buf []byte
}

func (t *tailSniffer) Write(p []byte) (int, error) {
	if len(p) >= t.max {
		t.buf = append(t.buf[:0], p[len(p)-t.max:]...)
		return len(p), nil
	}
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = append(t.buf[:0], t.buf[len(t.buf)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailSniffer) Bytes() []byte { return t.buf }

// sanitize 系列已下沉到 service 包(service/task_log_sanitize.go),供 handler(视频 proxy)与 service(图片 job)共用,并加了 multipart 解析(图生图 edits 抽出 prompt)。

// extractVideoTaskID 从视频提交响应体取上游任务 id(火山方舟 /contents/generations/tasks 返回 {"id":"cgt-..."});兼容 {"data":{"id":...}}。
func extractVideoTaskID(body []byte) string {
	var p struct {
		ID   string `json:"id"`
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return ""
	}
	if strings.TrimSpace(p.ID) != "" {
		return p.ID
	}
	return strings.TrimSpace(p.Data.ID)
}

// videoTaskFailed 判断视频状态轮询响应体是否为「明确失败态」(保守:只认确定失败,避免对 running/succeeded 误退)。
// 兼容裸响应 {"status":...} 与 envelope {"code":..,"data":{"status":...}};失败态对齐前端 video.ts:
// OpenAI=failed/cancelled,Seedance=failed/cancelled/expired(client 轮询超时是任务仍 running、不在此列,不退)。
func videoTaskFailed(body []byte) bool {
	var p struct {
		Status string `json:"status"`
		Data   struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return false
	}
	status := p.Status
	if status == "" {
		status = p.Data.Status
	}
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "fail", "error", "cancelled", "canceled", "expired":
		return true
	}
	return false
}

// refundVideoIfNeeded 视频任务失败时退款。退款的「标记 + 加回积分 + 记流水」由 service.RefundVideoAtomic
// 在单事务内完成（任一步失败整体回滚、refunded_at 不置位可重试），既保证「反复轮询只退一次」幂等，
// 又消除旧两段式「标记成功但退款失败=永久漏退」的窗口。
func refundVideoIfNeeded(taskID, traceID string) {
	if strings.TrimSpace(taskID) == "" {
		return
	}
	did, err := service.RefundVideoAtomic(taskID, "/videos")
	if err != nil {
		log.Printf("video refund failed: trace=%s task=%s err=%v", traceID, taskID, err)
		return
	}
	if did {
		log.Printf("video task failed, refunded: trace=%s task=%s", traceID, taskID)
	}
}

func readAIRequest(r *http.Request) ([]byte, string, string, error) {
	contentType := r.Header.Get("Content-Type")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, "", "", err
	}
	modelName := ""
	if strings.HasPrefix(contentType, "multipart/form-data") {
		modelName = readMultipartModel(body, contentType)
	} else {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &payload)
		modelName = payload.Model
	}
	if strings.TrimSpace(modelName) == "" {
		return nil, "", "", errMissingModel
	}
	return body, contentType, modelName, nil
}

func readMultipartModel(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	form, err := reader.ReadForm(32 << 20)
	if err != nil {
		return ""
	}
	defer form.RemoveAll()
	if values := form.Value["model"]; len(values) > 0 {
		return values[0]
	}
	return ""
}

// readAIImageBilling 一次解析出图像请求的计费三要素：张数 n、画质档 quality、尺寸 size。
// 三样合并读是有意的——multipart 图生图的表单可能有几十 MB，每多解析一遍就多复制一遍。
// quality/size 交给 service.ImageQualityTierFor 归档，这里只负责原样取出来。
func readAIImageBilling(body []byte, contentType string) (int, string, string) {
	count := 1
	quality := ""
	size := ""
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return count, quality, size
		}
		form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
		if err != nil {
			return count, quality, size
		}
		defer form.RemoveAll()
		if values := form.Value["n"]; len(values) > 0 {
			_, _ = fmt.Sscan(values[0], &count)
		}
		if values := form.Value["quality"]; len(values) > 0 {
			quality = values[0]
		}
		if values := form.Value["size"]; len(values) > 0 {
			size = values[0]
		}
	} else {
		var payload struct {
			N       int    `json:"n"`
			Quality string `json:"quality"`
			Size    string `json:"size"`
		}
		_ = json.Unmarshal(body, &payload)
		count = payload.N
		quality = payload.Quality
		size = payload.Size
	}
	if count < 1 {
		count = 1
	}
	return count, quality, size
}

// readAIVideoBilling 从视频生成请求里读出计费用的秒数、分辨率、以及是否带视频输入(视频生视频)。
// OpenAI 形态是 multipart（seconds / resolution_name 字段），Seedance 形态是 JSON（duration / resolution + content[] 字段）。
// 智能时长（duration=-1）返回 0 秒，由计费函数按上限预扣。
// 带视频输入判据：Seedance JSON 的 content 数组里存在 type="video_url"(role=reference_video)项。multipart 形态暂按不带视频输入计。
//
// 返回的 error 只有【视频编辑】这一条路会非空（见下方 omni_reference_task_type=="edit" 分支）：
// 那条路的计费秒数必须从源视频探出来，探不到就必须拒绝提交，不能凭空按默认秒数收钱。
// 其余所有形态一律返回 nil，行为与本改动前逐字节一致。
func readAIVideoBilling(userID string, body []byte, contentType string) (int, string, bool, error) {
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return 0, "", false, nil
		}
		form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
		if err != nil {
			return 0, "", false, nil
		}
		defer form.RemoveAll()
		seconds := 0
		if values := form.Value["seconds"]; len(values) > 0 {
			_, _ = fmt.Sscan(values[0], &seconds)
		}
		resolution := ""
		if values := form.Value["resolution_name"]; len(values) > 0 {
			resolution = values[0]
		}
		if resolution == "" {
			if values := form.Value["size"]; len(values) > 0 {
				resolution = values[0]
			}
		}
		// 「带视频输入」判据：multipart 这条路原先恒返回 false，
		// 于是视频生视频这条最贵的路永远按【不带输入】单价扣 —— 前端预估价却按带输入档显示，
		// 界面写 400 实扣 200，双价功能里唯一动扣费的那一档形同虚设。
		// 参考视频在这条路上以独立字段名传 URL，与后端按字段名判 Media.Type 同源；参考【音频】不算。
		hasVideoInput := false
		for _, value := range form.Value["input_reference_video_url[]"] {
			if strings.TrimSpace(value) != "" {
				hasVideoInput = true
				break
			}
		}
		return seconds, resolution, hasVideoInput, nil
	}
	var payload struct {
		Duration   int             `json:"duration"`
		Seconds    json.RawMessage `json:"seconds"`
		Resolution string          `json:"resolution"`
		Size       string          `json:"size"`
		// OmniTaskType 是 Seedance 的【顶层】字段 omni_reference_task_type，与 ratio/duration 平级
		// （不在 content[] 里，别去那儿找）。取值 auto / reference / edit / extend。
		OmniTaskType string `json:"omni_reference_task_type"`
		Content      []struct {
			Type string `json:"type"`
			// Role 官方按 content 项的 role 区分素材语义：reference_video / first_frame / last_frame / …
			Role     string `json:"role"`
			VideoURL struct {
				URL string `json:"url"`
			} `json:"video_url"`
		} `json:"content"`
	}
	_ = json.Unmarshal(body, &payload)
	seconds := payload.Duration
	if seconds == 0 && len(payload.Seconds) > 0 {
		raw := strings.Trim(strings.TrimSpace(string(payload.Seconds)), `"`)
		_, _ = fmt.Sscan(raw, &seconds)
	}
	if seconds < 0 {
		seconds = 0
	}
	resolution := payload.Resolution
	if resolution == "" {
		resolution = payload.Size
	}
	hasVideoInput := false
	for _, c := range payload.Content {
		if c.Type == "video_url" {
			hasVideoInput = true
			break
		}
	}
	// 🔴 视频编辑(omni_reference_task_type=="edit")的计费秒数单独算。
	//
	// 为什么必须单独算：上游【硬性要求】视频编辑的 duration 传 -1（不传就前置校验报错），
	// 而上面那段逻辑对负数一律钳成 0 秒 → service 的按秒计费里
	// `if seconds <= 0 { seconds = VideoBillingSmartDurationSeconds }` → 恒按 15 秒收钱。
	// 出片时长却是跟着源视频走的（4~30 秒），于是出 4 秒的片多收 11 秒、出 30 秒的片少收 15 秒。
	//
	// 为什么不需要「先预扣、出片后结算」：文档明确「自动保持输出视频宽高比、时长和待编辑视频一致」，
	// 实测也确认了（源片 4.06 秒 → 出片 4.06 秒），也就是 **源视频时长 = 输出时长 = 应扣秒数**，
	// 而且这个数在提交前就能确定 —— 探一次就够了，没有预扣/补扣/退差额那套东西，也就没有透支敞口。
	//
	// ⚠️ 视频延长(extend)传的是【真实秒数】(实测传 6、源片 4.06 秒 → 出片 6.00 秒，duration = 输出总长)，
	//    走上面的原路即可，别顺手给它加特殊处理 —— 多一条分支就多一处可能算错钱的地方。
	if strings.EqualFold(strings.TrimSpace(payload.OmniTaskType), videoOmniTaskEdit) {
		source := ""
		// role=="reference_video" 才是「待编辑的那段视频」。优先按 role 取，取不到再退回第一个
		// video_url —— 老客户端可能不带 role，那时候整个请求里本来也只有一段视频。
		for _, c := range payload.Content {
			if c.Role == "reference_video" && strings.TrimSpace(c.VideoURL.URL) != "" {
				source = c.VideoURL.URL
				break
			}
		}
		if source == "" {
			for _, c := range payload.Content {
				if c.Type == "video_url" && strings.TrimSpace(c.VideoURL.URL) != "" {
					source = c.VideoURL.URL
					break
				}
			}
		}
		editSeconds, err := videoEditBillingSeconds(userID, source)
		if err != nil {
			return 0, resolution, hasVideoInput, err
		}
		return editSeconds, resolution, hasVideoInput, nil
	}
	return seconds, resolution, hasVideoInput, nil
}

// videoOmniTaskEdit 「视频编辑」子任务。Seedance 顶层字段 omni_reference_task_type 的四个取值
// (auto / reference / edit / extend) 里，只有它需要我们插手计费：它是唯一强制 duration=-1 的那个，
// extend 传真实秒数、reference 与 auto 无特殊限制，都走原来的按秒计费。
const videoOmniTaskEdit = "edit"

// 待编辑视频的时长硬约束（文档原文：参考视频时长必须 4~30 秒）。
const (
	videoEditMinSourceSeconds = 4.0
	videoEditMaxSourceSeconds = 30.0
	// videoEditDurationTolerance ffprobe 读出来的时长是按容器时间基算的浮点数，
	// 一段标称 30 秒的片子常读成 30.016（最后一帧的显示时长也算进去了）。
	// 严格比大小会把明明合法的素材挡在门外，所以两端各放 0.05 秒；
	// 容差内的溢出按边界值 30 秒计费，不会因为那 0.016 秒多收用户 1 秒的钱。
	videoEditDurationTolerance = 0.05
)

// probeVideoForBilling 计费用的视频探测。抽成变量【只】为了单测能替换掉它 ——
// 真实实现要起 ffprobe 子进程去拉远端文件头，单测里不该做这种事。
var probeVideoForBilling = service.ProbeVideo

// videoEditBillingSeconds 探出「待编辑视频」的真实时长，作为视频编辑任务的计费秒数。
//
// 🔴 三条自我约束（都是动钱的红线）：
//  1. 探不到时长 → 报错拒绝提交，**绝不回落到 service.VideoBillingSmartDurationSeconds(15 秒)**。
//     回落就是凭空收钱：我们并不知道这条片子多长，15 秒是个编出来的数。
//  2. 源视频时长不在 4~30 秒 → 前置报错并把实际时长告诉用户。上游本来也会拒，
//     但那是一次【异步】失败（提交先成功、钱先扣、几十秒后才失败再退款），用户体验差得多。
//  3. 向上取整、不足 1 秒按 1 秒。
//
// 耗时：ProbeVideo 走 ffprobe 只读文件头、不拉整片，且带 90 秒超时（service/media_probe.go）。
// 它发生在扣费与提交【之前】，会给提交多加一次网络往返 —— 但视频生成本来就是个异步长任务
// （提交要等上游受理、出片要几十秒到几分钟），多读一次文件头在这条链路上可以忽略。
func videoEditBillingSeconds(userID string, sourceURL string) (int, error) {
	url := strings.TrimSpace(sourceURL)
	if url == "" {
		return 0, &aiError{"视频编辑需要接入一段待编辑的参考视频，请先连接视频素材后重试。本次未扣除点数。"}
	}
	// 做过「素材授权」的视频，前端会把地址换成火山方舟专有的 asset://，ffprobe 不认这个协议。
	// 认证时登记的公网地址就记在 portrait_assets.SourceURL 里，翻回来再探 ——
	// 否则就是「认证过的视频不能做编辑」，白白砍掉一个功能。翻不出来时保持原样，
	// 让下面的探测如实失败（而不是在这里替用户判死）。
	if resolved := service.ResolveVolcAssetSourceURL(userID, url); resolved != "" {
		url = resolved
	}
	probe, err := probeVideoForBilling(url)
	if err != nil {
		// 刻意不把 err 原文拼进去：ffprobe 的 stderr 里带完整 URL（含我们的桶域名）。
		log.Printf("video edit probe failed: user=%s err=%v", userID, err)
		return 0, &aiError{"无法读取待编辑视频的时长，请确认该视频可正常访问（公网可播放的 mp4/mov）后重试。本次未扣除点数。"}
	}
	if probe.DurationMs <= 0 {
		// 探到了流但容器里没写 duration（部分流式 mp4）。同样不猜：不知道多长就不能收钱。
		log.Printf("video edit probe got no duration: user=%s codec=%s", userID, probe.VideoCodec)
		return 0, &aiError{"无法读取待编辑视频的时长，请确认该视频可正常访问（公网可播放的 mp4/mov）后重试。本次未扣除点数。"}
	}
	seconds := float64(probe.DurationMs) / 1000
	if seconds < videoEditMinSourceSeconds-videoEditDurationTolerance || seconds > videoEditMaxSourceSeconds+videoEditDurationTolerance {
		return 0, &aiError{fmt.Sprintf("待编辑视频时长为 %.1f 秒，超出「视频编辑」支持的 4~30 秒范围，请换一段 4~30 秒的视频后重试。本次未扣除点数。", seconds)}
	}
	billed := int(math.Ceil(seconds))
	if billed < 1 {
		billed = 1 // 兜底：上面的区间校验已经保证进不来，留着是怕将来区间被放宽
	}
	if billed > int(videoEditMaxSourceSeconds) {
		// 容差放进来的那一点点溢出（如 30.016→31）按 30 秒收，不多收那 1 秒
		billed = int(videoEditMaxSourceSeconds)
	}
	return billed, nil
}

var errMissingModel = &aiError{"缺少模型名称"}

func resolveAIProxyPath(baseURL string, modelName string, path string) string {
	if !isArkSeedanceVideo(baseURL, modelName) {
		return path
	}
	if path == "/videos" {
		return "/contents/generations/tasks"
	}
	if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
		return "/contents/generations/tasks/" + strings.TrimPrefix(path, "/videos/")
	}
	return path
}

func isArkSeedanceVideo(baseURL string, modelName string) bool {
	base := strings.ToLower(baseURL)
	model := strings.ToLower(modelName)
	return strings.Contains(model, "seedance") || strings.Contains(model, "doubao-seedance") || strings.Contains(base, "/api/plan/v3")
}

func aiStatusMessage(statusCode int) string {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "AI 接口鉴权失败，请检查 API Key、套餐权限或模型权限"
	case http.StatusTooManyRequests:
		return "AI 接口限流或额度不足，请稍后重试或检查额度"
	default:
		return "AI 接口请求失败"
	}
}

func aiUpstreamStatusMessage(statusCode int, body []byte) string {
	base := aiStatusMessage(statusCode)
	detail := aiUpstreamErrorDetail(body)
	if detail == "" {
		return base
	}
	return base + "：" + detail
}

func aiUpstreamErrorDetail(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	var payload struct {
		Msg     string `json:"msg"`
		Message string `json:"message"`
		Error   struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		if payload.Error.Message != "" {
			if detail := friendlyUpstreamError(payload.Error.Code, payload.Error.Message); detail != "" {
				return safeUpstreamText(detail)
			}
			if payload.Error.Code != "" {
				return safeUpstreamText(payload.Error.Code + " " + payload.Error.Message)
			}
			return safeUpstreamText(payload.Error.Message)
		}
		if payload.Msg != "" {
			return safeUpstreamText(payload.Msg)
		}
		if payload.Message != "" {
			return safeUpstreamText(payload.Message)
		}
	}
	return safeUpstreamText(text)
}

// volcContentSlotRe 匹配火山报错里定位到具体素材的 'content[N]'。
var volcContentSlotRe = regexp.MustCompile(`content\[(\d+)\]`)

// volcContentSlot 取出被拒素材在 content 数组中的下标。
// content[0] 是提示词文本，其后依次是参考素材，因此下标 N 恰好等于「第 N 个参考素材」。
// 取不到时返回 0（调用方据此不附加位置信息）。
func volcContentSlot(message string) int {
	match := volcContentSlotRe.FindStringSubmatch(message)
	if len(match) != 2 {
		return 0
	}
	slot, err := strconv.Atoi(match[1])
	if err != nil || slot <= 0 {
		return 0
	}
	return slot
}

func friendlyUpstreamError(code string, message string) string {
	lowerCode := strings.ToLower(strings.TrimSpace(code))
	lowerMessage := strings.ToLower(message)
	if strings.Contains(lowerCode, "inputvideosensitivecontentdetected") || strings.Contains(lowerCode, "privacyinformation") {
		// 火山原文形如：The request failed because the input video 'content[7]' may contain real person.
		// 必须据此区分被拒的到底是参考图还是参考视频/音频——三者的处理动作不同。
		// 早期统一提示「请对该人设图开启肖像授权」把用户带进过死胡同：他反复认证图片（其实早已全部通过），
		// 而真正被拒的是那段参考视频，于是「一直跳要人脸验证」。
		subject, spec := "参考素材", ""
		switch {
		case strings.Contains(lowerMessage, "input video"):
			subject = "参考视频"
			spec = "（视频需 mp4/mov、时长 2~15 秒、帧率 24~60fps、总像素 ≤208.7 万、体积 ≤200MB）"
		case strings.Contains(lowerMessage, "input audio"):
			subject = "参考音频"
			spec = "（音频需 wav/mp3、时长 2~15 秒、体积 ≤15MB）"
		case strings.Contains(lowerMessage, "input image"):
			subject = "参考图"
		}
		if slot := volcContentSlot(message); slot > 0 {
			subject += "（第 " + strconv.Itoa(slot) + " 个参考素材）"
		}
		return strings.TrimSpace(code + " " + subject + "疑似包含真人或隐私信息，火山方舟拒绝以普通 URL 作为真人参考；请对该" + subject +
			"开启「素材授权」" + spec + "，入库通过后会自动以 asset:// 引用，或改用不含真人的素材。原始错误：" + message)
	}
	// 显式指定了 omni_reference_task_type（edit / extend）但提示词表达的意图对不上。
	//
	// 文档原文：指定 edit/extend 后接口会先做前置校验，但「实际处理任务时，模型仍会进一步结合提示词
	// 判断任务类型。若实际判定的任务类型和指定的不一致，仍会触发异步报错」—— 关键在【异步】：
	// 提交是成功的、钱是扣了的，几十秒后才失败（失败会走 video_refunds 退回）。用户这边看到的
	// 只有一句英文 InvalidParameter.TaskTypeMismatch，完全不知道该改什么。
	// 所以这里必须把「该往提示词里写什么词」直接给出来。
	if strings.Contains(lowerCode, "tasktypemismatch") || strings.Contains(lowerMessage, "task type mismatch") {
		return "提示词描述的意图与所选的生成模式不符。「视频编辑」请在提示词里写明要做的编辑动作" +
			"（编辑视频 / 增加、加上 / 删除、去掉 / 修改、替换、改成）；" +
			"「视频延长」请写明延长意图（向前延长、向后延长 / 延续 / 续写）；" +
			"如果你本来就不想改动原视频，把模式改成「参考生视频」即可。原始错误：" + message
	}
	// 视频延长/编辑任务：输出画幅必须跟随原视频，ratio 只能是 adaptive。
	// 「是不是延长」是模型【读提示词】判出来的（如「将原视频当中的X替换成Y」「接着往下拍」），
	// 用户在界面上选的 16:9 就成了非法值，而上游原文是英文还带一长串 Request id，看不出该改哪。
	// ⚠️ 两条路产出完全不同，必须让用户自己选，不能替他改成 adaptive 了事。
	if strings.Contains(lowerMessage, "must be `adaptive`") || (strings.Contains(lowerMessage, "video extension") && strings.Contains(lowerMessage, "ratio")) {
		return "Seedance 判定这次是「在原视频上做编辑/延长」的任务（提示词里要求在原视频当中替换人物、或接着往下拍等）。" +
			"这类任务的输出画幅必须跟随原视频，不能自己指定，所以你选的比例被拒了——" +
			"把「比例」改成「自适应」再试即可，画面会按原视频的画幅出。" +
			"（如果你并不想改原视频、只是想把它当风格参考另起一段，那就改写提示词，别出现「在原视频当中…替换/接着/继续」这类要求。）" +
			"原始错误：" + message
	}
	if strings.Contains(lowerCode, "inputtextsensitivecontentdetected") || strings.Contains(lowerMessage, "input text may contain sensitive") {
		return "提示词被模型平台内容安全审核拦截（判定可能含敏感/违规信息）。请修改提示词：避开暴力、血腥、政治、色情、违禁等敏感措辞，改用更中性的描述后重试。原始错误：" + message
	}
	// 输出视频内容审核（生成结果本身被判敏感，非输入素材）——须在通用 sensitivecontentdetected 之前命中，否则会被误判为「输入内容被拦截」误导用户去改提示词。
	if strings.Contains(lowerCode, "outputvideosensitivecontentdetected") || strings.Contains(lowerMessage, "output video may contain sensitive") {
		return "生成出的视频被模型平台内容安全审核判定为敏感/违规（针对生成结果本身，非提示词），本次积分已退回。可调整提示词（避开暴力、血腥、政治、色情、违禁）或更换参考素材后重试，也可改用更宽松的模型。原始错误：" + message
	}
	// 输出音频内容审核（生成结果的音频轨被判敏感，如带音频的视频 / TTS 配音）——须在通用 sensitivecontentdetected 之前命中。
	if strings.Contains(lowerCode, "outputaudiosensitivecontentdetected") || strings.Contains(lowerMessage, "output audio may contain sensitive") {
		return "生成出的音频被模型平台内容安全审核判定为敏感/违规（针对生成结果本身，非提示词）。可调整提示词/文本或关闭「生成音频」后重试；带音频的视频失败会自动退回积分（音频配音本身不扣积分）。原始错误：" + message
	}
	if strings.Contains(lowerCode, "sensitivecontentdetected") {
		return "输入内容（提示词或参考图）被模型平台内容安全审核拦截（判定可能含敏感信息）。请调整提示词或更换参考图后重试。原始错误：" + message
	}
	if strings.Contains(lowerMessage, "copyright") || strings.Contains(lowerCode, "copyright") {
		return "生成内容被判定可能涉及版权（如知名角色/影视/品牌元素），已被模型平台拦截。建议：把提示词中的 IP 名称改为通用描述、更换含版权形象的参考图，或直接重试。原始错误：" + message
	}
	if strings.Contains(lowerMessage, "timeout while fetching") {
		return "模型平台抓取参考素材超时（通常是图片过大或服务器公网带宽不足）。建议压缩参考图或升级服务器带宽后重试。原始错误：" + message
	}
	// 通用内容审核兜底：覆盖 OpenAI（content_policy_violation / safety system）及其它上游的内容拒绝关键词，
	// 让各家模型的「提示词违规」都给一致的清晰提示。超时/网络错误不经此函数，不会被误判为违规。
	combined := lowerCode + " " + lowerMessage
	for _, kw := range []string{"content_policy", "content policy", "policy_violation", "policy violation", "safety system", "safety_violation", "safety policies", "moderation", "prohibited content", "prohibited_content", "sensitive content", "sensitive information", "inappropriate content", "nsfw", "内容安全", "违规", "敏感内容"} {
		if strings.Contains(combined, kw) {
			return "提示词或参考图可能含违规/敏感内容，被模型平台内容安全审核拦截。请修改提示词（避开色情、暴力、血腥、政治、违禁等措辞）或更换参考图后重试；也可改用 doubao-seedream 等更宽松的模型。原始错误：" + message
		}
	}
	return ""
}

func safeUpstreamText(text string) string {
	// 上游响应体原文会显示到画布节点上，先抹掉其中的 URL/主机名再截断：
	// 上游若回的是 nginx 错误页或带链接的 JSON，会连带暴露本平台对接的是哪一家。
	// 只去链接、不动业务说明——「内容审核不通过」这类正是用户需要看到的。
	text = service.ScrubForUser(text)
	text = strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	runes := []rune(text)
	if len(runes) > 300 {
		return string(runes[:300]) + "..."
	}
	return text
}

type aiError struct {
	message string
}

func (err *aiError) Error() string {
	return err.message
}

// parseCanvasNodeHeader 解析 X-Canvas-Node 头：{"id":"video-...","x":1,"y":2,"w":640,"h":360}
//
// 解析失败一律返回空，绝不因为这个可选的上下文而影响生成本身 ——
// 它只是让救援能放得更准，拿不到就退回原来的「我的素材」路径。
func parseCanvasNodeHeader(raw string) (nodeID string, geom string) {
	if strings.TrimSpace(raw) == "" {
		return "", ""
	}
	var ctx struct {
		ID string  `json:"id"`
		X  float64 `json:"x"`
		Y  float64 `json:"y"`
		W  float64 `json:"w"`
		H  float64 `json:"h"`
	}
	if json.Unmarshal([]byte(raw), &ctx) != nil || strings.TrimSpace(ctx.ID) == "" {
		return "", ""
	}
	encoded, err := json.Marshal(map[string]float64{"x": ctx.X, "y": ctx.Y, "w": ctx.W, "h": ctx.H})
	if err != nil {
		return ctx.ID, ""
	}
	return ctx.ID, string(encoded)
}
