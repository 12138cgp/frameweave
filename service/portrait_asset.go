package service

import (
	"log"
	"strings"
	"sync"

	"aicanvas/model"
	"aicanvas/repository"
	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
)

const portraitAssetPollCron = "@every 30s"

var (
	portraitAssetCron *cron.Cron
	portraitAssetOnce sync.Once
)

// NormalizePortraitAssetKind 把外部传入的媒体类型归一化；未知/空值一律按图片，保持旧行为。
func NormalizePortraitAssetKind(raw string) model.PortraitAssetKind {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "video":
		return model.PortraitAssetKindVideo
	case "audio":
		return model.PortraitAssetKindAudio
	default:
		return model.PortraitAssetKindImage
	}
}

// SubmitPortraitAsset 把素材公网 URL 提交火山资产库入库审核。
// 按内容指纹（contentHash）去重：同一素材永远只入一条，已有可用 asset 时直接复用，
// 不再重复调 CreateAsset，避免多节点 / 多次点击 / 超时重试产生的重复入库。
//
// kind 为 image / video / audio（火山 CreateAsset 的 AssetType 三类都支持）。
// 空值按 image 处理——保持老调用方与存量记录的行为不变。
func SubmitPortraitAsset(userID string, sourceURL string, storageKey string, contentHash string, title string, kind model.PortraitAssetKind) (model.PortraitAsset, error) {
	if kind == "" {
		kind = model.PortraitAssetKindImage
	}
	label := kind.Label()
	sourceURL = strings.TrimSpace(sourceURL)
	if sourceURL == "" {
		return model.PortraitAsset{}, safeMessageError{message: "缺少" + label + "地址"}
	}
	if strings.HasPrefix(sourceURL, "asset://") {
		return model.PortraitAsset{}, safeMessageError{message: "该素材已是火山 asset 引用，无需重复认证"}
	}
	if !IsPublicHTTPURL(sourceURL) {
		return model.PortraitAsset{}, safeMessageError{message: label + "地址必须是 http(s) 链接"}
	}
	cfg, err := loadVolcAssetConfigForUser(userID)
	if err != nil {
		return model.PortraitAsset{}, err
	}
	contentHash = strings.TrimSpace(contentHash)
	storageKey = strings.TrimSpace(storageKey)
	// 复用策略：仅当已有记录仍在「审核中(processing)」时复用（刷新一次状态），避免审核窗口内
	// 多节点 / 多次点击 / 超时重试重复入库；已终态（active/failed）时用户再次点击认证一律
	// 重新入库刷新——不复用旧 asset。这样用户可手动重认证来修复「火山元数据仍在、但底层图已
	// 失效或尚未同步就绪」导致的视频生成失败（旧逻辑对 active 直接复用、无法重做）。
	existing, found := findExistingPortrait(userID, contentHash, storageKey)
	if found && existing.AssetID != "" && existing.Status == model.PortraitAssetProcessing {
		// 命中审核中的记录：向火山核实该 asset 是否仍存在并刷新状态；查得到才复用，
		// 查不到则落到下面重新入库——避免返回失效的本地缓存。
		if info, verr := getVolcAsset(cfg, existing.AssetID); verr == nil && strings.TrimSpace(info.Status) != "" {
			applyVolcAssetStatus(&existing, info.Status)
			existing.UpdatedAt = now()
			return repository.SavePortraitAsset(existing)
		}
	}
	groupID, err := ensureVolcAssetGroup(cfg)
	if err != nil {
		return model.PortraitAsset{}, err
	}
	assetID, err := createVolcAsset(cfg, groupID, sourceURL, strings.TrimSpace(title), kind.VolcAssetType())
	if err != nil {
		return model.PortraitAsset{}, err
	}
	// 复用已有空记录（如上次超时失败的占位），否则新建——保证每个素材至多一条记录。
	record := existing
	if !found {
		record = model.PortraitAsset{ID: "portrait-" + uuid.NewString(), CreatedAt: now()}
	}
	record.UserID = userID
	record.Title = strings.TrimSpace(title)
	record.SourceURL = sourceURL
	record.StorageKey = storageKey
	record.ContentHash = contentHash
	record.GroupID = groupID
	record.AssetID = assetID
	record.ProjectName = cfg.ProjectName
	record.Kind = kind
	record.Status = model.PortraitAssetProcessing
	record.ErrorMsg = ""
	record.UpdatedAt = now()
	return repository.SavePortraitAsset(record)
}

// 服务端重抓外来素材的大小上限。图片几 MB 足够；视频按火山单个 ≤200MB 的上限留同等余量，
// 音频火山限 15MB，这里给 16MB 让越界由火山给出准确报错而不是被我们截断成损坏文件。
const (
	portraitRefetchMaxBytes      = 32 << 20
	portraitRefetchVideoMaxBytes = 200 << 20
	portraitRefetchAudioMaxBytes = 16 << 20
)

// SubmitPortraitAssetFromURL 客户端读不到本地像素时的回退（如画布从他人分享/下载导入、素材仍在对方分组桶）：
// 浏览器跨域取不到像素，但对方分组桶是「公共读」，服务端可直接 HTTP GET。于是由服务端抓取源素材、
// 转存进本用户分组桶得到可公网访问的新地址，再走常规入库审核（sourceURL 换成本桶地址交火山拉取）。
func SubmitPortraitAssetFromURL(userID, sourceURL, storageKey, title string, kind model.PortraitAssetKind) (model.PortraitAsset, error) {
	if kind == "" {
		kind = model.PortraitAssetKindImage
	}
	label := kind.Label()
	src := strings.TrimSpace(sourceURL)
	if src == "" {
		return model.PortraitAsset{}, safeMessageError{message: "缺少" + label + "地址"}
	}
	if strings.HasPrefix(src, "asset://") {
		return model.PortraitAsset{}, safeMessageError{message: "该素材已是火山 asset 引用，无需重复认证"}
	}
	if !IsPublicHTTPURL(src) {
		return model.PortraitAsset{}, safeMessageError{message: "无法自动重认证：该" + label + "不是可访问的公网地址，请重新上传后再认证"}
	}
	// 尽早校验本用户火山/桶配置可用，避免抓完素材才发现没配置。
	if _, err := loadVolcAssetConfigForUser(userID); err != nil {
		return model.PortraitAsset{}, err
	}
	maxBytes := int64(portraitRefetchMaxBytes)
	switch kind {
	case model.PortraitAssetKindVideo:
		maxBytes = portraitRefetchVideoMaxBytes
	case model.PortraitAssetKindAudio:
		maxBytes = portraitRefetchAudioMaxBytes
	}
	key := "media/" + userID + "/reference/" + uuid.NewString() + portraitRefetchExt(src, kind)
	rehosted, err := FetchAndUploadToTOSForUser(userID, src, key, "", maxBytes)
	if err != nil {
		return model.PortraitAsset{}, err
	}
	// 转存后走常规入库；storageKey 沿用原节点的（供 storageKey 维度去重/回填），contentHash 交给 storageKey 兜底。
	return SubmitPortraitAsset(userID, rehosted, storageKey, "", title, kind)
}

// portraitRefetchExt 从源地址粗略取扩展名（仅用于对象键可读；实际 content-type 由抓取响应头决定）。
func portraitRefetchExt(src string, kind model.PortraitAssetKind) string {
	s := src
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		s = s[:i]
	}
	s = strings.ToLower(s)
	candidates := []string{".jpeg", ".jpg", ".png", ".webp", ".gif", ".bmp"}
	fallback := ".jpg"
	switch kind {
	case model.PortraitAssetKindVideo:
		candidates, fallback = []string{".mp4", ".mov"}, ".mp4"
	case model.PortraitAssetKindAudio:
		candidates, fallback = []string{".mp3", ".wav"}, ".mp3"
	}
	for _, ext := range candidates {
		if strings.HasSuffix(s, ext) {
			return ext
		}
	}
	return fallback
}

// findExistingPortrait 优先按内容指纹、其次按 storageKey 查找已有记录。
func findExistingPortrait(userID string, contentHash string, storageKey string) (model.PortraitAsset, bool) {
	if contentHash != "" {
		if record, ok, err := repository.FindPortraitAssetByContentHash(userID, contentHash); err == nil && ok {
			return record, true
		}
	}
	if storageKey != "" {
		if record, ok, err := repository.FindPortraitAssetByStorageKey(userID, storageKey); err == nil && ok {
			return record, true
		}
	}
	return model.PortraitAsset{}, false
}

// RefreshPortraitAsset 向火山查询素材最新状态并落库；终态（active/failed）直接返回。
func RefreshPortraitAsset(record model.PortraitAsset) (model.PortraitAsset, error) {
	if record.Status == model.PortraitAssetActive || record.AssetID == "" {
		return record, nil
	}
	cfg, err := loadVolcAssetConfigForUser(record.UserID)
	if err != nil {
		return record, err
	}
	info, err := getVolcAsset(cfg, record.AssetID)
	if err != nil {
		return record, err
	}
	applyVolcAssetStatus(&record, info.Status)
	record.UpdatedAt = now()
	return repository.SavePortraitAsset(record)
}

// portraitFailureHint 审核未通过时的规格提示。火山只回一个 Failed 不说原因，
// 把该类型的硬性限制直接列出来，用户能自己对照排查，不必再来问。
func portraitFailureHint(kind model.PortraitAssetKind) string {
	switch kind {
	case model.PortraitAssetKindVideo:
		return "火山素材审核未通过。参考视频需同时满足：mp4/mov、时长 2~15 秒、帧率 24~60fps、宽高各 300~6000px 且总像素 40.96 万~208.7 万（1080×1920 已接近上限）、宽高比 0.4~2.5、体积 ≤200MB。"
	case model.PortraitAssetKindAudio:
		return "火山素材审核未通过。参考音频需同时满足：wav/mp3、时长 2~15 秒、体积 ≤15MB。"
	default:
		return "火山素材审核未通过。人设图需同时满足：jpeg/png/webp/bmp/tiff/gif/heic/heif、宽高各 300~6000px、宽高比 0.4~2.5、体积 ≤30MB。"
	}
}

// applyVolcAssetStatus 将火山返回的素材状态映射到本地记录。
func applyVolcAssetStatus(record *model.PortraitAsset, status string) {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "active":
		record.Status = model.PortraitAssetActive
		record.ErrorMsg = ""
	case "failed":
		record.Status = model.PortraitAssetFailed
		record.ErrorMsg = portraitFailureHint(record.NormalizedKind())
	default:
		record.Status = model.PortraitAssetProcessing
	}
}

// GetUserPortraitAsset 查询用户的单条记录；仍在审核中时实时刷新一次。
func GetUserPortraitAsset(userID string, id string) (model.PortraitAsset, error) {
	record, ok, err := repository.GetPortraitAsset(id)
	if err != nil {
		return model.PortraitAsset{}, err
	}
	if !ok || record.UserID != userID {
		return model.PortraitAsset{}, safeMessageError{message: "人像资产不存在"}
	}
	if record.Status == model.PortraitAssetProcessing {
		if refreshed, refreshErr := RefreshPortraitAsset(record); refreshErr == nil {
			return refreshed, nil
		}
	}
	return record, nil
}

// ListUserPortraitAssets 返回用户的全部人像资产记录。
func ListUserPortraitAssets(userID string) ([]model.PortraitAsset, error) {
	return repository.ListPortraitAssets(userID)
}

// DeleteUserPortraitAsset 删除用户的人像资产记录。
func DeleteUserPortraitAsset(userID string, id string) error {
	record, ok, err := repository.GetPortraitAsset(id)
	if err != nil {
		return err
	}
	if !ok || record.UserID != userID {
		return safeMessageError{message: "人像资产不存在"}
	}
	return repository.DeletePortraitAsset(id)
}

// ListRemotePortraitAssets 直接从火山资产库拉取当前项目下的素材列表，用于核对入库情况。
func ListRemotePortraitAssets(userID string) ([]map[string]any, string, error) {
	cfg, err := loadVolcAssetConfigForUser(userID)
	if err != nil {
		return nil, "", err
	}
	items, err := listVolcAssets(cfg)
	if err != nil {
		return nil, cfg.ProjectName, err
	}
	return items, cfg.ProjectName, nil
}

// StartPortraitAssetScheduler 启动定时轮询，把仍在审核中的人像资产推进到终态，
// 确保「无感」不依赖前端一直轮询。未配置火山密钥时不启动。
func StartPortraitAssetScheduler() {
	portraitAssetOnce.Do(func() {
		portraitAssetCron = cron.New(cron.WithChain(cron.Recover(cron.DefaultLogger)))
		if _, err := portraitAssetCron.AddFunc(portraitAssetPollCron, refreshProcessingPortraitAssets); err != nil {
			log.Printf("add portrait asset cron failed err=%v", err)
			return
		}
		portraitAssetCron.Start()
	})
}

func refreshProcessingPortraitAssets() {
	if !volcAssetConfigured() {
		return
	}
	records, err := repository.ListProcessingPortraitAssets()
	if err != nil {
		log.Printf("list processing portrait assets failed err=%v", err)
		return
	}
	for _, record := range records {
		if _, err := RefreshPortraitAsset(record); err != nil {
			log.Printf("refresh portrait asset failed id=%s err=%v", record.ID, err)
		}
	}
}
