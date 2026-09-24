package repository

import (
	"time"

	"aicanvas/model"
)

// 用户反馈的「服务端侧现场快照」所需的探针查询。
//
// 单独一个文件，因为它们只服务于诊断、都是只读、且都刻意做了体量约束：
// 反馈可能在任何时刻提交，探针绝不能因为某个用户的画布有 20MB 就把请求拖死。
// 原则是「只取尺寸和计数，不取内容」——需要看内容时管理员另有工具。

// SyncDomainProbe 一个数据域在云端的体量与时间。
type SyncDomainProbe struct {
	Domain    string `json:"domain"`
	Bytes     int    `json:"bytes"`
	UpdatedAt string `json:"updatedAt"`
	Exists    bool   `json:"exists"`
}

// ProbeSyncDomains 取该用户各数据域在云端的字节数与更新时间。
// 用 length(data) 而不是把 data 读出来算——后者对 20MB 的画布是纯浪费。
func ProbeSyncDomains(userID string) ([]SyncDomainProbe, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	rows := make([]SyncDomainProbe, 0, len(model.SyncDomains))
	for _, domain := range model.SyncDomains {
		var probe struct {
			Bytes     int
			UpdatedAt string
		}
		err := db.Model(&model.SyncData{}).
			Select("length(data) as bytes, updated_at as updated_at").
			Where("user_id = ? AND domain = ?", userID, domain).
			Scan(&probe).Error
		if err != nil {
			return nil, err
		}
		rows = append(rows, SyncDomainProbe{
			Domain:    domain,
			Bytes:     probe.Bytes,
			UpdatedAt: probe.UpdatedAt,
			Exists:    probe.UpdatedAt != "",
		})
	}
	return rows, nil
}

// SnapshotProbe 快照序列里的一条（只有元信息，不含 data）。
type SnapshotProbe struct {
	CreatedAt string `json:"createdAt"`
	Bytes     int    `json:"bytes"`
}

// ProbeCanvasSnapshots 取画布域最近若干份快照的「时间+体积」序列。
//
// 这是判断「到底丢没丢」最直接的证据：体积一路增长说明没丢，
// 某一刻突然掉一大截就是真出事了，且掉之前那份快照就是恢复点。
// 明确 Select 掉 data 字段：快照本身就是整份画布，读出来毫无意义还很贵。
func ProbeCanvasSnapshots(userID string, limit int) ([]SnapshotProbe, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 40
	}
	var rows []SnapshotProbe
	err = db.Model(&model.SyncSnapshot{}).
		Select("created_at", "bytes").
		Where("user_id = ? AND domain = ?", userID, model.SyncDomainCanvas).
		Order("created_at desc").Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, err
	}
	// 倒序取的，翻回时间正序，读的人不用在脑子里倒着看
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows, nil
}

// TaskProbe 近期任务的一条摘要。
type TaskProbe struct {
	TaskID     string `json:"taskId"`
	TraceID    string `json:"traceId"`
	Kind       string `json:"kind"`
	Model      string `json:"model"`
	Status     int    `json:"status"`
	HasResult  bool   `json:"hasResult"`
	DurationMs int    `json:"durationMs"`
	CreatedAt  string `json:"createdAt"`
}

// ProbeRecentTasks 取该用户最近的生成任务摘要。
//
// 刻意【不】带 request 字段：那里面是提示词正文和参考图，属于用户内容，
// 不该因为提交了一次反馈就被复制进反馈表里（反馈是要给管理员看的）。
// HasResult 用 result_url 是否非空表达，够回答「出片了没有」，又不泄露地址。
func ProbeRecentTasks(userID string, since string, limit int) ([]TaskProbe, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 60
	}
	var raw []struct {
		TaskID     string
		TraceID    string
		Kind       string
		Model      string
		Status     int
		ResultURL  string
		DurationMs int
		CreatedAt  string
	}
	err = db.Model(&model.UpstreamLog{}).
		Select("task_id", "trace_id", "kind", "model", "upstream_status as status", "result_url", "duration_ms", "created_at").
		Where("user_id = ? AND created_at >= ?", userID, since).
		Order("created_at desc").Limit(limit).Find(&raw).Error
	if err != nil {
		return nil, err
	}
	out := make([]TaskProbe, 0, len(raw))
	for _, r := range raw {
		out = append(out, TaskProbe{
			TaskID: r.TaskID, TraceID: r.TraceID, Kind: r.Kind, Model: r.Model,
			Status: r.Status, HasResult: r.ResultURL != "", DurationMs: r.DurationMs, CreatedAt: r.CreatedAt,
		})
	}
	return out, nil
}

// ProbeCounts 若干个一眼能看出问题的计数。
type ProbeCounts struct {
	SyncFiles         int64 `json:"syncFiles"`         // 已登记的素材文件数
	CanvasSnapshots   int64 `json:"canvasSnapshots"`   // 画布快照份数（可恢复点有几个）
	PendingVideoTasks int64 `json:"pendingVideoTasks"` // 尚未认领的视频候选（还没确认送达用户的成片）
	Tasks24h          int64 `json:"tasks24h"`          // 近 24 小时任务数
	FailedTasks24h    int64 `json:"failedTasks24h"`    // 其中上游非 2xx 的
	VideosNoResult24h int64 `json:"videosNoResult24h"` // 近 24 小时没有产物地址的视频任务
}

// ProbeUserCounts 汇总几个关键计数。任一项失败不影响其余（诊断信息缺一块也比整个抓不到强）。
func ProbeUserCounts(userID string) ProbeCounts {
	var counts ProbeCounts
	db, err := DB()
	if err != nil {
		return counts
	}
	since := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)

	_ = db.Model(&model.SyncFile{}).Where("user_id = ?", userID).Count(&counts.SyncFiles).Error
	_ = db.Model(&model.SyncSnapshot{}).Where("user_id = ? AND domain = ?", userID, model.SyncDomainCanvas).Count(&counts.CanvasSnapshots).Error
	_ = db.Model(&model.VideoRefund{}).Where("user_id = ? AND (refunded_at IS NULL OR refunded_at = '')", userID).Count(&counts.PendingVideoTasks).Error
	_ = db.Model(&model.UpstreamLog{}).Where("user_id = ? AND created_at >= ?", userID, since).Count(&counts.Tasks24h).Error
	_ = db.Model(&model.UpstreamLog{}).Where("user_id = ? AND created_at >= ? AND (upstream_status < 200 OR upstream_status >= 300)", userID, since).Count(&counts.FailedTasks24h).Error
	_ = db.Model(&model.UpstreamLog{}).Where("user_id = ? AND created_at >= ? AND kind = 'video' AND (result_url IS NULL OR result_url = '')", userID, since).Count(&counts.VideosNoResult24h).Error
	return counts
}
