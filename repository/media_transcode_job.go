package repository

import (
	"aicanvas/model"
)

func SaveMediaTranscodeJob(job model.MediaTranscodeJob) (model.MediaTranscodeJob, error) {
	db, err := DB()
	if err != nil {
		return job, err
	}
	if err := db.Save(&job).Error; err != nil {
		return job, err
	}
	return job, nil
}

func GetMediaTranscodeJob(id string) (model.MediaTranscodeJob, bool, error) {
	db, err := DB()
	if err != nil {
		return model.MediaTranscodeJob{}, false, err
	}
	var job model.MediaTranscodeJob
	if err := db.Where("id = ?", id).First(&job).Error; err != nil {
		return model.MediaTranscodeJob{}, false, nil
	}
	return job, true, nil
}

// FindMediaTranscodeJobBySource 同一用户同一源片的既有任务（最新一条）。
// 转码烧的是自家 CPU，同一个视频没有任何理由转第二遍——
// 已经成功的直接把地址还回去，还在跑的让调用方接着轮询即可。
func FindMediaTranscodeJobBySource(userID, sourceKey string) (model.MediaTranscodeJob, bool) {
	db, err := DB()
	if err != nil {
		return model.MediaTranscodeJob{}, false
	}
	var job model.MediaTranscodeJob
	if err := db.Where("user_id = ? AND source_key = ? AND status <> ?", userID, sourceKey, "failed").
		Order("created_at desc").First(&job).Error; err != nil {
		return model.MediaTranscodeJob{}, false
	}
	return job, true
}

// ListUnfinishedMediaTranscodeJobs 供服务重启后把没跑完的任务捡回来。
func ListUnfinishedMediaTranscodeJobs() ([]model.MediaTranscodeJob, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var jobs []model.MediaTranscodeJob
	if err := db.Where("status IN ?", []string{"pending", "running"}).Find(&jobs).Error; err != nil {
		return nil, err
	}
	return jobs, nil
}
