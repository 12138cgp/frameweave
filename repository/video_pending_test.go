package repository

import (
	"testing"
	"time"

	"aicanvas/model"
)

// ListPendingVideoTasksForCanvas 的过滤语义。
//
// 这个查询是「刷新后误报生成已中断」的兜底：画布载入时按 canvas_id 把在途任务号
// 反查回来补给节点。它一旦放宽，后果不是查不到、而是【把不该转圈的节点转回 loading】——
// 比如已退款的失败任务被捞回来，用户会看到一个永远转不完的圈；
// 又比如漏了 user_id 条件，就成了越权读别人的任务号。所以每条过滤单独钉一个断言。
func TestListPendingVideoTasksForCanvasFilters(t *testing.T) {
	db, err := DB()
	if err != nil {
		t.Fatalf("打不开测试库: %v", err)
	}
	if err := db.AutoMigrate(&model.VideoRefund{}); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	const me = "u-pending-canvas"
	const canvas = "canvas-A"
	now := time.Now().Format(time.RFC3339)

	seed := func(vr model.VideoRefund) {
		t.Helper()
		if vr.CreatedAt == "" {
			vr.CreatedAt = now
		}
		if err := SaveVideoRefundCandidate(vr); err != nil {
			t.Fatalf("写候选失败 %s: %v", vr.TaskID, err)
		}
	}

	// 应当被查出来的：本人、本画布、有节点、未退款
	seed(model.VideoRefund{TaskID: "cgt-hit-1", UserID: me, CanvasID: canvas, NodeID: "node-1", Model: "doubao-seedance-2-0", Credits: 150})
	seed(model.VideoRefund{TaskID: "cgt-hit-2", UserID: me, CanvasID: canvas, NodeID: "node-2", Model: "doubao-seedance-2-5", Credits: 240,
		CreatedAt: time.Now().Add(-time.Hour).Format(time.RFC3339)})

	// 各种不该被查出来的
	seed(model.VideoRefund{TaskID: "cgt-refunded", UserID: me, CanvasID: canvas, NodeID: "node-3", RefundedAt: now})
	seed(model.VideoRefund{TaskID: "cgt-other-canvas", UserID: me, CanvasID: "canvas-B", NodeID: "node-4"})
	seed(model.VideoRefund{TaskID: "cgt-other-user", UserID: "u-someone-else", CanvasID: canvas, NodeID: "node-5"})
	seed(model.VideoRefund{TaskID: "cgt-no-node", UserID: me, CanvasID: canvas, NodeID: ""})

	got, err := ListPendingVideoTasksForCanvas(me, canvas, 0)
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	ids := map[string]bool{}
	for _, vr := range got {
		ids[vr.TaskID] = true
	}
	for _, want := range []string{"cgt-hit-1", "cgt-hit-2"} {
		if !ids[want] {
			t.Errorf("%s 应该被查出来，实际没有（节点会被误判成「已中断」）", want)
		}
	}
	for _, bad := range []string{"cgt-refunded", "cgt-other-canvas", "cgt-other-user", "cgt-no-node"} {
		if ids[bad] {
			t.Errorf("%s 不该被查出来，实际查到了", bad)
		}
	}
	if len(got) != 2 {
		t.Fatalf("应当只回 2 条，实得 %d 条: %v", len(got), ids)
	}
	// 按提交时间升序：先提交的先补，跟兜底扫描的顺序一致，便于对账。
	if got[0].TaskID != "cgt-hit-2" {
		t.Errorf("应按 created_at 升序，最早的是 cgt-hit-2，实得 %s", got[0].TaskID)
	}
}

// 空入参必须安全返回空，绝不能退化成「查全表」——
// 前端拿不到 canvasId 时会带空串过来，那一刻要是把别的画布甚至别人的任务号回过去，
// 就会在用户画布上凭空点亮一堆转圈节点。
func TestListPendingVideoTasksForCanvasRejectsEmptyArgs(t *testing.T) {
	db, err := DB()
	if err != nil {
		t.Fatalf("打不开测试库: %v", err)
	}
	if err := db.AutoMigrate(&model.VideoRefund{}); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if err := SaveVideoRefundCandidate(model.VideoRefund{
		TaskID: "cgt-empty-guard", UserID: "u-guard", CanvasID: "canvas-guard", NodeID: "node-guard",
		CreatedAt: time.Now().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("写候选失败: %v", err)
	}
	for _, c := range []struct{ user, canvas string }{
		{"", "canvas-guard"},
		{"u-guard", ""},
		{"", ""},
		{"   ", "  "},
	} {
		got, err := ListPendingVideoTasksForCanvas(c.user, c.canvas, 0)
		if err != nil {
			t.Fatalf("user=%q canvas=%q 不该报错: %v", c.user, c.canvas, err)
		}
		if len(got) != 0 {
			t.Errorf("user=%q canvas=%q 应回空，实得 %d 条", c.user, c.canvas, len(got))
		}
	}
}
