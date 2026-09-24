package model

// Group 用户分组：每组独立的模型渠道凭证与火山方舟项目凭证。
// 用户必须被管理员分配到分组后才能调用 AI 能力与人像资产入库；凭证不对用户端暴露。
type Group struct {
	ID   string `json:"id" gorm:"primaryKey"`
	Name string `json:"name" gorm:"uniqueIndex"`
	// OwnerID 拥有该分组的二级管理员 ID：空=超管/全局组。
	OwnerID string `json:"ownerId" gorm:"index"`
	// 分组自有模型渠道列表：JSON 数组 []ModelChannel（每组自行维护渠道与密钥，模型按组内渠道路由）
	Channels string `json:"channels"`
	// （旧版字段，仅用于启动迁移：全局渠道+组内密钥 → 组内渠道列表）
	ChannelBaseURL string `json:"channelBaseUrl"`
	ChannelAPIKey  string `json:"channelApiKey"`
	ChannelKeys    string `json:"channelKeys"`
	// 火山方舟人像资产库凭证（独立项目审核），Region/素材组名也按组配置
	VolcAccessKey    string `json:"volcAccessKey"`
	VolcSecretKey    string `json:"volcSecretKey"`
	VolcAssetProject string `json:"volcAssetProject"`
	VolcRegion       string `json:"volcRegion"`
	VolcGroupName    string `json:"volcGroupName"`
	// 每组独立对象存储桶（S3 兼容：火山 TOS / 阿里 OSS / 腾讯 COS / MinIO 等）。
	// 六项全空=该组回退全局 config.Cfg.TOS（兼容老组）；TOSBucket 非空=该组启用自有桶，
	// 此时 AK/SK/PublicBase 必须齐全，否则视为配置不完整报错（绝不静默回退全局公共桶，防跨组数据混入）。
	// Endpoint/Region 留空则继承全局默认。凭证明文存 DB，与 Volc*/Channels 一致，仅管理员可见。
	TOSBucket     string `json:"tosBucket"`
	TOSEndpoint   string `json:"tosEndpoint"`
	TOSRegion     string `json:"tosRegion"`
	TOSAccessKey  string `json:"tosAccessKey"`
	TOSSecretKey  string `json:"tosSecretKey"`
	TOSPublicBase string `json:"tosPublicBase"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}
