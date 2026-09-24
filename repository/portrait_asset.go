package repository

import (
	"aicanvas/model"
	"gorm.io/gorm"
)

// SavePortraitAsset 保存或更新人像资产记录，更新时保留原创建时间。
func SavePortraitAsset(item model.PortraitAsset) (model.PortraitAsset, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	if saved, ok, err := findPortraitAsset(db, item.ID); err != nil {
		return item, err
	} else if ok && item.CreatedAt == "" {
		item.CreatedAt = saved.CreatedAt
	}
	return item, db.Save(&item).Error
}

// GetPortraitAsset 按 ID 查询人像资产记录。
func GetPortraitAsset(id string) (model.PortraitAsset, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PortraitAsset{}, false, err
	}
	return findPortraitAsset(db, id)
}

// ListPortraitAssets 返回某用户的全部人像资产记录（按更新时间倒序）。
func ListPortraitAssets(userID string) ([]model.PortraitAsset, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.PortraitAsset
	err = db.Where("user_id = ?", userID).Order("updated_at desc").Find(&items).Error
	return items, err
}

// ListProcessingPortraitAssets 返回所有仍在审核中的人像资产，供定时轮询推进状态。
func ListProcessingPortraitAssets() ([]model.PortraitAsset, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.PortraitAsset
	err = db.Where("status = ?", model.PortraitAssetProcessing).Find(&items).Error
	return items, err
}

// FindPortraitAssetByStorageKey 按用户与本地素材 storageKey 查找已入库记录，用于去重。
func FindPortraitAssetByStorageKey(userID string, storageKey string) (model.PortraitAsset, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PortraitAsset{}, false, err
	}
	if storageKey == "" {
		return model.PortraitAsset{}, false, nil
	}
	var item model.PortraitAsset
	err = db.Where("user_id = ? AND storage_key = ?", userID, storageKey).Order("updated_at desc").First(&item).Error
	if err == gorm.ErrRecordNotFound {
		return model.PortraitAsset{}, false, nil
	}
	if err != nil {
		return model.PortraitAsset{}, false, err
	}
	return item, true, nil
}

// ListPortraitAssetsByAssetIDs 按火山资产 ID 批量查该用户的记录。
// 一次查完，别在循环里逐条查库——一个视频请求可能引用十几张参考图。
func ListPortraitAssetsByAssetIDs(userID string, assetIDs []string) ([]model.PortraitAsset, error) {
	if len(assetIDs) == 0 {
		return nil, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.PortraitAsset
	err = db.Where("user_id = ? AND asset_id IN ?", userID, assetIDs).Find(&items).Error
	return items, err
}

// FindPortraitAssetByContentHash 按用户与图片内容指纹查找已入库记录，用于按内容去重。
func FindPortraitAssetByContentHash(userID string, contentHash string) (model.PortraitAsset, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PortraitAsset{}, false, err
	}
	if contentHash == "" {
		return model.PortraitAsset{}, false, nil
	}
	var item model.PortraitAsset
	err = db.Where("user_id = ? AND content_hash = ?", userID, contentHash).Order("updated_at desc").First(&item).Error
	if err == gorm.ErrRecordNotFound {
		return model.PortraitAsset{}, false, nil
	}
	if err != nil {
		return model.PortraitAsset{}, false, err
	}
	return item, true, nil
}

// DeletePortraitAsset 删除指定人像资产记录。
func DeletePortraitAsset(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.PortraitAsset{}, "id = ?", id).Error
}

func findPortraitAsset(db *gorm.DB, id string) (model.PortraitAsset, bool, error) {
	var item model.PortraitAsset
	err := db.First(&item, "id = ?", id).Error
	if err == gorm.ErrRecordNotFound {
		return model.PortraitAsset{}, false, nil
	}
	if err != nil {
		return model.PortraitAsset{}, false, err
	}
	return item, true, nil
}
