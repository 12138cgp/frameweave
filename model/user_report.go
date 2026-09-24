package model

// 用户问题反馈。
//
// 目的很具体：用户说「我画布内容不见了 / 视频没了 / 一直提示同步失败」时，
// 管理员能只看这一条记录就还原出发生了什么，而不用再去翻数据库反推。
// 所以一条反馈 = 用户的话 + 客户端操作日志 + 客户端现场快照 + 【服务端自己抓的快照】。
//
// 服务端快照是刻意加的：客户端说什么都不算数。恰恰是「客户端以为自己传上去了」
// 这类问题最需要两边对照——「成片丢失」就是典型，
// 客户端一路顺利、字节也确实进了桶，只有服务端视角能看出用户数据里根本没有它。

// UserReportStatus 反馈处理状态。
type UserReportStatus string

const (
	UserReportStatusOpen     UserReportStatus = "open"     // 待处理
	UserReportStatusHandling UserReportStatus = "handling" // 处理中
	UserReportStatusClosed   UserReportStatus = "closed"   // 已处理
)

// UserReportCategory 问题类型。用户选，决定管理员先看哪一段日志。
type UserReportCategory string

const (
	UserReportCategoryCanvasLost UserReportCategory = "canvas_lost" // 画布或节点内容丢失
	UserReportCategoryMediaLost  UserReportCategory = "media_lost"  // 图片/视频丢失或打不开
	UserReportCategoryGenFailed  UserReportCategory = "gen_failed"  // 生成失败或长时间不出结果
	UserReportCategorySyncError  UserReportCategory = "sync_error"  // 同步异常
	UserReportCategoryCredits    UserReportCategory = "credits"     // 点数/计费有疑问
	UserReportCategorySlow       UserReportCategory = "slow"        // 卡顿或加载慢
	UserReportCategoryOther      UserReportCategory = "other"       // 其它
)

// IsUserReportCategory 校验前端传来的类型，不认识的一律归到 other，
// 不因为一个陌生字符串就拒收反馈——用户已经遇到问题了，不能连报都报不出来。
func IsUserReportCategory(value string) bool {
	switch UserReportCategory(value) {
	case UserReportCategoryCanvasLost, UserReportCategoryMediaLost, UserReportCategoryGenFailed,
		UserReportCategorySyncError, UserReportCategoryCredits, UserReportCategorySlow, UserReportCategoryOther:
		return true
	}
	return false
}

// UserReport 一条用户反馈。
type UserReport struct {
	ID int64 `json:"id" gorm:"primaryKey;autoIncrement"`

	UserID string `json:"userId" gorm:"index"`
	// Username / GroupID 冗余存一份：后台列表不用 join，且用户改名后仍能看到当时是谁报的。
	Username string `json:"username"`
	GroupID  string `json:"groupId" gorm:"index"`

	Category    string `json:"category" gorm:"index"`
	Description string `json:"description" gorm:"type:text"`
	Contact     string `json:"contact"`
	// 用户指认的「出问题的画布」，可空。
	CanvasID    string `json:"canvasId"`
	CanvasTitle string `json:"canvasTitle"`
	// 用户看到问题的大致时间（前端可让用户选，也可留空）。
	HappenedAt string `json:"happenedAt"`

	// ── 诊断包 ──
	// Env / Local 为客户端上报的 JSON 原文（浏览器环境、本机数据规模、素材对账）。
	Env   string `json:"env" gorm:"type:text"`
	Local string `json:"local" gorm:"type:text"`
	// Server 为服务端在收到反馈时自己抓的快照（云端各域体积、快照史、近期任务、近期同步失败）。
	Server string `json:"server" gorm:"type:text"`
	// LogGzip 为 gzip 压缩后的操作日志（JSON 数组）。
	// 压缩存是必须的：几千条日志原文 1~2MB，不压会让这张表迅速变成数据库里最大的表。
	// 不硬编码 type:blob：GORM 会按方言自动选 PG=bytea / MySQL=longblob / SQLite=BLOB。
	LogGzip   []byte `json:"-"`
	LogCount  int    `json:"logCount"`
	LogBytes  int    `json:"logBytes"`  // 压缩后字节
	RawBytes  int    `json:"rawBytes"`  // 压缩前字节
	Truncated bool   `json:"truncated"` // 日志是否因超限被截断（截断时保留最近的部分）

	Status    string `json:"status" gorm:"index"`
	AdminNote string `json:"adminNote" gorm:"type:text"`
	HandlerID string `json:"handlerId"`
	HandledAt string `json:"handledAt"`
	CreatedAt string `json:"createdAt" gorm:"index"`
	UpdatedAt string `json:"updatedAt"`
}

// TableName 指定表名为 mp_user_report（与项目其它业务表的 mp_ 前缀一致）。
func (UserReport) TableName() string {
	return "mp_user_report"
}
