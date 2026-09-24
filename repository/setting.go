package repository

import (
	"encoding/json"
	"log"

	"aicanvas/model"
	"gorm.io/gorm/clause"
)

// GetSettings 返回 public 和 private 两行配置。
func GetSettings() (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return model.Settings{}, err
	}
	var items []model.Setting
	if err := db.Find(&items).Error; err != nil {
		return model.Settings{}, err
	}
	result := model.Settings{}
	for _, item := range items {
		if item.Key == model.SettingKeyPrivate {
			if err := json.Unmarshal(item.Value, &result.Private); err != nil {
				log.Printf("settings: 解析 private 配置失败（配置可能损坏）: %v", err)
			}
		} else if item.Key == model.SettingKeyPublic {
			if err := json.Unmarshal(item.Value, &result.Public); err != nil {
				log.Printf("settings: 解析 public 配置失败（配置可能损坏）: %v", err)
			}
		}
	}
	return result, nil
}

// SaveSettings 保存 public 和 private 两行配置。
func SaveSettings(settings model.Settings, now string) (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return settings, err
	}
	publicValue, _ := json.Marshal(settings.Public)
	privateValue, _ := json.Marshal(settings.Private)
	items := []model.Setting{
		{Key: model.SettingKeyPublic, Value: publicValue, CreatedAt: now, UpdatedAt: now},
		{Key: model.SettingKeyPrivate, Value: privateValue, CreatedAt: now, UpdatedAt: now},
	}
	err = db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&items).Error
	return settings, err
}
