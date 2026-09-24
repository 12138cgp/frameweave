package repository

import (
	"time"

	"aicanvas/model"
)

func CreateGroupStyle(item model.GroupStyle) (model.GroupStyle, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	now := time.Now().Format(time.RFC3339)
	if item.CreatedAt == "" {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	if err := db.Create(&item).Error; err != nil {
		return item, err
	}
	return item, nil
}

// ListGroupStyles 取某组的全部共享风格，新的在前。
func ListGroupStyles(groupID string) ([]model.GroupStyle, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.GroupStyle
	if err := db.Where("group_id = ?", groupID).Order("created_at DESC").Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

func GetGroupStyleByID(id string) (model.GroupStyle, error) {
	db, err := DB()
	if err != nil {
		return model.GroupStyle{}, err
	}
	var item model.GroupStyle
	if err := db.Where("id = ?", id).First(&item).Error; err != nil {
		return model.GroupStyle{}, err
	}
	return item, nil
}

// FindGroupStyleBySource 同一个个人风格在同一组里只允许有一份共享，用于分享时去重（重复分享=更新）。
func FindGroupStyleBySource(groupID, sourceStyleID string) (model.GroupStyle, bool, error) {
	db, err := DB()
	if err != nil {
		return model.GroupStyle{}, false, err
	}
	var item model.GroupStyle
	err = db.Where("group_id = ? AND source_style_id = ?", groupID, sourceStyleID).First(&item).Error
	if err != nil {
		return model.GroupStyle{}, false, nil
	}
	return item, true, nil
}

func UpdateGroupStyle(item model.GroupStyle) error {
	db, err := DB()
	if err != nil {
		return err
	}
	item.UpdatedAt = time.Now().Format(time.RFC3339)
	return db.Model(&model.GroupStyle{}).Where("id = ?", item.ID).Updates(map[string]any{
		"name_zh":           item.NameZh,
		"description":       item.Description,
		"prefix_prompt":     item.PrefixPrompt,
		"inject_prompt":     item.InjectPrompt,
		"negative_prompt":   item.NegativePrompt,
		"preview_url":       item.PreviewURL,
		"preview_mime_type": item.PreviewMimeType,
		"updated_at":        item.UpdatedAt,
	}).Error
}

func DeleteGroupStyle(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("id = ?", id).Delete(&model.GroupStyle{}).Error
}
