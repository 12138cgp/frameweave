package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
)

// AdminGetManagerPrices GET /api/admin/managers/:id/prices（超管专用）：取某二级管理员的价格覆盖。
// 返回 {modelCosts, videoModelCosts}；未设置返回空列表（前端从全局默认带入起点）。
func AdminGetManagerPrices(w http.ResponseWriter, r *http.Request, id string) {
	id = strings.TrimSpace(id)
	if id == "" {
		Fail(w, "缺少管理员 ID")
		return
	}
	user, ok, err := repository.GetUserByID(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "用户不存在")
		return
	}
	payload := model.PriceOverridePayload{ModelCosts: []model.ModelCost{}, VideoModelCosts: []model.VideoModelCost{}}
	if raw := strings.TrimSpace(user.PriceOverride); raw != "" {
		_ = json.Unmarshal([]byte(raw), &payload)
	}
	if payload.ModelCosts == nil {
		payload.ModelCosts = []model.ModelCost{}
	}
	if payload.VideoModelCosts == nil {
		payload.VideoModelCosts = []model.VideoModelCost{}
	}
	if payload.AudioModelCosts == nil {
		payload.AudioModelCosts = []model.AudioModelCost{}
	}
	OK(w, payload)
}

// AdminSetManagerPrices POST /api/admin/managers/:id/prices（超管专用）：设置某二级管理员的价格覆盖（按模型）。
// 只覆盖 body 里列出的模型；空列表=清空覆盖（该管理员团队全部回退全局默认价）。
func AdminSetManagerPrices(w http.ResponseWriter, r *http.Request, id string) {
	id = strings.TrimSpace(id)
	if id == "" {
		Fail(w, "缺少管理员 ID")
		return
	}
	var payload model.PriceOverridePayload
	if !decodeJSON(w, r, &payload) {
		return
	}
	user, ok, err := repository.GetUserByID(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "用户不存在")
		return
	}
	if user.Role != model.UserRoleAdminL2 {
		Fail(w, "只能给二级管理员设置价格")
		return
	}
	// 清洗：去空模型名、负数归零。
	cleanModel := make([]model.ModelCost, 0, len(payload.ModelCosts))
	for _, c := range payload.ModelCosts {
		name := strings.TrimSpace(c.Model)
		if name == "" {
			continue
		}
		if c.Credits < 0 {
			c.Credits = 0
		}
		c.Model = name
		// 画质档价与全局默认价用同一套清洗（档名归一、非法档丢弃、0 价档丢弃）。
		c.QualityRates = service.NormalizeImageQualityRates(c.QualityRates)
		cleanModel = append(cleanModel, c)
	}
	cleanVideo := make([]model.VideoModelCost, 0, len(payload.VideoModelCosts))
	for _, v := range payload.VideoModelCosts {
		name := strings.TrimSpace(v.Model)
		if name == "" {
			continue
		}
		rates := make([]model.VideoResolutionRate, 0, len(v.Rates))
		for _, rt := range v.Rates {
			if strings.TrimSpace(rt.Resolution) == "" {
				continue
			}
			if rt.CreditsPerSecond < 0 {
				rt.CreditsPerSecond = 0
			}
			// 带视频输入价（视频生视频）整条带过去。这个字段在前端「分级定价」页的覆盖模式里
			// 曾经读不到也存不下，导致给二级管理员配的覆盖价一律按「无输入价」收——后端这里不能再漏一次。
			if rt.CreditsPerSecondWithVideo < 0 {
				rt.CreditsPerSecondWithVideo = 0
			}
			rates = append(rates, rt)
		}
		if len(rates) == 0 {
			continue // 无有效档位=不覆盖该视频模型
		}
		cleanVideo = append(cleanVideo, model.VideoModelCost{Model: name, Rates: rates, Label: v.Label})
	}

	// 音频按秒价覆盖。这里【保留 0 值】：0 对音频是有意义的一档语义——「该团队这个模型不按秒计费，
	// 回退按次一口价」，与视频「无有效档位=不覆盖」不同，所以不能照抄上面那条 continue。
	cleanAudio := make([]model.AudioModelCost, 0, len(payload.AudioModelCosts))
	for _, a := range payload.AudioModelCosts {
		name := strings.TrimSpace(a.Model)
		if name == "" {
			continue
		}
		if a.CreditsPerSecond < 0 {
			a.CreditsPerSecond = 0
		}
		if a.CreditsPer100Chars < 0 {
			a.CreditsPer100Chars = 0
		}
		cleanAudio = append(cleanAudio, model.AudioModelCost{Model: name, CreditsPer100Chars: a.CreditsPer100Chars, CreditsPerSecond: a.CreditsPerSecond, Label: strings.TrimSpace(a.Label)})
	}

	if len(cleanModel) == 0 && len(cleanVideo) == 0 && len(cleanAudio) == 0 {
		user.PriceOverride = "" // 清空=全部回退默认
	} else {
		encoded, mErr := json.Marshal(model.PriceOverridePayload{ModelCosts: cleanModel, VideoModelCosts: cleanVideo, AudioModelCosts: cleanAudio})
		if mErr != nil {
			FailError(w, mErr)
			return
		}
		user.PriceOverride = string(encoded)
	}
	// 先取完整 user 再只改 PriceOverride，其余字段原样写回。
	// 用 UpdateUserKeepingLive 而不是 SaveUser：整行写回会用事务外读到的旧快照覆盖
	// credits/session_id/last_login_at —— 那几列各有专用原子端点，被覆盖就是丢钱/踢下线
	//（见 repository/user.go userKeepLiveColumns 的说明）。
	if _, err := repository.UpdateUserKeepingLive(user); err != nil {
		FailError(w, err)
		return
	}
	OK(w, model.PriceOverridePayload{ModelCosts: cleanModel, VideoModelCosts: cleanVideo, AudioModelCosts: cleanAudio})
}
