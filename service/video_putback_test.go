package service

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
)

func putbackUID(p string) string { return fmt.Sprintf("%s-%d", p, time.Now().UnixNano()) }

func canvasWithProject(projectID string, nodes string, nodeTombstones string) string {
	tomb := "{}"
	if nodeTombstones != "" {
		tomb = nodeTombstones
	}
	return fmt.Sprintf(`{"data":{"projects":[{"id":"%s","title":"测试画布","nodes":[%s]}]},"nodeTombstones":%s}`,
		projectID, nodes, tomb)
}

func loadProjectNodes(t *testing.T, userID, projectID string) []map[string]any {
	t.Helper()
	item, err := repository.GetSyncData(userID, model.SyncDomainCanvas)
	if err != nil {
		t.Fatalf("读画布失败: %v", err)
	}
	var root map[string]any
	if err := json.Unmarshal([]byte(item.Data), &root); err != nil {
		t.Fatalf("解析画布失败: %v", err)
	}
	for _, raw := range (root["data"].(map[string]any))["projects"].([]any) {
		p := raw.(map[string]any)
		if p["id"] == projectID {
			out := []map[string]any{}
			if ns, ok := p["nodes"].([]any); ok {
				for _, n := range ns {
					out = append(out, n.(map[string]any))
				}
			}
			return out
		}
	}
	return nil
}

// 用户点完生成就关电脑 —— 节点从没同步上云。成片应该被放回【原画布、原位置、原节点 id】。
//
// 用原节点 id 是这件事成立的关键：用户回来同步时，合并看到同一个节点 id，
// 服务端这份（rev 更高）覆盖他本地那个「失败重试」，而不是画布上多出一个重复节点。
func TestPutBackCreatesNodeAtOriginalSpot(t *testing.T) {
	uid := putbackUID("u-putback")
	const pid = "proj-putback"
	const nid = "video-1786099999999-abcde"
	// 云端画布里只有一个别的节点，没有 nid
	if _, err := repository.SaveSyncData(uid, model.SyncDomainCanvas,
		canvasWithProject(pid, `{"id":"other-1","type":"image","nodes":[]}`, "")); err != nil {
		t.Fatalf("准备画布失败: %v", err)
	}
	vr := model.VideoRefund{
		UserID: uid, TaskID: "cgt-test-putback", Model: "doubao-seedance-2-0-260128",
		CanvasID: pid, NodeID: nid, NodeGeom: `{"x":1200,"y":-340,"w":640,"h":360}`,
	}
	ok, err := createCanvasVideoNode(vr, "https://bucket/x/video/abc.mp4", "video:abc", "video/mp4", 12345)
	if err != nil || !ok {
		t.Fatalf("应放回画布，实得 ok=%v err=%v", ok, err)
	}

	nodes := loadProjectNodes(t, uid, pid)
	var got map[string]any
	for _, n := range nodes {
		if n["id"] == nid {
			got = n
		}
	}
	if got == nil {
		t.Fatal("★ 节点没被放回画布")
	}
	meta := got["metadata"].(map[string]any)
	if meta["status"] != canvasNodeStatusSuccess {
		t.Fatalf("状态应为 success，实得 %v", meta["status"])
	}
	if meta["content"] != "https://bucket/x/video/abc.mp4" {
		t.Fatalf("content 应为永久地址，实得 %v", meta["content"])
	}
	pos := got["position"].(map[string]any)
	if pos["x"].(float64) != 1200 || pos["y"].(float64) != -340 {
		t.Fatalf("应放回原位 (1200,-340)，实得 (%v,%v)", pos["x"], pos["y"])
	}
	if got["width"].(float64) != 640 || got["height"].(float64) != 360 {
		t.Fatalf("尺寸应为 640x360，实得 %vx%v", got["width"], got["height"])
	}
	// rev 必须顶到毫秒时间戳级别，否则用户本地那个失败节点会在合并时赢、这次回写作废
	if rev, _ := got["rev"].(float64); rev < 1e12 {
		t.Fatalf("★ rev 没顶高（%v）—— 合并时会输给用户本地那个失败节点，回写等于没写", rev)
	}
}

// ★ 用户看到失败后自己把那个节点删了 —— 绝不能因为救援又把它复活。
// 这与「推高 rev 复活已删节点」是同一类问题。
func TestPutBackNeverResurrectsDeletedNode(t *testing.T) {
	uid := putbackUID("u-tomb")
	const pid = "proj-tomb"
	const nid = "video-deleted-by-user"
	if _, err := repository.SaveSyncData(uid, model.SyncDomainCanvas,
		canvasWithProject(pid, "", fmt.Sprintf(`{"%s":{"rev":123,"deletedAt":"2026-08-08T00:00:00Z"}}`, nid))); err != nil {
		t.Fatalf("准备画布失败: %v", err)
	}
	vr := model.VideoRefund{UserID: uid, TaskID: "cgt-test-tomb", CanvasID: pid, NodeID: nid}
	ok, err := createCanvasVideoNode(vr, "https://bucket/x/video/abc.mp4", "video:abc", "video/mp4", 1)
	if err != nil {
		t.Fatalf("不该报错: %v", err)
	}
	if ok {
		t.Fatal("★ 用户已删除该节点（有墓碑），绝不能放回去复活它")
	}
	if n := len(loadProjectNodes(t, uid, pid)); n != 0 {
		t.Fatalf("画布不该多出节点，实得 %d 个", n)
	}
}

// 节点后来同步上来了：交给按 taskID 的补丁路径，这里不能重复插一个。
func TestPutBackSkipsWhenNodeAlreadyThere(t *testing.T) {
	uid := putbackUID("u-exist")
	const pid = "proj-exist"
	const nid = "video-already-here"
	if _, err := repository.SaveSyncData(uid, model.SyncDomainCanvas,
		canvasWithProject(pid, fmt.Sprintf(`{"id":"%s","type":"video","metadata":{"status":"loading"}}`, nid), "")); err != nil {
		t.Fatalf("准备画布失败: %v", err)
	}
	vr := model.VideoRefund{UserID: uid, TaskID: "cgt-test-exist", CanvasID: pid, NodeID: nid}
	ok, err := createCanvasVideoNode(vr, "https://bucket/x/video/abc.mp4", "video:abc", "video/mp4", 1)
	if err != nil || ok {
		t.Fatalf("节点已存在时不该重复插入，实得 ok=%v err=%v", ok, err)
	}
	if n := len(loadProjectNodes(t, uid, pid)); n != 1 {
		t.Fatalf("应仍只有 1 个节点，实得 %d 个", n)
	}
}

// 画布本身被用户删了 / 云端根本没有这个画布 → 老实退回「我的素材」，别硬塞。
func TestPutBackSkipsWhenCanvasMissing(t *testing.T) {
	uid := putbackUID("u-nocanvas")
	if _, err := repository.SaveSyncData(uid, model.SyncDomainCanvas,
		canvasWithProject("some-other-project", "", "")); err != nil {
		t.Fatalf("准备画布失败: %v", err)
	}
	vr := model.VideoRefund{UserID: uid, TaskID: "cgt-test-nocanvas", CanvasID: "proj-not-exist", NodeID: "video-x"}
	ok, err := createCanvasVideoNode(vr, "https://bucket/x/video/abc.mp4", "video:abc", "video/mp4", 1)
	if err != nil || ok {
		t.Fatalf("云端没有这个画布时应放弃，实得 ok=%v err=%v", ok, err)
	}
}

// 老候选没有画布上下文（这个功能上线前提交的）→ 不报错，走原来的「我的素材」路径。
func TestPutBackNoopWithoutContext(t *testing.T) {
	vr := model.VideoRefund{UserID: putbackUID("u-legacy"), TaskID: "cgt-legacy"}
	ok, err := createCanvasVideoNode(vr, "https://bucket/x/video/abc.mp4", "video:abc", "video/mp4", 1)
	if err != nil || ok {
		t.Fatalf("无上下文时应静默跳过，实得 ok=%v err=%v", ok, err)
	}
}

// 位置信息缺失时给安全默认值，不能算出 NaN 把画布搞坏。
func TestParseNodeGeomFallback(t *testing.T) {
	x, y, w, h := parseNodeGeom("")
	if x != 0 || y != 0 || w != 640 || h != 360 {
		t.Fatalf("空值应回退到 (0,0,640,360)，实得 (%v,%v,%v,%v)", x, y, w, h)
	}
	if _, _, w, h = parseNodeGeom(`{"x":5,"y":6,"w":0,"h":0}`); w != 640 || h != 360 {
		t.Fatalf("尺寸为 0 应回退到 640x360，实得 %vx%v", w, h)
	}
	if x, y, _, _ = parseNodeGeom(`{"x":5,"y":6,"w":800,"h":450}`); x != 5 || y != 6 {
		t.Fatalf("正常值应原样取用，实得 (%v,%v)", x, y)
	}
}
