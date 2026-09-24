package repository

import (
	"strings"

	"aicanvas/model"
)

// CreateSmsLog 写入一条短信发送记录。
func CreateSmsLog(log model.SmsLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&log).Error
}

// ListSmsLogs 管理员查询短信发送记录（支持时间/状态/关键词/IP 过滤 + 分页）。
// q.Type 复用为状态筛选，q.Keyword 模糊匹配 phone 或 template_id，q.IP 精确匹配客户端 IP。
func ListSmsLogs(q model.Query) ([]model.SmsLog, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.SmsLog{})

	if start := strings.TrimSpace(q.Start); start != "" {
		tx = tx.Where("created_at >= ?", start)
	}
	if end := strings.TrimSpace(q.End); end != "" {
		tx = tx.Where("created_at <= ?", end)
	}
	if status := strings.TrimSpace(q.Type); status != "" {
		tx = tx.Where("status = ?", status)
	}
	if k := strings.TrimSpace(q.Keyword); k != "" {
		like := "%" + k + "%"
		tx = tx.Where("phone LIKE ? OR template_id LIKE ?", like, like)
	}
	if ip := strings.TrimSpace(q.IP); ip != "" {
		tx = tx.Where("ip = ?", ip)
	}

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if total == 0 {
		return []model.SmsLog{}, 0, nil
	}

	var logs []model.SmsLog
	err = tx.Order("created_at desc, id desc").Offset(q.Offset()).Limit(q.PageSize).Find(&logs).Error
	return logs, total, err
}

// CountSmsLogsByPhoneSince 统计某手机号自 since（RFC3339）起的发送尝试数（含 success/failed/skipped 三种状态）。
// 用于每日单手机号发送上限校验。
func CountSmsLogsByPhoneSince(phone, since string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var count int64
	err = db.Model(&model.SmsLog{}).Where("phone = ? AND created_at >= ?", phone, since).Count(&count).Error
	return count, err
}

// CountSmsLogsByIPSince 统计某 IP 自 since（RFC3339）起的发送尝试数。
// 用于每日单 IP 发送上限校验。
func CountSmsLogsByIPSince(ip, since string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var count int64
	err = db.Model(&model.SmsLog{}).Where("ip = ? AND created_at >= ?", ip, since).Count(&count).Error
	return count, err
}

// GetSmsLogSummary 短信发送记录汇总（成功/失败/跳过条数 + 总记录数 + 不同 IP 数）。
func GetSmsLogSummary(start, end, status, keyword, ip string) (model.SmsLogSummary, error) {
	db, err := DB()
	if err != nil {
		return model.SmsLogSummary{}, err
	}

	query := `SELECT
		COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
		COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
		COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped_count,
		COUNT(*) AS total_count,
		COUNT(DISTINCT NULLIF(ip, '')) AS ip_count
		FROM mp_sms_log WHERE 1=1`
	args := []interface{}{}
	if status = strings.TrimSpace(status); status != "" {
		query += " AND status = ?"
		args = append(args, status)
	}
	if start = strings.TrimSpace(start); start != "" {
		query += " AND created_at >= ?"
		args = append(args, start)
	}
	if end = strings.TrimSpace(end); end != "" {
		query += " AND created_at <= ?"
		args = append(args, end)
	}
	if k := strings.TrimSpace(keyword); k != "" {
		like := "%" + k + "%"
		query += " AND (phone LIKE ? OR template_id LIKE ?)"
		args = append(args, like, like)
	}
	if ip = strings.TrimSpace(ip); ip != "" {
		query += " AND ip = ?"
		args = append(args, ip)
	}

	var summary model.SmsLogSummary
	err = db.Raw(query, args...).Scan(&summary).Error
	return summary, err
}
