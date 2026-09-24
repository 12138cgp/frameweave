package repository

import (
	"strings"
	"time"

	"aicanvas/model"
	"github.com/google/uuid"
)

// SaveTokenLog 持久化一条 token / 计量观测日志；ID 空则生成 uuid、CreatedAt 空则填 now。
// best-effort：调用方在异步协程里调用，写失败只记 log、不影响响应。
func SaveTokenLog(entry model.TokenLog) error {
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

// BackfillVideoTokenUsage 视频完成后据上游任务号(cgt)把真实 total_tokens 回填到提交时创建的 token_logs(纯观测、不动扣费/退款)。
// 关联: upstream_logs.task_id=cgt -> 该提交 trace_id -> token_logs.trace_id;幂等: 仅 total_tokens 仍为 0 时回填一次。
func BackfillVideoTokenUsage(taskID string, totalTokens int) error {
	if strings.TrimSpace(taskID) == "" || totalTokens <= 0 {
		return nil
	}
	db, err := DB()
	if err != nil {
		return err
	}
	var traceIDs []string
	if err := db.Model(&model.UpstreamLog{}).Where("task_id = ?", taskID).Limit(1).Pluck("trace_id", &traceIDs).Error; err != nil {
		return err
	}
	if len(traceIDs) == 0 || strings.TrimSpace(traceIDs[0]) == "" {
		return nil
	}
	return db.Model(&model.TokenLog{}).Where("trace_id = ? AND kind = ? AND total_tokens = ?", traceIDs[0], "video", 0).Update("total_tokens", totalTokens).Error
}
