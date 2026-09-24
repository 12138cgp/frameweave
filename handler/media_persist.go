package handler

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
	"github.com/google/uuid"
)

var mediaKindDefaultExt = map[string]string{"image": "png", "video": "mp4", "audio": "mp3"}

// 转存到 TOS 的单文件字节上限（按类型）：生成的图/音远小于此，视频含 4K/15s 也够用；
// 未知类型走 FetchAndUploadToTOS 的默认 256MB。防止超大源 URL 把整文件读进内存致 OOM。
var mediaPersistMaxBytes = map[string]int64{
	"image": 32 << 20,
	"video": 200 << 20,
	"audio": 32 << 20,
}

// PersistMedia POST /api/v1/media/persist {url, kind, ext?, contentType?}
// 服务端把上游(如火山 Seedance)返回的临时媒体 URL 下载并转存到 TOS，返回稳定公网 URL。
// 解决：生成的视频此前只存火山临时链接，约 24h 过期后丢失。
func PersistMedia(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var payload struct {
		URL         string `json:"url"`
		Kind        string `json:"kind"`
		Ext         string `json:"ext"`
		ContentType string `json:"contentType"`
		TaskID      string `json:"taskId"` // 视频专用:上游 cgt 任务号,转存成功后把成片永久地址回填任务日志(供后台内联播放)
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "请求格式不正确")
		return
	}
	src := strings.TrimSpace(payload.URL)
	if !strings.HasPrefix(src, "http://") && !strings.HasPrefix(src, "https://") {
		Fail(w, "无效的媒体 URL")
		return
	}
	defExt, known := mediaKindDefaultExt[payload.Kind]
	if !known {
		Fail(w, "未知的媒体类型")
		return
	}
	ext := sanitizeMediaExt(payload.Ext, defExt)
	// shortID 同时用作 TOS 对象名与 sync_files 的 storageKey，两边逐字对齐：
	//   对象 key   = media/{user}/{kind}/{shortID}.{ext}
	//   storageKey = {kind}:{shortID}
	// 而 handler/sync.go 的 syncFileTOSKey 由 storageKey 推导出的正是同一个对象 key，
	// 所以不引入第二套命名规则：万一以后同一份字节经 /sync/files 再传一次，
	// 会覆盖同一个对象，而不是在桶里留个孤儿。
	// ⚠️ uuid v4 去横杠 = 32 位十六进制、122 bit 随机。storageKey 的【不可猜性】是跨账号隔离的
	//    唯一边界（按 key 的全局回退查询是无 user 过滤的），绝不能改成由 jobID/taskID 推导。
	shortID := strings.ReplaceAll(uuid.NewString(), "-", "")
	key := fmt.Sprintf("media/%s/%s/%s.%s", user.ID, payload.Kind, shortID, ext)
	// 按用户所属分组的桶配置转存：未分组/组未启用自有桶→回退全局；组启用了自有桶→用组桶。
	// 组配置不完整或全局都未配→返回可读错误（含具体原因），直接透传前端，不静默回退全局公共桶。
	saved, err := service.FetchAndUploadToTOSForUserDetailed(user.ID, src, key, payload.ContentType, mediaPersistMaxBytes[payload.Kind])
	if err != nil {
		FailError(w, err)
		return
	}
	publicURL := saved.URL
	// 视频:成片永久地址回填任务日志,供后台内联播放(纯观测、best-effort:失败不影响本次转存返回)。
	if payload.Kind == "video" {
		if taskID := strings.TrimSpace(payload.TaskID); taskID != "" {
			_ = repository.UpdateUpstreamLogResultURL(user.ID, taskID, publicURL)
		}
	}
	// 给成片登记 sync_files，让画布节点的自愈链对它也有效。
	//
	// storageKey 在本项目里历来只在「客户端手里有字节」时才诞生（uploadMediaFile 里的 prefix:nanoid），
	// 而远端渠道的成片字节从来不经过浏览器——这就是绝大多数视频节点没有 storageKey、
	// 节点自愈第一行就判死的根因。这里是唯一有资格造这个凭据的一环：字节刚由服务端自己下载并上传，
	// path/bytes/mime 全是服务端亲手掌握的事实，不采信客户端任何输入。
	//
	// 只给视频登记：图片那条 /media/persist 只是 uploadImage 内部抓图的中转（前端拿到地址后还会
	// 自己造 image:{nanoid} 再传一份），在这里登记只会留一行永远没人引用的孤儿。
	//
	// ⚠️ 顺序不能反：必须登记成功之后才把 storageKey 交给前端写进节点。反过来（节点先有 key、
	//    服务端没有行）会被「素材上传状态」体检算成已丢失——它拿 GET /api/v1/sync/files 当准绳。
	//    登记失败就不返回 storageKey：节点退回今天的形态（只有公网地址），与改动前完全一致。
	storageKey := ""
	if payload.Kind == "video" {
		candidate := payload.Kind + ":" + shortID
		mime := strings.TrimSpace(saved.ContentType)
		if mime == "" {
			mime = "video/mp4"
		}
		if serr := repository.SaveSyncFile(model.SyncFile{UserID: user.ID, StorageKey: candidate, Path: publicURL, MimeType: mime, Bytes: saved.Bytes}); serr != nil {
			log.Printf("媒体转存成功但 sync_files 登记失败（节点退回无 storageKey 形态）user=%s key=%s: %v", user.ID, candidate, serr)
		} else {
			storageKey = candidate
		}
	}
	OK(w, map[string]any{"url": publicURL, "key": key, "storageKey": storageKey})
}

func sanitizeMediaExt(ext, def string) string {
	ext = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(ext, ".")))
	if ext == "" || len(ext) > 5 {
		return def
	}
	for _, c := range ext {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return def
		}
	}
	return ext
}
