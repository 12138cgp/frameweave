package handler

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
	"github.com/google/uuid"
)

// 预览图上限：风格缩略图而已，4MB 足够；给大了只会让组内清单变慢。
const groupStylePreviewMaxBytes = 4 << 20

var groupStyleKinds = map[string]bool{"image": true, "video": true}

func groupStylesDir(groupID string) string {
	return filepath.Join(referenceDataDir(), "group-styles", groupID)
}

// 磁盘存储的预览图换成 content 端点；TOS 公网 URL 原样返回。
func groupStyleWithURL(item model.GroupStyle) model.GroupStyle {
	if item.PreviewURL != "" && !strings.HasPrefix(item.PreviewURL, "http://") && !strings.HasPrefix(item.PreviewURL, "https://") {
		item.PreviewURL = "/api/v1/group-styles/" + item.ID + "/preview"
	}
	return item
}

// canManageGroupStyle 谁能删/改一条共享风格：分享者本人，或管理员（超管/二级管理员）。
// 同组普通成员只能用，不能删别人分享的——否则一个人手滑就能清掉全组的风格。
func canManageGroupStyle(user model.AuthUser, item model.GroupStyle) bool {
	if item.OwnerUserID == user.ID {
		return true
	}
	return user.Role == model.UserRoleAdmin || user.Role == model.UserRoleAdminL2
}

// ListGroupStyles GET /api/v1/group-styles —— 当前用户所在分组的共享风格清单。
func ListGroupStyles(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	if user.GroupID == "" {
		OK(w, []model.GroupStyle{})
		return
	}
	items, err := repository.ListGroupStyles(user.GroupID)
	if err != nil {
		FailError(w, err)
		return
	}
	out := make([]model.GroupStyle, 0, len(items))
	for _, item := range items {
		out = append(out, groupStyleWithURL(item))
	}
	OK(w, out)
}

// ShareGroupStyle POST /api/v1/group-styles —— 把一条个人风格分享到本组。
//
// multipart 字段：kind / source_style_id / name_zh / description / prefix_prompt / inject_prompt / negative_prompt
// 可选文件字段 preview：预览图字节。由前端把本地那张预览图一并传上来——不能只存 storageKey，
// 因为跨账号回退只覆盖公共读桶，磁盘上的文件组内其他人取不到（见 model/group_style.go 注释）。
//
// 同一条个人风格重复分享 = 更新那份共享，不会产生第二条。
func ShareGroupStyle(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	if user.GroupID == "" {
		Fail(w, "当前账号未加入任何分组，无法分享到团队")
		return
	}
	if err := r.ParseMultipartForm(groupStylePreviewMaxBytes); err != nil {
		Fail(w, "请求解析失败")
		return
	}

	kind := strings.TrimSpace(r.FormValue("kind"))
	if !groupStyleKinds[kind] {
		Fail(w, "风格类型不合法")
		return
	}
	nameZh := strings.TrimSpace(r.FormValue("name_zh"))
	if nameZh == "" {
		Fail(w, "风格名称不能为空")
		return
	}
	injectPrompt := strings.TrimSpace(r.FormValue("inject_prompt"))
	if injectPrompt == "" {
		Fail(w, "风格提示词不能为空")
		return
	}
	sourceStyleID := strings.TrimSpace(r.FormValue("source_style_id"))

	// 预览图：可选。传了就复制进本组存储。
	previewURL, previewMime := "", ""
	if file, header, ferr := r.FormFile("preview"); ferr == nil {
		defer file.Close()
		data, rerr := io.ReadAll(io.LimitReader(file, groupStylePreviewMaxBytes))
		if rerr != nil {
			Fail(w, "预览图读取失败")
			return
		}
		if len(data) > 0 {
			previewMime = header.Header.Get("Content-Type")
			if previewMime == "" {
				previewMime = "image/png"
			}
			key := strings.ReplaceAll(uuid.NewString(), "-", "")
			ext := syncFileExt(previewMime)
			tosKey := fmt.Sprintf("group-styles/%s/%s.%s", user.GroupID, key, ext)
			if service.TOSConfiguredForUser(user.ID) {
				if url, terr := service.UploadToTOSForUser(user.ID, tosKey, data, previewMime); terr == nil {
					previewURL = url
				}
			}
			if previewURL == "" {
				dir := groupStylesDir(user.GroupID)
				if err := os.MkdirAll(dir, 0o755); err != nil {
					FailError(w, err)
					return
				}
				diskPath := filepath.Join(dir, key+"."+ext)
				if err := os.WriteFile(diskPath, data, 0o644); err != nil {
					FailError(w, err)
					return
				}
				previewURL = diskPath
			}
		}
	}

	ownerName := user.DisplayName
	if strings.TrimSpace(ownerName) == "" {
		ownerName = user.Username
	}

	item := model.GroupStyle{
		GroupID:         user.GroupID,
		OwnerUserID:     user.ID,
		OwnerName:       ownerName,
		Kind:            kind,
		NameZh:          nameZh,
		Description:     strings.TrimSpace(r.FormValue("description")),
		PrefixPrompt:    strings.TrimSpace(r.FormValue("prefix_prompt")),
		InjectPrompt:    injectPrompt,
		NegativePrompt:  strings.TrimSpace(r.FormValue("negative_prompt")),
		PreviewURL:      previewURL,
		PreviewMimeType: previewMime,
		SourceStyleID:   sourceStyleID,
	}

	// 重复分享同一条个人风格 → 更新已有那份，不新增。
	if sourceStyleID != "" {
		if existing, found, _ := repository.FindGroupStyleBySource(user.GroupID, sourceStyleID); found {
			if !canManageGroupStyle(user, existing) {
				Fail(w, "这条风格由他人分享，无法覆盖")
				return
			}
			existing.NameZh = item.NameZh
			existing.Description = item.Description
			existing.PrefixPrompt = item.PrefixPrompt
			existing.InjectPrompt = item.InjectPrompt
			existing.NegativePrompt = item.NegativePrompt
			// 没重新上传预览图就保留原来那张，别把已有的清掉。
			if previewURL != "" {
				existing.PreviewURL = previewURL
				existing.PreviewMimeType = previewMime
			}
			if err := repository.UpdateGroupStyle(existing); err != nil {
				FailError(w, err)
				return
			}
			OK(w, groupStyleWithURL(existing))
			return
		}
	}

	item.ID = uuid.NewString()
	created, err := repository.CreateGroupStyle(item)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, groupStyleWithURL(created))
}

// DeleteGroupStyle DELETE /api/v1/group-styles/:id —— 取消共享（仅分享者本人或管理员）。
// 只删这条共享记录，分享者本人「我的风格」里那条不受影响。
func DeleteGroupStyle(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, err := repository.GetGroupStyleByID(id)
	if err != nil || item.ID == "" {
		Fail(w, "风格不存在")
		return
	}
	if item.GroupID != user.GroupID {
		Fail(w, "无权操作")
		return
	}
	if !canManageGroupStyle(user, item) {
		Fail(w, "只有分享者本人或管理员可以取消共享")
		return
	}
	if err := repository.DeleteGroupStyle(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"ok": true})
}

// GetGroupStylePreview GET /api/v1/group-styles/:id/preview —— 落盘存储时的预览图读取端点。
func GetGroupStylePreview(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, err := repository.GetGroupStyleByID(id)
	if err != nil || item.ID == "" {
		http.NotFound(w, r)
		return
	}
	if item.GroupID != user.GroupID {
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(item.PreviewURL, "http://") || strings.HasPrefix(item.PreviewURL, "https://") {
		http.Redirect(w, r, item.PreviewURL, http.StatusFound)
		return
	}
	if item.PreviewURL == "" {
		http.NotFound(w, r)
		return
	}
	if item.PreviewMimeType != "" {
		w.Header().Set("Content-Type", item.PreviewMimeType)
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, item.PreviewURL)
}
