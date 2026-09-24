package model

// UpstreamLog 捕获上游(火山方舟等)在响应头返回的 LogID(X-Tt-Logid),
// 单独持久化便于事后对账查成本/排查;不改 generation_jobs 现有字段。
type UpstreamLog struct {
	ID             string `json:"id" gorm:"primaryKey"`
	TraceID        string `json:"traceId" gorm:"index"` // 异步=job.ID(完整UUID), 同步=8位 traceID
	UserID         string `json:"userId" gorm:"index"`
	Model          string `json:"model" gorm:"index"`
	Kind           string `json:"kind"` // text | image | video | audio(空=旧数据)
	Path           string `json:"path"`
	Request        string `json:"request" gorm:"type:text"`   // 请求体摘要(prompt/参数;base64 参考图剥成占位符)
	TaskID         string `json:"taskId" gorm:"index"`        // 上游任务号(火山视频 cgt-...;非视频为空)
	LogID          string `json:"logId" gorm:"index"`         // 火山 X-Tt-Logid
	UpstreamStatus int    `json:"upstreamStatus"`             // 上游 HTTP 状态码
	Source         string `json:"source"`                     // "job" | "proxy"
	ChannelID      string `json:"channelId" gorm:"index"`     // 本次实际选中的渠道 ID(ModelChannel.ID);便于按渠道归集用量,老行/未命中为空
	DurationMs     int    `json:"durationMs"`                 // 生成用时(ms):图片 job=记录时算 now-DispatchedAt;视频=成功轮询回填 now-提交;0=未知/旧数据
	ResultURL      string `json:"resultUrl" gorm:"type:text"` // 成片永久地址(视频转存 TOS 后前端回传;仅视频、best-effort、纯观测,供后台内联播放)
	CreatedAt      string `json:"createdAt" gorm:"index"`
}
