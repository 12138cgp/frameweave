package model

// TokenLog AI 调用的 token / 计量观测日志（只记录、不结算）。
// 文本（/chat/completions）记真实 token usage（含 cached / reasoning）；
// 图像/视频/音频无 token，记张数 / 秒数 / 分辨率。
// EstimatedQuota：文本=按粗略 token 倍率估算的积分当量；图像/视频/音频=当前按次/按秒真实扣的积分。
// ChargedCredits：本次实际扣的积分（现有 ModelCost 按次/按秒逻辑算出，一行未改）。
// ProjectID / ChargedToProject：prod 项目积分池归因——命中项目时记项目 id，ChargedToProject=true 表示扣的项目池、false 表示扣个人。
// 现阶段纯观测：跑一两周对比 estimated_quota vs charged_credits、看缓存命中，校准后再切真实结算。
type TokenLog struct {
	ID               string  `json:"id" gorm:"primaryKey"`
	TraceID          string  `json:"traceId" gorm:"index"`
	UserID           string  `json:"userId" gorm:"index"`
	GroupID          string  `json:"groupId"`
	ProjectID        string  `json:"projectId"`
	ChargedToProject bool    `json:"chargedToProject"`
	Model            string  `json:"model" gorm:"index"`
	Path             string  `json:"path"`
	Kind             string  `json:"kind"` // text | image | video | audio
	IsStream         bool    `json:"isStream"`
	PromptTokens     int     `json:"promptTokens"`
	CompletionTokens int     `json:"completionTokens"`
	CachedTokens     int     `json:"cachedTokens"`
	ReasoningTokens  int     `json:"reasoningTokens"`
	TotalTokens      int     `json:"totalTokens"`
	ImageCount       int     `json:"imageCount"`
	VideoSeconds     int     `json:"videoSeconds"`
	Resolution       string  `json:"resolution"`
	ChargedCredits   int     `json:"chargedCredits"`
	EstimatedQuota   float64 `json:"estimatedQuota"`
	UpstreamStatus   int     `json:"upstreamStatus"`
	CreatedAt        string  `json:"createdAt"`
}
