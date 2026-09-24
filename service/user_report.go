package service

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
)

// 用户问题反馈。
//
// 一条反馈由四部分组成，缺一不可：
//   1. 用户的话        —— 他觉得发生了什么
//   2. 客户端操作日志  —— 实际发生了什么（环形缓冲，见 web/src/services/action-log.ts）
//   3. 客户端现场快照  —— 他那边现在是什么状态（浏览器/本机数据/素材对账）
//   4. 服务端现场快照  —— 服务端看到的是什么状态（本文件的 buildServerSnapshot）
//
// 第 4 条是刻意加的，也是最不可少的一条：客户端说什么都不算数。
// 「成片丢失」这类问题就是典型——客户端一路顺利、字节确实进了桶，
// 只有从服务端看才能发现「用户自己的数据里根本没有它」。
// 只信客户端的诊断系统，恰好在最需要它的时候会跟着一起被骗。

const (
	// userReportMaxLogBytes 压缩后日志上限。
	// 超过就从【最旧】的一头丢，保住最近发生的——用户来报问题时，最近几分钟远比三天前重要。
	userReportMaxLogBytes = 1 << 20 // 1MB
	// userReportMaxRawBytes 压缩前上限，防止有人构造超大 payload 打爆内存。
	userReportMaxRawBytes = 24 << 20 // 24MB
	// userReportRateWindow / userReportRateLimit 限流：同一用户一小时最多提这么多条。
	// 不是防滥用，是防「点了没反应就狂点」把库灌满。
	userReportRateWindow = time.Hour
	userReportRateLimit  = 20
)

// UserReportInput 客户端提交的反馈内容。
type UserReportInput struct {
	Category    string            `json:"category"`
	Description string            `json:"description"`
	Contact     string            `json:"contact"`
	CanvasID    string            `json:"canvasId"`
	CanvasTitle string            `json:"canvasTitle"`
	HappenedAt  string            `json:"happenedAt"`
	Env         json.RawMessage   `json:"env"`
	Local       json.RawMessage   `json:"local"`
	Media       json.RawMessage   `json:"media"`
	Log         []json.RawMessage `json:"log"`
}

// SubmitUserReport 落一条用户反馈，并附上服务端自己抓的现场快照。
func SubmitUserReport(user model.AuthUser, input UserReportInput) (int64, error) {
	description := strings.TrimSpace(input.Description)
	if description == "" {
		return 0, fmt.Errorf("请先描述一下遇到的问题")
	}
	if len([]rune(description)) > 2000 {
		return 0, fmt.Errorf("问题描述太长了，请精简到 2000 字以内")
	}

	since := time.Now().Add(-userReportRateWindow).UTC().Format(time.RFC3339)
	if recent, err := repository.CountRecentUserReportsBy(user.ID, since); err == nil && recent >= userReportRateLimit {
		return 0, fmt.Errorf("最近提交的反馈有点多，请稍后再试；已经提交的我们都会看到")
	}

	category := strings.TrimSpace(input.Category)
	if !model.IsUserReportCategory(category) {
		// 不认识的类型归到「其它」而不是拒收：用户已经遇到问题了，不能连报都报不出来。
		category = string(model.UserReportCategoryOther)
	}

	logGzip, logCount, rawBytes, truncated, err := packActionLog(input.Log)
	if err != nil {
		return 0, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	report := &model.UserReport{
		UserID:      user.ID,
		Username:    user.Username,
		GroupID:     user.GroupID,
		Category:    category,
		Description: description,
		Contact:     strings.TrimSpace(input.Contact),
		CanvasID:    strings.TrimSpace(input.CanvasID),
		CanvasTitle: strings.TrimSpace(input.CanvasTitle),
		HappenedAt:  strings.TrimSpace(input.HappenedAt),
		Env:         compactJSON(input.Env),
		Local:       mergeClientState(input.Local, input.Media),
		Server:      buildServerSnapshot(user.ID),
		LogGzip:     logGzip,
		LogCount:    logCount,
		LogBytes:    len(logGzip),
		RawBytes:    rawBytes,
		Truncated:   truncated,
		Status:      string(model.UserReportStatusOpen),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := repository.CreateUserReport(report); err != nil {
		return 0, err
	}
	return report.ID, nil
}

// packActionLog 把日志数组压成 gzip。
//
// 超限时从最旧的一头丢：用户来报问题，最近几分钟的事远比三天前重要。
// 这个方向很容易写反——写反了就会在超限时把最关键的那段扔掉，而这恰恰只在
// 「日志特别多」也就是「出了大事」的时候才触发，平时测不出来。
func packActionLog(entries []json.RawMessage) ([]byte, int, int, bool, error) {
	return packActionLogWithLimit(entries, userReportMaxLogBytes)
}

// packActionLogWithLimit 把上限做成参数，只为让「丢哪一头」能被测到：
// 用真实的 1MB 上限去测就得先造出好几 MB 不可压缩的数据，慢且脆。
func packActionLogWithLimit(entries []json.RawMessage, maxGz int) ([]byte, int, int, bool, error) {
	if len(entries) == 0 {
		return nil, 0, 0, false, nil
	}
	raw, err := json.Marshal(entries)
	if err != nil {
		return nil, 0, 0, false, fmt.Errorf("操作日志格式不对")
	}
	if len(raw) > userReportMaxRawBytes {
		return nil, 0, 0, false, fmt.Errorf("操作日志过大")
	}
	rawBytes := len(raw)

	truncated := false
	kept := entries
	for {
		gz, err := gzipBytes(mustMarshal(kept))
		if err != nil {
			return nil, 0, 0, false, err
		}
		if len(gz) <= maxGz || len(kept) <= 50 {
			return gz, len(kept), rawBytes, truncated, nil
		}
		// 还是太大：砍掉最旧的四分之一，保留最近的
		truncated = true
		kept = kept[len(kept)/4:]
	}
}

func mustMarshal(entries []json.RawMessage) []byte {
	data, err := json.Marshal(entries)
	if err != nil {
		return []byte("[]")
	}
	return data
}

func gzipBytes(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	writer, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := writer.Write(data); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// UnpackUserReportLog 解开日志给后台看。
func UnpackUserReportLog(data []byte) ([]json.RawMessage, error) {
	if len(data) == 0 {
		return nil, nil
	}
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	var entries []json.RawMessage
	if err := json.NewDecoder(reader).Decode(&entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func compactJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return ""
	}
	return buf.String()
}

// mergeClientState 把「本机数据规模」和「素材对账」合成一份，后台展示时是同一块内容。
func mergeClientState(local, media json.RawMessage) string {
	out := map[string]json.RawMessage{}
	if len(local) > 0 {
		out["local"] = local
	}
	if len(media) > 0 {
		out["media"] = media
	}
	if len(out) == 0 {
		return ""
	}
	data, err := json.Marshal(out)
	if err != nil {
		return ""
	}
	return string(data)
}

// ServerSnapshot 服务端视角的现场快照。
type ServerSnapshot struct {
	TakenAt   string                       `json:"takenAt"`
	Domains   []repository.SyncDomainProbe `json:"domains"`
	Canvas    *cloudCanvasShape            `json:"canvas,omitempty"`
	Snapshots []repository.SnapshotProbe   `json:"snapshots"`
	Counts    repository.ProbeCounts       `json:"counts"`
	Tasks     []repository.TaskProbe       `json:"tasks"`
	Notes     []string                     `json:"notes"`
}

type cloudCanvasShape struct {
	ProjectCount int                `json:"projectCount"`
	NodeCount    int                `json:"nodeCount"`
	Projects     []cloudCanvasEntry `json:"projects"`
}

type cloudCanvasEntry struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Nodes     int    `json:"nodes"`
	DeletedAt string `json:"deletedAt,omitempty"`
}

// buildServerSnapshot 抓服务端这一侧的现场。
//
// 每一块都独立容错：抓不到就少一块，绝不让用户因为诊断信息不全就提交不了反馈。
// 结果里还会带几条 Notes，把「一眼就该注意到的异常」直接写成人话——
// 管理员打开反馈第一眼看到的就是它，不用自己去比对数字。
func buildServerSnapshot(userID string) string {
	snapshot := ServerSnapshot{
		TakenAt: time.Now().UTC().Format(time.RFC3339),
		Notes:   []string{},
	}

	if domains, err := repository.ProbeSyncDomains(userID); err == nil {
		snapshot.Domains = domains
	}
	if snaps, err := repository.ProbeCanvasSnapshots(userID, 40); err == nil {
		snapshot.Snapshots = snaps
		if note := snapshotDropNote(snaps); note != "" {
			snapshot.Notes = append(snapshot.Notes, note)
		}
	}

	counts := repository.ProbeUserCounts(userID)
	snapshot.Counts = counts
	if counts.CanvasSnapshots == 0 {
		snapshot.Notes = append(snapshot.Notes, "⚠️ 该用户没有任何画布快照，一旦确认丢失将【无可恢复点】。")
	}
	if counts.PendingVideoTasks > 0 {
		snapshot.Notes = append(snapshot.Notes, fmt.Sprintf(
			"该用户有 %d 个视频任务尚未确认送达（退款候选还在），成片可能还没进他的画布。", counts.PendingVideoTasks))
	}
	if counts.VideosNoResult24h > 0 {
		snapshot.Notes = append(snapshot.Notes, fmt.Sprintf(
			"近 24 小时有 %d 个视频任务没有产物地址。", counts.VideosNoResult24h))
	}

	since := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339)
	if tasks, err := repository.ProbeRecentTasks(userID, since, 60); err == nil {
		snapshot.Tasks = tasks
	}

	// 云端画布结构：只统计形状，不留内容。
	if raw, err := repository.GetSyncDataValue(userID, model.SyncDomainCanvas); err == nil && strings.TrimSpace(raw) != "" {
		if shape := parseCloudCanvasShape(raw); shape != nil {
			snapshot.Canvas = shape
		}
	} else {
		snapshot.Notes = append(snapshot.Notes, "⚠️ 云端没有该用户的画布数据（从未同步成功，或已被清空）。")
	}

	data, err := json.Marshal(snapshot)
	if err != nil {
		return ""
	}
	return string(data)
}

func parseCloudCanvasShape(raw string) *cloudCanvasShape {
	var payload struct {
		Data struct {
			Projects []struct {
				ID        string `json:"id"`
				Title     string `json:"title"`
				DeletedAt string `json:"deletedAt"`
				Nodes     []any  `json:"nodes"`
			} `json:"projects"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil
	}
	shape := &cloudCanvasShape{ProjectCount: len(payload.Data.Projects)}
	for _, project := range payload.Data.Projects {
		shape.NodeCount += len(project.Nodes)
		shape.Projects = append(shape.Projects, cloudCanvasEntry{
			ID: project.ID, Title: project.Title, Nodes: len(project.Nodes), DeletedAt: project.DeletedAt,
		})
	}
	return shape
}

// snapshotDropNote 从快照体积序列里判断「是不是真的丢过内容」。
//
// 快照一路增长 = 没丢（用户多半是虚惊或找不到入口）；
// 某一刻掉一大截 = 真出事了，而且峰值那份快照就是现成的恢复点。
// 这个判断管理员自己看序列也能得出，但让机器先说一句能省掉大量来回——
// 而且能防止「序列太长、人眼扫过去没注意到中间那次跌落」。
//
// 阈值 30%：日常编辑（删几个节点、换张图）不会让整份画布掉三成，
// 掉到这个程度基本只有「整个画布/子画布没了」一种解释。
func snapshotDropNote(snaps []repository.SnapshotProbe) string {
	if len(snaps) < 2 {
		return ""
	}
	peak, peakIdx := 0, 0
	for i, s := range snaps {
		if s.Bytes > peak {
			peak, peakIdx = s.Bytes, i
		}
	}
	// 峰值就是最后一份 = 还在长，没丢
	if peak <= 0 || peakIdx >= len(snaps)-1 {
		return ""
	}
	last := snaps[len(snaps)-1].Bytes
	if last >= peak*7/10 {
		return ""
	}
	return fmt.Sprintf(
		"⚠️ 画布快照体积从峰值 %.2fMB(%s) 掉到当前 %.2fMB(%s)，跌幅 %.0f%%，很可能真的丢过内容；峰值那份快照可作恢复点。",
		float64(peak)/1048576, snaps[peakIdx].CreatedAt,
		float64(last)/1048576, snaps[len(snaps)-1].CreatedAt,
		100*(1-float64(last)/float64(peak)))
}
