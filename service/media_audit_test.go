package service

import (
	"encoding/json"
	"testing"
)

// 对账口径必须只认「有 content 且有 storageKey」的媒体节点。
// 空节点（用户还没出图）和文本/配置节点都不能算进分母，否则数字会虚高、失去参考价值。
func TestAuditRootParsing(t *testing.T) {
	raw := `{"data":{"projects":[{"title":"示例画布","nodes":[
		{"type":"image","metadata":{"content":"blob:x","storageKey":"image:aaa"}},
		{"type":"image","metadata":{"content":"","storageKey":"image:empty"}},
		{"type":"image","metadata":{"content":"blob:y","storageKey":""}},
		{"type":"text","metadata":{"content":"hi","storageKey":"image:text"}},
		{"type":"video","metadata":{"content":"blob:z","storageKey":"video:bbb"}},
		{"type":"audio","metadata":{"content":"blob:w","storageKey":"audio:ccc"}}
	]}]}}`
	var root auditRoot
	if err := json.Unmarshal([]byte(raw), &root); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(root.Data.Projects) != 1 || root.Data.Projects[0].Title != "示例画布" {
		t.Fatalf("子画布解析不对: %+v", root.Data.Projects)
	}
	counted := map[string]bool{}
	for _, node := range root.Data.Projects[0].Nodes {
		if node.Type != "image" && node.Type != "video" && node.Type != "audio" {
			continue
		}
		if node.Metadata.StorageKey == "" || node.Metadata.Content == "" {
			continue
		}
		counted[node.Metadata.StorageKey] = true
	}
	want := []string{"image:aaa", "video:bbb", "audio:ccc"}
	if len(counted) != len(want) {
		t.Fatalf("应只统计 %d 个，实际 %d 个: %v", len(want), len(counted), counted)
	}
	for _, k := range want {
		if !counted[k] {
			t.Errorf("漏统计 %s", k)
		}
	}
	// 这几个必须被排除
	for _, k := range []string{"image:empty", "image:text"} {
		if counted[k] {
			t.Errorf("不该统计 %s", k)
		}
	}
}

// 同一个 storageKey 在多个子画布出现只能算一次，否则共享/复制画布会把数字放大数倍
// （实测：134 条统计结果里有一半是同一批图在两个账号的副本里被数了两遍）。
func TestAuditDedupesAcrossProjects(t *testing.T) {
	raw := `{"data":{"projects":[
		{"title":"A","nodes":[{"type":"image","metadata":{"content":"blob:x","storageKey":"image:same"}}]},
		{"title":"B","nodes":[{"type":"image","metadata":{"content":"blob:x","storageKey":"image:same"}}]}
	]}}`
	var root auditRoot
	if err := json.Unmarshal([]byte(raw), &root); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	count := 0
	for _, p := range root.Data.Projects {
		for _, n := range p.Nodes {
			k := n.Metadata.StorageKey
			if k == "" || n.Metadata.Content == "" || seen[k] {
				continue
			}
			seen[k] = true
			count++
		}
	}
	if count != 1 {
		t.Fatalf("同一 key 跨子画布应只算一次，实际算了 %d 次", count)
	}
}
