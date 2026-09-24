package repository

import (
	"encoding/json"
	"strings"

	"aicanvas/model"
)

// GenStatMetrics 单个用户的生成情况聚合中间量（handler 再补用户名/分组名/合计）。
type GenStatMetrics struct {
	VideoOK          int
	VideoOKSeconds   int
	VideoFail        int
	VideoFailSeconds int
	ImageCount       int
	AudioCount       int
	CreditsUsed      int
	// Breakdown 按「类型+模型+分辨率」的明细，key = kind|model|spec。
	Breakdown map[string]*model.GenStatBreakdownRow
}

// bump 累加一条明细（kind+模型+分辨率维度）。
func (m *GenStatMetrics) bump(kind, modelName, spec string, count, seconds, fail int) {
	if m.Breakdown == nil {
		m.Breakdown = map[string]*model.GenStatBreakdownRow{}
	}
	key := kind + "|" + modelName + "|" + spec
	r := m.Breakdown[key]
	if r == nil {
		r = &model.GenStatBreakdownRow{Kind: kind, Model: modelName, Spec: spec}
		m.Breakdown[key] = r
	}
	r.Count += count
	r.Seconds += seconds
	r.Fail += fail
}

// SubordinateUsers 返回某创建者（二级管理员）名下的全部用户（creatorID 空=创建者为空的用户，超管直属/自助注册）。
func SubordinateUsers(creatorID string) ([]model.User, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var users []model.User
	if err := db.Where("creator_id = ?", creatorID).Order("username asc").Find(&users).Error; err != nil {
		return nil, err
	}
	return users, nil
}

// SummarizeGenerationStats 汇总一批用户在 [startUTC, endUTC) 内的生成情况（created_at 为 UTC RFC3339 字符串，直接字符串比较）。
//   - 视频：upstream_logs kind=video、status=200、按 task_id 去重、request.duration 求和、request.resolution 分辨率；在 video_refunds(refunded_at 非空) 里的记为失败。
//   - 图片/音频：upstream_logs kind=image/audio、status=200 计数；图片按 request.size 分尺寸。
//   - 明细按「模型（upstream_logs.model 列）+ 分辨率」维度累加到 Breakdown。
//   - 点数：credit_logs 净消耗（ai_consume 取相反数 − ai_refund）。
func SummarizeGenerationStats(userIDs []string, startUTC, endUTC string) (map[string]*GenStatMetrics, error) {
	out := map[string]*GenStatMetrics{}
	if len(userIDs) == 0 {
		return out, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	get := func(uid string) *GenStatMetrics {
		m := out[uid]
		if m == nil {
			m = &GenStatMetrics{}
			out[uid] = m
		}
		return m
	}

	// —— 视频：拉成功提交的视频日志，按 task_id 去重 —— //
	type vrow struct {
		UserID  string
		TaskID  string
		Model   string
		Request string
	}
	var vrows []vrow
	if err := db.Table("upstream_logs").
		Select("user_id, task_id, model, request").
		Where("kind = ? AND upstream_status = 200 AND task_id <> '' AND user_id IN ? AND created_at >= ? AND created_at < ?",
			"video", userIDs, startUTC, endUTC).
		Scan(&vrows).Error; err != nil {
		return nil, err
	}
	type vinfo struct {
		UserID  string
		Seconds int
		Model   string
		Spec    string
	}
	byTask := map[string]vinfo{}
	taskIDs := make([]string, 0, len(vrows))
	for _, r := range vrows {
		if _, ok := byTask[r.TaskID]; ok {
			continue
		}
		byTask[r.TaskID] = vinfo{
			UserID:  r.UserID,
			Seconds: parseVideoDurationSeconds(r.Request),
			Model:   r.Model,
			Spec:    parseRequestString(r.Request, "resolution"),
		}
		taskIDs = append(taskIDs, r.TaskID)
	}
	// 退款（=生成失败）的 task_id 集合
	refunded := map[string]bool{}
	for _, chunk := range chunkStringSlice(taskIDs, 400) {
		var rr []string
		if err := db.Table("video_refunds").Select("task_id").
			Where("refunded_at <> '' AND task_id IN ?", chunk).Scan(&rr).Error; err != nil {
			return nil, err
		}
		for _, t := range rr {
			refunded[t] = true
		}
	}
	for _, t := range taskIDs {
		info := byTask[t]
		m := get(info.UserID)
		if refunded[t] {
			m.VideoFail++
			m.VideoFailSeconds += info.Seconds
			m.bump("video", info.Model, info.Spec, 0, 0, 1)
		} else {
			m.VideoOK++
			m.VideoOKSeconds += info.Seconds
			m.bump("video", info.Model, info.Spec, 1, info.Seconds, 0)
		}
	}

	// —— 图片：拉行、按 request.size 分尺寸计数 —— //
	type mrow struct {
		UserID  string
		Model   string
		Request string
	}
	var irows []mrow
	if err := db.Table("upstream_logs").
		Select("user_id, model, request").
		Where("kind = ? AND upstream_status = 200 AND user_id IN ? AND created_at >= ? AND created_at < ?",
			"image", userIDs, startUTC, endUTC).
		Scan(&irows).Error; err != nil {
		return nil, err
	}
	for _, r := range irows {
		m := get(r.UserID)
		m.ImageCount++
		m.bump("image", r.Model, parseRequestString(r.Request, "size"), 1, 0, 0)
	}

	// —— 音频：拉行计数（无分辨率维度）—— //
	type arow struct {
		UserID string
		Model  string
	}
	var arows []arow
	if err := db.Table("upstream_logs").
		Select("user_id, model").
		Where("kind = ? AND upstream_status = 200 AND user_id IN ? AND created_at >= ? AND created_at < ?",
			"audio", userIDs, startUTC, endUTC).
		Scan(&arows).Error; err != nil {
		return nil, err
	}
	for _, r := range arows {
		m := get(r.UserID)
		m.AudioCount++
		m.bump("audio", r.Model, "", 1, 0, 0)
	}

	// —— 点数：净消耗（口径同 SummarizeCreditLogs：ai_consume 金额为负，取相反数；减去 ai_refund）—— //
	type crow struct {
		UserID  string
		Consume int
		Refund  int
	}
	var crows []crow
	if err := db.Table("credit_logs").
		Select("user_id, "+
			"COALESCE(SUM(CASE WHEN type = 'ai_consume' THEN -amount ELSE 0 END),0) AS consume, "+
			"COALESCE(SUM(CASE WHEN type = 'ai_refund' THEN amount ELSE 0 END),0) AS refund").
		Where("user_id IN ? AND created_at >= ? AND created_at < ?", userIDs, startUTC, endUTC).
		Group("user_id").Scan(&crows).Error; err != nil {
		return nil, err
	}
	for _, r := range crows {
		get(r.UserID).CreditsUsed = r.Consume - r.Refund
	}

	return out, nil
}

// parseVideoDurationSeconds 从视频请求体摘要里解析 duration（秒）；解析失败/缺失返回 0。
func parseVideoDurationSeconds(request string) int {
	if strings.TrimSpace(request) == "" {
		return 0
	}
	var m map[string]any
	if json.Unmarshal([]byte(request), &m) != nil {
		return 0
	}
	switch v := m["duration"].(type) {
	case float64:
		return int(v)
	case string:
		n := 0
		for _, c := range v {
			if c >= '0' && c <= '9' {
				n = n*10 + int(c-'0')
			} else {
				break
			}
		}
		return n
	}
	return 0
}

// parseRequestString 从请求体摘要 JSON 里取某字段的字符串值（如 resolution / size）；缺失/非字符串返回空。
func parseRequestString(request, field string) string {
	if strings.TrimSpace(request) == "" {
		return ""
	}
	var m map[string]any
	if json.Unmarshal([]byte(request), &m) != nil {
		return ""
	}
	if v, ok := m[field].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func chunkStringSlice(s []string, size int) [][]string {
	if len(s) == 0 || size <= 0 {
		return nil
	}
	var out [][]string
	for i := 0; i < len(s); i += size {
		end := i + size
		if end > len(s) {
			end = len(s)
		}
		out = append(out, s[i:end])
	}
	return out
}
