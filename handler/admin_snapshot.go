package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
)

// canvasSnapshotListLimit 超管列表最多回传的快照份数（与 PruneSnapshots 保留份数一致）。
const canvasSnapshotListLimit = 30

// countManifestProjects 解析 manifest JSON 文本，返回 data.projects 数组长度；解析失败给 0。
func countManifestProjects(data string) int {
	if data == "" {
		return 0
	}
	var manifest struct {
		Data struct {
			Projects []json.RawMessage `json:"projects"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(data), &manifest); err != nil {
		return 0
	}
	return len(manifest.Data.Projects)
}

// AdminListCanvasSnapshots GET /api/admin/users/:id/canvas-snapshots
// 列该用户 canvas 域历史快照。逐条取 data 算出 projects 计数后丢弃 data，响应不回传 data。
func AdminListCanvasSnapshots(w http.ResponseWriter, r *http.Request, userID string) {
	// domain 可选，默认 canvas（老前端不传即保持原行为）。
	// 快照现已覆盖全部数据域——assets（我的素材）/presets（自定义风格）同样是用户内容，
	// 存了却列不出来等于假兜底。
	domain := strings.TrimSpace(r.URL.Query().Get("domain"))
	if domain == "" {
		domain = model.SyncDomainCanvas
	}
	if !model.IsSyncDomain(domain) {
		Fail(w, "未知的数据域")
		return
	}
	metas, err := repository.ListSnapshots(userID, domain, canvasSnapshotListLimit)
	if err != nil {
		FailError(w, err)
		return
	}
	snapshots := make([]map[string]any, 0, len(metas))
	for _, m := range metas {
		projects := 0
		if full, ok, gerr := repository.GetSnapshotByID(m.ID); gerr == nil && ok {
			projects = countManifestProjects(full.Data)
		}
		snapshots = append(snapshots, map[string]any{
			"id":        m.ID,
			"createdAt": m.CreatedAt,
			"bytes":     m.Bytes,
			"projects":  projects,
		})
	}
	OK(w, map[string]any{"snapshots": snapshots})
}

// AdminGetCanvasSnapshot GET /api/admin/canvas-snapshots/:snapId
// 返回单个快照完整内容（含 data，即该版本完整 manifest JSON 字符串），供前端预览。
func AdminGetCanvasSnapshot(w http.ResponseWriter, r *http.Request, snapID string) {
	snap, ok, err := repository.GetSnapshotByID(snapID)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok || snap.Domain != model.SyncDomainCanvas {
		Fail(w, "快照不存在")
		return
	}
	OK(w, map[string]any{
		"id":        snap.ID,
		"userId":    snap.UserID,
		"createdAt": snap.CreatedAt,
		"bytes":     snap.Bytes,
		"data":      snap.Data,
	})
}

// AdminRestoreCanvasSnapshot POST /api/admin/users/:id/canvas-snapshots/:snapId/restore
// 恢复：先强制把该用户当前 canvas 数据备份成一份快照（绕过节流/去重，可撤销），
// 再用目标快照 data 覆盖当前 SyncData（updatedAt=当前时间）。
func AdminRestoreCanvasSnapshot(w http.ResponseWriter, r *http.Request, userID, snapID string) {
	snap, ok, err := repository.GetSnapshotByID(snapID)
	if err != nil {
		FailError(w, err)
		return
	}
	// 按快照自身的域恢复，不再写死 canvas：快照已覆盖全部数据域，
	// 只认 canvas 会让 assets/presets 的快照存得进、取不出。
	if !ok || !model.IsSyncDomain(snap.Domain) || snap.UserID != userID {
		Fail(w, "快照不存在或不属于该用户")
		return
	}
	// 恢复前备份：把该域当前数据强制存一份（即便与最新快照相同也写，作为可撤销的还原点）。
	backupID := ""
	if current, cerr := repository.GetSyncData(userID, snap.Domain); cerr == nil {
		if id, berr := repository.ForceCanvasSnapshot(userID, snap.Domain, current.Data); berr == nil {
			backupID = id
		} else {
			// 备份失败属于安全网缺失，明确拒绝恢复，避免无回退地覆盖。
			FailError(w, berr)
			return
		}
	} else {
		FailError(w, cerr)
		return
	}
	if _, err := repository.SaveSyncData(userID, snap.Domain, snap.Data); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"restored": true, "domain": snap.Domain, "backupSnapshotId": backupID})
}
