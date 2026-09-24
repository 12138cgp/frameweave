package repository

import (
	"testing"

	"aicanvas/model"
)

// 快照补写的候选筛选。
//
// 锁的是这条链：快照原本只在推送成功时写、且带 10 分钟节流，于是「连续编辑一阵然后停手」
// 会让最后一版被节流挡在历史之外。以前靠客户端 90 秒心跳的冗余重推偶然补上；
// 客户端一旦改成「内容没变就不推」（省带宽），那个巧合就没了。
// 所以改由「数据是不是真的比历史新」来决定，本函数就是那个判据。
func TestListSyncDataNeedingSnapshot(t *testing.T) {
	const uid = "u-backfill"

	// ① 有数据、从没拍过快照 → 必须是候选（否则新用户第一版永远没有回滚点）
	if _, err := SaveSyncData(uid, model.SyncDomainCanvas, `{"v":1}`); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	rows, err := ListSyncDataNeedingSnapshot()
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if !containsDomain(rows, uid, model.SyncDomainCanvas) {
		t.Fatal("从未拍过快照的数据域必须进候选")
	}

	// ② 拍过快照且内容未变 → 不再是候选
	if _, err := ForceCanvasSnapshot(uid, model.SyncDomainCanvas, `{"v":1}`); err != nil {
		t.Fatalf("拍快照失败: %v", err)
	}
	rows, _ = ListSyncDataNeedingSnapshot()
	if containsDomain(rows, uid, model.SyncDomainCanvas) {
		t.Fatal("内容未变、已有快照，不该反复进候选（否则每 5 分钟灌一份重复快照）")
	}

	// ③ 内容又变了 → 重新成为候选。这正是被 10 分钟节流挡掉、且客户端不再重推的那一版。
	if _, err := SaveSyncData(uid, model.SyncDomainCanvas, `{"v":2}`); err != nil {
		t.Fatalf("二次写入失败: %v", err)
	}
	rows, _ = ListSyncDataNeedingSnapshot()
	if !containsDomain(rows, uid, model.SyncDomainCanvas) {
		t.Fatal("内容已比最新快照更新，必须进候选——漏掉它就等于最后一版没有回滚点")
	}

	// ④ 空内容不进候选：没必要给空清单留历史
	if _, err := SaveSyncData("u-backfill-empty", model.SyncDomainAssets, ""); err != nil {
		t.Fatalf("写空失败: %v", err)
	}
	rows, _ = ListSyncDataNeedingSnapshot()
	if containsDomain(rows, "u-backfill-empty", model.SyncDomainAssets) {
		t.Fatal("空内容不该进候选")
	}
}

// 哈希口径必须与 CaptureCanvasSnapshot 内部一致，否则补写任务的去重会失效、每轮都灌重复快照。
func TestHashSyncDataMatchesCapture(t *testing.T) {
	const uid, data = "u-hash", `{"v":"x"}`
	if err := CaptureCanvasSnapshot(uid, model.SyncDomainCanvas, data); err != nil {
		t.Fatalf("拍快照失败: %v", err)
	}
	latest, ok, err := LatestSnapshot(uid, model.SyncDomainCanvas)
	if err != nil || !ok {
		t.Fatalf("读快照失败: %v ok=%v", err, ok)
	}
	if got := HashSyncData(data); got != latest.Hash {
		t.Fatalf("哈希口径不一致：HashSyncData=%s 快照里=%s", got, latest.Hash)
	}
}

func containsDomain(rows []model.SyncData, userID, domain string) bool {
	for _, r := range rows {
		if r.UserID == userID && r.Domain == domain {
			return true
		}
	}
	return false
}
