package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"

	"aicanvas/model"
	"aicanvas/service"
)

// appBuildID 部署版本标识：读 Next 构建产物 .next/BUILD_ID（每次 next build 都变），回退 VERSION。
// 客户端轮询 /api/version，发现与启动时不同即提示刷新——杜绝用户卡在部署前的旧 JS。
var (
	appBuildIDOnce sync.Once
	appBuildID     string
)

func resolveAppBuildID() string {
	appBuildIDOnce.Do(func() {
		// 前后端拆分后，.next/BUILD_ID 只存在于【前端】容器，后端根本读不到，
		// 会一路回退到 /app/VERSION（写死的 v1.0，从不改变）——客户端每次轮询拿到的都一样，
		// 于是永远判定「没有更新」，用户一直卡在部署前的旧 JS 上。
		// 所以优先读部署时注入的发布标识（compose 里的 APP_BUILD_ID，每次构建都变）。
		if v := strings.TrimSpace(os.Getenv("APP_BUILD_ID")); v != "" {
			appBuildID = v
			return
		}
		for _, p := range []string{"/app/web/.next/BUILD_ID", "web/.next/BUILD_ID", ".next/BUILD_ID", "/app/VERSION", "VERSION"} {
			if b, err := os.ReadFile(p); err == nil {
				if v := strings.TrimSpace(string(b)); v != "" {
					appBuildID = v
					return
				}
			}
		}
	})
	return appBuildID
}

// AppVersion GET /api/version —— 公开、轻量，返回当前部署的构建标识，供客户端检测「有新版本→提示刷新」。
func AppVersion(w http.ResponseWriter, r *http.Request) {
	OK(w, map[string]any{"buildId": resolveAppBuildID()})
}

type adminChannelActionRequest struct {
	Index   *int               `json:"index"`
	Channel model.ModelChannel `json:"channel"`
	Model   string             `json:"model"`
}

func Settings(w http.ResponseWriter, r *http.Request) {
	// 登录用户按分组定制可用模型列表（OptionalAuth：匿名时回退全局配置）
	userID := ""
	if user, ok := service.UserFromContext(r.Context()); ok {
		userID = user.ID
	}
	settings, err := service.PublicSettingsForUser(userID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := service.AdminSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSaveSettings(w http.ResponseWriter, r *http.Request) {
	var settings model.Settings
	_ = json.NewDecoder(r.Body).Decode(&settings)
	result, err := service.SaveSettings(settings)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminChannelModels(w http.ResponseWriter, r *http.Request) {
	var request adminChannelActionRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	index := request.Index
	if me, _ := service.UserFromContext(r.Context()); me.Role == model.UserRoleAdminL2 {
		// 二级管理员只能测请求体里自带的渠道配置，禁止用 index 回退到全局已存渠道密钥。
		index = nil
	}
	models, err := service.AdminChannelModels(index, request.Channel)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, models)
}

func AdminTestChannelModel(w http.ResponseWriter, r *http.Request) {
	var request adminChannelActionRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	index := request.Index
	if me, _ := service.UserFromContext(r.Context()); me.Role == model.UserRoleAdminL2 {
		// 同上：二级管理员不得借 index 命中全局密钥。
		index = nil
	}
	result, err := service.AdminTestChannelModel(index, request.Channel, request.Model)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}
