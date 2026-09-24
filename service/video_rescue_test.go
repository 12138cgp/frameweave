package service

import (
	"encoding/json"
	"testing"
	"time"
)

// TestNextCanvasRevMonotonic 复刻前端 hlc.ts tick() 的语义：新 rev 必须严格大于已见 rev，
// 且不低于当前墙钟毫秒。这是让服务端回写在客户端深合并中判胜的唯一依据（见 sync-merge.ts entityNewer）。
func TestNextCanvasRevMonotonic(t *testing.T) {
	wall := time.Now().UnixMilli()
	cases := []float64{0, 1, 12345, float64(wall), float64(wall + 100000)}
	for _, seen := range cases {
		got := nextCanvasRev(seen)
		if got <= int64(seen) {
			t.Fatalf("nextCanvasRev(%v) = %d，必须严格大于 seen", seen, got)
		}
		if got < wall {
			t.Fatalf("nextCanvasRev(%v) = %d，不应低于墙钟 %d", seen, got, wall)
		}
	}
}

// TestForEachCanvasVideoNodeMatch 只命中 metadata.videoTaskId 相符的节点，不误伤其它节点。
func TestForEachCanvasVideoNodeMatch(t *testing.T) {
	canvas := `{
      "data":{"projects":[
        {"id":"p1","nodes":[
          {"id":"n1","rev":100,"metadata":{"videoTaskId":"job-A","status":"loading"}},
          {"id":"n2","rev":200,"metadata":{"videoTaskId":"job-B","status":"loading"}},
          {"id":"n3","metadata":{"status":"success"}}
        ]},
        {"id":"p2","nodes":[
          {"id":"n4","rev":300,"metadata":{"videoTaskId":"job-A","status":"success"}}
        ]}
      ]}}`
	var hit []string
	root := forEachCanvasVideoNode(canvas, "job-A", func(node map[string]any, meta map[string]any) {
		id, _ := node["id"].(string)
		hit = append(hit, id)
	})
	if root == nil {
		t.Fatal("解析失败")
	}
	if len(hit) != 2 || hit[0] != "n1" || hit[1] != "n4" {
		t.Fatalf("命中节点应为 [n1 n4]，实际 %v", hit)
	}
}

// TestPatchBumpsRevAndKeepsOtherNodes 回写必须：①推进 rev ②改 metadata ③不动其它节点/顶层字段。
// 这里直接复刻 tryPatch 里的改写逻辑（不碰 DB），断言产出的 JSON 形态正确。
func TestPatchBumpsRevAndKeepsOtherNodes(t *testing.T) {
	canvas := `{
      "app":"aicanvas","version":1,
      "nodeTombstones":{"dead":{"deletedAt":"x","rev":9}},
      "data":{"projects":[{"id":"p1","nodes":[
        {"id":"n1","rev":100,"updatedAt":"2026-01-01T00:00:00.000Z","metadata":{"videoTaskId":"job-A","status":"loading","prompt":"狗"}},
        {"id":"other","rev":7,"metadata":{"status":"success"}}
      ]}]}}`

	patched := false
	root := forEachCanvasVideoNode(canvas, "job-A", func(node map[string]any, meta map[string]any) {
		if status, _ := meta["status"].(string); status != canvasNodeStatusLoading {
			return
		}
		meta["status"] = canvasNodeStatusSuccess
		meta["content"] = "https://bucket/x.mp4"
		meta["storageKey"] = "video:abc"
		delete(meta, "videoTaskId")
		seen, _ := node["rev"].(float64)
		node["rev"] = nextCanvasRev(seen)
		node["updatedAt"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		patched = true
	})
	if !patched || root == nil {
		t.Fatal("应命中并改写")
	}

	out, err := json.Marshal(root)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("回读失败: %v", err)
	}

	// 顶层字段不能丢
	for _, key := range []string{"app", "version", "nodeTombstones", "data"} {
		if _, ok := back[key]; !ok {
			t.Fatalf("顶层字段 %s 丢失", key)
		}
	}
	nodes := back["data"].(map[string]any)["projects"].([]any)[0].(map[string]any)["nodes"].([]any)

	n1 := nodes[0].(map[string]any)
	if rev, _ := n1["rev"].(float64); rev <= 100 {
		t.Fatalf("rev 必须推进，实际 %v", rev)
	}
	m1 := n1["metadata"].(map[string]any)
	if m1["status"] != "success" || m1["content"] != "https://bucket/x.mp4" {
		t.Fatalf("metadata 未正确改写: %v", m1)
	}
	if _, still := m1["videoTaskId"]; still {
		t.Fatal("videoTaskId 应被清除")
	}
	if m1["prompt"] != "狗" {
		t.Fatal("原有 metadata 字段不应丢失")
	}

	// 其它节点必须原样
	other := nodes[1].(map[string]any)
	if rev, _ := other["rev"].(float64); rev != 7 {
		t.Fatalf("其它节点 rev 被动了: %v", rev)
	}
	if len(nodes) != 2 {
		t.Fatalf("节点数变了: %d", len(nodes))
	}
}

// TestTombstonedNodeNotResurrected 已删节点（有墓碑）绝不能被回写复活。
// 背景：前端墓碑仲裁是「节点 rev > 墓碑 rev 就复活并作废墓碑」，而我们回写会把 rev 顶到
// 毫秒时间戳、必然大于墓碑 rev —— 不做这道判断就会把用户刚删的节点硬生生复活。
func TestTombstonedNodeNotResurrected(t *testing.T) {
	canvas := `{
      "nodeTombstones":{"video-dead":{"deletedAt":"2026-07-27T00:00:00Z","rev":5}},
      "data":{"projects":[{"id":"p1","nodes":[
        {"id":"video-dead","rev":5,"metadata":{"videoTaskId":"job-X","status":"loading"}},
        {"id":"video-alive","rev":5,"metadata":{"videoTaskId":"job-X","status":"loading"}}
      ]}]}}`

	tomb := canvasNodeTombstones(canvas)
	if !tomb["video-dead"] {
		t.Fatal("应识别出 video-dead 的墓碑")
	}
	if tomb["video-alive"] {
		t.Fatal("video-alive 不应被当成已删")
	}

	var touched []string
	forEachCanvasVideoNode(canvas, "job-X", func(node map[string]any, meta map[string]any) {
		id, _ := node["id"].(string)
		if tomb[id] {
			return // 与生产逻辑一致：跳过已删节点
		}
		touched = append(touched, id)
	})
	if len(touched) != 1 || touched[0] != "video-alive" {
		t.Fatalf("只应回写 video-alive，实际 %v", touched)
	}
}
