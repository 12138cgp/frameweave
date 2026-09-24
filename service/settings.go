package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
)

var adminModelHTTPClient = &http.Client{Timeout: 30 * time.Second}

func PublicSettings() (model.PublicSetting, error) {
	settings, err := repository.GetSettings()
	return normalizeSettings(settings).Public, err
}

func AdminSettings() (model.Settings, error) {
	settings, err := repository.GetSettings()
	return hidePrivateAPIKeys(normalizeSettings(settings)), err
}

func SaveSettings(settings model.Settings) (model.Settings, error) {
	saved, err := repository.GetSettings()
	if err != nil {
		return model.Settings{}, err
	}
	settings = normalizeSettings(settings)
	keepPrivateAPIKeys(&settings, normalizeSettings(saved))
	keepPrivateAuthSecrets(&settings, normalizeSettings(saved))
	// 短信服务启用时校验：SecretKey 在表单回显时被清空，如果保存后仍为空说明首次未填写，直接报错让管理员补填
	if settings.Private.Sms.Enabled != nil && *settings.Private.Sms.Enabled && strings.TrimSpace(settings.Private.Sms.SecretKey) == "" {
		return model.Settings{}, safeMessageError{message: "已启用短信服务但 SecretKey 为空，请在「火山引擎短信服务」的 SecretKey 密码框中填写后保存"}
	}
	stampAnnouncementID(&settings.Public.Announcement, normalizeSettings(saved).Public.Announcement)
	result, err := repository.SaveSettings(settings, now())
	if err == nil {
		RefreshPromptSyncScheduler()
	}
	return hidePrivateAPIKeys(result), err
}

func AdminChannelModels(index *int, channel model.ModelChannel) ([]string, error) {
	resolved, err := resolveAdminChannel(index, channel)
	if err != nil {
		return nil, err
	}
	return fetchAdminChannelModels(resolved)
}

func AdminTestChannelModel(index *int, channel model.ModelChannel, modelName string) (string, error) {
	resolved, err := resolveAdminChannel(index, channel)
	if err != nil {
		return "", err
	}
	if isArkAgentPlanChannel(resolved) || isSeedanceModelName(modelName) {
		return testArkSeedanceChannelModel(resolved, modelName)
	}
	return testAdminChannelModel(resolved, modelName)
}

func normalizeSettings(settings model.Settings) model.Settings {
	settings.Private = normalizePrivateSetting(settings.Private)
	settings.Public = normalizePublicSettingWithChannels(settings.Public, settings.Private.Channels)
	return settings
}

func normalizePublicSetting(setting model.PublicSetting) model.PublicSetting {
	return normalizePublicSettingWithChannels(setting, nil)
}

func normalizePublicSettingWithChannels(setting model.PublicSetting, channels []model.ModelChannel) model.PublicSetting {
	if setting.ModelChannel.AvailableModels == nil {
		setting.ModelChannel.AvailableModels = []string{}
	}
	if setting.ModelChannel.ModelCosts == nil {
		setting.ModelChannel.ModelCosts = []model.ModelCost{}
	}
	for i := range setting.ModelChannel.ModelCosts {
		setting.ModelChannel.ModelCosts[i].Model = strings.TrimSpace(setting.ModelChannel.ModelCosts[i].Model)
		setting.ModelChannel.ModelCosts[i].Label = strings.TrimSpace(setting.ModelChannel.ModelCosts[i].Label)
		if setting.ModelChannel.ModelCosts[i].Credits < 0 {
			setting.ModelChannel.ModelCosts[i].Credits = 0
		}
		setting.ModelChannel.ModelCosts[i].QualityRates = NormalizeImageQualityRates(setting.ModelChannel.ModelCosts[i].QualityRates)
	}
	// 模型元信息（类型 + 支持档位）：脏值不许进配置。
	// 手输极易出现模型名粘连（两个名字被一个点号连在一起）、漏字（模型名尾部少了几个字符）
	// 这类脏数据，它们永远匹配不上任何东西却又不报错，所以这里做一次收敛。
	for i := range setting.ModelChannel.ModelMetas {
		meta := &setting.ModelChannel.ModelMetas[i]
		meta.Model = strings.TrimSpace(meta.Model)
		if !model.ValidModelKind(meta.Kind) {
			// 类型非法（含空）就地按名字推断，而不是留个空值让下游各自猜。
			meta.Kind = inferModelKind(meta.Model)
		}
		allowed := model.VideoResolutionTiers
		if meta.Kind == model.ModelKindImage {
			allowed = model.ImageQualityTiers
		}
		if meta.MaxSeconds < 0 {
			meta.MaxSeconds = 0
		}
		if meta.Kind != model.ModelKindVideo {
			// 秒数上限只对视频有意义；图片/文本/音频留着会让后台表单出现无意义的输入框。
			meta.MaxSeconds = 0
		}
		if meta.Kind == model.ModelKindText || meta.Kind == model.ModelKindAudio {
			// 文本/音频没有档位维度，留着只会让后台表单显示一堆无意义的勾。
			meta.Resolutions = nil
			continue
		}
		kept := make([]string, 0, len(meta.Resolutions))
		seen := make(map[string]bool, len(meta.Resolutions))
		for _, r := range meta.Resolutions {
			v := strings.ToLower(strings.TrimSpace(r))
			if v == "" || seen[v] {
				continue
			}
			for _, a := range allowed {
				if v == a {
					seen[v] = true
					kept = append(kept, v)
					break
				}
			}
		}
		meta.Resolutions = kept
	}
	if setting.ModelChannel.VideoModelCosts == nil {
		setting.ModelChannel.VideoModelCosts = []model.VideoModelCost{}
	}
	for i := range setting.ModelChannel.VideoModelCosts {
		setting.ModelChannel.VideoModelCosts[i].Model = strings.TrimSpace(setting.ModelChannel.VideoModelCosts[i].Model)
		setting.ModelChannel.VideoModelCosts[i].Label = strings.TrimSpace(setting.ModelChannel.VideoModelCosts[i].Label)
		if setting.ModelChannel.VideoModelCosts[i].Rates == nil {
			setting.ModelChannel.VideoModelCosts[i].Rates = []model.VideoResolutionRate{}
		}
		for j := range setting.ModelChannel.VideoModelCosts[i].Rates {
			setting.ModelChannel.VideoModelCosts[i].Rates[j].Resolution = NormalizeVideoBillingResolution(setting.ModelChannel.VideoModelCosts[i].Rates[j].Resolution)
			if setting.ModelChannel.VideoModelCosts[i].Rates[j].CreditsPerSecond < 0 {
				setting.ModelChannel.VideoModelCosts[i].Rates[j].CreditsPerSecond = 0
			}
			if setting.ModelChannel.VideoModelCosts[i].Rates[j].CreditsPerSecondWithVideo < 0 {
				setting.ModelChannel.VideoModelCosts[i].Rates[j].CreditsPerSecondWithVideo = 0
			}
		}
	}
	if setting.ModelChannel.AudioModelCosts == nil {
		setting.ModelChannel.AudioModelCosts = []model.AudioModelCost{}
	}
	for i := range setting.ModelChannel.AudioModelCosts {
		setting.ModelChannel.AudioModelCosts[i].Model = strings.TrimSpace(setting.ModelChannel.AudioModelCosts[i].Model)
		setting.ModelChannel.AudioModelCosts[i].Label = strings.TrimSpace(setting.ModelChannel.AudioModelCosts[i].Label)
		if setting.ModelChannel.AudioModelCosts[i].CreditsPerSecond < 0 {
			setting.ModelChannel.AudioModelCosts[i].CreditsPerSecond = 0
		}
		if setting.ModelChannel.AudioModelCosts[i].CreditsPer100Chars < 0 {
			setting.ModelChannel.AudioModelCosts[i].CreditsPer100Chars = 0
		}
	}
	if setting.ModelChannel.AllowCustomChannel == nil {
		enabled := true
		setting.ModelChannel.AllowCustomChannel = &enabled
	}
	if setting.Auth.AllowRegister == nil {
		enabled := true
		setting.Auth.AllowRegister = &enabled
	}
	if setting.Auth.SmsCode == nil {
		enabled := true
		setting.Auth.SmsCode = &enabled
	}
	enabledModels := enabledChannelModels(channels)
	if len(enabledModels) > 0 {
		setting.ModelChannel.AvailableModels = enabledModels
	} else {
		setting.ModelChannel.AvailableModels = uniqueModelNames(setting.ModelChannel.AvailableModels)
	}
	setting.ModelChannel.DefaultTextModel = repairDefaultModel(setting.ModelChannel.DefaultTextModel, setting.ModelChannel.AvailableModels, isTextModelName)
	setting.ModelChannel.DefaultImageModel = repairDefaultModel(setting.ModelChannel.DefaultImageModel, setting.ModelChannel.AvailableModels, isImageModelName)
	setting.ModelChannel.DefaultVideoModel = repairDefaultModel(setting.ModelChannel.DefaultVideoModel, setting.ModelChannel.AvailableModels, isVideoModelName)
	setting.ModelChannel.DefaultModel = repairDefaultModel(setting.ModelChannel.DefaultModel, setting.ModelChannel.AvailableModels, isTextModelName)
	setting.PortraitAsset.Enabled = volcAssetConfigured()
	setting.Announcement.Message = strings.TrimSpace(setting.Announcement.Message)
	return setting
}

// stampAnnouncementID 维护更新提醒的 ID：开启且(由关变开 / 消息变更)时盖新 ID（毫秒时间戳），
// 否则沿用旧 ID——这样管理员仅改其它设置而公告未变时不会误重弹；每盖一次新 ID 即对所有用户重新弹一次。
func stampAnnouncementID(next *model.AnnouncementSetting, old model.AnnouncementSetting) {
	if !next.Enabled {
		return
	}
	if !old.Enabled || strings.TrimSpace(old.Message) != strings.TrimSpace(next.Message) {
		next.ID = fmt.Sprintf("%d", time.Now().UnixMilli())
		return
	}
	next.ID = old.ID
}

// NormalizeImageQualityRates 收敛图片画质档价（全局默认价与二级管理员覆盖价共用同一套清洗）：档名归一成 1k/2k/4k，非法档丢弃，
// 同档去重（后写覆盖先写），价 <= 0 的档整行丢掉——「这档没单独定价」和「这档免费」必须能区分，
// 详见 PickImageQualityCredits 的说明。
func NormalizeImageQualityRates(rates []model.ImageQualityRate) []model.ImageQualityRate {
	if len(rates) == 0 {
		return nil
	}
	allowed := map[string]bool{}
	for _, tier := range model.ImageQualityTiers {
		allowed[tier] = true
	}
	seen := map[string]int{}
	out := make([]model.ImageQualityRate, 0, len(rates))
	for _, rate := range rates {
		quality := strings.ToLower(strings.TrimSpace(rate.Quality))
		if !allowed[quality] || rate.Credits <= 0 {
			continue
		}
		if idx, ok := seen[quality]; ok {
			out[idx] = model.ImageQualityRate{Quality: quality, Credits: rate.Credits}
			continue
		}
		seen[quality] = len(out)
		out = append(out, model.ImageQualityRate{Quality: quality, Credits: rate.Credits})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ModelCostEntry 取某模型的按次计费整条配置（含画质档价）；查不到返回零值 + false。
func ModelCostEntry(modelName string) (model.ModelCost, bool, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.ModelCost{}, false, err
	}
	modelName = strings.TrimSpace(modelName)
	for _, item := range normalizePublicSetting(settings.Public).ModelChannel.ModelCosts {
		if item.Model == modelName {
			return item, true, nil
		}
	}
	return model.ModelCost{}, false, nil
}

func ModelCost(modelName string) (int, error) {
	return ImageModelCost(modelName, "")
}

// ImageModelCost 全局默认价的按档取价：tier 为空（非图片/未知档）即取一口价。
func ImageModelCost(modelName, tier string) (int, error) {
	entry, ok, err := ModelCostEntry(modelName)
	if err != nil || !ok {
		return 0, err
	}
	return PickImageQualityCredits(entry, tier), nil
}

// TokenBillingRate 文本模型按 token 的粗略倍率（积分 / 1K token）。
// 观测期硬编码经验值——没有 credits↔钱 的真实锚点，靠 token_logs 里 estimated_quota vs charged_credits
// 对账校准后，再迁到可配置 settings、再切真实结算。CacheRatio：cached_tokens 相对输入价的折扣（火山前缀缓存命中 ~0.4）。
type TokenBillingRate struct {
	InputPer1K  float64
	OutputPer1K float64
	CacheRatio  float64
}

// defaultTokenBillingRate 未在表里的文本模型回退用的保守默认倍率。
var defaultTokenBillingRate = TokenBillingRate{InputPer1K: 1.0, OutputPer1K: 4.0, CacheRatio: 0.4}

// tokenBillingRates 按模型名单独覆写倍率的可选表，默认【空】。
//
// 空表不是漏配：查表必然不命中，于是所有文本模型统一走 defaultTokenBillingRate。
// 这个估值只写进 token_logs.estimated_quota 供事后对账观测，**不参与任何扣费与退款** ——
// 用户真正被扣多少点，由后台「模型点数」定价配置决定。所以留空对计费没有任何影响。
// 只有想给个别模型单独校准这个观测值时，才需要在这里补一行并重新编译；
// 若目的是调整用户实际被扣的点数，请改后台定价，不要动这里。
var tokenBillingRates = map[string]TokenBillingRate{}

// EstimateTokenQuota 按粗略倍率估算文本调用「会扣多少积分」（仅记录到 token_logs.estimated_quota，不参与任何扣费/退款）。
// 公式：billableInput = (prompt − cached) + cached × CacheRatio；quota = billableInput/1000 × InputPer1K + completion/1000 × OutputPer1K。
func EstimateTokenQuota(modelName string, prompt, completion, cached int) float64 {
	rate, ok := tokenBillingRates[strings.TrimSpace(modelName)]
	if !ok {
		rate = defaultTokenBillingRate
	}
	if cached < 0 || cached > prompt {
		cached = 0
	}
	billableInput := float64(prompt-cached) + float64(cached)*rate.CacheRatio
	return billableInput/1000*rate.InputPer1K + float64(completion)/1000*rate.OutputPer1K
}

// VideoBillingSmartDurationSeconds 智能时长（duration=-1）按上限预扣的秒数。
const VideoBillingSmartDurationSeconds = 15

// VideoModelCredits 视频模型按「秒数 × 分辨率每秒点数」计费。hasVideoInput=true(视频生视频)时用带视频输入档单价。
// 返回 (credits, true) 表示该模型配置了按秒计费；(0, false) 表示未配置，调用方应回退按次计费。
func VideoModelCredits(modelName string, seconds int, resolution string, hasVideoInput bool) (int, bool, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return 0, false, err
	}
	modelName = strings.TrimSpace(modelName)
	normalizedResolution := NormalizeVideoBillingResolution(resolution)
	for _, item := range normalizePublicSetting(settings.Public).ModelChannel.VideoModelCosts {
		if item.Model != modelName {
			continue
		}
		rate, ok := pickVideoResolutionRate(item.Rates, normalizedResolution)
		if !ok {
			return 0, false, nil
		}
		if seconds <= 0 {
			seconds = VideoBillingSmartDurationSeconds
		}
		return videoRatePerSecond(rate, hasVideoInput) * seconds, true, nil
	}
	return 0, false, nil
}

// AudioCharUnits 把字数换算成计费档数：不足一档按一档算（100 字以内 = 1 档）。
// 空文本按 0 档（不收费）——空提示词根本发不出去，收钱没有道理。
func AudioCharUnits(chars int) int {
	if chars <= 0 {
		return 0
	}
	units := chars / model.AudioCharBillingUnit
	if chars%model.AudioCharBillingUnit != 0 {
		units++
	}
	return units
}

// AudioCharCredits 音频按「字数」计费：ceil(字数/100) × 每 100 字单价。
// 返回 (credits, true) 表示该模型配了按字数价；(0, false) 表示没配，调用方继续判按秒价/按次价。
//
// ⭐ 与按秒计价的关键差别：字数在【提交时】就已知，所以这里算出来的就是最终价，
// 一次扣准，不存在预扣、结算、多退少补，也就没有透支敞口。
func AudioCharCredits(modelName string, chars int) (int, bool, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return 0, false, err
	}
	modelName = strings.TrimSpace(modelName)
	for _, item := range normalizePublicSetting(settings.Public).ModelChannel.AudioModelCosts {
		if item.Model != modelName {
			continue
		}
		if item.CreditsPer100Chars <= 0 {
			return 0, false, nil
		}
		return item.CreditsPer100Chars * AudioCharUnits(chars), true, nil
	}
	return 0, false, nil
}

// AudioBillingMaxSeconds 音频生成的出片硬上限（上游 seed-audio 的 original_duration 上限 120 秒）。
// 目标时长与结算秒数都钳在这个上限内：上游不可能返回超过它的时长，钳一下是为了万一上游改了口径
// 也不会凭空多扣钱。
const AudioBillingMaxSeconds = 120

// AudioBillingDefaultSeconds 没给目标时长时的预扣秒数。
const AudioBillingDefaultSeconds = 15

// AudioModelCredits 音频模型按「秒数 × 每秒点数」计费。
// 返回 (credits, true) 表示该模型配置了按秒价；(0, false) 表示未配置，调用方应回退按次计费。
//
// ⚠️ 2026-09-20 起，线上音频（doubao-tts / doubao-tts-icl / seed-audio-1.0）一律走
// 【按次一口价 5 点】，即后台没有给它们配「每秒点数」，这个函数对它们恒返回 (0,false)。
// 按秒计价的整条链路（预扣 → original_duration 结算 → 多退少补 → 透支保护）保留可用，
// 只要在后台「分级定价 → 音频模型按秒计费」里填上单价即可启用，无需改代码。
//
// ⚠️ 与视频的关键差别：视频的秒数是用户选定的参数、提交时就是真值；音频这里传进来的 seconds
// 在【提交时】只是「目标时长」(预扣依据)，真实秒数要等上游返回 original_duration。
// 同一个函数既用于预扣、也用于结算，两次传的 seconds 不同，这是有意的。
func AudioModelCredits(modelName string, seconds int) (int, bool, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return 0, false, err
	}
	modelName = strings.TrimSpace(modelName)
	for _, item := range normalizePublicSetting(settings.Public).ModelChannel.AudioModelCosts {
		if item.Model != modelName {
			continue
		}
		if item.CreditsPerSecond <= 0 {
			return 0, false, nil
		}
		return item.CreditsPerSecond * NormalizeAudioBillingSeconds(seconds), true, nil
	}
	return 0, false, nil
}

// NormalizeAudioBillingSeconds 把秒数钳进 [1, AudioBillingMaxSeconds]；<=0 视为没给，用默认预扣秒数。
// 不足 1 秒按 1 秒算（上游 original_duration 是浮点，0.4 秒也得收钱，否则短音效等于白送）。
func NormalizeAudioBillingSeconds(seconds int) int {
	if seconds <= 0 {
		return AudioBillingDefaultSeconds
	}
	if seconds > AudioBillingMaxSeconds {
		return AudioBillingMaxSeconds
	}
	return seconds
}

// videoRatePerSecond 按是否带视频输入取每秒单价:带视频输入且配了带输入档(>0)用带输入档,否则一律回退不带输入档。
func videoRatePerSecond(rate model.VideoResolutionRate, hasVideoInput bool) int {
	if hasVideoInput && rate.CreditsPerSecondWithVideo > 0 {
		return rate.CreditsPerSecondWithVideo
	}
	return rate.CreditsPerSecond
}

// pickVideoResolutionRate 精确匹配分辨率档位，未命中回退 720p 档，再回退第一档。返回整条费率(含带/不带视频输入两价)。
func pickVideoResolutionRate(rates []model.VideoResolutionRate, resolution string) (model.VideoResolutionRate, bool) {
	if len(rates) == 0 {
		return model.VideoResolutionRate{}, false
	}
	for _, rate := range rates {
		if rate.Resolution == resolution {
			return rate, true
		}
	}
	for _, rate := range rates {
		if rate.Resolution == "720p" {
			return rate, true
		}
	}
	return rates[0], true
}

// NormalizeVideoBillingResolution 把各种分辨率写法（720 / 720p / high / auto / 4k / 1280x720…）归一成 480p/720p/1080p/2160p 档位。
func NormalizeVideoBillingResolution(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "", "auto", "medium", "high", "720", "720p":
		return "720p"
	case "low", "480", "480p":
		return "480p"
	case "1080", "1080p", "fhd":
		return "1080p"
	case "2160", "2160p", "4k", "uhd":
		return "2160p"
	}
	if width, height, ok := parseVideoPixelSize(normalized); ok {
		shortSide := width
		if height < shortSide {
			shortSide = height
		}
		if shortSide <= 560 {
			return "480p"
		}
		if shortSide <= 900 {
			return "720p"
		}
		if shortSide <= 1980 {
			return "1080p"
		}
		return "2160p"
	}
	return "720p"
}

func parseVideoPixelSize(value string) (int, int, bool) {
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	var width, height int
	if _, err := fmt.Sscan(parts[0], &width); err != nil {
		return 0, 0, false
	}
	if _, err := fmt.Sscan(parts[1], &height); err != nil {
		return 0, 0, false
	}
	if width <= 0 || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}

func normalizePrivateSetting(setting model.PrivateSetting) model.PrivateSetting {
	if setting.Channels == nil {
		setting.Channels = []model.ModelChannel{}
	}
	setting.PromptSync = normalizePromptSyncSetting(setting.PromptSync)
	for i := range setting.Channels {
		if setting.Channels[i].Protocol == "" {
			setting.Channels[i].Protocol = "openai"
		}
		if setting.Channels[i].Models == nil {
			setting.Channels[i].Models = []string{}
		}
		if setting.Channels[i].Weight <= 0 {
			setting.Channels[i].Weight = 1
		}
	}
	if strings.TrimSpace(setting.Sms.Region) == "" {
		setting.Sms.Region = "cn-north-1"
	}
	return setting
}

func hidePrivateAPIKeys(settings model.Settings) model.Settings {
	for i := range settings.Private.Channels {
		settings.Private.Channels[i].APIKey = ""
		// AccessKeySecret 与 apiKey 同等敏感，一并遮蔽(否则后台读设置会把 Secret 明文回吐)
		settings.Private.Channels[i].AccessKeySecret = ""
	}
	settings.Private.PortraitAsset.SecretKey = ""
	settings.Private.Sms.SecretKey = ""
	return settings
}

func keepPrivateAPIKeys(settings *model.Settings, saved model.Settings) {
	for i := range settings.Private.Channels {
		blankKey := strings.TrimSpace(settings.Private.Channels[i].APIKey) == ""
		blankSecret := strings.TrimSpace(settings.Private.Channels[i].AccessKeySecret) == ""
		if !blankKey && !blankSecret {
			continue
		}
		channel, ok := findSavedChannel(settings.Private.Channels[i], saved.Private.Channels, i)
		if !ok {
			continue
		}
		// 留空=沿用旧值(前端读取时是被遮蔽的空串，不能因此把已存密钥冲掉)；apiKey 与 AccessKeySecret 各自独立判断
		if blankKey {
			settings.Private.Channels[i].APIKey = channel.APIKey
		}
		if blankSecret {
			settings.Private.Channels[i].AccessKeySecret = channel.AccessKeySecret
		}
	}
}

func keepPrivateAuthSecrets(settings *model.Settings, saved model.Settings) {
	if strings.TrimSpace(settings.Private.PortraitAsset.SecretKey) == "" {
		settings.Private.PortraitAsset.SecretKey = saved.Private.PortraitAsset.SecretKey
	}
	if strings.TrimSpace(settings.Private.Sms.SecretKey) == "" {
		settings.Private.Sms.SecretKey = saved.Private.Sms.SecretKey
	}
}

func findSavedChannel(channel model.ModelChannel, saved []model.ModelChannel, index int) (model.ModelChannel, bool) {
	for _, item := range saved {
		if item.Name == channel.Name && item.BaseURL == channel.BaseURL {
			return item, true
		}
	}
	// index 传 -1 表示「只按名称 + 地址找，不按序号兜底」。必须挡住负数：
	// 否则 -1 < len(saved) 恒成立，saved[-1] 直接越界 panic——后台填了地址、还没填 API Key
	// 就点「拉取模型 / 测试连通」时必然走到这里，管理员只会看到一个 500。
	if index >= 0 && index < len(saved) {
		return saved[index], true
	}
	return model.ModelChannel{}, false
}

// GroupModelChannels 解析分组自有渠道列表（JSON []ModelChannel）。
func GroupModelChannels(group model.Group) []model.ModelChannel {
	raw := strings.TrimSpace(group.Channels)
	if raw == "" {
		return nil
	}
	var channels []model.ModelChannel
	if err := json.Unmarshal([]byte(raw), &channels); err != nil {
		return nil
	}
	return channels
}

func pickWeightedModelChannel(channels []model.ModelChannel) model.ModelChannel {
	total := 0
	for _, channel := range channels {
		total += channel.Weight
	}
	if total <= 0 {
		return channels[0]
	}
	hit := rand.IntN(total)
	for _, channel := range channels {
		hit -= channel.Weight
		if hit < 0 {
			return channel
		}
	}
	return channels[0]
}

// SelectModelChannelForUser 按用户所属分组选择渠道：模型在该组自有渠道列表内路由，
// 每个渠道自带密钥；未分组或组内没有承载该模型的渠道直接拒绝。
func SelectModelChannelForUser(userID, modelName string) (model.ModelChannel, error) {
	user, ok, err := repository.GetUserByID(userID)
	if err != nil {
		return model.ModelChannel{}, err
	}
	if !ok || strings.TrimSpace(user.GroupID) == "" {
		return model.ModelChannel{}, safeMessageError{message: "你还没有被分配到分组，无法使用 AI 能力，请联系管理员"}
	}
	group, ok, err := repository.GetGroupByID(user.GroupID)
	if err != nil {
		return model.ModelChannel{}, err
	}
	if !ok {
		return model.ModelChannel{}, safeMessageError{message: "所属分组不存在，请联系管理员重新分配"}
	}
	groupChannels := GroupModelChannels(group)
	if len(groupChannels) == 0 {
		return model.ModelChannel{}, safeMessageError{message: "所属分组还没有配置模型渠道，请联系管理员在「分组管理」中添加"}
	}
	candidates := modelChannelsForModel(groupChannels, modelName)
	if len(candidates) == 0 {
		return model.ModelChannel{}, safeMessageError{message: fmt.Sprintf("所属分组没有可用的「%s」模型渠道，请联系管理员", modelName)}
	}
	chosen := pickWeightedModelChannel(candidates)
	// 用户级 apiKey 覆盖：该用户若对命中渠道配了自有 key，则改用它（仅换 key，
	// 渠道地址/协议/模型路由/计费一概不变）；未配则回退团队渠道自带的 key。
	if key := userChannelKeyOverride(user, chosen.Name); key != "" {
		chosen.APIKey = key
	}
	return chosen, nil
}

// userChannelKeyOverride 返回用户对指定渠道名配置的覆盖 apiKey（无则空）。
// 存在 user.ChannelKeys（JSON map「渠道名 → apiKey」）里；解析失败/未配一律回退空（=用组的 key）。
func userChannelKeyOverride(user model.User, channelName string) string {
	raw := strings.TrimSpace(user.ChannelKeys)
	if raw == "" {
		return ""
	}
	var m map[string]string
	if json.Unmarshal([]byte(raw), &m) != nil {
		return ""
	}
	return strings.TrimSpace(m[channelName])
}

// PublicSettingsForUser 公开配置按用户分组定制：可用模型列表换成该组渠道聚合的模型。
func PublicSettingsForUser(userID string) (model.PublicSetting, error) {
	settings, err := PublicSettings()
	if err != nil {
		return settings, err
	}
	if strings.TrimSpace(userID) == "" {
		return settings, nil
	}
	user, ok, err := repository.GetUserByID(userID)
	if err != nil || !ok {
		return settings, nil
	}
	// 价格覆盖（按该用户所属二级管理员，不依赖分组）：把覆盖价合并进 ModelCosts/VideoModelCosts，
	// 使前端显示的「本次消耗点数」与后端实际扣费口径一致。
	settings.ModelChannel.ModelCosts = effectiveModelCosts(user, settings.ModelChannel.ModelCosts)
	settings.ModelChannel.VideoModelCosts = effectiveVideoModelCosts(user, settings.ModelChannel.VideoModelCosts)
	settings.ModelChannel.AudioModelCosts = effectiveAudioModelCosts(user, settings.ModelChannel.AudioModelCosts)
	// 分组定制：可用模型列表换成组内渠道聚合的模型。
	if strings.TrimSpace(user.GroupID) != "" {
		if group, gok, gerr := repository.GetGroupByID(user.GroupID); gerr == nil && gok {
			if models := enabledChannelModels(GroupModelChannels(group)); len(models) > 0 {
				settings.ModelChannel.AvailableModels = models
				settings.ModelChannel.DefaultTextModel = repairDefaultModel(settings.ModelChannel.DefaultTextModel, models, isTextModelName)
				settings.ModelChannel.DefaultImageModel = repairDefaultModel(settings.ModelChannel.DefaultImageModel, models, isImageModelName)
				settings.ModelChannel.DefaultVideoModel = repairDefaultModel(settings.ModelChannel.DefaultVideoModel, models, isVideoModelName)
				settings.ModelChannel.DefaultModel = repairDefaultModel(settings.ModelChannel.DefaultModel, models, isTextModelName)
			}
		}
	}
	return settings, nil
}

// MigrateGroupChannels 启动迁移：把「全局渠道 + 组内密钥覆盖」的旧配置折叠成组内自有渠道列表；
// 同时把全局资产库 Region/素材组名补到分组。幂等：已有 Channels 的分组跳过。
func MigrateGroupChannels() {
	groups, err := repository.ListGroups()
	if err != nil {
		return
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return
	}
	private := normalizePrivateSetting(settings.Private)
	for _, group := range groups {
		changed := false
		if strings.TrimSpace(group.Channels) == "" && (strings.TrimSpace(group.ChannelAPIKey) != "" || strings.TrimSpace(group.ChannelKeys) != "") {
			var keys map[string]string
			if raw := strings.TrimSpace(group.ChannelKeys); raw != "" {
				_ = json.Unmarshal([]byte(raw), &keys)
			}
			migrated := []model.ModelChannel{}
			for _, channel := range private.Channels {
				apiKey := strings.TrimSpace(keys[channel.Name])
				if apiKey == "" {
					apiKey = strings.TrimSpace(group.ChannelAPIKey)
				}
				if apiKey == "" {
					continue
				}
				channel.APIKey = apiKey
				if baseURL := strings.TrimSpace(group.ChannelBaseURL); baseURL != "" {
					channel.BaseURL = baseURL
				}
				migrated = append(migrated, channel)
			}
			if len(migrated) > 0 {
				if encoded, err := json.Marshal(migrated); err == nil {
					group.Channels = string(encoded)
					changed = true
				}
			}
		}
		if strings.TrimSpace(group.VolcRegion) == "" && strings.TrimSpace(private.PortraitAsset.Region) != "" {
			group.VolcRegion = strings.TrimSpace(private.PortraitAsset.Region)
			changed = true
		}
		if strings.TrimSpace(group.VolcGroupName) == "" && strings.TrimSpace(private.PortraitAsset.GroupName) != "" {
			group.VolcGroupName = strings.TrimSpace(private.PortraitAsset.GroupName)
			changed = true
		}
		if changed {
			if _, err := repository.SaveGroup(group); err == nil {
				log.Printf("group channel migrate: %s 已折叠为组内渠道配置", group.Name)
			}
		}
	}
}

func BuildModelChannelURL(channel model.ModelChannel, path string) string {
	baseURL := normalizeModelChannelBaseURL(channel.BaseURL)
	lowerBaseURL := strings.ToLower(baseURL)
	if !strings.HasSuffix(lowerBaseURL, "/v1") && !strings.HasSuffix(lowerBaseURL, "/api/v3") && !strings.HasSuffix(lowerBaseURL, "/api/plan/v3") {
		baseURL += "/v1"
	}
	return baseURL + path
}

func normalizeModelChannelBaseURL(baseURL string) string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err == nil && parsed.Scheme != "" && parsed.Host != "" {
		path := strings.TrimRight(parsed.Path, "/")
		lowerPath := strings.ToLower(path)
		if index := strings.Index(lowerPath, "/api/plan/v3"); index >= 0 {
			end := index + len("/api/plan/v3")
			if len(lowerPath) == end || lowerPath[end] == '/' {
				parsed.Path = path[:end]
				parsed.RawPath = ""
				parsed.RawQuery = ""
				parsed.Fragment = ""
				return strings.TrimRight(parsed.String(), "/")
			}
		}
	}
	return baseURL
}

func isArkAgentPlanChannel(channel model.ModelChannel) bool {
	baseURL := strings.ToLower(normalizeModelChannelBaseURL(channel.BaseURL))
	return strings.HasSuffix(baseURL, "/api/plan/v3")
}

func isSeedanceModelName(modelName string) bool {
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(modelName, "seedance") || strings.Contains(modelName, "doubao-seedance")
}

func enabledChannelModels(channels []model.ModelChannel) []string {
	models := []string{}
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		models = append(models, channel.Models...)
	}
	return uniqueModelNames(models)
}

func uniqueModelNames(models []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, item := range models {
		name := strings.TrimSpace(item)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, name)
	}
	return result
}

func repairDefaultModel(current string, models []string, preferred func(string) bool) string {
	current = strings.TrimSpace(current)
	for _, item := range models {
		if item == current {
			return current
		}
	}
	for _, item := range models {
		if preferred(item) {
			return item
		}
	}
	if len(models) > 0 {
		return models[0]
	}
	return ""
}

// 下面四个判据全部委托给 model_kind_rules.go —— 关键词表只在那一个文件里定义。
// 它们做的额外事情只有「互斥」：一个模型只能属于一类，排除顺序与前端
// web/src/lib/model-kind-rules.ts 逐字对应（audio 最优先，然后 video，然后 image）。
//
// ⚠️ 别再往这里加关键词。加在 model_kind_rules.go，并同步前端那份副本 +
// testdata/model-kind-fixture.json，否则前后端对拍检查会失败。
func isVideoModelName(modelName string) bool {
	return classifyModelKindByName(modelName) == model.ModelKindVideo
}

func isImageModelName(modelName string) bool {
	return classifyModelKindByName(modelName) == model.ModelKindImage
}

// isTextModelName ⚠️ 必须排除 audio：否则语音模型会被 repairDefaultModel 选成
// 「默认文本模型」写进配置，后台系统设置页就会把默认文本模型显示成一个音频模型。
func isTextModelName(modelName string) bool {
	return classifyModelKindByName(modelName) == model.ModelKindText
}

func normalizeModelChannel(channel model.ModelChannel) model.ModelChannel {
	if channel.Protocol == "" {
		channel.Protocol = "openai"
	}
	if channel.Models == nil {
		channel.Models = []string{}
	}
	if channel.Weight <= 0 {
		channel.Weight = 1
	}
	return channel
}

func resolveAdminChannel(index *int, channel model.ModelChannel) (model.ModelChannel, error) {
	resolved := normalizeModelChannel(channel)
	if strings.TrimSpace(resolved.APIKey) == "" {
		settings, err := repository.GetSettings()
		if err != nil {
			return model.ModelChannel{}, err
		}
		saved := normalizePrivateSetting(settings.Private).Channels
		if index != nil && *index >= 0 && *index < len(saved) {
			if resolved.APIKey == "" {
				resolved.APIKey = saved[*index].APIKey
			}
			if resolved.BaseURL == "" {
				resolved.BaseURL = saved[*index].BaseURL
			}
			if resolved.Name == "" {
				resolved.Name = saved[*index].Name
			}
		}
		if resolved.APIKey == "" {
			if savedChannel, ok := findSavedChannel(resolved, saved, -1); ok {
				resolved.APIKey = savedChannel.APIKey
			}
		}
	}
	if strings.TrimSpace(resolved.BaseURL) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少接口地址"}
	}
	if strings.TrimSpace(resolved.APIKey) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少 API Key"}
	}
	return resolved, nil
}

func fetchAdminChannelModels(channel model.ModelChannel) ([]string, error) {
	request, err := http.NewRequest(http.MethodGet, BuildModelChannelURL(channel, "/models"), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return nil, safeMessageError{message: "读取模型失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		if response.StatusCode == http.StatusNotFound && isArkAgentPlanChannel(channel) {
			return nil, safeMessageError{message: "火山方舟 Agent Plan 未提供 OpenAI /models 模型列表接口，请手动填写模型名称，例如 doubao-seedance-2.0。"}
		}
		return nil, readAdminChannelError(body, response.StatusCode, "读取模型失败")
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(body, &payload)
	result := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if strings.TrimSpace(item.ID) != "" {
			result = append(result, item.ID)
		}
	}
	sort.Strings(result)
	return result, nil
}

func testAdminChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	body, _ := json.Marshal(map[string]any{
		"model": modelName,
		"messages": []map[string]string{{
			"role":    "user",
			"content": "hi",
		}},
	})
	request, err := http.NewRequest(http.MethodPost, BuildModelChannelURL(channel, "/chat/completions"), strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return "", safeMessageError{message: "测试失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return "", readAdminChannelError(responseBody, response.StatusCode, "测试失败")
	}
	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(responseBody, &payload)
	if len(payload.Choices) > 0 && strings.TrimSpace(payload.Choices[0].Message.Content) != "" {
		return payload.Choices[0].Message.Content, nil
	}
	return "ok", nil
}

func testArkSeedanceChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	if strings.TrimSpace(channel.BaseURL) == "" {
		return "", safeMessageError{message: "缺少接口地址"}
	}
	if strings.TrimSpace(channel.APIKey) == "" {
		return "", safeMessageError{message: "缺少 API Key"}
	}
	if !isArkAgentPlanChannel(channel) {
		return "Seedance 视频模型不会发送 /chat/completions 文本测试。已检查 Base URL、API Key 和模型名非空；未调用视频生成接口，因此未验证套餐额度或模型权限。", nil
	}
	return "Agent Plan / Seedance 视频模型配置格式已通过。后台测试不会调用视频生成接口，因此未验证 API Key、套餐额度或模型权限；请在画布中使用视频生成验证。", nil
}

func readAdminChannelError(body []byte, statusCode int, fallback string) error {
	var payload struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Msg string `json:"msg"`
	}
	if len(body) > 0 && json.Unmarshal(body, &payload) == nil {
		if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
			return safeMessageError{message: payload.Error.Message}
		}
		if strings.TrimSpace(payload.Msg) != "" {
			return safeMessageError{message: payload.Msg}
		}
	}
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		return safeMessageError{message: fmt.Sprintf("上游接口鉴权失败（%d），请检查 API Key、套餐权限或模型权限", statusCode)}
	}
	if statusCode == http.StatusTooManyRequests {
		return safeMessageError{message: "上游接口限流或额度不足（429），请稍后重试或检查额度"}
	}
	if statusCode > 0 {
		return safeMessageError{message: fmt.Sprintf("%s：%d", fallback, statusCode)}
	}
	return safeMessageError{message: fallback}
}

type safeMessageError struct {
	message string
}

func (err safeMessageError) Error() string {
	return err.message
}

func (err safeMessageError) SafeMessage() string {
	return err.message
}

func modelChannelsForModel(channels []model.ModelChannel, modelName string) []model.ModelChannel {
	result := []model.ModelChannel{}
	for _, channel := range channels {
		if !channel.Enabled || channel.APIKey == "" {
			continue
		}
		// ⚠️ BaseURL 只对「需要填地址」的协议强制。火山音频(volc-audio)允许留空——
		// 适配器会回退到 openspeech 官方域名，后台的渠道表单也是按「可留空」校验的。
		// 原先这里一刀切要求非空，结果是：管理员按界面提示把它留空保存成功，
		// 而这条渠道在选渠道时被【静默跳过】，用户只看到「所属分组没有可用的 X 模型渠道」，
		// 完全看不出是 BaseURL 的问题。2026-09-20 部署实测时发现。
		if channel.BaseURL == "" && channel.Protocol != "volc-audio" {
			continue
		}
		for _, item := range channel.Models {
			if strings.TrimSpace(item) == modelName {
				result = append(result, channel)
				break
			}
		}
	}
	return result
}
