package service

import (
	"encoding/json"
	"fmt"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
)

// AdminListSmsLogs 管理员查询短信发送记录。
func AdminListSmsLogs(q model.Query) ([]model.SmsLog, int64, error) {
	return repository.ListSmsLogs(q)
}

// AdminGetSmsLogSummary 短信发送记录汇总（成功/失败/跳过条数 + 总记录数 + 不同 IP 数）。
func AdminGetSmsLogSummary(start, end, status, keyword, ip string) (model.SmsLogSummary, error) {
	return repository.GetSmsLogSummary(start, end, status, keyword, ip)
}

// buildSmsRequestPayload 构造短信请求内容 JSON（含 phone/templateParam/sign/templateId/smsAccount）。
// templateParam 与 volcSendSms 内部构造保持一致（固定 code 变量）。
func buildSmsRequestPayload(cfg model.SmsSetting, phone, code string) string {
	payload := map[string]string{
		"phone":         phone,
		"templateParam": fmt.Sprintf(`{"code":"%s"}`, code),
		"sign":          cfg.Sign,
		"templateId":    cfg.TemplateID,
		"smsAccount":    cfg.SmsAccount,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return string(data)
}

// recordSmsLog 写入一条短信发送记录（best-effort，失败不影响主流程）。
// result 为 nil 时表示未真正调用火山接口（如 skipped 场景），响应相关字段留空。
func recordSmsLog(status model.SmsLogStatus, phone, ip, code string, cfg model.SmsSetting, result *smsSendResult) {
	log := model.SmsLog{
		Phone:          phone,
		IP:             ip,
		TemplateID:     cfg.TemplateID,
		Sign:           cfg.Sign,
		Status:         status,
		RequestPayload: buildSmsRequestPayload(cfg, phone, code),
		CreatedAt:      now(),
	}
	if result != nil {
		log.ResponsePayload = result.ResponseBody
		log.ErrorCode = result.ErrorCode
		log.ErrorMessage = result.ErrorMessage
		log.DurationMs = result.DurationMs
		log.RequestID = result.RequestID
		log.MessageID = result.MessageID
	}
	_ = repository.CreateSmsLog(log)
}

// startOfToday 今日 0 点（服务器本地时区，与 now() 一致），用于每日发送上限的统计边界。
func startOfToday() string {
	n := time.Now()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, n.Location()).Format(time.RFC3339)
}

// checkSmsDailyLimit 检查单手机号/单 IP 每日发送上限，超限返回 safeMessageError。
// 计数包含 success/failed/skipped 三种状态（都是用户触发的请求），fail-closed（查询失败也拒绝）。
// ip 为空时跳过 IP 维度检查（如本地开发无法提取 IP）。
func checkSmsDailyLimit(cfg model.SmsSetting, phone, ip string) error {
	since := startOfToday()
	if phoneCount, err := repository.CountSmsLogsByPhoneSince(phone, since); err != nil {
		return safeMessageError{message: "发送频率校验失败，请稍后重试"}
	} else if phoneCount >= int64(cfg.DailyLimitPerPhone) {
		return safeMessageError{message: fmt.Sprintf("该手机号今日发送已达上限（%d 条），请明天再试", cfg.DailyLimitPerPhone)}
	}
	if ip != "" {
		if ipCount, err := repository.CountSmsLogsByIPSince(ip, since); err != nil {
			return safeMessageError{message: "发送频率校验失败，请稍后重试"}
		} else if ipCount >= int64(cfg.DailyLimitPerIP) {
			return safeMessageError{message: fmt.Sprintf("当前 IP 今日发送已达上限（%d 条），请明天再试", cfg.DailyLimitPerIP)}
		}
	}
	return nil
}
