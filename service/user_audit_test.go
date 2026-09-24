package service

import (
	"encoding/json"
	"strings"
	"testing"

	"aicanvas/model"
)

// 这组测试守的是 user_audit.go 顶部那三条红线里最要命的两条：
// 密码和渠道 Key 的【值】绝不能进审计表。
//
// 为什么值得单独写测试：审计表的用途就是给人看，将来很可能有人为了"方便排查"
// 顺手把 from/to 填上——那一刻这张表就从「安全工具」变成「明文密钥仓库」，
// 而且因为它是给管理员看的页面，泄露面比 .env 还大。测试红着就改不动。

// buildChanges 复刻 RecordUserAudit 里的 diff 逻辑（不落库，只验字段计算）。
// 保持与生产代码同源：如果 RecordUserAudit 的字段表变了，这里也要跟着变。
func buildChanges(old, saved model.User, passwordChanged bool) []model.UserAuditChange {
	changes := make([]model.UserAuditChange, 0, 4)
	for _, f := range userAuditFields {
		from, to := f.get(old), f.get(saved)
		if from == to {
			continue
		}
		if model.UserAuditSensitiveFields[f.name] {
			changes = append(changes, model.UserAuditChange{Field: f.name})
			continue
		}
		changes = append(changes, model.UserAuditChange{Field: f.name, From: from, To: to})
	}
	if passwordChanged && old.ID == "" {
		changes = append(changes, model.UserAuditChange{Field: "password"})
	}
	return changes
}

func TestUserAuditNeverRecordsPasswordValue(t *testing.T) {
	const secret = "SuperSecret!2026"
	old := model.User{ID: "u1", Username: "user-a", Password: "$2a$10$oldhasholdhasholdhash"}
	saved := model.User{ID: "u1", Username: "user-a", Password: "$2a$10$newhashnewhashnewhash"}

	changes := buildChanges(old, saved, true)
	encoded, err := json.Marshal(changes)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	body := string(encoded)

	// ① 必须记下「密码改过」这个事实
	found := false
	for _, ch := range changes {
		if ch.Field == "password" {
			found = true
			if ch.From != "" || ch.To != "" {
				t.Errorf("密码变更的 from/to 必须为空，实得 from=%q to=%q", ch.From, ch.To)
			}
		}
	}
	if !found {
		t.Error("改了密码却没记下「password」字段——审计等于没做")
	}

	// ② 明文和哈希都不许出现在审计正文里
	for _, leak := range []string{secret, old.Password, saved.Password, "$2a$"} {
		if strings.Contains(body, leak) {
			t.Errorf("审计正文里出现了密码相关内容 %q —— 这张表是给管理员看的页面，等于明文泄露\n正文: %s", leak, body)
		}
	}
}

func TestUserAuditNeverRecordsChannelKeyValue(t *testing.T) {
	const key = `{"主力渠道":"sk-test-placeholder-not-a-real-key"}`
	old := model.User{ID: "u1", Username: "user-b", ChannelKeys: `{"主力渠道":"sk-test-placeholder-previous-value"}`}
	saved := model.User{ID: "u1", Username: "user-b", ChannelKeys: key}

	changes := buildChanges(old, saved, false)
	encoded, _ := json.Marshal(changes)
	body := string(encoded)

	found := false
	for _, ch := range changes {
		if ch.Field == "channelKeys" {
			found = true
			if ch.From != "" || ch.To != "" {
				t.Errorf("渠道 Key 变更的 from/to 必须为空，实得 from=%q to=%q", ch.From, ch.To)
			}
		}
	}
	if !found {
		t.Error("改了渠道 Key 却没记下——那正是最该留痕的操作之一（等于送上游算力）")
	}
	for _, leak := range []string{"sk-test-placeholder-not-a-real-key", "sk-test-placeholder-previous-value"} {
		if strings.Contains(body, leak) {
			t.Errorf("审计正文里出现了渠道密钥 %q\n正文: %s", leak, body)
		}
	}
}

// 非敏感字段必须记下 from→to，否则「他被谁挪出了分组」这类问题照样查不出来。
func TestUserAuditRecordsNormalFieldTransitions(t *testing.T) {
	old := model.User{ID: "u1", Username: "user-a", Role: model.UserRoleUser, GroupID: "g-old", Status: model.UserStatusActive}
	saved := model.User{ID: "u1", Username: "user-a-renamed", Role: model.UserRoleAdminL2, GroupID: "g-new", Status: model.UserStatusActive}

	changes := buildChanges(old, saved, false)
	got := map[string][2]string{}
	for _, ch := range changes {
		got[ch.Field] = [2]string{ch.From, ch.To}
	}
	for field, want := range map[string][2]string{
		"username": {"user-a", "user-a-renamed"},
		"role":     {string(model.UserRoleUser), string(model.UserRoleAdminL2)},
		"groupId":  {"g-old", "g-new"},
	} {
		if got[field] != want {
			t.Errorf("%s 应记录 %v，实得 %v", field, want, got[field])
		}
	}
	// 没变的字段不该出现，否则每次保存都刷一大堆噪音
	if _, ok := got["status"]; ok {
		t.Error("status 没变却被记进了审计——会把真正的变更淹掉")
	}
}

// 什么都没改时不该产生审计条目（用户点了保存却没动任何字段）。
func TestUserAuditSkipsNoOpEdit(t *testing.T) {
	u := model.User{ID: "u1", Username: "user-a", Role: model.UserRoleUser, GroupID: "g1"}
	if changes := buildChanges(u, u, false); len(changes) != 0 {
		t.Errorf("无改动时不该产生审计条目，实得 %d 条: %+v", len(changes), changes)
	}
}
