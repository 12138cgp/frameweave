package model

// Project 项目级积分池：由 admin/admin_l2 创建，池内积分被项目成员共享消耗。
// Credits=剩余池，CreditsTotal=累计额度（已用=CreditsTotal-Credits）。
type Project struct {
	ID           string `json:"id" gorm:"primaryKey"`
	Name         string `json:"name"`
	OwnerID      string `json:"ownerId" gorm:"index"` // 创建该项目的 admin/admin_l2
	Credits      int    `json:"credits"`              // 剩余池
	CreditsTotal int    `json:"creditsTotal"`         // 累计额度
	Status       string `json:"status"`               // active | disabled
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
}

const (
	ProjectStatusActive   = "active"
	ProjectStatusDisabled = "disabled"
)

// ProjectMember 项目成员：决定哪些用户可消耗该项目积分池。
type ProjectMember struct {
	ID        string `json:"id" gorm:"primaryKey"`
	ProjectID string `json:"projectId" gorm:"index"`
	UserID    string `json:"userId" gorm:"index"`
	CreatedAt string `json:"createdAt"`
}
