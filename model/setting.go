package model

import "encoding/json"

type SettingKey string

const (
	SettingKeyPublic  SettingKey = "public"
	SettingKeyPrivate SettingKey = "private"
)

// ModelChannel 模型渠道配置。
type ModelChannel struct {
	// ID 渠道稳定标识(保存时生成、改名/调序不变),用量埋点(upstream_logs.channel_id)按它归集,是按渠道统计用量的前提。
	ID string `json:"id,omitempty"`
	// IDHistory 该渠道用过的历史 ID(最新的在最后)。存在的理由:后台表单一旦没把 id 带回来,
	// 每保存一次分组就会给全组渠道重铸一遍 uuid,历史用量因此散落在一串死 ID 上。
	// 按渠道归集用量时把 ID+IDHistory 一并算进同一个渠道,才能让往月的数据对得上。
	// 表单侧已经做了防护(隐藏 Form.Item 注册 id),这里既是历史数据的载体,也是万一再丢 id 时的兜底。
	IDHistory []string `json:"idHistory,omitempty"`
	Protocol  string   `json:"protocol"`
	Name      string   `json:"name"`
	BaseURL   string   `json:"baseUrl"`
	APIKey    string   `json:"apiKey"`
	Models    []string `json:"models"`
	Weight    int      `json:"weight"`
	Enabled   bool     `json:"enabled"`
	Remark    string   `json:"remark"`
	// Hidden 该渠道对二级管理员隐藏（仅超管可设）：true=该条渠道（含 apiKey）在 L2 的分组列表/编辑表单里不出现、
	// 且 L2 保存时不可修改；生成路由不受影响（服务端仍按全部渠道路由）。分组自有渠道(group.channels)专用语义。
	Hidden bool `json:"hidden,omitempty"`
	// ResourceID 仅 protocol="volc-audio"（火山音频 / 豆包语音）用：X-Api-Resource-Id，
	// 决定 TTS 的模型版本（默认 seed-tts-1.0）。音频生成 /tts/create 不看这个头。
	ResourceID string `json:"resourceId,omitempty"`
	// AccessKeySecret 需要 AK/SK 双段凭证(而非 Bearer)的渠道用：约定 APIKey 字段存 AccessKeyId、
	// BaseURL 存接入域名，本字段只存 Secret —— 这样渠道候选过滤(要求 BaseURL/APIKey 非空)、
	// 后台密钥遮蔽、用户级 apiKey 覆盖等既有机制全部天然复用，无需为它开特例。
	// 当前版本没有读它的调用方，只在后台读设置时把它当敏感值一并遮蔽。
	AccessKeySecret string `json:"accessKeySecret,omitempty"`
}

// ModelKind 模型类型。一个模型只归一类——真实调用记录(upstream_logs.kind)
// 显示没有任何一个模型跨类型，所以单选既够用又能让判据保持单一。
type ModelKind string

const (
	ModelKindText  ModelKind = "text"
	ModelKindImage ModelKind = "image"
	ModelKindVideo ModelKind = "video"
	ModelKindAudio ModelKind = "audio"
)

// ValidModelKind 该值是否是已知类型（空值不算）。
func ValidModelKind(k ModelKind) bool {
	switch k {
	case ModelKindText, ModelKindImage, ModelKindVideo, ModelKindAudio:
		return true
	}
	return false
}

// 图片画质档与视频分辨率档的取值范围。前端选择器按这两组值渲染，模型未声明的档位置灰。
var (
	ImageQualityTiers    = []string{"1k", "2k", "4k"}
	VideoResolutionTiers = []string{"480p", "720p", "1080p", "2160p"}
)

// ModelMeta 模型元信息：类型 + 支持的档位。
//
// 刻意与定价表分开存，而不是塞进 ModelCost/VideoModelCost：定价表在保存时会把价为 0 的档位
// 整行丢弃(见后台两个定价页的 normalize)，于是「支持这个档位、但不额外收费」这个状态在价格表里
// 根本表达不出来。类型和档位是"能力"，价格是"收多少"，两件事。
type ModelMeta struct {
	Model string    `json:"model"`
	Kind  ModelKind `json:"kind"`
	// Resolutions 该模型支持的档位：图片填 ImageQualityTiers 的子集，视频填 VideoResolutionTiers 的子集。
	// 留空 = 不限制(前端全开)，这样老数据在管理员补齐之前不会突然变得一个档位都选不了。
	Resolutions []string `json:"resolutions,omitempty"`
	// MaxSeconds 视频模型的出片最长秒数上限。0 = 不限制(前端沿用内置能力表或默认 15 秒)。
	// 只对视频类型有意义；秒数在界面上是一根滑动条而不是几个档位，所以这里存上限而非可选值集合。
	MaxSeconds int `json:"maxSeconds,omitempty"`
}

// ImageQualityRate 图片某画质档的每张点数。
type ImageQualityRate struct {
	Quality string `json:"quality"`
	Credits int    `json:"credits"`
}

// ModelCost 模型点数配置（按次计费：文本/图片/音频）。
type ModelCost struct {
	Model string `json:"model"`
	// Credits 每次调用的点数。QualityRates 为空时用它；非空时它作为未命中档位的兜底。
	Credits int `json:"credits"`
	// QualityRates 图片按画质档分别定价。非空时优先于 Credits（按档取，取不到再回落 Credits）。
	// 留空 = 沿用原来的「不分档，一口价」，所以存量配置零改动、零迁移。
	QualityRates []ImageQualityRate `json:"qualityRates,omitempty"`
	// Label 显示代称：仅前台展示用的别名(留空则显示模型名本身)，不参与任何调用/扣费匹配。
	Label string `json:"label,omitempty"`
}

// VideoResolutionRate 视频某分辨率档位的每秒点数。
type VideoResolutionRate struct {
	Resolution string `json:"resolution"`
	// CreditsPerSecond 不带视频输入(文/图生视频)时的每秒点数。
	CreditsPerSecond int `json:"creditsPerSecond"`
	// CreditsPerSecondWithVideo 带视频输入(视频生视频,请求 content 里含 video_url/reference_video)时的每秒点数。
	// 为 0 时回退用 CreditsPerSecond(兼容未区分的旧配置)。
	CreditsPerSecondWithVideo int `json:"creditsPerSecondWithVideo,omitempty"`
}

// VideoModelCost 视频模型按「秒数 × 分辨率每秒点数」计费配置；未配置的视频模型回退按次计费。
type VideoModelCost struct {
	Model string                `json:"model"`
	Rates []VideoResolutionRate `json:"rates"`
	Label string                `json:"label,omitempty"`
}

// AudioModelCost 音频模型计价配置；两项都为 0 时回退 ModelCost 的按次一口价。
//
// 为什么不复用 VideoModelCost：视频的单价挂在分辨率档位上，音频没有这个维度。
// 更要紧的是「秒数从哪来」不同——视频的秒数是用户选定的参数、提交时就确定；
// 而音频生成(seed-audio)上游【没有时长参数】，真实秒数要等上游返回 original_duration。
type AudioModelCost struct {
	Model string `json:"model"`
	// CreditsPer100Chars 每 100 字（不足 100 按 100 算）的点数。0 = 未配置。
	//
	// **优先级最高**。它比按秒计价好在：字数在提交时就已知，可以一次扣准，
	// 不需要「预扣 → 出片后结算差额」那一套，也就没有透支敞口。
	CreditsPer100Chars int `json:"creditsPer100Chars"`
	// CreditsPerSecond 每秒点数。0 = 未配置。仅当 CreditsPer100Chars 未配置时才生效。
	CreditsPerSecond int    `json:"creditsPerSecond"`
	Label            string `json:"label,omitempty"`
}

// AudioCharBillingUnit 按字数计价的计费单位：每多少字算一档（不足一档按一档算）。
const AudioCharBillingUnit = 100

// PriceOverridePayload 某二级管理员的价格覆盖（按模型；未列出的模型用全局默认价）。存在 User.PriceOverride 里。
type PriceOverridePayload struct {
	ModelCosts      []ModelCost      `json:"modelCosts"`
	VideoModelCosts []VideoModelCost `json:"videoModelCosts"`
	AudioModelCosts []AudioModelCost `json:"audioModelCosts"`
}

// PublicModelChannelSetting 公开模型渠道配置。
type PublicModelChannelSetting struct {
	AvailableModels []string `json:"availableModels"`
	// ModelMetas 每个模型的类型与支持档位。按模型名索引，与 ModelCosts/VideoModelCosts 同源不同表。
	ModelMetas         []ModelMeta      `json:"modelMetas,omitempty"`
	ModelCosts         []ModelCost      `json:"modelCosts"`
	VideoModelCosts    []VideoModelCost `json:"videoModelCosts"`
	// AudioModelCosts 音频模型计价配置。与 ModelCosts/VideoModelCosts 同源不同表。
	AudioModelCosts    []AudioModelCost `json:"audioModelCosts"`
	DefaultModel       string           `json:"defaultModel"`
	DefaultImageModel  string           `json:"defaultImageModel"`
	DefaultVideoModel  string           `json:"defaultVideoModel"`
	DefaultTextModel   string           `json:"defaultTextModel"`
	SystemPrompt       string           `json:"systemPrompt"`
	AllowCustomChannel *bool            `json:"allowCustomChannel"`
}

// PublicSetting 公开配置。
type PublicSetting struct {
	ModelChannel  PublicModelChannelSetting  `json:"modelChannel"`
	Auth          PublicAuthSetting          `json:"auth"`
	PortraitAsset PublicPortraitAssetSetting `json:"portraitAsset"`
	Announcement  AnnouncementSetting        `json:"announcement"`
}

// PublicPortraitAssetSetting 人像资产功能对外暴露的开关。
type PublicPortraitAssetSetting struct {
	Enabled bool `json:"enabled"`
}

// AnnouncementSetting 更新提醒一次性弹窗配置。管理员推送更新前开启，部署后关闭。
// ID 由后端在保存时自动维护：开启且(消息变更/由关变开)时盖新 ID，前端按「未读过该 ID」弹一次。
type AnnouncementSetting struct {
	Enabled bool   `json:"enabled"`
	Message string `json:"message"`
	ID      string `json:"id"`
}

type PublicAuthSetting struct {
	AllowRegister *bool `json:"allowRegister"`
	// SmsCode 是否开启手机验证码登录注册（登录页据此显示/隐藏「手机验证码」入口）。
	// 与短信服务是否启用解耦：管理员可独立控制登录页是否暴露验证码登录，未配置时默认开启（保持现状）。
	SmsCode *bool `json:"smsCode"`
}

// PrivateSetting 私有配置。
type PrivateSetting struct {
	Channels      []ModelChannel              `json:"channels"`
	PromptSync    PromptSyncSetting           `json:"promptSync"`
	PortraitAsset PrivatePortraitAssetSetting `json:"portraitAsset"`
	Sms           SmsSetting                  `json:"sms"`
}

// SmsSetting 火山引擎短信服务配置（登录验证码）。
// 凭证优先从后台「私有配置」读取，未填项回退 .env；Region 默认 cn-north-1（短信仅在该区域可用）。
type SmsSetting struct {
	Enabled            *bool  `json:"enabled"`
	AccessKey          string `json:"accessKey"`
	SecretKey          string `json:"secretKey"`
	Region             string `json:"region"`             // 默认 cn-north-1
	SmsAccount         string `json:"smsAccount"`         // 短信消息组ID
	Sign               string `json:"sign"`               // 短信签名
	TemplateID         string `json:"templateId"`         // 短信模板 ID
	DailyLimitPerPhone int    `json:"dailyLimitPerPhone"` // 单手机号每日发送上限，默认 20（loadSmsConfig 兜底）
	DailyLimitPerIP    int    `json:"dailyLimitPerIP"`    // 单 IP 每日发送上限，默认 100（loadSmsConfig 兜底）
	VerifyMaxAttempts  int    `json:"verifyMaxAttempts"`  // 相同手机号+IP 连续错误上限，默认 5（超限锁定验证码发送与验证）
	VerifyLockMinutes  int    `json:"verifyLockMinutes"`  // 锁定时长（分钟），默认 5
	// DevMode 开发模式：不真正发送短信，直接在响应里把验证码返回给调用方。
	// 🚨 这是个危险开关，只用于联调。一旦它为 true 且「短信验证码登录」开着，
	// 任何人都能对任意已注册手机号取码登录（账号接管）。
	// 缺省 nil 即【关】——isSmsDevMode 要求显式 true，读写两端都不要把缺省当成开。
	DevMode *bool `json:"devMode"`
}

// PrivatePortraitAssetSetting 火山方舟人像资产库配置（后台可视化设置，优先于 .env）。
type PrivatePortraitAssetSetting struct {
	AccessKey   string `json:"accessKey"`
	SecretKey   string `json:"secretKey"`
	ProjectName string `json:"projectName"`
	Region      string `json:"region"`
	GroupName   string `json:"groupName"`
}

// PromptSyncSetting 提示词定时同步配置。
type PromptSyncSetting struct {
	Enabled *bool  `json:"enabled"`
	Cron    string `json:"cron"`
}

// Setting 系统配置。
type Setting struct {
	Key       SettingKey      `json:"key" gorm:"primaryKey"`
	Value     json.RawMessage `json:"value" gorm:"serializer:json"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

// Settings 系统公开和私有配置。
type Settings struct {
	Public  PublicSetting  `json:"public"`
	Private PrivateSetting `json:"private"`
}
