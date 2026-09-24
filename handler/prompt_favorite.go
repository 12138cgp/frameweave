package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
	"github.com/google/uuid"
)

// 「收藏提示词」用户侧接口。
//
// 一条收藏 = 这次生成的完整输入：提示词（原文 + 烘焙版）+ 配置 + 风格快照 +
// 参考素材副本 + 成品副本。目的是让用户日后能复现「效果好的那一次」，
// 也让管理员能把全站的好提示词连同素材批量提取出来。
//
// 两条设计原则，改这个文件前先读：
//
//  1. **参考素材存副本，不存引用。** 引用的坑「团队素材取用」已经踩过——上传者一删，
//     取用方就成死链。收藏更怕这个：用户收藏就是为了以后还能用，管理员提取时更不能扑空。
//  2. **单项失败绝不拖垮整条收藏。** 一张参考图取不到就标记 Missing 继续，
//     用户至少留住了提示词和其余素材，而不是白点一次、还不知道为什么失败。

const favoriteFileMaxBytes = 60 << 20

// favoriteFileKeyPattern 只允许 uuid 去掉横线后的字符集，堵死路径穿越。
var favoriteFileKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func favoriteFilesDir(userID string) string {
	return filepath.Join(referenceDataDir(), "favorite-files", userID)
}

// favoriteTOSKey 转存副本在对象存储里的位置。
//
// 用独立前缀 favorites/ 而不是复用 media/：收藏副本的语义是「永不随原素材消失」，
// 将来任何针对 media/ 的清理、迁移、对账策略都不该扫到它。
func favoriteTOSKey(userID, fileKey, mimeType string) string {
	return fmt.Sprintf("favorites/%s/%s.%s", userID, fileKey, syncFileExt(mimeType))
}

type promptFavoriteAssetInput struct {
	Kind         string `json:"kind"`
	Label        string `json:"label"`
	Text         string `json:"text"`
	StorageKey   string `json:"storageKey"`
	URL          string `json:"url"`
	MimeType     string `json:"mimeType"`
	DurationMs   int64  `json:"durationMs"`
	SourceNodeID string `json:"sourceNodeId"`
}

type promptFavoriteRequest struct {
	CanvasID    string `json:"canvasId"`
	CanvasTitle string `json:"canvasTitle"`
	NodeID      string `json:"nodeId"`
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	Note        string `json:"note"`
	PromptDraft string `json:"promptDraft"`
	Prompt      string `json:"prompt"`
	// Config / StyleSnapshot 原样透传落库，服务端不解析——
	// 生成配置项散在前端六处且还在增加，后端跟着定义结构必然追不上。
	Config        json.RawMessage            `json:"config"`
	StyleSnapshot json.RawMessage            `json:"styleSnapshot"`
	References    []promptFavoriteAssetInput `json:"references"`
	Result        *promptFavoriteAssetInput  `json:"result"`
}

// fetchRemoteBytes 下载远端素材（没配对象存储时才用到）。
// 带超时与体积上限：这里的 URL 来自画布节点，可能指向任意上游图床。
func fetchRemoteBytes(url string, maxBytes int64) ([]byte, error) {
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("下载素材失败: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errors.New("素材超出单文件上限")
	}
	return data, nil
}

// persistFavoriteAsset 把一份参考素材/成品复制成收藏专属副本。
//
// 为什么是服务端复制、而不是让前端把字节传上来：
// 素材在被用来生成的那一刻就已经同步到服务端了（画布同步会上传全部 storageKey），
// 本地磁盘或对象存储里本来就有一份。让前端再传一遍，等于把几十 MB 的图片视频
// 在用户网络上来回搬一趟，慢、耗流量、还容易半路失败。
//
// 来源按优先级：本人 sync_files 里的登记 → 请求里带的公网 URL → 都没有则报错。
// 返回 (fileKey, filePath, 字节数)。filePath 是对象存储 URL 或本地路径，绝不下发给前端。
func persistFavoriteAsset(userID, storageKey, srcURL, mimeType string) (string, string, int64, error) {
	src := strings.TrimSpace(srcURL)
	if key := strings.TrimSpace(storageKey); key != "" && syncStorageKeyPattern.MatchString(key) {
		if item, ferr := repository.GetSyncFile(userID, key); ferr == nil && item.Path != "" {
			src = item.Path
			if strings.TrimSpace(mimeType) == "" {
				mimeType = item.MimeType
			}
		}
	}
	if src == "" {
		return "", "", 0, errors.New("这份素材在服务端没有可用来源")
	}
	// blob: / data: 都是前端运行时地址，服务端取不到（这个项目历史上反复把 blob: 写进持久字段，
	// 遇到就直接判失败，让调用方标 Missing，不要白白发一次请求。
	if !strings.HasPrefix(src, "http://") && !strings.HasPrefix(src, "https://") && !filepath.IsAbs(src) {
		return "", "", 0, errors.New("素材地址不是服务端可读取的位置")
	}
	fileKey := strings.ReplaceAll(uuid.NewString(), "-", "")
	remote := strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://")

	// 优先进对象存储，与画布素材同一套策略（各用户组用自己的桶、各付各的费）。
	if service.TOSConfiguredForUser(userID) {
		tosKey := favoriteTOSKey(userID, fileKey, mimeType)
		if remote {
			url, terr := service.FetchAndUploadToTOSForUser(userID, src, tosKey, mimeType, favoriteFileMaxBytes)
			if terr != nil {
				return "", "", 0, terr
			}
			// 抓取转存拿不到确切字节数，留 0；列表展示与打包都不依赖它。
			return fileKey, url, 0, nil
		}
		data, rerr := os.ReadFile(src)
		if rerr != nil {
			return "", "", 0, rerr
		}
		url, terr := service.UploadToTOSForUser(userID, tosKey, data, mimeType)
		if terr != nil {
			return "", "", 0, terr
		}
		return fileKey, url, int64(len(data)), nil
	}

	// 没配对象存储：落本地磁盘 data/favorite-files/{userID}/。
	if err := os.MkdirAll(favoriteFilesDir(userID), 0o755); err != nil {
		return "", "", 0, err
	}
	var data []byte
	if remote {
		fetched, ferr := fetchRemoteBytes(src, favoriteFileMaxBytes)
		if ferr != nil {
			return "", "", 0, ferr
		}
		data = fetched
	} else {
		read, rerr := os.ReadFile(src)
		if rerr != nil {
			return "", "", 0, rerr
		}
		if int64(len(read)) > favoriteFileMaxBytes {
			return "", "", 0, errors.New("素材超出单文件上限")
		}
		data = read
	}
	target := filepath.Join(favoriteFilesDir(userID), fileKey)
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", "", 0, err
	}
	return fileKey, target, int64(len(data)), nil
}

func decodeFavoriteRefs(raw string) []model.PromptFavoriteRef {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var refs []model.PromptFavoriteRef
	if err := json.Unmarshal([]byte(raw), &refs); err != nil {
		return nil
	}
	return refs
}

// sanitizeFavorite 下发前剥掉服务端内部字段。
//
// FilePath 是本地磁盘路径或桶内地址，暴露等于泄露服务器目录结构 / 绕过接口直取。
// 做成「统一出口清一次」而不是各调用方自己记得清——这种事只要靠自觉，早晚漏一处。
func sanitizeFavorite(item model.PromptFavorite) model.PromptFavorite {
	item.ResultFilePath = ""
	refs := decodeFavoriteRefs(item.References)
	if refs == nil {
		item.References = "[]"
		return item
	}
	for i := range refs {
		refs[i].FilePath = ""
	}
	encoded, err := json.Marshal(refs)
	if err != nil {
		item.References = "[]"
		return item
	}
	item.References = string(encoded)
	return item
}

func sanitizeFavorites(items []model.PromptFavorite) []model.PromptFavorite {
	out := make([]model.PromptFavorite, 0, len(items))
	for _, item := range items {
		out = append(out, sanitizeFavorite(item))
	}
	return out
}

// reuseFavoriteAsset 在旧收藏里找同源的已转存副本。
//
// 重复收藏（取消再收、改了提示词再收）很常见，同一张参考图没必要一存再存。
// 认定「同源」的条件是原始 storageKey 一致且上次转存成功。
func reuseFavoriteAsset(previous []model.PromptFavoriteRef, storageKey string) (model.PromptFavoriteRef, bool) {
	key := strings.TrimSpace(storageKey)
	if key == "" {
		return model.PromptFavoriteRef{}, false
	}
	for _, ref := range previous {
		if ref.SourceStorageKey == key && ref.FileKey != "" && !ref.Missing {
			return ref, true
		}
	}
	return model.PromptFavoriteRef{}, false
}

// CreatePromptFavorite POST /api/v1/prompt-favorites
//
// 幂等：同一画布同一节点重复提交＝更新那条收藏，不会攒出重复记录。
// 这不是可选的优化——前端把「已收藏」标记写在节点 metadata 上，而该项目存在已知的
// 这一拍写入有被 skipNextPersist 吞掉的可能，标记一丢用户就会再点一次。
func CreatePromptFavorite(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var req promptFavoriteRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	canvasID := strings.TrimSpace(req.CanvasID)
	nodeID := strings.TrimSpace(req.NodeID)
	kind := strings.TrimSpace(req.Kind)
	if canvasID == "" || nodeID == "" {
		Fail(w, "缺少画布或节点信息")
		return
	}
	if !model.PromptFavoriteKinds[kind] {
		Fail(w, "只能收藏图片或视频节点")
		return
	}
	if strings.TrimSpace(req.Prompt) == "" && strings.TrimSpace(req.PromptDraft) == "" {
		Fail(w, "这个节点没有提示词，无法收藏")
		return
	}

	// 取上一次的转存结果，用于复用同源副本。查不到就是首次收藏，正常。
	existing, _ := repository.FindPromptFavoriteByNode(user.ID, canvasID, nodeID)
	previousRefs := decodeFavoriteRefs(existing.References)

	refs := make([]model.PromptFavoriteRef, 0, len(req.References))
	missing := 0
	for _, input := range req.References {
		ref := model.PromptFavoriteRef{
			Kind:             strings.TrimSpace(input.Kind),
			Label:            strings.TrimSpace(input.Label),
			MimeType:         strings.TrimSpace(input.MimeType),
			DurationMs:       input.DurationMs,
			SourceNodeID:     strings.TrimSpace(input.SourceNodeID),
			SourceStorageKey: strings.TrimSpace(input.StorageKey),
		}
		// 文本参考没有文件，正文直接存下来即可。
		if ref.Kind == "text" {
			ref.Text = input.Text
			refs = append(refs, ref)
			continue
		}
		if reused, hit := reuseFavoriteAsset(previousRefs, input.StorageKey); hit {
			ref.FileKey = reused.FileKey
			ref.FilePath = reused.FilePath
			ref.Bytes = reused.Bytes
			if ref.MimeType == "" {
				ref.MimeType = reused.MimeType
			}
			refs = append(refs, ref)
			continue
		}
		fileKey, filePath, size, err := persistFavoriteAsset(user.ID, input.StorageKey, input.URL, input.MimeType)
		if err != nil {
			// 只标记、不中断：留住提示词和其余素材，比整条失败对用户有用得多。
			log.Printf("收藏转存参考素材失败 user=%s canvas=%s node=%s label=%s: %v", user.ID, canvasID, nodeID, ref.Label, err)
			ref.Missing = true
			missing++
			refs = append(refs, ref)
			continue
		}
		ref.FileKey = fileKey
		ref.FilePath = filePath
		ref.Bytes = size
		refs = append(refs, ref)
	}

	encodedRefs, err := json.Marshal(refs)
	if err != nil {
		FailError(w, err)
		return
	}

	item := model.PromptFavorite{
		UserID:        user.ID,
		Username:      user.Username,
		GroupID:       user.GroupID,
		CanvasID:      canvasID,
		CanvasTitle:   strings.TrimSpace(req.CanvasTitle),
		SourceNodeID:  nodeID,
		Kind:          kind,
		Title:         strings.TrimSpace(req.Title),
		Note:          strings.TrimSpace(req.Note),
		PromptDraft:   req.PromptDraft,
		Prompt:        req.Prompt,
		Config:        string(req.Config),
		StyleSnapshot: string(req.StyleSnapshot),
		References:    string(encodedRefs),
	}
	// 组名是冗余快照：管理员导出时不必联表，用户日后换组也不会改写历史记录。
	// 查不到就留空，不影响收藏本身。
	if group, found, gerr := repository.GetGroupByID(user.GroupID); gerr == nil && found {
		item.GroupName = group.Name
	}

	// 成品（用户觉得「效果好」的那张图/那个视频）同样转存一份。
	if req.Result != nil {
		if reused, hit := reuseFavoriteAsset(previousRefs, req.Result.StorageKey); hit {
			item.ResultFileKey = reused.FileKey
			item.ResultFilePath = reused.FilePath
			item.ResultMimeType = reused.MimeType
			item.ResultBytes = reused.Bytes
		} else if existing.ResultFileKey != "" && strings.TrimSpace(req.Result.StorageKey) != "" && existing.ResultFileKey == strings.TrimSpace(req.Result.StorageKey) {
			item.ResultFileKey = existing.ResultFileKey
			item.ResultFilePath = existing.ResultFilePath
			item.ResultMimeType = existing.ResultMimeType
			item.ResultBytes = existing.ResultBytes
		} else {
			fileKey, filePath, size, rerr := persistFavoriteAsset(user.ID, req.Result.StorageKey, req.Result.URL, req.Result.MimeType)
			if rerr != nil {
				log.Printf("收藏转存成品失败 user=%s canvas=%s node=%s: %v", user.ID, canvasID, nodeID, rerr)
				missing++
			} else {
				item.ResultFileKey = fileKey
				item.ResultFilePath = filePath
				item.ResultMimeType = strings.TrimSpace(req.Result.MimeType)
				item.ResultBytes = size
			}
		}
	}

	saved, err := repository.SavePromptFavorite(item)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"favorite": sanitizeFavorite(saved), "missing": missing})
}

// ListMyPromptFavorites GET /api/v1/prompt-favorites?kind=&keyword=&page=&pageSize=
func ListMyPromptFavorites(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	query := r.URL.Query()
	page, _ := strconv.Atoi(strings.TrimSpace(query.Get("page")))
	pageSize, _ := strconv.Atoi(strings.TrimSpace(query.Get("pageSize")))
	// userID 写死成本人，绝不从入参取——这是「只能看自己的收藏」的唯一防线。
	items, total, err := repository.ListPromptFavorites(user.ID, "", strings.TrimSpace(query.Get("kind")), strings.TrimSpace(query.Get("keyword")), page, pageSize)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"items": sanitizeFavorites(items), "total": total})
}

// ListMyPromptFavoriteNodes GET /api/v1/prompt-favorites/nodes?canvasId=xxx
//
// 返回该画布里本人已收藏的节点 id。画布加载时拉一次，校正节点上的「已收藏」标记——
// 那个标记写在 metadata 里，会被 B7 的「持久化被吞」吃掉，光靠它会出现
// 「明明收藏过、按钮却没亮」。只回 id 数组，几百个节点也就几 KB。
func ListMyPromptFavoriteNodes(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	canvasID := strings.TrimSpace(r.URL.Query().Get("canvasId"))
	if canvasID == "" {
		Fail(w, "缺少画布 id")
		return
	}
	rows, err := repository.ListPromptFavoriteNodeRefs(user.ID, canvasID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"nodes": rows})
}

// DeleteMyPromptFavorite DELETE /api/v1/prompt-favorites/:id
//
// 只删库记录，不删转存副本文件。
// 理由：这条收藏的副本可能正被另一条收藏复用（reuseFavoriteAsset 会跨记录复用同源副本），
// 顺手删文件会把还在用的副本删掉——「宁可留一点垃圾，也不能删掉还在用的东西」。
// 真要回收空间，另做一个按引用计数扫描的离线清理，别在删除路径上顺手做。
func DeleteMyPromptFavorite(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	affected, err := repository.DeletePromptFavorite(user.ID, id)
	if err != nil {
		FailError(w, err)
		return
	}
	if affected == 0 {
		Fail(w, "收藏不存在或不属于你")
		return
	}
	OK(w, map[string]any{"deleted": affected})
}

// GetMyPromptFavoriteFile GET /api/v1/prompt-favorites/:id/files/:key
//
// 取自己收藏里的某个副本（参考素材或成品）。
func GetMyPromptFavoriteFile(w http.ResponseWriter, r *http.Request, id, fileKey string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	item, err := repository.GetPromptFavorite(id)
	if err != nil || item.ID == "" {
		http.NotFound(w, r)
		return
	}
	// 归属校验：只能取自己的。少了这一句，任何登录用户凭 id 就能取别人的素材。
	if item.UserID != user.ID {
		http.NotFound(w, r)
		return
	}
	serveFavoriteFile(w, r, item, fileKey)
}

// serveFavoriteFile 按 fileKey 下发收藏副本。归属校验由调用方负责。
func serveFavoriteFile(w http.ResponseWriter, r *http.Request, item model.PromptFavorite, fileKey string) {
	key := strings.TrimSpace(fileKey)
	if !favoriteFileKeyPattern.MatchString(key) {
		http.NotFound(w, r)
		return
	}
	path, mimeType := "", ""
	if item.ResultFileKey == key {
		path, mimeType = item.ResultFilePath, item.ResultMimeType
	} else {
		for _, ref := range decodeFavoriteRefs(item.References) {
			if ref.FileKey == key {
				path, mimeType = ref.FilePath, ref.MimeType
				break
			}
		}
	}
	if path == "" {
		http.NotFound(w, r)
		return
	}
	// 存在对象存储的副本：302 过去（浏览器跟随跳转时会剥掉 Authorization，公共读桶放行）。
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		http.Redirect(w, r, path, http.StatusFound)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	if mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	}
	w.Header().Set("Cache-Control", "private, max-age=31536000")
	http.ServeContent(w, r, key, time.Time{}, file)
}
