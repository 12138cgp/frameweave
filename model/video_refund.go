package model

// VideoRefund 视频生成退款幂等记录：POST /videos 提交时按 task id 落候选（含扣费来源），
// 轮询到任务失败时据此退款；refunded_at 非空=已退过，保证反复轮询只退一次。
type VideoRefund struct {
	TaskID           string `json:"taskId" gorm:"primaryKey"` // 上游返回的视频任务 id
	UserID           string `json:"userId" gorm:"index"`
	ProjectID        string `json:"projectId"` // 非空=扣的是项目积分池
	Model            string `json:"model"`
	Credits          int    `json:"credits"`          // 当初扣的积分（退款金额）
	ChargedToProject bool   `json:"chargedToProject"` // true=从项目池扣，退项目；false=退个人
	CreatedAt        string `json:"createdAt"`
	RefundedAt       string `json:"refundedAt"` // 非空=已退款（幂等标记）

	// 以下三个是「把成片放回画布原位」所需的上下文，提交时由客户端带上。
	//
	// 为什么必须在【提交那一刻】记下来：救援发生时，客户端可能早就关掉了，
	// 而那个正在转圈的节点如果还没同步上云，服务端翻遍云端画布也找不到它 ——
	// 只能退而求其次丢进「我的素材」，用户还得自己去翻。
	// 有了这三个字段，服务端可以直接在原画布、原位置、用原节点 id 把成片放回去。
	// 用【原节点 id】是关键：用户浏览器下次同步上来时，合并看到的是同一个节点，
	// 会被服务端这份覆盖，而不是多出一个重复节点。
	CanvasID string `json:"canvasId"` // 画布清单里的 project id（= CanvasProject.id）
	NodeID   string `json:"nodeId"`   // 那个视频节点的 id
	NodeGeom string `json:"nodeGeom"` // 位置与尺寸 {"x":..,"y":..,"w":..,"h":..}，原样回填
}
