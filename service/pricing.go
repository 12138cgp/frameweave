package service

import (
	"encoding/json"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
)

// pricingOwnerID 计费归属的二级管理员：admin_l2 用户=自己；普通用户=其创建者（二级管理员）。空=无归属（用全局默认价）。
func pricingOwnerID(user model.User) string {
	if user.Role == model.UserRoleAdminL2 {
		return user.ID
	}
	return strings.TrimSpace(user.CreatorID)
}

// priceOverrideForUser 返回该用户所属二级管理员的价格覆盖：
// 图片 map[模型]整条按次配置（含画质档价）、视频 map[模型]分辨率档位。
// map 里有该模型键 = 被覆盖（即使是 0）；无键 = 用全局默认。
//
// 图片这边刻意存整条 ModelCost 而不是单个积分：覆盖价也要能按 1K/2K/4K 分档，
// 只回一个 int 的话，二级管理员的覆盖会把分档价悄悄拍平成一口价。
func priceOverrideForUser(user model.User) (map[string]model.ModelCost, map[string][]model.VideoResolutionRate, map[string]model.AudioModelCost) {
	img := map[string]model.ModelCost{}
	vid := map[string][]model.VideoResolutionRate{}
	aud := map[string]model.AudioModelCost{}
	owner := pricingOwnerID(user)
	if owner == "" {
		return img, vid, aud
	}
	ov := user
	if owner != user.ID {
		o, ok, err := repository.GetUserByID(owner)
		if err != nil || !ok {
			return img, vid, aud
		}
		ov = o
	}
	raw := strings.TrimSpace(ov.PriceOverride)
	if raw == "" {
		return img, vid, aud
	}
	var p model.PriceOverridePayload
	if json.Unmarshal([]byte(raw), &p) != nil {
		return img, vid, aud
	}
	for _, c := range p.ModelCosts {
		name := strings.TrimSpace(c.Model)
		c.Model = name
		c.QualityRates = NormalizeImageQualityRates(c.QualityRates)
		img[name] = c
	}
	for _, v := range p.VideoModelCosts {
		vid[strings.TrimSpace(v.Model)] = v.Rates
	}
	for _, a := range p.AudioModelCosts {
		name := strings.TrimSpace(a.Model)
		a.Model = name
		aud[name] = a
	}
	return img, vid, aud
}

// ModelCostForUser 音频等按次计费（不分档）：先看该用户所属二级管理员的覆盖价，未覆盖回退全局默认。
func ModelCostForUser(userID, modelName string) (int, error) {
	return ImageModelCostForUser(userID, modelName, "")
}

// ImageModelCostForUser 图片按「画质档」计费：覆盖价优先，未覆盖回退全局默认；
// 两边都是「该档配了价用档价、没配用一口价」。tier 传空 = 不分档（音频等按次模型走这条）。
func ImageModelCostForUser(userID, modelName, tier string) (int, error) {
	modelName = strings.TrimSpace(modelName)
	if user, ok, err := repository.GetUserByID(userID); err == nil && ok {
		img, _, _ := priceOverrideForUser(user)
		if cost, ok := img[modelName]; ok {
			return PickImageQualityCredits(cost, tier), nil
		}
	}
	return ImageModelCost(modelName, tier)
}

// VideoModelCreditsForUser 视频按「秒数 × 分辨率每秒点数」计费：先看覆盖，未覆盖回退全局默认。
// hasVideoInput=true(视频生视频)时用「带视频输入」档单价。
func VideoModelCreditsForUser(userID, modelName string, seconds int, resolution string, hasVideoInput bool) (int, bool, error) {
	modelName = strings.TrimSpace(modelName)
	if user, ok, err := repository.GetUserByID(userID); err == nil && ok {
		_, vid, _ := priceOverrideForUser(user)
		if rates, ok := vid[modelName]; ok {
			rate, hit := pickVideoResolutionRate(rates, NormalizeVideoBillingResolution(resolution))
			if !hit {
				return 0, false, nil
			}
			if seconds <= 0 {
				seconds = VideoBillingSmartDurationSeconds
			}
			return videoRatePerSecond(rate, hasVideoInput) * seconds, true, nil
		}
	}
	return VideoModelCredits(modelName, seconds, resolution, hasVideoInput)
}

// AudioModelCreditsForUser 音频按「秒数 × 每秒点数」计费：先看覆盖，未覆盖回退全局默认。
// seconds 在预扣时传「目标时长」、结算时传上游返回的真实秒数，见 model.AudioModelCost 的说明。
func AudioModelCreditsForUser(userID, modelName string, seconds int) (int, bool, error) {
	modelName = strings.TrimSpace(modelName)
	if user, ok, err := repository.GetUserByID(userID); err == nil && ok {
		_, _, aud := priceOverrideForUser(user)
		if cost, ok := aud[modelName]; ok {
			if cost.CreditsPerSecond <= 0 {
				return 0, false, nil
			}
			return cost.CreditsPerSecond * NormalizeAudioBillingSeconds(seconds), true, nil
		}
	}
	return AudioModelCredits(modelName, seconds)
}

// AudioCharCreditsForUser 音频按字数计费：先看该用户所属二级管理员的覆盖价，未覆盖回退全局默认。
func AudioCharCreditsForUser(userID, modelName string, chars int) (int, bool, error) {
	modelName = strings.TrimSpace(modelName)
	if user, ok, err := repository.GetUserByID(userID); err == nil && ok {
		_, _, aud := priceOverrideForUser(user)
		if cost, ok := aud[modelName]; ok {
			if cost.CreditsPer100Chars <= 0 {
				return 0, false, nil
			}
			return cost.CreditsPer100Chars * AudioCharUnits(chars), true, nil
		}
	}
	return AudioCharCredits(modelName, chars)
}

// effectiveAudioModelCosts 同上，音频版：把覆盖价合并进默认表，供前端显示与后端扣费口径一致。
func effectiveAudioModelCosts(user model.User, defaults []model.AudioModelCost) []model.AudioModelCost {
	_, _, aud := priceOverrideForUser(user)
	if len(aud) == 0 {
		return defaults
	}
	out := make([]model.AudioModelCost, 0, len(defaults)+len(aud))
	replaced := map[string]bool{}
	for _, c := range defaults {
		name := strings.TrimSpace(c.Model)
		if cost, ok := aud[name]; ok {
			c.CreditsPerSecond = cost.CreditsPerSecond
			c.CreditsPer100Chars = cost.CreditsPer100Chars
			replaced[name] = true
		}
		out = append(out, c)
	}
	for name, cost := range aud {
		if !replaced[name] {
			out = append(out, model.AudioModelCost{Model: name, CreditsPerSecond: cost.CreditsPerSecond, CreditsPer100Chars: cost.CreditsPer100Chars})
		}
	}
	return out
}

// effectiveModelCosts 把某用户所属二级管理员的图片覆盖价合并进默认表（覆盖里的模型替换/追加），供前端显示与后端口径一致。
func effectiveModelCosts(user model.User, defaults []model.ModelCost) []model.ModelCost {
	img, _, _ := priceOverrideForUser(user)
	if len(img) == 0 {
		return defaults
	}
	out := make([]model.ModelCost, 0, len(defaults)+len(img))
	replaced := map[string]bool{}
	for _, c := range defaults {
		name := strings.TrimSpace(c.Model)
		if override, ok := img[name]; ok {
			// 价格整体换成覆盖价（含画质档价）；Label 是展示代称、不属于价格，保留默认表里的。
			c.Credits = override.Credits
			c.QualityRates = override.QualityRates
			replaced[name] = true
		}
		out = append(out, c)
	}
	for name, override := range img {
		if !replaced[name] {
			out = append(out, model.ModelCost{Model: name, Credits: override.Credits, QualityRates: override.QualityRates})
		}
	}
	return out
}

// effectiveVideoModelCosts 同上，视频版。
func effectiveVideoModelCosts(user model.User, defaults []model.VideoModelCost) []model.VideoModelCost {
	_, vid, _ := priceOverrideForUser(user)
	if len(vid) == 0 {
		return defaults
	}
	out := make([]model.VideoModelCost, 0, len(defaults)+len(vid))
	replaced := map[string]bool{}
	for _, c := range defaults {
		name := strings.TrimSpace(c.Model)
		if rates, ok := vid[name]; ok {
			c.Rates = rates
			replaced[name] = true
		}
		out = append(out, c)
	}
	for name, rates := range vid {
		if !replaced[name] {
			out = append(out, model.VideoModelCost{Model: name, Rates: rates})
		}
	}
	return out
}
