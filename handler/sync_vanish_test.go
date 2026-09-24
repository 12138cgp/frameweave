package handler

import "testing"

// 要防的故障形态：用户的画布「凭空不见、云端也从没有过」。
// 被抹掉的是【刚新建、还没放节点】的项目，而只看节点数的护栏 canvasShrinkDetected 对 len(nodes)==0
// 直接 continue，这类项目完全在视野外，于是一次也拦不住。这里锁住新护栏的判定。
func TestCanvasProjectVanished(t *testing.T) {
	cases := []struct {
		name     string
		old      string
		next     string
		wantLost bool
		wantID   string
	}{
		{
			name:     "零节点新项目被抹掉且无墓碑——正是最隐蔽的那种，必须拦",
			old:      `{"data":{"projects":[{"id":"p1","nodes":[]}]},"tombstones":{}}`,
			next:     `{"data":{"projects":[]},"tombstones":{}}`,
			wantLost: true, wantID: "p1",
		},
		{
			name:     "有内容的项目被抹掉且无墓碑，必须拦",
			old:      `{"data":{"projects":[{"id":"p1","nodes":[{},{},{}]}]},"tombstones":{}}`,
			next:     `{"data":{"projects":[]},"tombstones":{}}`,
			wantLost: true, wantID: "p1",
		},
		{
			name:     "多个项目里只丢了其中一个，也要拦并指出是哪个",
			old:      `{"data":{"projects":[{"id":"keep","nodes":[{}]},{"id":"lost","nodes":[]}]},"tombstones":{}}`,
			next:     `{"data":{"projects":[{"id":"keep","nodes":[{}]}]},"tombstones":{}}`,
			wantLost: true, wantID: "lost",
		},
		{
			name:     "用户真删（推送里带了该项目的墓碑），放行",
			old:      `{"data":{"projects":[{"id":"p1","nodes":[{},{}]}]},"tombstones":{}}`,
			next:     `{"data":{"projects":[]},"tombstones":{"p1":"2026-08-04T01:00:00.000Z"}}`,
			wantLost: false,
		},
		{
			name:     "项目还在、只是节点少了——不归这条管（由原 canvasShrinkDetected 判）",
			old:      `{"data":{"projects":[{"id":"p1","nodes":[{},{},{},{}]}]},"tombstones":{}}`,
			next:     `{"data":{"projects":[{"id":"p1","nodes":[{}]}]},"tombstones":{}}`,
			wantLost: false,
		},
		{
			name:     "新增项目不算消失",
			old:      `{"data":{"projects":[{"id":"p1","nodes":[{}]}]},"tombstones":{}}`,
			next:     `{"data":{"projects":[{"id":"p1","nodes":[{}]},{"id":"p2","nodes":[]}]},"tombstones":{}}`,
			wantLost: false,
		},
		{
			name:     "云端本来就空，首次推送不该被拦（新用户正常路径）",
			old:      `{"data":{"projects":[]},"tombstones":{}}`,
			next:     `{"data":{"projects":[{"id":"p1","nodes":[]}]},"tombstones":{}}`,
			wantLost: false,
		},
		{
			name:     "云端 JSON 坏了：保守放行，不因格式问题卡死保存",
			old:      `{{{坏数据`,
			next:     `{"data":{"projects":[]},"tombstones":{}}`,
			wantLost: false,
		},
		{
			name:     "推送 JSON 坏了：同样放行，交由后续逻辑处理",
			old:      `{"data":{"projects":[{"id":"p1","nodes":[{}]}]},"tombstones":{}}`,
			next:     `坏数据`,
			wantLost: false,
		},
		{
			name:     "缺 tombstones 字段（老客户端）时，项目消失仍要拦",
			old:      `{"data":{"projects":[{"id":"p1","nodes":[]}]}}`,
			next:     `{"data":{"projects":[]}}`,
			wantLost: true, wantID: "p1",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotID, got := canvasProjectVanished(c.old, c.next)
			if got != c.wantLost {
				t.Fatalf("判定错误：want vanished=%v got=%v（丢失项目=%q）", c.wantLost, got, gotID)
			}
			if c.wantLost && gotID != c.wantID {
				t.Fatalf("指出的丢失项目不对：want %q got %q", c.wantID, gotID)
			}
		})
	}
}

// ConfirmShrink 不该能让「项目消失」蒙混过关——该标志是客户端模块级全局布尔、与载荷解耦。
// 这条用判定函数本身把契约锁住：它压根不接受 confirmShrink 参数，调用点也不得据此跳过。
func TestCanvasProjectVanishedIgnoresConfirmShrink(t *testing.T) {
	old := `{"data":{"projects":[{"id":"p1","nodes":[{},{}]}]},"tombstones":{}}`
	next := `{"data":{"projects":[]},"tombstones":{}}`
	if _, vanished := canvasProjectVanished(old, next); !vanished {
		t.Fatal("项目无墓碑消失必须被判定为丢失，不受任何客户端标志影响")
	}
}
