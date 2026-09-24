package handler

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
	"github.com/google/uuid"
)

const groupAssetMaxBytes = 60 << 20

var groupAssetKinds = map[string]bool{"image": true, "video": true, "audio": true}

func groupAssetsDir(groupID string) string {
	return filepath.Join(referenceDataDir(), "group-files", groupID)
}

// contentURL 把本地磁盘存储的素材换成可访问的 content 端点；TOS 公网 URL 原样返回。
func groupAssetWithURL(item model.GroupAsset) model.GroupAsset {
	if !strings.HasPrefix(item.URL, "http://") && !strings.HasPrefix(item.URL, "https://") {
		item.URL = "/api/v1/group-assets/" + item.ID + "/content"
	}
	return item
}

// ListGroupAssets GET /api/v1/group-assets —— 当前用户所在分组的共享素材清单。
func ListGroupAssets(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	if user.GroupID == "" {
		OK(w, []model.GroupAsset{})
		return
	}
	items, err := repository.ListGroupAssets(user.GroupID)
	if err != nil {
		FailError(w, err)
		return
	}
	out := make([]model.GroupAsset, 0, len(items))
	for _, item := range items {
		out = append(out, groupAssetWithURL(item))
	}
	OK(w, out)
}

// UploadGroupAsset POST /api/v1/group-assets —— multipart(file, kind, custom_name, source_canvas_name, mime_type, width, height, duration_ms)
func UploadGroupAsset(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	if user.GroupID == "" {
		Fail(w, "你尚未分配分组，暂不能使用团队素材")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, groupAssetMaxBytes+1)
	if err := r.ParseMultipartForm(groupAssetMaxBytes); err != nil {
		Fail(w, "文件过大或上传格式不正确")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	kind := r.FormValue("kind")
	if !groupAssetKinds[kind] {
		Fail(w, "素材类型不正确")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请上传文件")
		return
	}
	defer file.Close()
	mimeType := r.FormValue("mime_type")
	if mimeType == "" {
		mimeType = header.Header.Get("Content-Type")
	}
	data, err := io.ReadAll(file)
	if err != nil {
		Fail(w, "文件读取失败")
		return
	}
	storageKey := strings.ReplaceAll(uuid.NewString(), "-", "")
	ext := syncFileExt(mimeType)

	path := ""
	tosKey := fmt.Sprintf("group-media/%s/%s/%s.%s", user.GroupID, kind, storageKey, ext)
	if service.TOSConfiguredForUser(user.ID) {
		if url, terr := service.UploadToTOSForUser(user.ID, tosKey, data, mimeType); terr == nil {
			path = url
		}
	}
	if path == "" {
		// 未配置对象存储 / 组桶配置不完整 / 上传失败 → 落本组本地磁盘（非全局公共桶，不跨组混入）
		dir := groupAssetsDir(user.GroupID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			FailError(w, err)
			return
		}
		diskPath := filepath.Join(dir, storageKey+"."+ext)
		if err := os.WriteFile(diskPath, data, 0o644); err != nil {
			FailError(w, err)
			return
		}
		path = diskPath
	}

	ownerName := user.DisplayName
	if strings.TrimSpace(ownerName) == "" {
		ownerName = user.Username
	}
	// 来源项目：前端传 canvas 所属项目 id；反查项目名反范式化存下，供团队素材按项目筛选/展示（项目改名后仍稳定）。
	projectID := strings.TrimSpace(r.FormValue("project_id"))
	projectName := ""
	if projectID != "" {
		if p, ok, _ := repository.GetProjectByID(projectID); ok {
			projectName = p.Name
		}
	}
	asset := model.GroupAsset{
		GroupID:             user.GroupID,
		OwnerUserID:         user.ID,
		OwnerName:           ownerName,
		SourceCanvasName:    strings.TrimSpace(r.FormValue("source_canvas_name")),
		CustomName:          strings.TrimSpace(r.FormValue("custom_name")),
		Kind:                kind,
		URL:                 path,
		StorageKey:          storageKey,
		MimeType:            mimeType,
		Bytes:               int64(len(data)),
		Width:               atoiSafe(r.FormValue("width")),
		Height:              atoiSafe(r.FormValue("height")),
		DurationMs:          atoiSafe(r.FormValue("duration_ms")),
		PortraitAssetID:     strings.TrimSpace(r.FormValue("portrait_asset_id")),
		PortraitAssetStatus: strings.TrimSpace(r.FormValue("portrait_asset_status")),
		PortraitAssetURI:    strings.TrimSpace(r.FormValue("portrait_asset_uri")),
		ProjectID:           projectID,
		ProjectName:         projectName,
	}
	saved, err := repository.CreateGroupAsset(asset)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, groupAssetWithURL(saved))
}

// DeleteGroupAsset DELETE /api/v1/group-assets/:id —— 本人或管理员可删。
func DeleteGroupAsset(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, err := repository.GetGroupAssetByID(id)
	if err != nil || item.ID == "" {
		http.NotFound(w, r)
		return
	}
	if item.GroupID != user.GroupID {
		Fail(w, "无权操作其它分组的素材")
		return
	}
	if item.OwnerUserID != user.ID && user.Role != model.UserRoleAdmin {
		Fail(w, "只能删除自己上传的素材")
		return
	}
	if err := repository.DeleteGroupAsset(id); err != nil {
		FailError(w, err)
		return
	}
	// 本地磁盘文件顺手删除；TOS 对象暂不回收（与 sync 一致，孤儿量小可忽略）。
	if !strings.HasPrefix(item.URL, "http") {
		_ = os.Remove(item.URL)
	}
	OK(w, map[string]any{"id": id})
}

// GetGroupAssetContent GET /api/v1/group-assets/:id/content —— 同组成员可取（TOS 跳转 / 磁盘读盘）。
func GetGroupAssetContent(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, err := repository.GetGroupAssetByID(id)
	if err != nil || item.ID == "" {
		http.NotFound(w, r)
		return
	}
	if item.GroupID != user.GroupID {
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(item.URL, "http://") || strings.HasPrefix(item.URL, "https://") {
		http.Redirect(w, r, item.URL, http.StatusFound)
		return
	}
	if item.MimeType != "" {
		w.Header().Set("Content-Type", item.MimeType)
	}
	http.ServeFile(w, r, item.URL)
}

func atoiSafe(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return n
}
