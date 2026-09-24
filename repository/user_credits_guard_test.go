package repository

import (
	"fmt"
	"testing"
	"time"

	"aicanvas/model"
)

// 这一组测试锁死「整行写回不得覆盖点数」。
//
// 要锁死的丢失序列：
//     T+0s   后台调额 34 → 1034（AdjustUserCreditsTx 单事务提交成功，流水已落库）
//     T+18s  同一用户的表单被保存了一次，它在事务外读到的还是调额【之前】的 34
//            → 整行 db.Save 把 credits 写回 34 → 1000 点数凭空消失，流水却还留着
// 只在 service 层「先 GetUserByID 把旧值塞回结构体」是保不住的：那个读在事务外，
// 读与写之间就是丢失更新的窗口。下面每条测试都刻意用【过期的 user 快照】去写，
// 只要哪天有人把 Omit 去掉、或新增一条整行写回的路径，这里就会红。

func newTestUser(t *testing.T, credits int) model.User {
	t.Helper()
	ts := time.Now().UTC().Format(time.RFC3339Nano)
	// aff_code 有唯一索引，留空的话第二个测试用户就会撞上第一个的空串。
	seq := time.Now().UnixNano()
	user := model.User{
		ID:        fmt.Sprintf("user-guard-%d", seq),
		Username:  fmt.Sprintf("guard-%d", seq),
		AffCode:   fmt.Sprintf("aff%d", seq),
		Role:      model.UserRoleUser,
		Status:    model.UserStatusActive,
		Credits:   credits,
		CreatedAt: ts,
		UpdatedAt: ts,
	}
	saved, err := SaveUser(user)
	if err != nil {
		t.Fatalf("建测试用户失败: %v", err)
	}
	if saved.Credits != credits {
		t.Fatalf("新建用户的初始点数必须写进去（创建路径仍走整行写），期望 %d 实得 %d", credits, saved.Credits)
	}
	return saved
}

// 后台用户表单：拿调额之前的旧快照保存，点数必须纹丝不动。这条就是上面那个丢失序列本身。
func TestUpdateUserFormNeverOverwritesCredits(t *testing.T) {
	user := newTestUser(t, 34)
	stale := user // 表单在事务外读到的旧快照，credits=34

	if _, _, err := AdjustUserCreditsTx(user.ID, 1034, time.Now().UTC().Format(time.RFC3339Nano), model.CreditLog{
		ID: "credit-guard-" + user.ID, UserID: user.ID, Type: model.CreditLogTypeAdminAdjust,
		Remark: "测试调额", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatalf("调额失败: %v", err)
	}

	stale.DisplayName = "表单改了昵称"
	if _, err := UpdateUserForm(stale); err != nil {
		t.Fatalf("表单保存失败: %v", err)
	}

	got, ok, err := GetUserByID(user.ID)
	if err != nil || !ok {
		t.Fatalf("读回用户失败: %v", err)
	}
	if got.Credits != 1034 {
		t.Fatalf("表单保存把点数从 1034 覆盖成了 %d —— 正是丢 1000 点的那类竞态", got.Credits)
	}
	if got.DisplayName != "表单改了昵称" {
		t.Fatalf("表单该改的字段没生效，实得 %q", got.DisplayName)
	}
}

// 登录路径：登录是高频操作，每次登录都整行写回等于每次都拿旧快照覆盖一遍点数。
func TestUpdateUserOnLoginNeverOverwritesCredits(t *testing.T) {
	user := newTestUser(t, 500)
	stale := user

	if ok, err := ConsumeUserCreditsTx(user.ID, 120, time.Now().UTC().Format(time.RFC3339Nano), model.CreditLog{
		ID: "credit-guard-c-" + user.ID, UserID: user.ID, Type: model.CreditLogTypeAIConsume,
		Remark: "测试扣费", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil || !ok {
		t.Fatalf("扣费失败: ok=%v err=%v", ok, err)
	}

	stale.LastLoginAt = time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := UpdateUserOnLogin(stale); err != nil {
		t.Fatalf("登录写回失败: %v", err)
	}

	got, _, _ := GetUserByID(user.ID)
	if got.Credits != 380 {
		t.Fatalf("登录写回把点数从 380 覆盖成了 %d —— 用户在别处生成时登录一次就丢钱", got.Credits)
	}
	if got.LastLoginAt != stale.LastLoginAt {
		t.Fatal("登录时间必须能写进去，否则单设备登录判定会失效")
	}
}

// 只改单个字段的后台端点（分级定价 / 项目分配 / 指派创建者）同样不得碰点数。
func TestUpdateUserKeepingLiveNeverOverwritesCredits(t *testing.T) {
	user := newTestUser(t, 800)
	stale := user

	if _, _, err := AdjustUserCreditsTx(user.ID, 2000, time.Now().UTC().Format(time.RFC3339Nano), model.CreditLog{
		ID: "credit-guard-k-" + user.ID, UserID: user.ID, Type: model.CreditLogTypeAdminAdjust,
		Remark: "测试调额", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatalf("调额失败: %v", err)
	}

	stale.PriceOverride = `{"modelCosts":{}}`
	if _, err := UpdateUserKeepingLive(stale); err != nil {
		t.Fatalf("写分级定价失败: %v", err)
	}

	got, _, _ := GetUserByID(user.ID)
	if got.Credits != 2000 {
		t.Fatalf("改定价把点数从 2000 覆盖成了 %d", got.Credits)
	}
	if got.PriceOverride != `{"modelCosts":{}}` {
		t.Fatalf("该端点自己要写的那一列必须生效，实得 %q", got.PriceOverride)
	}
}

// 会话 ID 同理：两台设备同时登录时，写回旧 session 会把另一台踢下线。
func TestUpdateUserOnLoginNeverOverwritesSessionID(t *testing.T) {
	user := newTestUser(t, 10)
	stale := user

	if err := UpdateUserSessionID(user.ID, "session-from-other-device"); err != nil {
		t.Fatalf("换会话失败: %v", err)
	}

	stale.SessionID = "session-stale"
	stale.LastLoginAt = time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := UpdateUserOnLogin(stale); err != nil {
		t.Fatalf("登录写回失败: %v", err)
	}

	got, _, _ := GetUserByID(user.ID)
	if got.SessionID != "session-from-other-device" {
		t.Fatalf("登录写回把会话覆盖成了 %q，会把另一台设备踢下线", got.SessionID)
	}
}
