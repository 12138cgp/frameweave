package handler

import (
	"net/http"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
)

// taskLogItem 任务日志行 + 用户名(userName 富化,展示用;UpstreamLog 字段内联展开）。
type taskLogItem struct {
	model.UpstreamLog
	UserName string `json:"userName"`
	// Refunded：该视频任务是否已判定失败并退还点数。
	// 列表原先只显示 upstream_status，而它只代表【提交被受理】——视频是异步生成的，
	// 提交成功之后仍可能因内容审核不通过等原因失败。运营看到绿色的 200 会以为生成成功了，
	// 用户来要视频时才发现根本没有成片。有了这个字段，前端才能显示真实结局。
	Refunded bool `json:"refunded"`
}

// AdminTaskLogs 任务日志:分页列出每次 AI 调用(source=proxy)的请求体摘要 + 上游任务号(cgt)/LogID/状态/类型 + 用户名。
// 复用 creditLogQuery 的筛选解析 + 角色隔离(二级管理员只看自己子用户);q.Type 复用为 kind 过滤,
// 关键词可搜 user_id / task_id(cgt) / log_id / model / request。纯只读观测,不碰扣费。
func AdminTaskLogs(w http.ResponseWriter, r *http.Request) {
	q, ok := creditLogQuery(w, r)
	if !ok {
		return
	}
	logs, total, err := repository.ListUpstreamLogs(q)
	if err != nil {
		FailError(w, err)
		return
	}
	idSet := make(map[string]struct{}, len(logs))
	for _, log := range logs {
		if log.UserID != "" {
			idSet[log.UserID] = struct{}{}
		}
	}
	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	names, err := repository.UsernamesByIDs(ids)
	if err != nil {
		FailError(w, err)
		return
	}
	// 批量查退费状态：只对有任务号的视频任务有意义
	taskIDs := make([]string, 0, len(logs))
	for _, log := range logs {
		if log.Kind == "video" && strings.TrimSpace(log.TaskID) != "" {
			taskIDs = append(taskIDs, log.TaskID)
		}
	}
	refunded, rerr := repository.RefundedTaskIDs(taskIDs)
	if rerr != nil {
		// 退费状态取不到不该让整页打不开，降级成「未知」即可
		refunded = map[string]bool{}
	}
	items := make([]taskLogItem, 0, len(logs))
	for _, log := range logs {
		items = append(items, taskLogItem{UpstreamLog: log, UserName: names[log.UserID], Refunded: refunded[log.TaskID]})
	}
	OK(w, map[string]any{"items": items, "total": total})
}
