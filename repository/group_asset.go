package repository

import (
	"time"

	"aicanvas/model"
	"github.com/google/uuid"
)

func CreateGroupAsset(asset model.GroupAsset) (model.GroupAsset, error) {
	db, err := DB()
	if err != nil {
		return asset, err
	}
	if asset.ID == "" {
		asset.ID = uuid.NewString()
	}
	if asset.CreatedAt == "" {
		asset.CreatedAt = time.Now().Format(time.RFC3339)
	}
	err = db.Create(&asset).Error
	return asset, err
}

func ListGroupAssets(groupID string) ([]model.GroupAsset, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.GroupAsset
	err = db.Where("group_id = ?", groupID).Order("created_at DESC").Find(&items).Error
	return items, err
}

func GetGroupAssetByID(id string) (model.GroupAsset, error) {
	db, err := DB()
	if err != nil {
		return model.GroupAsset{}, err
	}
	var item model.GroupAsset
	err = db.Where("id = ?", id).Limit(1).Find(&item).Error
	return item, err
}

func DeleteGroupAsset(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("id = ?", id).Delete(&model.GroupAsset{}).Error
}
