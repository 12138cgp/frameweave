package handler

import (
	"net/http"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
)

// 「我的消耗」:普通用户查看自己的任务日志 / 点数日志。
// 出参一律走白名单 DTO——渠道/上游标识(logId)、内部架构(source/path)、他人信息、
// 管理员账号(operator)等内部字段从根上不出后端,而不是前端过滤。

// myCreditLogItem 「我的点数日志」白名单出参。
// 不含 userId/userName(就是本人)、operatorId/operatorName(不向普通用户暴露管理员账号)、extra 原文。
type myCreditLogItem struct {
	ID     string              `json:"id"`
	Type   model.CreditLogType `json:"type"`
	Amount int                 `json:"amount"`
	// Balance 该笔结算后的余额:个人流水=个人余额;项目流水=项目积分池余额(前端标「(池)」)。
	Balance int    `json:"balance"`
	Model   string `json:"model"`
	// ProjectID 非空=该笔从项目积分池扣;空=个人积分。
	ProjectID   string `json:"projectId"`
	ProjectName string `json:"projectName"`
	Remark      string `json:"remark"`
	CreatedAt   string `json:"createdAt"`
}

// MyCreditLogs GET /api/my/credit-logs?type=&source=&start=&end=&page=&pageSize=
// 当前用户自己的点数流水:SQL 层强制 user_id=本人,复用后台同一查询器(creditLogFilteredTx),口径一致。
func MyCreditLogs(w http.ResponseWriter, r *http.Request) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录")
		return
	}
	q := parseQuery(r) // type/page/pageSize;keyword 不对普通用户开放
	q.Keyword = ""
	query := r.URL.Query()
	q.Start = query.Get("start")
	q.End = query.Get("end")
	q.Source = query.Get("source") // __personal__ / 项目 id / 空=全部
	q.UserIDs = []string{me.ID}    // 锁死本人,防越权
	logs, err := service.ListCreditLogs(q)
	if err != nil {
		FailError(w, err)
		return
	}
	// 项目 id → 项目名(用户是这些项目的成员,项目名对其可见)。
	projectNames := map[string]string{}
	if projects, perr := repository.ListProjects(); perr == nil {
		for _, p := range projects {
			projectNames[p.ID] = p.Name
		}
	}
	items := make([]myCreditLogItem, 0, len(logs.Items))
	for _, log := range logs.Items {
		items = append(items, myCreditLogItem{
			ID:          log.ID,
			Type:        log.Type,
			Amount:      log.Amount,
			Balance:     log.Balance,
			Model:       creditLogModelName(log.Extra),
			ProjectID:   log.ProjectID,
			ProjectName: projectNames[log.ProjectID],
			Remark:      log.Remark,
			CreatedAt:   log.CreatedAt,
		})
	}
	// 当前筛选口径下的汇总(总消费/返还/调整/净额),供抽屉顶部显示。
	overall, _, _, err := service.SummarizeCreditLogs(q)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"items": items, "total": logs.Total, "summary": overall})
}

// myTaskLogItem 「我的任务日志」白名单出参。
// 不含 logId(上游供应商日志号)/source(内部 proxy|job)/path(内部路由)/userId;
// 状态不下发裸上游 HTTP 码,映射成 ok/fail/空(未知)。request 是本人提示词摘要,给本人看安全。
type myTaskLogItem struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Model      string `json:"model"`
	TaskID     string `json:"taskId"`
	Status     string `json:"status"` // ok | fail | ""(未知/旧数据)
	DurationMs int    `json:"durationMs"`
	Credits    int    `json:"credits"`  // 本次实扣点数(0=免费/未知)
	Refunded   bool   `json:"refunded"` // 已确认退款(视频生成失败退款);其余失败任务的返还以点数日志为准
	Request    string `json:"request"`
	ResultURL  string `json:"resultUrl"`
	CreatedAt  string `json:"createdAt"`
}

// MyTaskLogs GET /api/my/task-logs?type=&start=&end=&page=&pageSize=
// 当前用户自己的生成任务日志。点数按 trace 精确关联:图片(source=job)走 generation_jobs.credits,
// 文本/视频/音频(source=proxy)走 token_logs.charged_credits;关联失败不影响列表本身(best-effort)。
func MyTaskLogs(w http.ResponseWriter, r *http.Request) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录")
		return
	}
	q := parseQuery(r) // type(=kind)/page/pageSize;keyword 不对普通用户开放
	q.Keyword = ""
	query := r.URL.Query()
	q.Start = query.Get("start")
	q.End = query.Get("end")
	q.UserIDs = []string{me.ID} // 锁死本人,防越权
	logs, total, err := repository.ListUpstreamLogs(q)
	if err != nil {
		FailError(w, err)
		return
	}
	proxyTraces := make([]string, 0, len(logs))
	jobTraces := make([]string, 0, len(logs))
	taskIDs := make([]string, 0, len(logs))
	for _, l := range logs {
		if l.TraceID != "" {
			if l.Source == "job" {
				jobTraces = append(jobTraces, l.TraceID)
			} else {
				proxyTraces = append(proxyTraces, l.TraceID)
			}
		}
		if l.TaskID != "" {
			taskIDs = append(taskIDs, l.TaskID)
		}
	}
	// 点数/退款关联均为旁路信息:查询失败时列表照常返回(map 为空,点数显示为未知)。
	tokenCredits, _ := repository.TokenChargedCreditsByTraceIDs(proxyTraces)
	jobCredits, _ := repository.GenerationJobCreditsByIDs(jobTraces)
	refunded, _ := repository.RefundedVideoTaskIDs(taskIDs)
	items := make([]myTaskLogItem, 0, len(logs))
	for _, l := range logs {
		credits := tokenCredits[l.TraceID]
		if l.Source == "job" {
			credits = jobCredits[l.TraceID]
		}
		status := ""
		if l.UpstreamStatus >= 200 && l.UpstreamStatus < 400 {
			status = "ok"
		}
		if l.UpstreamStatus >= 400 {
			status = "fail"
		}
		items = append(items, myTaskLogItem{
			ID:         l.ID,
			Kind:       l.Kind,
			Model:      l.Model,
			TaskID:     l.TaskID,
			Status:     status,
			DurationMs: l.DurationMs,
			Credits:    credits,
			Refunded:   refunded[l.TaskID],
			Request:    l.Request,
			ResultURL:  l.ResultURL,
			CreatedAt:  l.CreatedAt,
		})
	}
	OK(w, map[string]any{"items": items, "total": total})
}
