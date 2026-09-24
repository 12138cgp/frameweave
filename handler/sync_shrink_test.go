package handler

import (
	"strings"
	"testing"
)

// 拦截日志必须说清「少了什么」，否则下次再发生只能靠猜是陈旧标签页还是护栏误判。
func TestCanvasShrinkSummary(t *testing.T) {
	oldData := `{"data":{"projects":[
		{"id":"p1","nodes":[1,2,3,4,5,6,7,8,9,10]},
		{"id":"p2","nodes":[1,2,3]},
		{"id":"p3","nodes":[1,2,3,4,5]}
	]}}`
	// p3 整个消失；p1 从 10 掉到 2（跌 80%）
	newData := `{"data":{"projects":[
		{"id":"p1","nodes":[1,2]},
		{"id":"p2","nodes":[1,2,3]}
	]}}`
	got := canvasShrinkSummary(oldData, newData)
	for _, want := range []string{"projects 3->2", "nodes 18->5", "p3(5)", "p1 10->2"} {
		if !strings.Contains(got, want) {
			t.Errorf("摘要里缺少 %q，实际: %s", want, got)
		}
	}
}

// 摘要解析失败时不能 panic、也不能返回空串（空串会让日志看起来像正常）。
func TestCanvasShrinkSummaryBadJSON(t *testing.T) {
	if got := canvasShrinkSummary("{", "{"); got == "" {
		t.Fatal("解析失败时应返回可辨识的提示")
	}
}
