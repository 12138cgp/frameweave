package model

// UserAuditLog 后台「改用户」的操作审计。
//
// 为什么加这张表：被问到「某个用户最近有没有改过密码」时，根本查不出来——
// 库里没有任何记录用户改动的地方，`users.updated_at` 又被之后的登录覆盖掉了，
// nginx 只记了 `POST /api/admin/users` 这个路径、不记请求体，看不出改的是谁、改了什么。
// 也就是说：**谁把谁的密码改了、谁把谁挪了分组、谁给谁配了渠道 Key，全都无从追溯。**
//
// ⚠️ 三条红线（改这个文件前先读）：
//  1. **绝不记录密码明文或哈希**。密码只记「改过」这个事实（Changes 里 to 恒为空串）。
//  2. **绝不记录渠道 Key 的值**。ChannelKeys 里是上游 API Key，泄露等于送算力，同样只记「改过」。
//  3. **审计失败绝不能影响主流程**。记不下来就打条日志继续走——用户保存不能因为审计挂掉。
type UserAuditLog struct {
	ID string `json:"id" gorm:"primaryKey"`
	// TargetUserID 被改的那个用户。新建时也记，便于按人追溯全部历史。
	TargetUserID   string `json:"targetUserId" gorm:"index"`
	TargetUsername string `json:"targetUsername"`
	// Action create=新建用户 / update=编辑用户
	Action string `json:"action" gorm:"index"`
	// OperatorID 操作人（管理员或二级管理员）。
	OperatorID   string `json:"operatorId" gorm:"index"`
	OperatorName string `json:"operatorName"`
	// Changes 变更明细，JSON 数组：[{"field":"role","from":"user","to":"adminL2"}]
	// 敏感字段（password / channelKeys）的 from/to 恒为空串，只靠 field 存在与否表达「改过」。
	Changes string `json:"changes"`
	// IP 操作来源。真实 IP 由 nginx 注入；直连 :3000 时不可信；必须配 TRUSTED_PROXIES，见《部署与使用说明.md》第三章。
	IP        string `json:"ip"`
	CreatedAt string `json:"createdAt" gorm:"index"`
}

// UserAuditChange 单个字段的变化。
type UserAuditChange struct {
	Field string `json:"field"`
	From  string `json:"from"`
	To    string `json:"to"`
}

// UserAuditSensitiveFields 只记「改过」、绝不记值的字段。
// 新增敏感字段时往这里加，别在调用处零散判断。
var UserAuditSensitiveFields = map[string]bool{
	"password":    true,
	"channelKeys": true,
}
