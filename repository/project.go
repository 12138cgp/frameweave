package repository

import (
	"errors"
	"time"

	"aicanvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

func ListProjects() ([]model.Project, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.Project
	err = db.Order("created_at asc").Find(&items).Error
	return items, err
}

// ListProjectsByOwner 仅返回某 admin/admin_l2 拥有的项目。
func ListProjectsByOwner(ownerID string) ([]model.Project, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.Project
	err = db.Where("owner_id = ?", ownerID).Order("created_at asc").Find(&items).Error
	return items, err
}

func GetProjectByID(id string) (model.Project, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Project{}, false, err
	}
	var item model.Project
	err = db.Where("id = ?", id).Limit(1).Find(&item).Error
	return item, item.ID != "", err
}

// SaveProject 新建时生成 uuid + CreatedAt；编辑时仅更新 UpdatedAt（整条 db.Save）。
func SaveProject(p model.Project) (model.Project, error) {
	db, err := DB()
	if err != nil {
		return p, err
	}
	now := time.Now().Format(time.RFC3339)
	if p.ID == "" {
		p.ID = uuid.NewString()
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	return p, db.Save(&p).Error
}

// DeleteProject 删项目并删该项目全部成员（同事务）。
func DeleteProject(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.ProjectMember{}, "project_id = ?", id).Error; err != nil {
			return err
		}
		return tx.Delete(&model.Project{}, "id = ?", id).Error
	})
}

func ListProjectMemberUserIDs(projectID string) ([]string, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var rows []model.ProjectMember
	if err := db.Select("user_id").Where("project_id = ?", projectID).Find(&rows).Error; err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.UserID)
	}
	return ids, nil
}

// SetProjectMembers 全量替换某项目成员（删旧增新，同事务）。
func SetProjectMembers(projectID string, userIDs []string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	now := time.Now().Format(time.RFC3339)
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.ProjectMember{}, "project_id = ?", projectID).Error; err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, uid := range userIDs {
			if uid == "" || seen[uid] {
				continue
			}
			seen[uid] = true
			m := model.ProjectMember{
				ID:        uuid.NewString(),
				ProjectID: projectID,
				UserID:    uid,
				CreatedAt: now,
			}
			if err := tx.Create(&m).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func IsProjectMember(projectID, userID string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	err = db.Model(&model.ProjectMember{}).Where("project_id = ? AND user_id = ?", projectID, userID).Count(&count).Error
	return count > 0, err
}

// ListProjectsForUser 返回用户参与（作为成员）的全部项目。
func ListProjectsForUser(userID string) ([]model.Project, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var ids []string
	if err := db.Model(&model.ProjectMember{}).
		Where("user_id = ?", userID).
		Distinct().Pluck("project_id", &ids).Error; err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return []model.Project{}, nil
	}
	var items []model.Project
	err = db.Where("id IN (?)", ids).Order("created_at asc").Find(&items).Error
	return items, err
}

// ConsumeProjectCreditsTx 项目积分扣费与流水写入同事务（镜像 ConsumeUserCreditsTx 的原子写法）。
// 池不足时返回 ok=false 且不扣不记。log.Balance 由本函数按扣后池剩余填充。
// SettleConsumeProjectCreditsTx 项目池的结算补扣：不校验余额，允许扣成负数。
// 理由同 repository.SettleConsumeUserCreditsTx——产物已交付，账必须如实记。
func SettleConsumeProjectCreditsTx(projectID, userID string, credits int, at string, log model.CreditLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	if credits <= 0 {
		return nil
	}
	return db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.Project{}).Where("id = ?", projectID).Updates(map[string]any{
			"credits":    gorm.Expr("credits - ?", credits),
			"updated_at": at,
		})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errors.New("项目不存在")
		}
		var p model.Project
		if err := tx.Where("id = ?", projectID).First(&p).Error; err != nil {
			return err
		}
		log.Balance = p.Credits
		return tx.Save(&log).Error
	})
}

func ConsumeProjectCreditsTx(projectID, userID string, credits int, at string, log model.CreditLog) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	if credits <= 0 {
		return true, nil
	}
	ok := false
	err = db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.Project{}).Where("id = ? AND credits >= ?", projectID, credits).Updates(map[string]any{
			"credits":    gorm.Expr("credits - ?", credits),
			"updated_at": at,
		})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil // 池不足：不扣不记
		}
		ok = true
		var p model.Project
		if err := tx.Where("id = ?", projectID).First(&p).Error; err != nil {
			return err
		}
		log.Balance = p.Credits
		return tx.Save(&log).Error
	})
	if err != nil {
		return false, err
	}
	return ok, nil
}

// RefundProjectCreditsTx 项目积分退款与流水写入同事务。
func RefundProjectCreditsTx(projectID, userID string, credits int, at string, log model.CreditLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	if credits <= 0 {
		return nil
	}
	return db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.Project{}).Where("id = ?", projectID).Updates(map[string]any{
			"credits":    gorm.Expr("credits + ?", credits),
			"updated_at": at,
		})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil // 项目不存在：不退不记
		}
		var p model.Project
		if err := tx.Where("id = ?", projectID).First(&p).Error; err != nil {
			return err
		}
		log.Balance = p.Credits
		return tx.Save(&log).Error
	})
}

// CountProjectCanvases 统计某项目下生成任务涉及的去重画布数（canvas_id 非空）。
func CountProjectCanvases(projectID string) (int, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var count int64
	err = db.Model(&model.GenerationJob{}).
		Where("project_id = ? AND canvas_id <> ''", projectID).
		Distinct("canvas_id").
		Count(&count).Error
	return int(count), err
}

// ProjectMemberUsage 返回某项目内 user_id -> 净消耗积分 的映射。
// 净消耗 = -(SUM(amount))：consume 为负、refund 为正，取负后即净扣除值。
// 仅返回有流水的成员；无流水的成员由上层补 used=0。
func ProjectMemberUsage(projectID string) (map[string]int, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	type row struct {
		UserID string
		Used   int
	}
	var rows []row
	err = db.Model(&model.CreditLog{}).
		Select("user_id, -SUM(amount) AS used").
		Where("project_id = ?", projectID).
		Group("user_id").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	usage := make(map[string]int, len(rows))
	for _, r := range rows {
		usage[r.UserID] = r.Used
	}
	return usage, nil
}

// AdjustProjectCredits 管理员调整项目积分：delta>0 同时累加 credits_total（加额度）。
func AdjustProjectCredits(projectID string, delta int) error {
	db, err := DB()
	if err != nil {
		return err
	}
	if delta == 0 {
		return nil
	}
	updates := map[string]any{
		"credits":    gorm.Expr("credits + ?", delta),
		"updated_at": time.Now().Format(time.RFC3339),
	}
	if delta > 0 {
		updates["credits_total"] = gorm.Expr("credits_total + ?", delta)
	}
	return db.Model(&model.Project{}).Where("id = ?", projectID).Updates(updates).Error
}
