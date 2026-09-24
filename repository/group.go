package repository

import (
	"time"

	"aicanvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

func ListGroups() ([]model.Group, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.Group
	err = db.Order("created_at asc").Find(&items).Error
	return items, err
}

// ListGroupsByOwner 仅返回某二级管理员拥有的分组。
func ListGroupsByOwner(ownerID string) ([]model.Group, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.Group
	err = db.Where("owner_id = ?", ownerID).Order("created_at asc").Find(&items).Error
	return items, err
}

func GetGroupByID(id string) (model.Group, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Group{}, false, err
	}
	var item model.Group
	err = db.Where("id = ?", id).Limit(1).Find(&item).Error
	return item, item.ID != "", err
}

func SaveGroup(group model.Group) (model.Group, error) {
	db, err := DB()
	if err != nil {
		return group, err
	}
	now := time.Now().Format(time.RFC3339)
	if group.ID == "" {
		group.ID = uuid.NewString()
		group.CreatedAt = now
	}
	group.UpdatedAt = now
	return group, db.Save(&group).Error
}

// DeleteGroup 删除分组并把该组用户清为未分组。两步放进同一事务，
// 避免「清了 group_id 但删组失败」或中途崩溃导致的孤儿用户/数据不一致。
func DeleteGroup(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.User{}).Where("group_id = ?", id).Update("group_id", "").Error; err != nil {
			return err
		}
		return tx.Delete(&model.Group{}, "id = ?", id).Error
	})
}
