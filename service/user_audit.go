package service

import (
	"encoding/json"
	"log"
	"strings"

	"github.com/google/uuid"

	"aicanvas/model"
	"aicanvas/repository"
)

// 后台「改用户」的操作审计。
//
// 起因：被问到「某个用户最近有没有改过密码」时，完全查不出来——
// 库里没有任何记录用户改动的地方；`users.updated_at` 会被之后的登录覆盖掉；
// nginx 只记 `POST /api/admin/users` 这个路径、不记请求体，看不出改的是谁、改了什么。
// 于是「谁把谁的密码改了 / 谁把谁挪了分组 / 谁给谁配了渠道 Key」全都无从追溯。
//
// ⚠️ 本文件的三条红线：
//  1. 绝不记录密码明文或哈希 —— 只记「改过」这个事实。
//  2. 绝不记录渠道 Key 的值 —— 那是上游 API Key，泄露等于送算力。同样只记「改过」。
//  3. 审计绝不能成为故障源 —— 任何一步失败都只打日志，主流程照常返回成功。

// userAuditField 参与 diff 的字段：字段名 + 取值函数。
// 只挑「改了会影响权限、归属、计费、登录」的，避免把 LastLoginAt 这种噪音记进来。
type userAuditField struct {
	name string
	get  func(model.User) string
}

var userAuditFields = []userAuditField{
	{"username", func(u model.User) string { return u.Username }},
	{"role", func(u model.User) string { return string(u.Role) }},
	{"status", func(u model.User) string { return string(u.Status) }},
	{"groupId", func(u model.User) string { return u.GroupID }},
	{"email", func(u model.User) string { return u.Email }},
	{"phone", func(u model.User) string { return u.Phone }},
	{"displayName", func(u model.User) string { return u.DisplayName }},
	{"creatorId", func(u model.User) string { return u.CreatorID }},
	// channelKeys 只比「变没变」，值本身是密钥、绝不落库
	{"channelKeys", func(u model.User) string { return u.ChannelKeys }},
	// password 走【同一套】敏感字段机制，而不是在下面特判。
	// 这样「绝不记密码」这条红线由 UserAuditSensitiveFields 一处保证，
	// 谁把它从名单里拿掉，测试立刻变红（见 user_audit_test.go）。
	// 比的是 bcrypt 哈希：改密码必然换哈希，不改则完全相同。
	{"password", func(u model.User) string { return u.Password }},
}

// RecordUserAudit 记一条改用户审计。
//
// old/hadOld：编辑前的用户（新建时 hadOld=false）。
// passwordChanged：本次请求是否带了新密码（调用方判断 request.Password != ""）。
//
// 返回值刻意省略：调用方不该也不能因为审计失败而改变行为。
func RecordUserAudit(operator model.AuthUser, old model.User, hadOld bool, saved model.User, passwordChanged bool, ip string) {
	defer func() {
		// 审计自身绝不能把主流程带崩（JSON 编码、库连接都可能出意外）
		if rec := recover(); rec != nil {
			log.Printf("用户审计记录失败(已忽略) target=%s err=%v", saved.ID, rec)
		}
	}()

	action := "update"
	if !hadOld {
		action = "create"
	}

	changes := make([]model.UserAuditChange, 0, 4)
	if hadOld {
		for _, f := range userAuditFields {
			from, to := f.get(old), f.get(saved)
			if from == to {
				continue
			}
			if model.UserAuditSensitiveFields[f.name] {
				// 只记「改过」，值一律置空
				changes = append(changes, model.UserAuditChange{Field: f.name})
				continue
			}
			changes = append(changes, model.UserAuditChange{Field: f.name, From: from, To: to})
		}
	} else {
		// 新建：记下初始的关键属性，便于日后回溯「这号是谁开的、开成什么角色」
		for _, name := range []string{"username", "role", "status", "groupId"} {
			for _, f := range userAuditFields {
				if f.name != name {
					continue
				}
				if v := f.get(saved); v != "" {
					changes = append(changes, model.UserAuditChange{Field: f.name, To: v})
				}
			}
		}
	}
	// 新建路径没有 old 可比，字段表那圈不会跑；这里补一笔。
	// 编辑路径由上面的字段表按哈希差异自动检出，不用也不该在这里重复加。
	if passwordChanged && !hadOld {
		changes = append(changes, model.UserAuditChange{Field: "password"})
	}

	// 编辑但什么都没变（用户点了保存却没动任何字段）就不记，避免刷屏
	if action == "update" && len(changes) == 0 {
		return
	}

	encoded, err := json.Marshal(changes)
	if err != nil {
		log.Printf("用户审计序列化失败(已忽略) target=%s err=%v", saved.ID, err)
		return
	}

	item := model.UserAuditLog{
		ID:             "uaudit-" + strings.ReplaceAll(uuid.NewString(), "-", ""),
		TargetUserID:   saved.ID,
		TargetUsername: saved.Username,
		Action:         action,
		OperatorID:     operator.ID,
		OperatorName:   operator.Username,
		Changes:        string(encoded),
		IP:             strings.TrimSpace(ip),
		CreatedAt:      now(),
	}
	if err := repository.SaveUserAuditLog(item); err != nil {
		log.Printf("用户审计入库失败(已忽略) target=%s err=%v", saved.ID, err)
	}

	// 同时打一行到落盘日志：库要是哪天出问题，日志里还留着一份；也方便直接 grep。
	// 注意这里同样不打印任何密钥/密码值。
	fields := make([]string, 0, len(changes))
	for _, ch := range changes {
		fields = append(fields, ch.Field)
	}
	log.Printf("用户审计: %s 用户 %s(%s) 由 %s(%s) 操作，变更字段=[%s] ip=%s",
		action, saved.Username, saved.ID, operator.Username, operator.ID,
		strings.Join(fields, " "), ip)
}
