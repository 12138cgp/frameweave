package model

// GenerationJob 异步生成任务：生图改为「创建任务→服务端后台执行→轮询领取」，
// 上游调用与浏览器连接解耦；刷新/切页/关页后凭任务 ID 找回结果（保留 48 小时）。
type GenerationJob struct {
	ID     string `json:"id" gorm:"primaryKey"`
	UserID string `json:"userId" gorm:"index"`
	// 上游路径：/images/generations | /images/edits
	Path        string `json:"path"`
	Model       string `json:"model"`
	Status      string `json:"status"` // pending | running | succeeded | failed
	Payload     []byte `json:"-"`      // 原始请求体（透传上游，JSON 或 multipart）
	ContentType string `json:"-"`
	// 成功=上游响应体；失败=上游错误体（查询时做中文化翻译用）
	Result         []byte `json:"-"`
	UpstreamStatus int    `json:"-"`
	// DispatchedAt 上游请求已发起的时刻（RFC3339）；非空=已向上游 API 发出过请求。
	// 服务重启恢复据此去重：已发起的任务结果丢失后不重跑（避免重复调用上游），改标失败退款让用户重试。
	DispatchedAt string `json:"-"`
	Error        string `json:"error"`
	// ProjectID 本次扣的项目积分池 ID（空=扣个人积分）；退款时据此路由回项目或个人。
	ProjectID string `json:"projectId" gorm:"column:project_id"`
	// CanvasID 本次生成所在画布 ID（空=未知/无画布）；用于项目统计「画布数」。
	CanvasID string `json:"canvasId" gorm:"column:canvas_id;index"`
	Credits  int    `json:"credits"`
	// UnitCredits 本次扣费用的「单价」（1 张图的点数）快照。图片按画质档定价后，
	// 缺额退款不能再事后重新查价——档位信息只在请求体里，而价表随时可能被管理员改动，
	// 事后查到的单价可能既不是当时的档、也不是当时的价。0 = 老任务（本列上线前创建），退款时回退旧算法。
	UnitCredits int    `json:"-" gorm:"column:unit_credits"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}
