package model

// SmsLogStatus 短信发送状态。
type SmsLogStatus string

const (
	SmsLogStatusSuccess SmsLogStatus = "success" // 真实发送成功
	SmsLogStatusFailed  SmsLogStatus = "failed"  // 真实发送失败
	SmsLogStatusSkipped SmsLogStatus = "skipped" // 跳过发送（未启用短信或字段不全，开发模式直接返回验证码）
)

// SmsLog 短信发送记录。每次调用火山引擎短信服务（或跳过发送）都落库一条，便于事后排障。
type SmsLog struct {
	ID              int64        `json:"id" gorm:"primaryKey;autoIncrement"`
	Phone           string       `json:"phone" gorm:"index"`               // 接收手机号
	IP              string       `json:"ip" gorm:"index"`                  // 客户端 IP（每日 IP 发送上限统计用）
	TemplateID      string       `json:"templateId" gorm:"index"`          // 模板 ID
	Sign            string       `json:"sign"`                             // 短信签名
	Status          SmsLogStatus `json:"status" gorm:"index"`              // success/failed/skipped
	RequestPayload  string       `json:"requestPayload" gorm:"type:text"`  // 请求内容 JSON（含 phone/templateParam/sign/templateId/smsAccount）
	ResponsePayload string       `json:"responsePayload" gorm:"type:text"` // 火山引擎响应原始 JSON 或错误描述
	ErrorCode       string       `json:"errorCode"`                        // 错误码（火山 Code/HTTPxxx；成功为空）
	ErrorMessage    string       `json:"errorMessage"`                     // 失败原因（错误 Message）
	DurationMs      int64        `json:"durationMs"`                       // 耗时（毫秒）
	RequestID       string       `json:"requestId"`                        // 火山引擎 RequestId
	MessageID       string       `json:"messageId"`                        // 火山引擎返回的短信 ID
	CreatedAt       string       `json:"createdAt" gorm:"index"`
}

// TableName 指定表名为 mp_sms_log。
func (SmsLog) TableName() string { return "mp_sms_log" }

// SmsLogSummary 短信发送记录汇总。
type SmsLogSummary struct {
	SuccessCount int64 `json:"successCount"` // 成功条数
	FailedCount  int64 `json:"failedCount"`  // 失败条数
	SkippedCount int64 `json:"skippedCount"` // 跳过条数
	TotalCount   int64 `json:"totalCount"`   // 查询范围内总记录数
	IPCount      int64 `json:"ipCount"`      // 查询范围内不同客户端 IP 数量
}
