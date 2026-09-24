package repository

import (
	"testing"

	"aicanvas/model"
)

// 同步推送的乐观锁语义。
//
// 背景：客户端一次同步是「T0 读云端 → 合并 → 传媒体 → T1 写回」，T1−T0 可长达分钟级。
// 原先服务端是无条件覆盖，这期间任何落到云端的写入（另一标签页 / 另一台设备 /
// 服务端的取用分享回写 / 快照回滚）都会被 T0 那份旧快照整块抹掉，且不留墓碑、护栏也看不出来。
// 现在推送带上 T0 读到的 updatedAt 作为基准版本，只在版本未变时才写。
func TestSaveSyncDataIfUnchangedRejectsStaleBase(t *testing.T) {
	const uid, domain = "u-cas", model.SyncDomainCanvas

	first, err := SaveSyncData(uid, domain, `{"v":1}`)
	if err != nil {
		t.Fatalf("首次写入失败: %v", err)
	}
	v1 := first.UpdatedAt
	if v1 == "" {
		t.Fatal("首次写入后应有 updatedAt 作为版本号")
	}

	// 模拟「同步窗口内别处写入」：云端被改到 v2
	second, err := SaveSyncData(uid, domain, `{"v":2}`)
	if err != nil {
		t.Fatalf("并发写入失败: %v", err)
	}
	// 版本号是纳秒精度（syncVersionLayout），同秒内的两次写入也必须产生不同版本，
	// 否则 CAS 就留了一秒宽的盲区——而并发写最容易撞的正是这个窗口。
	if second.UpdatedAt == v1 {
		t.Fatalf("两次写入的版本号相同（%s），CAS 无法分辨同秒并发写", v1)
	}

	// 迟到的旧快照带着 v1 来覆盖 —— 必须被拒
	written, err := SaveSyncDataIfUnchanged(uid, domain, `{"v":"stale"}`, v1)
	if err != nil {
		t.Fatalf("CAS 不该报错: %v", err)
	}
	if written {
		t.Fatal("基准版本已过期，绝不能写入——这正是画布被旧快照整块覆盖的成因")
	}

	got, err := GetSyncData(uid, domain)
	if err != nil {
		t.Fatalf("回读失败: %v", err)
	}
	if got.Data != `{"v":2}` {
		t.Fatalf("云端内容被旧快照覆盖了：期望 {\"v\":2}，实得 %s", got.Data)
	}
}

// 基准版本仍是最新时，正常写入。
func TestSaveSyncDataIfUnchangedAcceptsCurrentBase(t *testing.T) {
	const uid, domain = "u-cas-ok", model.SyncDomainAssets

	cur, err := SaveSyncData(uid, domain, `{"v":1}`)
	if err != nil {
		t.Fatalf("首次写入失败: %v", err)
	}

	written, err := SaveSyncDataIfUnchanged(uid, domain, `{"v":2}`, cur.UpdatedAt)
	if err != nil {
		t.Fatalf("CAS 不该报错: %v", err)
	}
	if !written {
		t.Fatal("基准版本仍是最新，应当写入成功")
	}

	got, _ := GetSyncData(uid, domain)
	if got.Data != `{"v":2}` {
		t.Fatalf("写入未生效：实得 %s", got.Data)
	}
	if got.UpdatedAt == cur.UpdatedAt {
		t.Log("提示：两次写入时间戳相同（同秒），实际运行中不影响正确性")
	}
}

// 云端本来就没有该行时，CAS 写不进去——这正是「首次推送必须退化为无条件写入」的原因，
// 否则新用户的第一次同步会永远失败。
func TestSaveSyncDataIfUnchangedOnMissingRow(t *testing.T) {
	written, err := SaveSyncDataIfUnchanged("u-cas-none", model.SyncDomainPresets, `{"v":1}`, "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatalf("不该报错: %v", err)
	}
	if written {
		t.Fatal("行不存在时不该写入")
	}
}
