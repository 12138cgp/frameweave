package model

type UserRole string

const (
	UserRoleGuest   UserRole = "guest"
	UserRoleUser    UserRole = "user"
	UserRoleAdmin   UserRole = "admin"
	UserRoleAdminL2 UserRole = "admin_l2"
)

type UserStatus string

const (
	UserStatusActive UserStatus = "active"
	UserStatusBan    UserStatus = "ban"
)

// User 系统用户。
type User struct {
	ID          string     `json:"id" gorm:"primaryKey"`
	Username    string     `json:"username" gorm:"uniqueIndex"`
	Password    string     `json:"-"`
	Email       string     `json:"email"`
	Phone       string     `json:"phone" gorm:"index"`
	DisplayName string     `json:"displayName"`
	AvatarURL   string     `json:"avatarUrl"`
	Role        UserRole   `json:"role"`
	Credits     int        `json:"credits"`
	AffCode     string     `json:"affCode" gorm:"uniqueIndex"`
	Status      UserStatus `json:"status"`
	// SessionID 当前有效会话：每次登录旋转，旧设备的 token 立即失效（单设备登录）。
	SessionID string `json:"-"`
	// GroupID 所属分组：决定调用 AI / 人像资产所用的凭证，由管理员分配。
	GroupID string `json:"groupId" gorm:"index"`
	// ChannelKeys 用户级渠道 API Key 覆盖：JSON map「渠道名 → apiKey」。
	// 发上游时若该用户对命中的渠道配了覆盖 key 则用它、否则回退团队渠道自带的 key
	// （仅覆盖 key，渠道地址/协议/模型路由/计费均不变）。空=全部用团队的。仅管理员可配。
	ChannelKeys string `json:"channelKeys" gorm:"type:text"`
	// PriceOverride 二级管理员价格覆盖（仅 admin_l2 用户上有意义）：JSON=PriceOverridePayload。
	// 计费时该二级管理员本人及其下辖用户，对覆盖里列出的模型用覆盖价、未列出的模型用全局默认价。空=全部用默认。仅超管可配。
	PriceOverride string `json:"priceOverride" gorm:"type:text"`
	// CreatorID 创建该用户的二级管理员 ID：空=超管创建/自助注册。
	CreatorID   string `json:"creatorId" gorm:"index"`
	LastLoginAt string `json:"lastLoginAt"`
	Extra       string `json:"extra" gorm:"type:text"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

// UserList 用户分页结果。
type UserList struct {
	Items []User `json:"items"`
	Total int    `json:"total"`
}

// AuthUser 用户公开信息。
type AuthUser struct {
	ID          string   `json:"id"`
	Username    string   `json:"username"`
	DisplayName string   `json:"displayName"`
	AvatarURL   string   `json:"avatarUrl"`
	Role        UserRole `json:"role"`
	Credits     int      `json:"credits"`
	GroupID     string   `json:"groupId"`
	CreatedAt   string   `json:"createdAt"`
	UpdatedAt   string   `json:"updatedAt"`
}

// AuthSession 登录会话信息。
type AuthSession struct {
	Token string   `json:"token"`
	User  AuthUser `json:"user"`
}

func PublicUser(user User) AuthUser {
	return AuthUser{
		ID:          user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		AvatarURL:   user.AvatarURL,
		Role:        user.Role,
		Credits:     user.Credits,
		GroupID:     user.GroupID,
		CreatedAt:   user.CreatedAt,
		UpdatedAt:   user.UpdatedAt,
	}
}

type CreditLogType string

const (
	CreditLogTypeAdminAdjust CreditLogType = "admin_adjust"
	CreditLogTypeAIConsume   CreditLogType = "ai_consume"
	CreditLogTypeAIRefund    CreditLogType = "ai_refund"
)

// CreditLog 用户点数变更流水。
type CreditLog struct {
	ID        string        `json:"id" gorm:"primaryKey"`
	UserID    string        `json:"userId" gorm:"index"`
	Type      CreditLogType `json:"type"`
	Amount    int           `json:"amount"`
	Balance   int           `json:"balance"`
	RelatedID string        `json:"relatedId"`
	// ProjectID 非空=该笔流水属于某项目积分池消费/退款（个人积分流水为空）。
	ProjectID string `json:"projectId" gorm:"column:project_id"`
	// OperatorID 非空=该笔流水由某管理员手动调整产生（记录操作管理员的 user id；系统消费/退款为空）。
	OperatorID string `json:"operatorId" gorm:"column:operator_id"`
	Remark     string `json:"remark"`
	Extra      string `json:"extra" gorm:"type:text"`
	CreatedAt  string `json:"createdAt"`
}

type CreditLogList struct {
	Items []CreditLog `json:"items"`
	Total int         `json:"total"`
}

// CreditLogSummary 当前筛选条件下的积分流水汇总（顶部总数）。
// Consume=总消费(正数，对 ai_consume 取相反数累加)、Refund=总返还、Adjust=后台调整净额、Net=净消耗(消费−返还)、Count=笔数。
type CreditLogSummary struct {
	Consume int   `json:"consume"`
	Refund  int   `json:"refund"`
	Adjust  int   `json:"adjust"`
	Net     int   `json:"net"`
	Count   int64 `json:"count"`
}

// CreditLogMemberStat 按成员维度的积分用量汇总（每个成员一行）。
type CreditLogMemberStat struct {
	UserID   string `json:"userId"`
	UserName string `json:"userName"`
	Consume  int    `json:"consume"`
	Refund   int    `json:"refund"`
	Adjust   int    `json:"adjust"`
	Net      int    `json:"net"`
	Count    int    `json:"count"`
}

// CreditLogModelStat 按模型维度的积分用量汇总（每个模型一行；模型名从流水 extra JSON 解析，空=后台调整/无模型）。
type CreditLogModelStat struct {
	Model   string `json:"model"`
	Consume int    `json:"consume"`
	Refund  int    `json:"refund"`
	Adjust  int    `json:"adjust"`
	Net     int    `json:"net"`
	Count   int    `json:"count"`
}
