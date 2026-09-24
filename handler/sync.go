package handler

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
	"github.com/google/uuid"
)

// syncFileMaxBytes 单个同步文件（画布上传的图片/视频/音频）的体积上限。
//
// 取 300MB：服务端要处理的成片动辄一两百 MB，上限定得太低会让它们
// 根本传不上来。整条链路上有四道闸，四道必须一起放开，否则用户只会换个地方撞墙：
//
//	① 画布客户端预检 canvas-client-page.tsx 的 MAX_BYTES
//	② Next 代理 web/src/app/api/[...path]/route.ts 的 MAX_UPLOAD_BYTES（env PROXY_MAX_UPLOAD_MB）
//	③ 这里
//	④ 反向代理（Nginx）的 client_max_body_size —— 调大本项前必须同步调大它
const syncFileMaxBytes = 300 << 20

// syncFileMemoryBytes multipart 解析时最多在内存里放多少，超出部分由标准库落到临时文件。
// 刻意远小于 syncFileMaxBytes：以前两者相等，等于「上限多大就敢在内存里放多大」，
// 300MB 的视频会让一次上传直接吃掉 300MB 常驻内存。
const syncFileMemoryBytes = 32 << 20

// syncDomains 入参白名单：由 model.SyncDomains 派生，新增域时只需改 model 一处，
// 不会出现「model 加了域、这里忘了加」导致新域推送被拒的情况。
var syncDomains = func() map[string]bool {
	m := make(map[string]bool, len(model.SyncDomains))
	for _, d := range model.SyncDomains {
		m[d] = true
	}
	return m
}()

// storageKey 形如 image:abc123 / video:abc123，限制字符集防止路径穿越。
var syncStorageKeyPattern = regexp.MustCompile(`^[a-z]+:[A-Za-z0-9_-]{1,128}$`)

func syncFilesDir(userID string) string {
	return filepath.Join(referenceDataDir(), "sync-files", userID)
}

func syncFileName(storageKey string) string {
	return strings.ReplaceAll(storageKey, ":", "_")
}

// syncFileTOSKey 把 storageKey(如 image:abc) 映射成 TOS 对象 key: media/{用户}/{类型}/{id}.{ext}
func syncFileTOSKey(userID, storageKey, mimeType string) string {
	prefix, id := "file", storageKey
	if i := strings.IndexByte(storageKey, ':'); i >= 0 {
		prefix, id = storageKey[:i], storageKey[i+1:]
	}
	return fmt.Sprintf("media/%s/%s/%s.%s", userID, prefix, id, syncFileExt(mimeType))
}

func syncFileExt(mimeType string) string {
	mt := strings.ToLower(strings.TrimSpace(mimeType))
	if i := strings.IndexByte(mt, ';'); i >= 0 {
		mt = mt[:i]
	}
	switch mt {
	case "image/jpeg":
		return "jpg"
	case "image/png":
		return "png"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	case "video/mp4":
		return "mp4"
	case "video/webm":
		return "webm"
	case "audio/mpeg":
		return "mp3"
	case "audio/wav", "audio/x-wav":
		return "wav"
	case "audio/mp4", "audio/aac":
		return "aac"
	case "audio/ogg":
		return "ogg"
	}
	if i := strings.IndexByte(mt, '/'); i >= 0 {
		clean := ""
		for _, c := range mt[i+1:] {
			if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' {
				clean += string(c)
			}
		}
		if clean != "" && len(clean) <= 5 {
			return clean
		}
	}
	return "bin"
}

// writeSyncFileStream 与 writeSyncFileBytes 同义，但流式写盘（TOS 失败回退时用）：
// 300MB 的视频不该为了落盘先在内存里凑成一整个 []byte。返回落盘路径与写入字节数。
func writeSyncFileStream(userID, storageKey string, src io.Reader) (string, int64, error) {
	if err := os.MkdirAll(syncFilesDir(userID), 0o755); err != nil {
		return "", 0, err
	}
	path := filepath.Join(syncFilesDir(userID), syncFileName(storageKey))
	target, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return "", 0, err
	}
	written, copyErr := io.Copy(target, src)
	closeErr := target.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(path)
		if copyErr != nil {
			return "", 0, copyErr
		}
		return "", 0, closeErr
	}
	return path, written, nil
}

// GetSyncManifest GET /api/v1/sync/manifest?domain=canvas
func GetSyncManifest(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	domain := r.URL.Query().Get("domain")
	if !syncDomains[domain] {
		Fail(w, "未知的数据域")
		return
	}
	item, err := repository.GetSyncData(user.ID, domain)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"domain": domain, "data": item.Data, "updatedAt": item.UpdatedAt})
}

// SaveSyncManifest POST /api/v1/sync/manifest {domain, data}
func SaveSyncManifest(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var payload struct {
		Domain string `json:"domain"`
		Data   string `json:"data"`
		// ConfirmShrink：客户端在「本次确有真实删除」时置 true，放行收缩。老客户端无此字段=false。
		ConfirmShrink bool `json:"confirmShrink"`
		// BaseVersion：客户端本次同步开始时读到的 updatedAt，用作乐观锁基准（见下方 CAS 段）。
		// 空 = 首次推送或老客户端，退化为无条件写入。
		BaseVersion string `json:"baseVersion"`
	}
	// 画布正文要作为 JSON 字符串塞进请求体（每个 " 变 \"），体积比正文本身膨胀约 60%：
	// 26MB 的画布打包出来有 43MB，原先 32MB 的上限会把推送整个拒掉，用户改动只留在浏览器里，
	// 一掉线就全没了，而且用户会长期停在这个状态里、自己完全察觉不到。
	// 512MB 高于 nginx 的 client_max_body_size 320m，应用层不再是瓶颈；
	// 保留 MaxBytesReader 而非删除，是为了留一个明确的失败边界，不让它变成无界读。
	r.Body = http.MaxBytesReader(w, r.Body, 512<<20)
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "同步数据格式不正确")
		return
	}
	if !syncDomains[payload.Domain] {
		Fail(w, "未知的数据域")
		return
	}
	// P0 收缩护栏（env 开关 SYNC_SHRINK_GUARD=on）：canvas 域，若本次推送会让既有项目节点数大幅缩水
	// 且客户端未声明这是真实删除，则【拒绝覆盖】——把多设备「旧的非空整项目 LWW 冲掉新的丰富版」从静默丢失
	// 变成可感知的同步失败；云端当前版推送时已自动快照、此处再去重备份一次，零数据损失。前端 apiPost 遇 code!=0
	// 会保留本地、下轮重试，绝不覆盖云端。仅 canvas、仅缩水、仅未确认时触发。
	// 「项目整个消失且推送里没有它的墓碑」单列一条，且【不受 ConfirmShrink 支配】：
	// 那个标志是客户端的模块级全局布尔、与载荷解耦，挡不住这类事故（详见 canvasProjectVanished 注释）。
	if payload.Domain == model.SyncDomainCanvas && canvasShrinkGuardOn() {
		if cur, gerr := repository.GetSyncData(user.ID, payload.Domain); gerr == nil && strings.TrimSpace(cur.Data) != "" {
			if lostID, vanished := canvasProjectVanished(cur.Data, payload.Data); vanished {
				if err := repository.CaptureCanvasSnapshot(user.ID, payload.Domain, cur.Data); err != nil {
					log.Printf("画布消失护栏备份快照失败（已忽略）user=%s err=%v", user.ID, err)
				}
				log.Printf("canvas 项目消失护栏拦截 user=%s lost_project=%s confirm_shrink=%v %s",
					user.ID, lostID, payload.ConfirmShrink, canvasShrinkSummary(cur.Data, payload.Data))
				Fail(w, "检测到有画布在本次保存中整个消失，且不是你主动删除的；为防止丢失，本次未保存到云端。请刷新页面让云端最新内容合并后再编辑。")
				return
			}
		}
	}
	if payload.Domain == model.SyncDomainCanvas && canvasShrinkGuardOn() && !payload.ConfirmShrink {
		if cur, gerr := repository.GetSyncData(user.ID, payload.Domain); gerr == nil && strings.TrimSpace(cur.Data) != "" {
			if canvasShrinkDetected(cur.Data, payload.Data) {
				// 去重备份云端现状（同 hash 跳过、不刷屏）
				if err := repository.CaptureCanvasSnapshot(user.ID, payload.Domain, cur.Data); err != nil {
					log.Printf("收缩护栏备份快照失败（已忽略）user=%s err=%v", user.ID, err)
				}
				// 记清楚「少了什么」：只记 user= 的话，下次再发生仍然只能靠猜是陈旧标签页还是护栏误判。
				log.Printf("canvas 收缩护栏拦截覆盖 user=%s %s", user.ID, canvasShrinkSummary(cur.Data, payload.Data))
				Fail(w, "检测到画布内容大幅减少；为防止多设备互相覆盖丢失，本次未保存到云端。请刷新页面让云端最新内容合并后再编辑。")
				return
			}
		}
	}
	// ── 乐观并发控制（CAS）────────────────────────────────────────────────
	// 客户端的一次同步是「T0 读云端 → 合并 → 传媒体 → T1 写回」，T1−T0 可长达分钟级
	// （媒体单文件超时 300s，看门狗 900s 封顶）。若这期间有别的写入落到云端——另一个标签页、
	// 另一台设备、服务端的取用分享回写、快照回滚——原先的无条件覆盖会拿 T0 那份旧快照把它整块抹掉，
	// 且不留墓碑、护栏也看不出（护栏只比对项目集合，节点级/其它域的丢失完全无感）。
	//
	// 客户端读取时把 updatedAt 一起带回来当 baseVersion；这里只在版本仍然一致时才写。
	// 版本已变【不是错误】，是乐观并发的正常结果：回 conflict=true，客户端重新拉取合并后重试。
	// baseVersion 为空 = 首次推送（云端本无该行）或老客户端 → 保持原有无条件写入，不破坏兼容。
	baseVersion := strings.TrimSpace(payload.BaseVersion)
	if baseVersion != "" {
		written, werr := repository.SaveSyncDataIfUnchanged(user.ID, payload.Domain, payload.Data, baseVersion)
		if werr != nil {
			FailError(w, werr)
			return
		}
		if !written {
			cur, _ := repository.GetSyncData(user.ID, payload.Domain)
			log.Printf("sync CAS 冲突（客户端将重试）user=%s domain=%s base=%s now=%s",
				user.ID, payload.Domain, baseVersion, cur.UpdatedAt)
			OK(w, map[string]any{"domain": payload.Domain, "conflict": true, "updatedAt": cur.UpdatedAt})
			return
		}
		captureSnapshot(user.ID, payload.Domain, payload.Data)
		cur, _ := repository.GetSyncData(user.ID, payload.Domain)
		OK(w, map[string]any{"domain": payload.Domain, "updatedAt": cur.UpdatedAt})
		return
	}

	item, err := repository.SaveSyncData(user.ID, payload.Domain, payload.Data)
	if err != nil {
		FailError(w, err)
		return
	}
	captureSnapshot(user.ID, payload.Domain, payload.Data)
	OK(w, map[string]any{"domain": payload.Domain, "updatedAt": item.UpdatedAt})
}

// captureSnapshot best-effort 写历史版本快照（去重+节流）；任何错误只记日志，
// 不影响推送的成功响应与时延语义。
//
// 覆盖【全部数据域】：assets（我的素材）/presets（自定义风格）同样是用户内容，
// 被覆盖后一样没有退路。域的过滤交给 repository.CaptureCanvasSnapshot 里的
// model.IsSyncDomain 统一判断，这里不再另设一道 canvas 白名单。
func captureSnapshot(userID, domain, data string) {
	if err := repository.CaptureCanvasSnapshot(userID, domain, data); err != nil {
		log.Printf("canvas 快照写入失败（已忽略）user=%s err=%v", userID, err)
	}
}

// canvasShrinkSummary 描述本次推送相对云端到底少了什么，供拦截日志定位。
// 输出形如：projects 27->26 nodes 2688->2404 missing=[「画布 8」(882)] shrunk=[「示例画布」284->12]
// 只读两份 JSON 的节点计数，不解析节点内部，开销可忽略。
func canvasShrinkSummary(oldData, newData string) string {
	var oldM, newM canvasShrinkManifest
	if json.Unmarshal([]byte(oldData), &oldM) != nil || json.Unmarshal([]byte(newData), &newM) != nil {
		return "(摘要解析失败)"
	}
	newCounts := make(map[string]int, len(newM.Data.Projects))
	for _, p := range newM.Data.Projects {
		newCounts[p.ID] = len(p.Nodes)
	}
	oldNodes, newNodes := 0, 0
	for _, p := range newM.Data.Projects {
		newNodes += len(p.Nodes)
	}
	missing := make([]string, 0, 4)
	shrunk := make([]string, 0, 4)
	for _, op := range oldM.Data.Projects {
		oldN := len(op.Nodes)
		oldNodes += oldN
		if oldN == 0 {
			continue
		}
		newN, ok := newCounts[op.ID]
		if !ok || newN == 0 {
			if len(missing) < 5 {
				missing = append(missing, fmt.Sprintf("%s(%d)", op.ID, oldN))
			}
			continue
		}
		if drop := oldN - newN; drop >= 3 && drop*10 > oldN*3 {
			if len(shrunk) < 5 {
				shrunk = append(shrunk, fmt.Sprintf("%s %d->%d", op.ID, oldN, newN))
			}
		}
	}
	return fmt.Sprintf("projects %d->%d nodes %d->%d missing=%v shrunk=%v",
		len(oldM.Data.Projects), len(newM.Data.Projects), oldNodes, newNodes, missing, shrunk)
}

// canvasShrinkGuardOn 收缩护栏开关（env SYNC_SHRINK_GUARD=on 才生效，默认关，便于灰度）。
func canvasShrinkGuardOn() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("SYNC_SHRINK_GUARD")), "on")
}

// canvasShrinkManifest 仅解析判断收缩所需的最小结构（nodes/connections 只数长度，不解析内部）。
// Tombstones：客户端真删项目时会写墓碑，是区分「用户真删」与「陈旧快照覆盖」的唯一可信凭据。
type canvasShrinkManifest struct {
	Data struct {
		Projects []struct {
			ID    string            `json:"id"`
			Nodes []json.RawMessage `json:"nodes"`
		} `json:"projects"`
	} `json:"data"`
	Tombstones map[string]json.RawMessage `json:"tombstones"`
}

// canvasProjectVanished 判断「云端有、推送里没有、且推送的墓碑里也没有」的项目——
// 这种消失无法用任何用户动作解释，只能是陈旧/被清空的本地快照覆盖了云端，必须拦。
//
// 为什么不看节点数：最容易被整个抹掉的恰恰是【刚新建、还没放节点】
// 的项目（用户在首次同步跑完前就建了画布，随后 applyData 的盲替换把它从本地抹掉、推送再把云端抹掉）。
// 只看节点数的护栏对 len(nodes)==0 直接 continue，这类项目完全在视野外，于是一次也拦不住。
//
// 为什么不受 ConfirmShrink 支配：ConfirmShrink 来自客户端一个模块级全局布尔，在推送时刻才消费，
// 与本次推送的内容完全解耦——用户在别处随手删一个节点就能给「整项目消失」的推送发通行证。
// 项目真被删时客户端一定会写项目墓碑（deleteProjects → addSyncTombstones），所以这里只认墓碑，不认那个标志。
func canvasProjectVanished(oldData, newData string) (string, bool) {
	var oldM, newM canvasShrinkManifest
	if json.Unmarshal([]byte(oldData), &oldM) != nil {
		return "", false
	}
	if json.Unmarshal([]byte(newData), &newM) != nil {
		return "", false
	}
	newIDs := make(map[string]struct{}, len(newM.Data.Projects))
	for _, p := range newM.Data.Projects {
		newIDs[p.ID] = struct{}{}
	}
	for _, op := range oldM.Data.Projects {
		if op.ID == "" {
			continue
		}
		if _, ok := newIDs[op.ID]; ok {
			continue
		}
		if _, tombstoned := newM.Tombstones[op.ID]; tombstoned {
			continue // 客户端声明这是真删，放行
		}
		return op.ID, true
	}
	return "", false
}

// canvasShrinkDetected 判断 newData 相对 oldData 是否构成「危险收缩」：
// 任一既有非空项目整体消失、或其节点数下降且 >30% 且绝对 >=3。解析失败一律放行（false），不误伤。
func canvasShrinkDetected(oldData, newData string) bool {
	var oldM, newM canvasShrinkManifest
	if json.Unmarshal([]byte(oldData), &oldM) != nil {
		return false
	}
	if json.Unmarshal([]byte(newData), &newM) != nil {
		// 新数据解析不出来时保守放行，避免因格式问题卡死保存（极端情况交由后续逻辑）。
		return false
	}
	newCounts := make(map[string]int, len(newM.Data.Projects))
	for _, p := range newM.Data.Projects {
		newCounts[p.ID] = len(p.Nodes)
	}
	for _, op := range oldM.Data.Projects {
		oldN := len(op.Nodes)
		if oldN == 0 {
			continue
		}
		newN, ok := newCounts[op.ID]
		if !ok || newN == 0 {
			return true // 非空项目整体消失
		}
		drop := oldN - newN
		if drop >= 3 && drop*10 > oldN*3 {
			return true // 跌幅 >30% 且绝对 >=3
		}
	}
	return false
}

// UploadSyncFile POST /api/v1/sync/files multipart(file, storage_key, mime_type)
func UploadSyncFile(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, syncFileMaxBytes+1)
	if err := r.ParseMultipartForm(syncFileMemoryBytes); err != nil {
		Fail(w, "文件过大或上传格式不正确")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	storageKey := r.FormValue("storage_key")
	if !syncStorageKeyPattern.MatchString(storageKey) {
		Fail(w, "storage_key 格式不正确")
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
	// 优先存对象存储(TOS)：流式上传，记录 TOS 公网 URL 到 Path；TOS 失败则回退本地磁盘。
	// 老文件仍在磁盘，读取时按 Path 区分(http→跳 TOS / 本地路径→读盘)。
	//
	// 这里刻意不再 io.ReadAll：上限提到 300MB 后，读进内存等于一次上传吃掉一份等大的常驻内存。
	// multipart 已经把超过 syncFileMemoryBytes 的部分落到临时文件，file 本身就是可 Seek 的，
	// 直接交给流式上传即可（签名要过一遍哈希，所以流会被读两遍，都走磁盘、不进内存）。
	if service.TOSConfiguredForUser(user.ID) {
		size := header.Size
		path := ""
		url, terr := service.UploadStreamToTOSForUser(user.ID, syncFileTOSKey(user.ID, storageKey, mimeType), file, size, mimeType)
		if terr == nil {
			path = url
		} else {
			log.Printf("sync file TOS upload failed, fallback to disk: user=%s key=%s bytes=%d err=%v", user.ID, storageKey, size, terr)
			if _, serr := file.Seek(0, io.SeekStart); serr != nil {
				Fail(w, "文件读取失败")
				return
			}
			diskPath, written, derr := writeSyncFileStream(user.ID, storageKey, file)
			if derr != nil {
				FailError(w, derr)
				return
			}
			path = diskPath
			size = written
		}
		if err := repository.SaveSyncFile(model.SyncFile{UserID: user.ID, StorageKey: storageKey, Path: path, MimeType: mimeType, Bytes: size}); err != nil {
			FailError(w, err)
			return
		}
		OK(w, map[string]any{"storageKey": storageKey, "bytes": size})
		return
	}
	if err := os.MkdirAll(syncFilesDir(user.ID), 0o755); err != nil {
		FailError(w, err)
		return
	}
	targetPath := filepath.Join(syncFilesDir(user.ID), syncFileName(storageKey))
	target, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		FailError(w, err)
		return
	}
	bytes, copyErr := io.Copy(target, file)
	closeErr := target.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(targetPath)
		Fail(w, "文件保存失败")
		return
	}
	if err := repository.SaveSyncFile(model.SyncFile{UserID: user.ID, StorageKey: storageKey, Path: targetPath, MimeType: mimeType, Bytes: bytes}); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"storageKey": storageKey, "bytes": bytes})
}

// ListSyncFiles GET /api/v1/sync/files —— 返回当前用户已上传的文件清单（storageKey 列表）。
func ListSyncFiles(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	items, err := repository.ListSyncFiles(user.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, items)
}

// GetSyncFileContent GET /api/v1/sync/files/:key
func GetSyncFileContent(w http.ResponseWriter, r *http.Request, storageKey string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	serveSyncFile(w, r, user.ID, storageKey)
}

func serveSyncFile(w http.ResponseWriter, r *http.Request, ownerID, storageKey string) {
	if !syncStorageKeyPattern.MatchString(storageKey) {
		http.NotFound(w, r)
		return
	}
	item, err := repository.GetSyncFile(ownerID, storageKey)
	if err != nil || item.ID == "" {
		// 跨账号回退:分享/取用/导入来的画布,文件登记仍在原上传者名下,本人名下查无此 key。
		// 仅回退公网(公共读桶)文件并 302——本地磁盘文件仍按账号隔离;全局也没有才 404。
		fallback, ferr := repository.GetPublicSyncFileByKey(storageKey)
		if ferr != nil || fallback.ID == "" {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, fallback.Path, http.StatusFound)
		return
	}
	// 存到 TOS 的文件：Path 为公网 URL，302 跳转（浏览器跨域跟随会剥离 Authorization，公共读放行）。
	// 老文件 Path 仍是本地磁盘路径，继续按下面读盘逻辑返回。
	if strings.HasPrefix(item.Path, "http://") || strings.HasPrefix(item.Path, "https://") {
		http.Redirect(w, r, item.Path, http.StatusFound)
		return
	}
	file, err := os.Open(item.Path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	if item.MimeType != "" {
		w.Header().Set("Content-Type", item.MimeType)
	}
	w.Header().Set("Cache-Control", "private, max-age=31536000")
	http.ServeContent(w, r, syncFileName(storageKey), time.Time{}, file)
}

// CreateCanvasShare POST /api/v1/canvas/share {title, project, fileKeys}
func CreateCanvasShare(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var payload struct {
		Title    string   `json:"title"`
		Project  string   `json:"project"`
		FileKeys []string `json:"fileKeys"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || strings.TrimSpace(payload.Project) == "" {
		Fail(w, "分享内容格式不正确")
		return
	}
	for _, key := range payload.FileKeys {
		if !syncStorageKeyPattern.MatchString(key) {
			Fail(w, "分享内容格式不正确")
			return
		}
	}
	fileKeys, err := json.Marshal(payload.FileKeys)
	if err != nil {
		FailError(w, err)
		return
	}
	code, err := newShareCode()
	if err != nil {
		FailError(w, err)
		return
	}
	share := model.CanvasShare{
		Code:      code,
		OwnerID:   user.ID,
		Title:     payload.Title,
		Project:   payload.Project,
		FileKeys:  string(fileKeys),
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	if err := repository.SaveCanvasShare(share); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"code": code})
}

// SharedCanvas GET /api/canvas/share/:code（公开只读）
func SharedCanvas(w http.ResponseWriter, r *http.Request, code string) {
	share, err := repository.GetCanvasShare(code)
	if err != nil || share.Code == "" {
		Fail(w, "分享不存在或已失效")
		return
	}
	var fileKeys []string
	if err := json.Unmarshal([]byte(share.FileKeys), &fileKeys); err != nil {
		log.Printf("分享文件清单解析失败（数据可能损坏）share=%s err=%v", share.Code, err)
	}
	OK(w, map[string]any{"code": share.Code, "title": share.Title, "project": share.Project, "fileKeys": fileKeys, "createdAt": share.CreatedAt})
}

// SharedCanvasFile GET /api/canvas/share/:code/files/:key（公开，仅限分享引用的文件）
func SharedCanvasFile(w http.ResponseWriter, r *http.Request, code, storageKey string) {
	share, err := repository.GetCanvasShare(code)
	if err != nil || share.Code == "" {
		http.NotFound(w, r)
		return
	}
	var fileKeys []string
	if err := json.Unmarshal([]byte(share.FileKeys), &fileKeys); err != nil {
		log.Printf("分享文件清单解析失败（数据可能损坏）share=%s err=%v", share.Code, err)
	}
	allowed := false
	for _, key := range fileKeys {
		if key == storageKey {
			allowed = true
			break
		}
	}
	if !allowed {
		http.NotFound(w, r)
		return
	}
	serveSyncFile(w, r, share.OwnerID, storageKey)
}

// ForkCanvasShare POST /api/v1/canvas/share/:code/fork —— 把分享的画布复制为当前用户的项目。
func ForkCanvasShare(w http.ResponseWriter, r *http.Request, code string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	share, err := repository.GetCanvasShare(code)
	if err != nil || share.Code == "" {
		Fail(w, "分享不存在或已失效")
		return
	}
	var project map[string]any
	if err := json.Unmarshal([]byte(share.Project), &project); err != nil {
		Fail(w, "分享内容已损坏")
		return
	}
	now := time.Now().Format(time.RFC3339)
	newProjectID := uuid.NewString()
	project["id"] = newProjectID
	if title, _ := project["title"].(string); title != "" {
		project["title"] = title + "（副本）"
	}
	project["createdAt"] = now
	project["updatedAt"] = now

	// 接收方在「复制到我的画布」时选择的积分来源：覆盖原画布继承的 projectId（空=个人积分）
	var forkBody struct {
		ProjectID string `json:"projectId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&forkBody)
	if strings.TrimSpace(forkBody.ProjectID) != "" {
		project["projectId"] = strings.TrimSpace(forkBody.ProjectID)
	} else {
		delete(project, "projectId")
	}

	// 复制媒体文件归属（磁盘 + 索引），storageKey 不变所以项目 JSON 里的引用无需改写
	var fileKeys []string
	if err := json.Unmarshal([]byte(share.FileKeys), &fileKeys); err != nil {
		log.Printf("分享文件清单解析失败（数据可能损坏）share=%s err=%v", share.Code, err)
	}
	copiedFiles := make([]model.SyncFile, 0, len(fileKeys))
	for _, key := range fileKeys {
		source, err := repository.GetSyncFile(share.OwnerID, key)
		if err != nil || source.ID == "" {
			continue
		}
		if existing, err := repository.GetSyncFile(user.ID, key); err == nil && existing.ID != "" {
			copiedFiles = append(copiedFiles, existing)
			continue
		}
		if err := copySyncFile(source, user.ID, key); err != nil {
			FailError(w, fmt.Errorf("复制分享文件失败: %w", err))
			return
		}
		copied, err := repository.GetSyncFile(user.ID, key)
		if err == nil && copied.ID != "" {
			copiedFiles = append(copiedFiles, copied)
		}
	}

	// 把项目合并进当前用户 canvas 域清单。
	// 清单结构与前端 app-sync 的 DomainManifest 一致：{app, version, domain, exportedAt, data: {projects}, files}。
	existing, err := repository.GetSyncData(user.ID, model.SyncDomainCanvas)
	if err != nil {
		FailError(w, err)
		return
	}
	var manifest map[string]any
	if strings.TrimSpace(existing.Data) != "" {
		if err := json.Unmarshal([]byte(existing.Data), &manifest); err != nil {
			manifest = nil
		}
	}
	if manifest == nil {
		manifest = map[string]any{"app": "aicanvas", "version": 1, "domain": model.SyncDomainCanvas, "data": map[string]any{"projects": []any{}}, "files": []any{}}
	}
	dataField, _ := manifest["data"].(map[string]any)
	if dataField == nil {
		dataField = map[string]any{"projects": []any{}}
	}
	projects, _ := dataField["projects"].([]any)
	dataField["projects"] = append(projects, project)
	manifest["data"] = dataField
	// files 清单补上 fork 进来的文件，前端同步时才会把媒体下载到本地
	files, _ := manifest["files"].([]any)
	knownKeys := map[string]bool{}
	for _, item := range files {
		if entry, ok := item.(map[string]any); ok {
			if key, ok := entry["storageKey"].(string); ok {
				knownKeys[key] = true
			}
		}
	}
	for _, file := range copiedFiles {
		if knownKeys[file.StorageKey] {
			continue
		}
		// 视频/音频不进接收方的 files 清单：清单里的条目会被客户端当作「该下载到本地」的素材，
		// 而成片是公共读直链，节点直接用 content 播就行——多下一遍只会把几百 MB 灌进 IndexedDB。
		// sync_files 索引行照常复制（上面的 copiedFiles 已经建好），需要时自愈链仍按 key 找得到。
		if strings.HasPrefix(file.StorageKey, "video:") || strings.HasPrefix(file.StorageKey, "audio:") {
			continue
		}
		files = append(files, map[string]any{"storageKey": file.StorageKey, "path": "canvas/files/" + syncFileName(file.StorageKey), "mimeType": file.MimeType, "bytes": file.Bytes})
	}
	manifest["files"] = files
	manifest["exportedAt"] = now
	nextData, err := json.Marshal(manifest)
	if err != nil {
		FailError(w, err)
		return
	}
	if _, err := repository.SaveSyncData(user.ID, model.SyncDomainCanvas, string(nextData)); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"projectId": newProjectID})
}

func copySyncFile(source model.SyncFile, targetUserID, storageKey string) error {
	// TOS 文件：source.Path 是对象存储的公网 URL（对象公共读、跨用户共享），不能也无需 os.Open 一个 http URL——
	// 直接给接收方建一条指向同一 URL 的文件索引即可（否则 os.Open 一个 https 串必然失败 → 「复制分享文件失败」）。
	if strings.HasPrefix(source.Path, "http://") || strings.HasPrefix(source.Path, "https://") {
		return repository.SaveSyncFile(model.SyncFile{UserID: targetUserID, StorageKey: storageKey, Path: source.Path, MimeType: source.MimeType, Bytes: source.Bytes})
	}
	// 本地磁盘文件：物理复制到接收方的同步目录。
	if err := os.MkdirAll(syncFilesDir(targetUserID), 0o755); err != nil {
		return err
	}
	input, err := os.Open(source.Path)
	if err != nil {
		return err
	}
	defer input.Close()
	targetPath := filepath.Join(syncFilesDir(targetUserID), syncFileName(storageKey))
	output, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	bytes, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(targetPath)
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	}
	return repository.SaveSyncFile(model.SyncFile{UserID: targetUserID, StorageKey: storageKey, Path: targetPath, MimeType: source.MimeType, Bytes: bytes})
}

func newShareCode() (string, error) {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", errors.New("生成分享码失败")
	}
	for i, b := range buf {
		buf[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(buf), nil
}
