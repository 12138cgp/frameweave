package repository

import (
	"strings"

	"aicanvas/model"
)

// SaveUserAuditLog 落一条「改用户」审计。
//
// ⚠️ 调用方必须把错误当成「可以忽略」处理：审计是旁路，绝不能让用户保存因为它失败。
func SaveUserAuditLog(item model.UserAuditLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&item).Error
}

// ListUserAuditLogs 查审计。三个筛选都可留空。
//
//   - targetUserID 只看某个用户被改的历史（排查「他密码是谁改的」用这个）
//   - operatorID   只看某个管理员干了什么
//   - keyword      模糊匹配被改用户名 / 操作人名 / 变更内容
//
// 结果按时间倒序。limit 上限 500，防止一次拉爆。
func ListUserAuditLogs(targetUserID, operatorID, keyword string, page, pageSize int) ([]model.UserAuditLog, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	tx := db.Model(&model.UserAuditLog{})
	if v := strings.TrimSpace(targetUserID); v != "" {
		tx = tx.Where("target_user_id = ?", v)
	}
	if v := strings.TrimSpace(operatorID); v != "" {
		tx = tx.Where("operator_id = ?", v)
	}
	if v := strings.TrimSpace(keyword); v != "" {
		like := "%" + v + "%"
		tx = tx.Where("target_username LIKE ? OR operator_name LIKE ? OR changes LIKE ?", like, like, like)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if pageSize <= 0 || pageSize > 500 {
		pageSize = 50
	}
	if page <= 0 {
		page = 1
	}
	var items []model.UserAuditLog
	err = tx.Order("created_at desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&items).Error
	if err != nil {
		return nil, 0, err
	}
	return items, total, nil
}
