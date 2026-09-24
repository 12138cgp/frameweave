package repository

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"aicanvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm/clause"
)

func GetSyncData(userID, domain string) (model.SyncData, error) {
	db, err := DB()
	if err != nil {
		return model.SyncData{}, err
	}
	var item model.SyncData
	err = db.Where("user_id = ? AND domain = ?", userID, domain).Limit(1).Find(&item).Error
	return item, err
}

func SaveSyncData(userID, domain, data string) (model.SyncData, error) {
	db, err := DB()
	if err != nil {
		return model.SyncData{}, err
	}
	item := model.SyncData{
		ID:        uuid.NewString(),
		UserID:    userID,
		Domain:    domain,
		Data:      data,
		UpdatedAt: time.Now().Format(syncVersionLayout),
	}
	err = db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "domain"}},
		DoUpdates: clause.AssignmentColumns([]string{"data", "updated_at"}),
	}).Create(&item).Error
	return item, err
}

// syncVersionLayout sync_data.updated_at 的格式。
//
// 用纳秒精度而非 RFC3339（秒级）：这个字段唯一的用途就是当【乐观锁的版本令牌】——
// GET 返回它、推送时带回来做 CAS（handler/sync.go），服务端回写也用它（video_rescue）。
// 它从不展示给用户、不解析成日期、不参与排序。
// 若停留在秒级，同一秒内的两次写入版本号完全相同，CAS 分辨不出来，迟到的旧快照照样能覆盖
// ——等于留了个一秒宽的盲区，而这恰恰是并发写最容易撞上的窗口。
// 旧数据是秒级字符串，按精确相等比较依然工作，首次重写后自动升到纳秒，无需迁移。
const syncVersionLayout = time.RFC3339Nano

// SaveSyncDataIfUnchanged 条件写入（CAS）：仅当该行的 updated_at 仍等于 expectedUpdatedAt 时才覆盖。
// 用于服务端的「读-改-写」场景（如孤儿视频回写画布）：若期间客户端推送过新版本，本次写入放弃，
// 避免把整块画布回滚到服务端读取那一刻、抹掉用户的并发编辑。返回是否真的写入。
func SaveSyncDataIfUnchanged(userID, domain, data, expectedUpdatedAt string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Model(&model.SyncData{}).
		Where("user_id = ? AND domain = ? AND updated_at = ?", userID, domain, expectedUpdatedAt).
		Updates(map[string]any{"data": data, "updated_at": time.Now().Format(syncVersionLayout)})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

func GetSyncFile(userID, storageKey string) (model.SyncFile, error) {
	db, err := DB()
	if err != nil {
		return model.SyncFile{}, err
	}
	var item model.SyncFile
	err = db.Where("user_id = ? AND storage_key = ?", userID, storageKey).Limit(1).Find(&item).Error
	return item, err
}

// GetPublicSyncFileByKey 跨账号按 storageKey 查文件登记——仅限公网 http(s) 路径(公共读桶上的对象)。
// 用途:分享/取用/导入把画布内容带到另一账号后,storageKey 引用的文件登记仍在原上传者名下,
// 接收方自愈按本人查会 404(「同一画布 A 账号打开丢图、B 账号正常」的根因)。桶对象本就公共读、
// key 是不可猜的随机 id 且只随分享内容合法流转,放开「按 key 全局解析(仅公网)」不产生新的暴露面。
// 本地磁盘文件(老数据)不在此列,仍严格按账号隔离。
func GetPublicSyncFileByKey(storageKey string) (model.SyncFile, error) {
	db, err := DB()
	if err != nil {
		return model.SyncFile{}, err
	}
	var item model.SyncFile
	err = db.Where("storage_key = ? AND (path LIKE 'http://%' OR path LIKE 'https://%')", storageKey).Limit(1).Find(&item).Error
	return item, err
}

func ListSyncFiles(userID string) ([]model.SyncFile, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.SyncFile
	err = db.Where("user_id = ?", userID).Find(&items).Error
	return items, err
}

func SaveSyncFile(file model.SyncFile) error {
	db, err := DB()
	if err != nil {
		return err
	}
	if file.ID == "" {
		file.ID = uuid.NewString()
	}
	if file.CreatedAt == "" {
		file.CreatedAt = time.Now().Format(time.RFC3339)
	}
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "storage_key"}},
		DoUpdates: clause.AssignmentColumns([]string{"path", "mime_type", "bytes"}),
	}).Create(&file).Error
}

func GetCanvasShare(code string) (model.CanvasShare, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasShare{}, err
	}
	var item model.CanvasShare
	err = db.Where("code = ?", code).Limit(1).Find(&item).Error
	return item, err
}

func SaveCanvasShare(share model.CanvasShare) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&share).Error
}

// snapshotSnapshotKeepDefault 推送快照默认保留份数。
const snapshotKeepDefault = 30

// snapshotThrottle 节流窗口：同 user+domain 距上一份快照不足该时长则跳过（挡防抖刷屏）。
const snapshotThrottle = 10 * time.Minute

// SyncSnapshotMeta 快照轻量投影（列表用，不含 Data 大字段）。
type SyncSnapshotMeta struct {
	ID        string `json:"id"`
	UserID    string `json:"userId"`
	Domain    string `json:"domain"`
	Hash      string `json:"hash"`
	Bytes     int    `json:"bytes"`
	CreatedAt string `json:"createdAt"`
}

// LatestSnapshot 取该 user+domain 下 created_at 最新的一条快照。
func LatestSnapshot(userID, domain string) (model.SyncSnapshot, bool, error) {
	db, err := DB()
	if err != nil {
		return model.SyncSnapshot{}, false, err
	}
	var item model.SyncSnapshot
	// 【只取判定所需的三列，绝不带 data】：本函数在每次推送时被调用（CaptureCanvasSnapshot 的
	// 去重+节流判断只用 hash 与 created_at）。若按整行取，会把上一份快照的完整 JSON 一起读出来——
	// 单份 canvas 快照约 3MB 量级，等于每次推送白读 3MB；快照覆盖 5 个域后这个开销再乘 5，
	// 推送耗时被明显拉长，同步窗口变长又更容易和用户正在进行的拖动/编辑撞上。
	// 需要完整内容的场景走 GetSnapshotByID。
	err = db.Model(&model.SyncSnapshot{}).
		Select("id", "user_id", "domain", "hash", "bytes", "created_at").
		Where("user_id = ? AND domain = ?", userID, domain).
		Order("created_at DESC").Limit(1).Find(&item).Error
	if err != nil {
		return model.SyncSnapshot{}, false, err
	}
	return item, item.ID != "", nil
}

// SaveSyncSnapshot 写入一条新快照（历史版本，非 UPSERT）。未填 ID/CreatedAt 时按现有写法补齐。
func SaveSyncSnapshot(s model.SyncSnapshot) error {
	db, err := DB()
	if err != nil {
		return err
	}
	if s.ID == "" {
		s.ID = uuid.NewString()
	}
	if s.CreatedAt == "" {
		s.CreatedAt = time.Now().Format(syncVersionLayout)
	}
	return db.Create(&s).Error
}

// PruneSnapshots 仅保留该 user+domain 下最新 keep 条，其余删除。
// ⚠️ 被钉住（Pinned）的快照永远不删——那是「疑似丢数据」时保下来的恢复点，
// 清理策略再怎么轮换也不能把它冲掉，否则等人发现时已经无从恢复。
func PruneSnapshots(userID, domain string, keep int) error {
	if keep < 0 {
		keep = 0
	}
	db, err := DB()
	if err != nil {
		return err
	}
	// 先查出要保留的 id（最新 keep 条），删除其余。
	var keepIDs []string
	// ⚠️⚠️ `pinned IS NULL OR pinned = 0` —— 这个 NULL 分支【绝对不能省】。
	//
	// AutoMigrate 给存量行补的 pinned 是 NULL，不是 0。若只写 `pinned = 0`，
	// 那么所有存量快照既进不了这个保留名单（NULL ≠ 0）、也进不了下面的钉住名单（NULL ≠ 1），
	// 于是【全部被当成该删的删掉】—— 一个用户的整段快照历史会在下一次清理时清零，
	// 正好毁掉这套机制要保护的东西。
	// 实测：存量 861 份快照里有 860 份 pinned 为 NULL，只写 `pinned = 0` 时
	// 它们会被整批删掉。
	err = db.Model(&model.SyncSnapshot{}).
		Where("user_id = ? AND domain = ? AND (pinned IS NULL OR pinned = ?)", userID, domain, false).
		Order("created_at DESC").Limit(keep).
		Pluck("id", &keepIDs).Error
	if err != nil {
		return err
	}
	// 钉住的一律进保留名单，不占 keep 的名额（否则钉几份就把正常轮换挤没了）。
	var pinnedIDs []string
	if err := db.Model(&model.SyncSnapshot{}).
		Where("user_id = ? AND domain = ? AND pinned = ?", userID, domain, true).
		Pluck("id", &pinnedIDs).Error; err != nil {
		return err
	}
	keepIDs = append(keepIDs, pinnedIDs...)
	q := db.Where("user_id = ? AND domain = ?", userID, domain)
	if len(keepIDs) > 0 {
		q = q.Where("id NOT IN ?", keepIDs)
	}
	return q.Delete(&model.SyncSnapshot{}).Error
}

// ListSnapshots 列该 user+domain 的快照（created_at desc，limit<=0 不限），不返回 Data 大字段。
func ListSnapshots(userID, domain string, limit int) ([]SyncSnapshotMeta, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	q := db.Model(&model.SyncSnapshot{}).
		Select("id", "user_id", "domain", "hash", "bytes", "created_at").
		Where("user_id = ? AND domain = ?", userID, domain).
		Order("created_at DESC")
	if limit > 0 {
		q = q.Limit(limit)
	}
	var items []SyncSnapshotMeta
	if err := q.Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

// GetSnapshotByID 取单条完整快照（含 Data）。
func GetSnapshotByID(id string) (model.SyncSnapshot, bool, error) {
	db, err := DB()
	if err != nil {
		return model.SyncSnapshot{}, false, err
	}
	var item model.SyncSnapshot
	err = db.Where("id = ?", id).Limit(1).Find(&item).Error
	if err != nil {
		return model.SyncSnapshot{}, false, err
	}
	return item, item.ID != "", nil
}

// CaptureCanvasSnapshot 推送时的历史版本快照（best-effort，任何错误只记日志、绝不影响推送）。
// 去重：与最新快照 hash 相同则跳过（挡 90s 心跳重复）。
// 节流：距最新快照不足 snapshotThrottle 则跳过（挡 8s 防抖刷屏）。
// 否则写新版本 + Prune 到保留份数。
//
// 【覆盖全部数据域】原先只给 canvas 拍快照，assets（我的素材）/presets（自定义风格）/
// 两个工作台域一份历史都没有——这几个域同样是用户内容，一旦被覆盖就彻底没有退路。
// 体量上也没有理由不拍：各域体量差距悬殊，canvas 占几百 MB 时 assets 也才十几 MB，presets 与工作台可忽略。
// 函数名保留 CaptureCanvasSnapshot 不改，避免动到已有调用点与后台快照页的既有语义。
func CaptureCanvasSnapshot(userID, domain, data string) error {
	if !model.IsSyncDomain(domain) {
		return nil
	}
	sum := sha256.Sum256([]byte(data))
	hash := hex.EncodeToString(sum[:])

	latest, ok, err := LatestSnapshot(userID, domain)
	if err != nil {
		return err
	}
	if ok {
		if latest.Hash == hash {
			return nil // 内容未变，去重跳过
		}
		if latest.CreatedAt != "" {
			if t, perr := time.Parse(time.RFC3339, latest.CreatedAt); perr == nil {
				if time.Since(t) < snapshotThrottle {
					return nil // 距上次过近，节流跳过
				}
			}
		}
	}
	projects, nodes := CanvasScale(data)
	if err := SaveSyncSnapshot(model.SyncSnapshot{
		UserID:    userID,
		Domain:    domain,
		Data:      data,
		Hash:      hash,
		Bytes:     len(data),
		Projects:  projects,
		Nodes:     nodes,
		CreatedAt: time.Now().Format(syncVersionLayout),
	}); err != nil {
		return err
	}
	return PruneSnapshots(userID, domain, snapshotKeep())
}

// snapshotKeep 每个 user+domain 保留的快照份数，可用 SYNC_SNAPSHOT_KEEP 覆盖。
//
// 默认 30：canvas 平均单份 3MB 上下，30 份 × 域数 × 用户数就已经是 10GB 量级，不宜再大。
// 需要更长的可回溯窗口时（例如数据量还很小的测试环境），把它调高（如 200）即可，
// 那种环境下的存储成本可以忽略。取值 <=0 时回退默认。
func snapshotKeep() int {
	if v := strings.TrimSpace(os.Getenv("SYNC_SNAPSHOT_KEEP")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return snapshotKeepDefault
}

// ForceCanvasSnapshot 强制写一份快照（绕过去重/节流），返回新快照 ID。用于恢复前备份。
func ForceCanvasSnapshot(userID, domain, data string) (string, error) {
	// 规模统计必须在这里也算：这条路径（快照补写调度器）造的快照如果 nodes=0，
	// 就永远当不了「峰值」，按规模做的巡检统计对这批快照完全看不见。
	scaleP, scaleN := CanvasScale(data)
	sum := sha256.Sum256([]byte(data))
	hash := hex.EncodeToString(sum[:])
	id := uuid.NewString()
	if err := SaveSyncSnapshot(model.SyncSnapshot{
		Projects:  scaleP,
		Nodes:     scaleN,
		ID:        id,
		UserID:    userID,
		Domain:    domain,
		Data:      data,
		Hash:      hash,
		Bytes:     len(data),
		CreatedAt: time.Now().Format(syncVersionLayout),
	}); err != nil {
		return "", err
	}
	if err := PruneSnapshots(userID, domain, snapshotKeepDefault); err != nil {
		log.Printf("恢复前备份后裁剪快照失败 user=%s domain=%s err=%v", userID, domain, err)
	}
	return id, nil
}

// —— 素材对账用的只读查询（见 service/media_audit.go）——

// GetSyncDataValue 直接取某域的原始 JSON；不存在返回空串。
func GetSyncDataValue(userID, domain string) (string, error) {
	item, err := GetSyncData(userID, domain)
	if err != nil {
		return "", err
	}
	return item.Data, nil
}

// SyncFileKeySet 返回该用户名下全部 storageKey 的集合。
func SyncFileKeySet(userID string) (map[string]bool, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var keys []string
	if err := db.Model(&model.SyncFile{}).Where("user_id = ?", userID).Pluck("storage_key", &keys).Error; err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(keys))
	for _, key := range keys {
		set[key] = true
	}
	return set, nil
}

// SyncFileKeyExistsAnyUser 判断该 storageKey 是否登记在【任意】账号名下。
// 分享/取用来的画布，文件登记留在原上传者名下，本人名下查无并不代表丢失。
func SyncFileKeyExistsAnyUser(storageKey string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	if err := db.Model(&model.SyncFile{}).Where("storage_key = ?", storageKey).Limit(1).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

// SyncDataUserIDs 返回在该域有数据的全部用户 ID。
func SyncDataUserIDs(domain string) ([]string, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var ids []string
	if err := db.Model(&model.SyncData{}).Where("domain = ?", domain).Pluck("user_id", &ids).Error; err != nil {
		return nil, err
	}
	return ids, nil
}

// HashSyncData 计算快照去重用的内容哈希（与 CaptureCanvasSnapshot 内部口径一致）。
func HashSyncData(data string) string {
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:])
}

// ListSyncDataNeedingSnapshot 找出「内容比它最新的那份快照更新」的数据域。
//
// ⚠️ 必须按【解析后的时间】比较，不能直接比字符串：
// sync_data.updated_at 用的是纳秒精度（syncVersionLayout=RFC3339Nano，为了让 CAS 能分辨同秒并发写），
// 而 sync_snapshots.created_at 是秒级 RFC3339。两种格式混在一起做字符串比较必然出错——
// "…10:00:00.123Z" 与 "…10:00:00Z" 逐字符比到第 20 位是 '.'(46) vs 'Z'(90)，
// 结论与真实先后完全相反。历史数据里两种格式还并存，更不能靠字符串。
//
// 先只取时间戳列筛出候选（不碰 data 大字段），再单独把候选的内容读出来。
// 供快照补写定时任务使用，见 service/snapshot_backfill.go 里为什么需要它。
func ListSyncDataNeedingSnapshot() ([]model.SyncData, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	type stamp struct {
		UserID    string
		Domain    string
		UpdatedAt string
	}
	var rows []stamp
	if err := db.Model(&model.SyncData{}).
		Select("user_id", "domain", "updated_at").
		Where("data <> ''").Scan(&rows).Error; err != nil {
		return nil, err
	}
	type snap struct {
		UserID string
		Domain string
		LastAt string
	}
	var snaps []snap
	if err := db.Model(&model.SyncSnapshot{}).
		Select("user_id", "domain", "MAX(created_at) AS last_at").
		Group("user_id, domain").Scan(&snaps).Error; err != nil {
		return nil, err
	}
	latest := make(map[string]time.Time, len(snaps))
	for _, s := range snaps {
		if t, ok := parseSyncTime(s.LastAt); ok {
			latest[s.UserID+"|"+s.Domain] = t
		}
	}

	out := make([]model.SyncData, 0, 8)
	for _, r := range rows {
		last, seen := latest[r.UserID+"|"+r.Domain]
		if seen {
			cur, ok := parseSyncTime(r.UpdatedAt)
			// 时间戳解析不了就保守当作「需要补写」：宁可多拍一份（hash 去重会挡掉），
			// 也不能因为格式意外而让某一版永远没有回滚点。
			if ok && !cur.After(last) {
				continue
			}
		}
		item, gerr := GetSyncData(r.UserID, r.Domain)
		if gerr != nil || strings.TrimSpace(item.Data) == "" {
			continue
		}
		out = append(out, item)
	}
	return out, nil
}

// parseSyncTime 同时接受 RFC3339 与 RFC3339Nano（历史数据两种格式并存）。
func parseSyncTime(v string) (time.Time, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return t, true
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t, true
	}
	return time.Time{}, false
}

// ListAllSyncDataForSnapshotCheck 返回全部非空数据域（含 data），交由调用方按哈希判断是否需要快照。
//
// 与 ListSyncDataNeedingSnapshot 的分工：那个按时间戳做廉价预筛，适合每 5 分钟跑；
// 但时间戳挡不住「绕过应用直接改库」——那种改动不 bump updated_at，会永久漏掉。
// 本函数供每小时一次的全量核对使用，用内容哈希兜底，不依赖任何时间字段。
func ListAllSyncDataForSnapshotCheck() ([]model.SyncData, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var rows []model.SyncData
	if err := db.Where("data <> ''").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// CanvasScale 数一份画布清单里有多少个（未删除的）项目和节点。
// 放在 repository 是因为写快照时就要算——统计必须和正文同时落库，
// 否则「找峰值」还得回头读正文，那正是要避免的事。
func CanvasScale(data string) (projects int, nodes int) {
	if strings.TrimSpace(data) == "" {
		return 0, 0
	}
	var m struct {
		Data struct {
			Projects []struct {
				Nodes     []json.RawMessage `json:"nodes"`
				DeletedAt string            `json:"deletedAt"`
			} `json:"projects"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(data), &m) != nil {
		return 0, 0
	}
	for _, p := range m.Data.Projects {
		if strings.TrimSpace(p.DeletedAt) != "" {
			continue
		}
		projects++
		nodes += len(p.Nodes)
	}
	return projects, nodes
}
