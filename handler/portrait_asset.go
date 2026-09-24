package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"aicanvas/service"
)

type portraitAssetRequest struct {
	URL string `json:"url"`
	// SourceURL 服务端重抓模式：客户端读不到本地像素（如画布从他人分享导入、图仍在对方桶、浏览器跨域取不到）时，
	// 只传源图公网地址，由服务端抓取转存进本用户桶后入库。URL 为空且 SourceURL 非空时走此路径。
	SourceURL   string `json:"sourceUrl"`
	StorageKey  string `json:"storageKey"`
	ContentHash string `json:"contentHash"`
	Title       string `json:"title"`
	// Kind 媒体类型 image/video/audio，对应火山 CreateAsset 的 AssetType。
	// 老客户端不传 → 归一化为 image，行为与改造前一致。
	Kind string `json:"kind"`
}

// PortraitAssets 返回当前用户的全部人像资产记录。
func PortraitAssets(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	items, err := service.ListUserPortraitAssets(user.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, items)
}

// CreatePortraitAsset 把人设图提交火山资产库入库审核。
func CreatePortraitAsset(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var request portraitAssetRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	kind := service.NormalizePortraitAssetKind(request.Kind)
	if strings.TrimSpace(request.URL) == "" {
		// 回退：客户端读不到本地像素，只给了源素材公网地址 → 服务端抓取转存进本用户桶后入库。
		if strings.TrimSpace(request.SourceURL) != "" {
			record, err := service.SubmitPortraitAssetFromURL(user.ID, request.SourceURL, request.StorageKey, request.Title, kind)
			if err != nil {
				FailError(w, err)
				return
			}
			OK(w, record)
			return
		}
		Fail(w, "缺少"+kind.Label()+"地址")
		return
	}
	record, err := service.SubmitPortraitAsset(user.ID, request.URL, request.StorageKey, request.ContentHash, request.Title, kind)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, record)
}

// GetPortraitAsset 查询单条人像资产状态（仍在审核中会实时刷新一次）。
func GetPortraitAsset(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	record, err := service.GetUserPortraitAsset(user.ID, id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, record)
}

// RemotePortraitAssets 直接列出火山资产库中当前项目下的素材，用于核对。
func RemotePortraitAssets(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	items, project, err := service.ListRemotePortraitAssets(user.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"projectName": project, "items": items})
}

// DeletePortraitAsset 删除一条人像资产记录。
func DeletePortraitAsset(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	if err := service.DeleteUserPortraitAsset(user.ID, id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}
