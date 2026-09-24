package repository

import (
	"testing"
	"time"

	"aicanvas/model"
)

// 占位退费候选的读写语义。
//
// 背景：video_refunds 整张表按 task_id 索引，可「扣费成功 → 发出上游请求 → 拿到 task id」
// 这一小段窗口里根本还没有 task id。部署重建容器只要正好打断一次视频提交，就会是：
// 钱扣了、任务没建成、没有任何东西负责退，后台连记录都查不到（用户只看到「连接失败」）。
// 现在用 "pending:<traceID>" 占位，拿到真 task id 或同步退费后清掉，
// 进程被杀则由下次启动的 RecoverInterruptedVideoSubmits 兜底。
func TestPendingSubmitCandidateLifecycle(t *testing.T) {
	const key = "pending:trace-abc"

	if err := SaveVideoRefundCandidate(model.VideoRefund{
		TaskID: key, UserID: "u-pending", Model: "doubao-seedance", Credits: 110,
	}); err != nil {
		t.Fatalf("写占位失败: %v", err)
	}
	got, ok, err := GetVideoRefund(key)
	if err != nil || !ok {
		t.Fatalf("读占位失败: %v ok=%v", err, ok)
	}
	if got.Credits != 110 || got.UserID != "u-pending" {
		t.Fatalf("占位内容不对: %+v", got)
	}

	// 拿到真 task id 后应能清掉，否则下次启动会重复退款
	if err := DeleteVideoRefund(key); err != nil {
		t.Fatalf("清占位失败: %v", err)
	}
	if _, ok, _ := GetVideoRefund(key); ok {
		t.Fatal("占位清理后不该还能读到——残留会导致重复退款")
	}
}

// 未退费候选列表要能把占位一并捞出来，否则恢复逻辑根本看不到它们。
func TestListUnrefundedIncludesPendingKeys(t *testing.T) {
	const key = "pending:trace-list"
	if err := SaveVideoRefundCandidate(model.VideoRefund{
		TaskID: key, UserID: "u-list", Model: "m", Credits: 50,
	}); err != nil {
		t.Fatalf("写占位失败: %v", err)
	}
	defer DeleteVideoRefund(key)

	// cutoff 取未来时刻，确保刚写下的这条落在范围内
	cutoff := time.Now().Add(time.Hour).Format(time.RFC3339)
	rows, err := ListUnrefundedVideoRefunds(cutoff, 500)
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.TaskID == key {
			found = true
		}
	}
	if !found {
		t.Fatal("占位候选没出现在未退费列表里——中断恢复将永远扫不到它，钱退不回去")
	}

	// 锁住那个真实踩过的坑：条件是 created_at <= ?，传空串永远匹配不到任何行，
	// 恢复逻辑会变成静默空转。谁要是再把 cutoff 写成 ""，这里就会红。
	empty, err := ListUnrefundedVideoRefunds("", 500)
	if err != nil {
		t.Fatalf("空 cutoff 查询失败: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("预期空 cutoff 捞不到任何行（这正是坑所在），实得 %d 行", len(empty))
	}
}

// 已退费的不应再出现在未退费列表里（防止重复退款）。
func TestRefundedCandidateExcluded(t *testing.T) {
	const key = "pending:trace-done"
	if err := SaveVideoRefundCandidate(model.VideoRefund{
		TaskID: key, UserID: "u-done", Model: "m", Credits: 10,
	}); err != nil {
		t.Fatalf("写占位失败: %v", err)
	}
	defer DeleteVideoRefund(key)
	if _, err := MarkVideoRefunded(key); err != nil {
		t.Fatalf("标记已退失败: %v", err)
	}
	rows, err := ListUnrefundedVideoRefunds(time.Now().Add(time.Hour).Format(time.RFC3339), 500)
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	for _, r := range rows {
		if r.TaskID == key {
			t.Fatal("已退费的候选仍出现在未退费列表——会被重复退款")
		}
	}
}
