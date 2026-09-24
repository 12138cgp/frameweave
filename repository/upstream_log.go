package repository

import (
	"strings"
	"time"

	"aicanvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// SaveUpstreamLog 持久化一条上游 LogID 记录;ID 空则生成 uuid、CreatedAt 空则填 now。
func SaveUpstreamLog(entry model.UpstreamLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	if entry.ID == "" {
		entry.ID = uuid.NewString()
	}
	if entry.CreatedAt == "" {
		entry.CreatedAt = time.Now().Format(time.RFC3339)
	}
	return db.Create(&entry).Error
}

// UpdateUpstreamLogTaskID 视频提交拿到上游 cgt 任务号后,回填到本次 trace 的日志行(best-effort、幂等:只填空的)。
func UpdateUpstreamLogTaskID(traceID, taskID string) error {
	if traceID == "" || taskID == "" {
		return nil
	}
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.UpstreamLog{}).Where("trace_id = ? AND task_id = ?", traceID, "").Update("task_id", taskID).Error
}

// UpdateUpstreamLogResultURL 视频转存到 TOS 得到永久地址后,前端回传、按 task_id(cgt) 回填到本次日志行
// (限本人、best-effort、纯观测:便于后台内联播放成片,不碰扣费)。
func UpdateUpstreamLogResultURL(userID, taskID, url string) error {
	taskID = strings.TrimSpace(taskID)
	url = strings.TrimSpace(url)
	if taskID == "" || url == "" {
		return nil
	}
	db, err := DB()
	if err != nil {
		return err
	}
	tx := db.Model(&model.UpstreamLog{}).Where("task_id = ?", taskID)
	if userID != "" {
		tx = tx.Where("user_id = ?", userID)
	}
	return tx.Update("result_url", url).Error
}

// VideoResultURLByTask 取该任务已回填的成片永久地址（非空即说明客户端调过 /media/persist 存过桶）。
// 供孤儿视频兜底扫描判断「客户端是否已经拿到」——查无记录返回空串、不算错误。
func VideoResultURLByTask(userID, taskID string) (string, error) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return "", nil
	}
	db, err := DB()
	if err != nil {
		return "", err
	}
	var urls []string
	tx := db.Model(&model.UpstreamLog{}).Where("task_id = ?", taskID)
	if userID != "" {
		tx = tx.Where("user_id = ?", userID)
	}
	if err := tx.Where("result_url IS NOT NULL AND result_url != ''").
		Limit(1).Pluck("result_url", &urls).Error; err != nil {
		return "", err
	}
	if len(urls) == 0 {
		return "", nil
	}
	return urls[0], nil
}

// BackfillVideoDuration 视频轮询到成功时回填生成用时(ms = now - 提交时刻 created_at)。
// 幂等:只填 duration_ms 仍为 0 的最近一行,首次成功即固定(前端反复轮询同一 succeeded 任务只写一次)。纯观测、不碰扣费。
func BackfillVideoDuration(taskID string) error {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return nil
	}
	db, err := DB()
	if err != nil {
		return err
	}
	var entry model.UpstreamLog
	if err := db.Model(&model.UpstreamLog{}).Where("task_id = ? AND duration_ms = 0", taskID).Order("created_at desc").Limit(1).Find(&entry).Error; err != nil {
		return err
	}
	if entry.ID == "" || entry.CreatedAt == "" {
		return nil
	}
	created, perr := time.Parse(time.RFC3339, entry.CreatedAt)
	if perr != nil {
		return nil
	}
	ms := int(time.Since(created).Milliseconds())
	if ms <= 0 {
		return nil
	}
	return db.Model(&model.UpstreamLog{}).Where("id = ?", entry.ID).Update("duration_ms", ms).Error
}

// GetTaskIDByTraceID 按 trace_id 查这次 AI 调用回填的上游 cgt 任务号（限本人、只取已回填 task_id 的最近一条）。
func GetTaskIDByTraceID(userID, traceID string) (string, error) {
	traceID = strings.TrimSpace(traceID)
	if traceID == "" {
		return "", nil
	}
	db, err := DB()
	if err != nil {
		return "", err
	}
	var entry model.UpstreamLog
	tx := db.Model(&model.UpstreamLog{}).Where("trace_id = ? AND task_id <> ''", traceID)
	if userID != "" {
		tx = tx.Where("user_id = ?", userID)
	}
	if err := tx.Order("created_at desc").Limit(1).Find(&entry).Error; err != nil {
		return "", err
	}
	return entry.TaskID, nil
}

// taskLogFilteredTx 「任务日志」筛选:只看代理请求(source=proxy),按关键词/用户/类型(kind)/模型/时间/成员过滤。
// 复用 model.Query,与积分日志同款口径,列表与将来的导出共用。
func taskLogFilteredTx(db *gorm.DB, q model.Query) *gorm.DB {
	tx := db.Model(&model.UpstreamLog{}).Where("source IN ?", []string{"proxy", "job"})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("user_id LIKE ? OR task_id LIKE ? OR log_id LIKE ? OR model LIKE ? OR request LIKE ?", like, like, like, like, like)
	}
	if q.UserIDs != nil {
		// 二级管理员只看自己子用户;子用户为空时 UserIDs 为非 nil 空切片,IN () 命中 0 条。
		tx = tx.Where("user_id IN (?)", q.UserIDs)
	}
	if t := strings.TrimSpace(q.Type); t != "" {
		tx = tx.Where("kind = ?", t)
	}
	if m := strings.TrimSpace(q.Model); m != "" {
		tx = tx.Where("model LIKE ?", "%"+m+"%")
	}
	if s := strings.TrimSpace(q.Start); s != "" {
		tx = tx.Where("created_at >= ?", s)
	}
	if e := strings.TrimSpace(q.End); e != "" {
		tx = tx.Where("created_at <= ?", e)
	}
	if mem := strings.TrimSpace(q.Member); mem != "" {
		like := "%" + mem + "%"
		sub := db.Model(&model.User{}).Select("id").Where("username LIKE ? OR id LIKE ?", like, like)
		tx = tx.Where("user_id IN (?)", sub)
	}
	return tx
}

// ListUpstreamLogs 任务日志分页列表(created_at 倒序)。
func ListUpstreamLogs(q model.Query) ([]model.UpstreamLog, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := taskLogFilteredTx(db, q)
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var logs []model.UpstreamLog
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&logs).Error
	return logs, total, err
}

// —— 「我的任务日志」点数/退款旁路批查(供 handler.MyTaskLogs 用) —— //

// TokenChargedCreditsByTraceIDs 按 trace_id 批查 token_logs 实扣点数(proxy 路径:文本/视频/音频每次调用一行)。
func TokenChargedCreditsByTraceIDs(traceIDs []string) (map[string]int, error) {
	out := map[string]int{}
	if len(traceIDs) == 0 {
		return out, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	type row struct {
		TraceID        string
		ChargedCredits int
	}
	for _, chunk := range chunkStringSlice(traceIDs, 400) {
		var rows []row
		if err := db.Model(&model.TokenLog{}).Select("trace_id, charged_credits").Where("trace_id IN ?", chunk).Scan(&rows).Error; err != nil {
			return nil, err
		}
		for _, r := range rows {
			out[r.TraceID] += r.ChargedCredits
		}
	}
	return out, nil
}

// GenerationJobCreditsByIDs 按 job id(=upstream_logs.trace_id,source=job)批查图片任务实扣点数。
func GenerationJobCreditsByIDs(ids []string) (map[string]int, error) {
	out := map[string]int{}
	if len(ids) == 0 {
		return out, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	type row struct {
		ID      string
		Credits int
	}
	for _, chunk := range chunkStringSlice(ids, 400) {
		var rows []row
		if err := db.Model(&model.GenerationJob{}).Select("id, credits").Where("id IN ?", chunk).Scan(&rows).Error; err != nil {
			return nil, err
		}
		for _, r := range rows {
			out[r.ID] = r.Credits
		}
	}
	return out, nil
}

// RefundedVideoTaskIDs 批查已退款(=视频生成失败)的 task_id 集合(与生成统计 video_refunds 同口径)。
func RefundedVideoTaskIDs(taskIDs []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(taskIDs) == 0 {
		return out, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	for _, chunk := range chunkStringSlice(taskIDs, 400) {
		var ids []string
		if err := db.Table("video_refunds").Select("task_id").Where("refunded_at <> '' AND task_id IN ?", chunk).Scan(&ids).Error; err != nil {
			return nil, err
		}
		for _, t := range ids {
			out[t] = true
		}
	}
	return out, nil
}
