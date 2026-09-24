package repository

import (
	"fmt"
	"testing"
	"time"

	"aicanvas/model"
)

// 收藏提示词的仓储层测试。三件事必须锁死：
//
//  1. **`references` 是 SQL 保留字。** 表里有一列就叫 references（SQLite 里 REFERENCES 是外键
//     约束关键字）。建表能过不代表读写能过——引号漏一处，插入或查询就会在运行时炸。
//     这组测试每条都往那一列写真实 JSON 再读回来比对。
//  2. **幂等。** 同一画布同一节点重复收藏必须是更新而不是新增。前端把「已收藏」标记写在节点
//     metadata 上，而这一拍写入有被 skipNextPersist 吞掉的可能，标记一丢用户就会再点一次。
//  3. **归属隔离。** 删除必须同时按 user_id 过滤，否则任何登录用户凭 id 就能删别人的收藏。

func newTestFavorite(t *testing.T, userID, canvasID, nodeID string) model.PromptFavorite {
	t.Helper()
	return model.PromptFavorite{
		UserID:       userID,
		Username:     "fav-" + userID,
		CanvasID:     canvasID,
		SourceNodeID: nodeID,
		Kind:         "image",
		PromptDraft:  "画一只猫 @[node:image-1]",
		Prompt:       "画一只猫 图片1",
		Config:       `{"model":"seedream-4","size":"16:9"}`,
		// 故意带上完整的 references JSON：这一列的列名是 SQL 保留字，必须真的写进去再读出来。
		References: `[{"kind":"image","label":"图片1","fileKey":"abc123","mimeType":"image/png","bytes":42}]`,
		Title:      "测试收藏",
	}
}

func TestSavePromptFavoriteRoundTripsReservedWordColumn(t *testing.T) {
	seq := time.Now().UnixNano()
	userID := fmt.Sprintf("user-fav-%d", seq)
	canvasID := fmt.Sprintf("canvas-%d", seq)
	item := newTestFavorite(t, userID, canvasID, "node-1")

	saved, err := SavePromptFavorite(item)
	if err != nil {
		t.Fatalf("保存收藏失败（若报 near \"references\" 就是保留字没被引号包住）: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("保存后必须有 id")
	}
	if saved.CreatedAt == "" || saved.UpdatedAt == "" {
		t.Fatal("保存后必须有创建/更新时间")
	}

	got, err := FindPromptFavoriteByNode(userID, canvasID, "node-1")
	if err != nil {
		t.Fatalf("按节点查收藏失败: %v", err)
	}
	if got.ID != saved.ID {
		t.Fatalf("按节点查到的应是刚存那条，期望 %s 实得 %s", saved.ID, got.ID)
	}
	// 这一句是本测试的核心：保留字列的内容必须原样往返。
	if got.References != item.References {
		t.Fatalf("references 列内容被改写了\n期望: %s\n实得: %s", item.References, got.References)
	}
	if got.Config != item.Config {
		t.Fatalf("config 列内容被改写了，期望 %s 实得 %s", item.Config, got.Config)
	}
	if got.PromptDraft != item.PromptDraft {
		t.Fatalf("promptDraft 必须原样保留（含 @[node:] token），实得 %s", got.PromptDraft)
	}
}

func TestSavePromptFavoriteIsIdempotentPerNode(t *testing.T) {
	seq := time.Now().UnixNano()
	userID := fmt.Sprintf("user-fav-%d", seq)
	canvasID := fmt.Sprintf("canvas-%d", seq)

	first, err := SavePromptFavorite(newTestFavorite(t, userID, canvasID, "node-1"))
	if err != nil {
		t.Fatalf("首次收藏失败: %v", err)
	}

	// 同一节点再收藏一次：内容变了，但必须更新那条、不能新增。
	second := newTestFavorite(t, userID, canvasID, "node-1")
	second.Prompt = "换了提示词"
	second.References = `[{"kind":"audio","label":"音频1","fileKey":"zzz","mimeType":"audio/mpeg"}]`
	updated, err := SavePromptFavorite(second)
	if err != nil {
		t.Fatalf("重复收藏失败: %v", err)
	}
	if updated.ID != first.ID {
		t.Fatalf("重复收藏必须复用同一条记录（幂等），期望 id %s 实得 %s", first.ID, updated.ID)
	}
	if updated.CreatedAt != first.CreatedAt {
		t.Fatalf("重复收藏应保留首次收藏时间，期望 %s 实得 %s", first.CreatedAt, updated.CreatedAt)
	}
	if updated.Prompt != "换了提示词" {
		t.Fatalf("重复收藏应覆盖内容，实得 %s", updated.Prompt)
	}

	items, total, err := ListPromptFavorites(userID, "", "", "", 1, 50)
	if err != nil {
		t.Fatalf("列表查询失败: %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("同一节点重复收藏后只应有 1 条，实得 total=%d len=%d", total, len(items))
	}
	if items[0].References != second.References {
		t.Fatalf("更新后 references 应是新内容，实得 %s", items[0].References)
	}
}

func TestDeletePromptFavoriteRefusesOtherUsers(t *testing.T) {
	seq := time.Now().UnixNano()
	owner := fmt.Sprintf("user-owner-%d", seq)
	stranger := fmt.Sprintf("user-stranger-%d", seq)
	canvasID := fmt.Sprintf("canvas-%d", seq)

	saved, err := SavePromptFavorite(newTestFavorite(t, owner, canvasID, "node-1"))
	if err != nil {
		t.Fatalf("保存收藏失败: %v", err)
	}

	// 别人拿着 id 也删不掉。少了 user_id 这个条件，任何登录用户就能删全站的收藏。
	affected, err := DeletePromptFavorite(stranger, saved.ID)
	if err != nil {
		t.Fatalf("删除调用不应报错: %v", err)
	}
	if affected != 0 {
		t.Fatalf("别的用户不得删掉这条收藏，却删掉了 %d 行", affected)
	}
	still, err := FindPromptFavoriteByNode(owner, canvasID, "node-1")
	if err != nil || still.ID == "" {
		t.Fatalf("收藏应还在，err=%v id=%s", err, still.ID)
	}

	affected, err = DeletePromptFavorite(owner, saved.ID)
	if err != nil {
		t.Fatalf("本人删除失败: %v", err)
	}
	if affected != 1 {
		t.Fatalf("本人删除应影响 1 行，实得 %d", affected)
	}
}

func TestListPromptFavoriteNodeRefsCarriesFavoriteID(t *testing.T) {
	seq := time.Now().UnixNano()
	userID := fmt.Sprintf("user-fav-%d", seq)
	canvasID := fmt.Sprintf("canvas-%d", seq)
	other := fmt.Sprintf("canvas-other-%d", seq)

	a, err := SavePromptFavorite(newTestFavorite(t, userID, canvasID, "node-1"))
	if err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	if _, err := SavePromptFavorite(newTestFavorite(t, userID, canvasID, "node-2")); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	// 另一块画布的收藏不该出现在这块画布的校正结果里。
	if _, err := SavePromptFavorite(newTestFavorite(t, userID, other, "node-3")); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	rows, err := ListPromptFavoriteNodeRefs(userID, canvasID)
	if err != nil {
		t.Fatalf("查画布收藏节点失败: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("这块画布应有 2 个已收藏节点，实得 %d", len(rows))
	}
	byNode := map[string]string{}
	for _, row := range rows {
		byNode[row.SourceNodeID] = row.ID
	}
	// 收藏 id 必须带回来：前端「取消收藏」用的就是它，只给节点 id 的话校正完就没法取消了。
	if byNode["node-1"] != a.ID {
		t.Fatalf("node-1 应带回收藏 id %s，实得 %q", a.ID, byNode["node-1"])
	}
	if byNode["node-2"] == "" {
		t.Fatal("node-2 也必须带回非空的收藏 id")
	}
}

func TestListPromptFavoritesFiltersByKeywordAndUser(t *testing.T) {
	seq := time.Now().UnixNano()
	userA := fmt.Sprintf("user-a-%d", seq)
	userB := fmt.Sprintf("user-b-%d", seq)
	canvasID := fmt.Sprintf("canvas-%d", seq)

	itemA := newTestFavorite(t, userA, canvasID, "node-1")
	itemA.Prompt = "一只戴帽子的橘猫"
	if _, err := SavePromptFavorite(itemA); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	itemB := newTestFavorite(t, userB, canvasID, "node-1")
	itemB.Prompt = "一辆红色跑车"
	if _, err := SavePromptFavorite(itemB); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	// 用户维度隔离：查 A 不该看到 B 的。
	items, _, err := ListPromptFavorites(userA, "", "", "", 1, 50)
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	for _, item := range items {
		if item.UserID != userA {
			t.Fatalf("查 %s 的收藏却返回了 %s 的", userA, item.UserID)
		}
	}

	// 关键词命中提示词正文。
	hits, _, err := ListPromptFavorites("", "", "", "橘猫", 1, 50)
	if err != nil {
		t.Fatalf("关键词查询失败: %v", err)
	}
	found := false
	for _, item := range hits {
		if item.UserID == userA {
			found = true
		}
		if item.UserID == userB {
			t.Fatal("「橘猫」不应命中「一辆红色跑车」那条")
		}
	}
	if !found {
		t.Fatal("关键词「橘猫」应命中 A 的收藏")
	}
}
