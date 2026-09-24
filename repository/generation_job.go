package repository

import (
	"time"

	"aicanvas/model"
	"github.com/google/uuid"
)

func SaveGenerationJob(job model.GenerationJob) (model.GenerationJob, error) {
	db, err := DB()
	if err != nil {
		return job, err
	}
	now := time.Now().Format(time.RFC3339)
	if job.ID == "" {
		// 创建：原样写全部字段（含 payload）。
		job.ID = uuid.NewString()
		job.CreatedAt = now
		job.UpdatedAt = now
		return job, db.Save(&job).Error
	}
	// 更新：不重写 payload。图生图 payload 是含参考图的整个 multipart（~1MB+），创建后不再变；
	// 若每次状态流转（dispatched/succeeded/failed）都全行重写它，在串行写下会让单次 UPDATE 堆到数十秒，
	// Next 代理(undici)等不到响应头超时 → 前端「接口连接失败」、同步请求排队 →「云端同步失败」。
	// payload 仅创建时写一次、48h 后随 TTL 清理；恢复时 pending 重跑仍能读到它。
	job.UpdatedAt = now
	return job, db.Omit("payload").Save(&job).Error
}

func GetGenerationJob(id string) (model.GenerationJob, bool, error) {
	db, err := DB()
	if err != nil {
		return model.GenerationJob{}, false, err
	}
	var item model.GenerationJob
	err = db.Where("id = ?", id).Limit(1).Find(&item).Error
	return item, item.ID != "", err
}

func ListGenerationJobIDsByStatus(statuses []string) ([]string, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var ids []string
	err = db.Model(&model.GenerationJob{}).Where("status IN ?", statuses).Order("created_at asc").Pluck("id", &ids).Error
	return ids, err
}

// MarkUndispatchedRunningJobsPending 服务重启恢复：进程被杀时遗留的 running 且【尚未向上游发起请求】的，
// 回退 pending 安全重跑（不会造成重复上游调用）。已发起上游的不在此列，由 ListInterruptedDispatchedJobs 单独处理。
func MarkUndispatchedRunningJobsPending() error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.GenerationJob{}).
		Where("status = ? AND (dispatched_at IS NULL OR dispatched_at = '')", "running").
		Update("status", "pending").Error
}

// ListInterruptedDispatchedJobs 列出服务重启时遗留的 running 且【已向上游发起过请求】的任务：
// 结果已丢失且无法判断上游是否成功，重跑会重复调用上游，故交给上层标失败 + 退款。
func ListInterruptedDispatchedJobs() ([]model.GenerationJob, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var jobs []model.GenerationJob
	err = db.Where("status = ? AND dispatched_at IS NOT NULL AND dispatched_at != ''", "running").Find(&jobs).Error
	return jobs, err
}

func PurgeGenerationJobsBefore(cutoff string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("created_at < ?", cutoff).Delete(&model.GenerationJob{}).Error
}

// ClearGenerationJobBlobsBefore 清除 cutoff 之前【终态】任务的大 blob（payload/result，各约 ~5MB 的图）。
// 只清成功/失败的任务（pending/running/dispatched 仍可能重跑或待领结果、payload/result 不能动）；整行删除另由 TTL 负责。
// 仅清非空 blob，避免反复重写已清空的行。
func ClearGenerationJobBlobsBefore(cutoff string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.GenerationJob{}).
		Where("created_at < ? AND status IN ? AND (payload <> '' OR result <> '')", cutoff, []string{"succeeded", "failed"}).
		Updates(map[string]any{"payload": "", "result": ""}).Error
}
