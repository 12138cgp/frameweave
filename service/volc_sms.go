package service

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"aicanvas/config"
	"aicanvas/model"
	"aicanvas/repository"

	"github.com/volcengine/volc-sdk-golang/service/sms"
)

// 火山引擎短信服务 SendSms API 封装。
// 使用 volc-sdk-golang 专用 SMS 客户端（host=sms.volcengineapi.com），而非 universal client
// （universal client 会构造 volcSMS.cn-north-1.volcengineapi.com，与短信服务实际 host 不匹配导致签名失败）。
// 注意：短信服务仅在 cn-north-1 区域可用。
const volcSmsDefaultReg = "cn-north-1"

// 短信每日发送上限默认值：管理员未配置或填 0/负数时回退，防止误配成"无限制"。
const (
	smsDefaultDailyLimitPerPhone = 20
	smsDefaultDailyLimitPerIP    = 100
)

// 暴力破解防护默认值：相同手机号+IP 连续 5 次错误后锁定 5 分钟。
const (
	smsDefaultVerifyMaxAttempts = 5
	smsDefaultVerifyLockMinutes = 5
)

// loadSmsConfig 读取短信服务配置：后台「私有配置」优先，未填项回退 .env。
// 未配置 AK/SK 时返回 ok=false（调用方据此回退开发模式）。
func loadSmsConfig() (model.SmsSetting, bool, error) {
	cfg := model.SmsSetting{
		AccessKey:  strings.TrimSpace(config.Cfg.VolcSmsAccessKey),
		SecretKey:  strings.TrimSpace(config.Cfg.VolcSmsSecretKey),
		Region:     strings.TrimSpace(config.Cfg.VolcSmsRegion),
		SmsAccount: strings.TrimSpace(config.Cfg.VolcSmsAccount),
		Sign:       strings.TrimSpace(config.Cfg.VolcSmsSign),
		TemplateID: strings.TrimSpace(config.Cfg.VolcSmsTemplateID),
	}
	if settings, err := repository.GetSettings(); err == nil {
		p := settings.Private.Sms
		if v := strings.TrimSpace(p.AccessKey); v != "" {
			cfg.AccessKey = v
		}
		if v := strings.TrimSpace(p.SecretKey); v != "" {
			cfg.SecretKey = v
		}
		if v := strings.TrimSpace(p.Region); v != "" {
			cfg.Region = v
		}
		if v := strings.TrimSpace(p.SmsAccount); v != "" {
			cfg.SmsAccount = v
		}
		if v := strings.TrimSpace(p.Sign); v != "" {
			cfg.Sign = v
		}
		if v := strings.TrimSpace(p.TemplateID); v != "" {
			cfg.TemplateID = v
		}
		// Enabled/DevMode 仅由后台控制，.env 不参与
		if p.Enabled != nil {
			cfg.Enabled = p.Enabled
		}
		if p.DevMode != nil {
			cfg.DevMode = p.DevMode
		}
		// 每日发送上限仅由后台控制（.env 不参与）；0 表示后台未配置，后续回退默认值
		if p.DailyLimitPerPhone > 0 {
			cfg.DailyLimitPerPhone = p.DailyLimitPerPhone
		}
		if p.DailyLimitPerIP > 0 {
			cfg.DailyLimitPerIP = p.DailyLimitPerIP
		}
		// 暴力破解防护仅由后台控制
		if p.VerifyMaxAttempts > 0 {
			cfg.VerifyMaxAttempts = p.VerifyMaxAttempts
		}
		if p.VerifyLockMinutes > 0 {
			cfg.VerifyLockMinutes = p.VerifyLockMinutes
		}
	}
	if cfg.Region == "" {
		cfg.Region = volcSmsDefaultReg
	}
	// 每日发送上限默认值兜底（0/负数 → 默认 20/100，防误配成"无限制"）。
	// 放在 enabled 判定之前，确保未启用短信时也能用默认值做限流。
	if cfg.DailyLimitPerPhone <= 0 {
		cfg.DailyLimitPerPhone = smsDefaultDailyLimitPerPhone
	}
	if cfg.DailyLimitPerIP <= 0 {
		cfg.DailyLimitPerIP = smsDefaultDailyLimitPerIP
	}
	// 暴力破解防护默认值兜底
	if cfg.VerifyMaxAttempts <= 0 {
		cfg.VerifyMaxAttempts = smsDefaultVerifyMaxAttempts
	}
	if cfg.VerifyLockMinutes <= 0 {
		cfg.VerifyLockMinutes = smsDefaultVerifyLockMinutes
	}
	// 判定是否真正接入：Enabled 为 true 且关键字段齐全
	enabled := cfg.Enabled != nil && *cfg.Enabled
	if !enabled {
		// 仅当显式开启了 DevMode 才允许回退开发模式（返回验证码，不真正发送）
		// 否则返回错误，fail-closed，避免默认状态下形成登录后门
		if isSmsDevMode(cfg) {
			return cfg, false, nil
		}
		return cfg, false, safeMessageError{message: "短信服务未启用，请联系管理员开通"}
	}
	var missing []string
	if cfg.AccessKey == "" {
		missing = append(missing, "AccessKey")
	}
	if cfg.SecretKey == "" {
		missing = append(missing, "SecretKey")
	}
	if cfg.SmsAccount == "" {
		missing = append(missing, "SmsAccount（短信消息组ID）")
	}
	if cfg.Sign == "" {
		missing = append(missing, "Sign（短信签名）")
	}
	if cfg.TemplateID == "" {
		missing = append(missing, "TemplateID（短信模板 ID）")
	}
	if len(missing) > 0 {
		hint := ""
		if sliceContains(missing, "SecretKey") {
			hint = "（提示：SecretKey 在后台读取时出于安全会被清空，请在「系统设置 → 私有配置 → 火山引擎短信服务」的 SecretKey 密码框中重新输入后保存）"
		}
		return cfg, false, safeMessageError{message: fmt.Sprintf("短信服务配置不完整，缺少：%s%s", strings.Join(missing, "、"), hint)}
	}
	return cfg, true, nil
}

func sliceContains(slice []string, target string) bool {
	for _, s := range slice {
		if s == target {
			return true
		}
	}
	return false
}

// isSmsDevMode 是否处于开发模式（DevMode=true 时直接在响应里返回验证码，不真正发送短信）。
func isSmsDevMode(cfg model.SmsSetting) bool {
	return cfg.DevMode != nil && *cfg.DevMode
}

// smsSendResult 短信发送结果详情，用于落库记录。
type smsSendResult struct {
	Success      bool
	StatusCode   int
	RequestID    string // 火山引擎 RequestId
	MessageID    string // 火山引擎返回的短信 ID（多个用逗号拼接）
	ErrorCode    string // 错误码（火山 Code/HTTPxxx；成功为空）
	ErrorMessage string // 失败原因（错误 Message）
	ResponseBody string // 火山引擎响应原始 JSON 或错误描述
	DurationMs   int64  // 耗时（毫秒）
}

// volcSendSms 调用火山引擎短信服务发送验证码。
// 模板变量固定为 code，需与短信模板占位符一致。
// 返回 (*smsSendResult, error)：result 始终非 nil（含错误详情供日志记录）；error 仅用于给用户提示。
func volcSendSms(cfg model.SmsSetting, phone string, code string) (*smsSendResult, error) {
	result := &smsSendResult{}

	templateParam, err := json.Marshal(map[string]string{"code": code})
	if err != nil {
		return result, safeMessageError{message: "构造短信模板参数失败"}
	}

	instance := sms.NewInstance()
	instance.Client.SetAccessKey(cfg.AccessKey)
	instance.Client.SetSecretKey(cfg.SecretKey)
	instance.Client.SetScheme("https")

	req := &sms.SmsRequest{
		SmsAccount:    cfg.SmsAccount,
		Sign:          cfg.Sign,
		TemplateID:    cfg.TemplateID,
		TemplateParam: string(templateParam),
		PhoneNumbers:  phone,
	}

	startedAt := time.Now()
	resp, statusCode, err := instance.Send(req)
	result.StatusCode = statusCode
	result.DurationMs = time.Since(startedAt).Milliseconds()

	if err != nil {
		result.ResponseBody = err.Error()
		return result, volcSmsError(err)
	}
	if resp == nil {
		result.ResponseBody = fmt.Sprintf("短信服务无响应（HTTP %d）", statusCode)
		return result, safeMessageError{message: result.ResponseBody}
	}

	// 序列化响应体（用于日志展示）
	if body, mErr := json.Marshal(resp); mErr == nil {
		result.ResponseBody = string(body)
	}
	result.RequestID = resp.ResponseMetadata.RequestId
	if resp.Result != nil && len(resp.Result.MessageID) > 0 {
		result.MessageID = strings.Join(resp.Result.MessageID, ",")
	}

	// API 业务错误：ResponseMetadata.Error 非空表示火山侧返回了错误码
	if resp.ResponseMetadata.Error != nil {
		e := resp.ResponseMetadata.Error
		result.ErrorCode = e.Code
		result.ErrorMessage = strings.TrimSpace(e.Message)
		msg := result.ErrorMessage
		if msg == "" {
			msg = e.Code
		}
		return result, safeMessageError{message: fmt.Sprintf("短信发送失败（%s）：%s", e.Code, msg)}
	}
	// HTTP 错误但没有 Error 对象（非预期情况）
	if statusCode >= 400 {
		result.ErrorCode = fmt.Sprintf("HTTP%d", statusCode)
		result.ErrorMessage = fmt.Sprintf("HTTP %d", statusCode)
		return result, safeMessageError{message: fmt.Sprintf("短信发送失败：HTTP %d", statusCode)}
	}

	result.Success = true
	return result, nil
}

func volcSmsError(err error) error {
	message := strings.Join(strings.Fields(strings.TrimSpace(err.Error())), " ")
	if message == "" {
		message = "请求失败"
	}
	if runes := []rune(message); len(runes) > 300 {
		message = string(runes[:300]) + "..."
	}
	return safeMessageError{message: fmt.Sprintf("短信服务调用失败：%s", message)}
}
