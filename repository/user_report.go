package repository

import (
	"errors"
	"strings"

	"gorm.io/gorm"

	"aicanvas/model"
)

// CreateUserReport 落一条反馈。
func CreateUserReport(report *model.UserReport) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(report).Error
}

// GetUserReport 按 ID 取一条（含日志字节）。
func GetUserReport(id int64) (model.UserReport, bool, error) {
	db, err := DB()
	if err != nil {
		return model.UserReport{}, false, err
	}
	var report model.UserReport
	if err := db.Where("id = ?", id).First(&report).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return model.UserReport{}, false, nil
		}
		return model.UserReport{}, false, err
	}
	return report, true, nil
}

// UserReportFilter 后台列表筛选条件。
type UserReportFilter struct {
	// UserIDs 非 nil 时限定这批用户（二级管理员只看下辖；空切片表示「一个都不该看到」）。
	UserIDs  []string
	Status   string
	Category string
	Keyword  string
	Start    string
	End      string
}

// ListUserReports 分页列出反馈。
//
// ⚠️ 刻意 Omit 掉 log_gzip：列表页一次 20 条、每条日志几百 KB，不排除就是每次翻页几十 MB
// 白读白传。日志只在打开详情时按 ID 单独取。
func ListUserReports(filter UserReportFilter, q model.Query) ([]model.UserReport, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()

	tx := db.Model(&model.UserReport{})
	if filter.UserIDs != nil {
		if len(filter.UserIDs) == 0 {
			return []model.UserReport{}, 0, nil
		}
		tx = tx.Where("user_id IN (?)", filter.UserIDs)
	}
	if status := strings.TrimSpace(filter.Status); status != "" {
		tx = tx.Where("status = ?", status)
	}
	if category := strings.TrimSpace(filter.Category); category != "" {
		tx = tx.Where("category = ?", category)
	}
	if start := strings.TrimSpace(filter.Start); start != "" {
		tx = tx.Where("created_at >= ?", start)
	}
	if end := strings.TrimSpace(filter.End); end != "" {
		tx = tx.Where("created_at <= ?", end)
	}
	if keyword := strings.TrimSpace(filter.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("username LIKE ? OR description LIKE ? OR canvas_title LIKE ?", like, like, like)
	}

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if total == 0 {
		return []model.UserReport{}, 0, nil
	}

	var items []model.UserReport
	err = tx.Omit("log_gzip").Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

// UpdateUserReportStatus 管理员处理反馈：改状态、写备注、记处理人。
func UpdateUserReportStatus(id int64, status string, note string, handlerID string, handledAt string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	updates := map[string]any{
		"status":     status,
		"admin_note": note,
		"handler_id": handlerID,
		"handled_at": handledAt,
		"updated_at": handledAt,
	}
	return db.Model(&model.UserReport{}).Where("id = ?", id).Updates(updates).Error
}

// CountOpenUserReports 待处理数量，给后台菜单角标用。
// 与列表同一套归属过滤，否则二级管理员会看到一个自己点不开的数字。
func CountOpenUserReports(userIDs []string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	tx := db.Model(&model.UserReport{}).Where("status = ?", string(model.UserReportStatusOpen))
	if userIDs != nil {
		if len(userIDs) == 0 {
			return 0, nil
		}
		tx = tx.Where("user_id IN (?)", userIDs)
	}
	var total int64
	err = tx.Count(&total).Error
	return total, err
}

// ListMyUserReports 用户看自己提过的反馈（不含日志字节）。
func ListMyUserReports(userID string, q model.Query) ([]model.UserReport, int64, error) {
	return ListUserReports(UserReportFilter{UserIDs: []string{userID}}, q)
}

// CountRecentUserReportsBy 统计某用户最近提了几条，用于限流。
func CountRecentUserReportsBy(userID string, since string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var total int64
	err = db.Model(&model.UserReport{}).Where("user_id = ? AND created_at >= ?", userID, since).Count(&total).Error
	return total, err
}
