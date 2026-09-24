package model

// 同步数据域：与前端 app-sync 的 domain 一致。
const (
	SyncDomainCanvas         = "canvas"
	SyncDomainAssets         = "assets"
	SyncDomainImageWorkbench = "image-workbench"
	SyncDomainVideoWorkbench = "video-workbench"
	// SyncDomainPresets 用户自定义预设(图片风格/视图/视频风格),含预览图 storageKey;后端域无关,与其它域同款存取。
	SyncDomainPresets = "presets"
	// SyncDomainShortcuts 用户自定义快捷键。只存改过的那几条(命令 id + 键位 + updatedAt),无媒体文件。
	SyncDomainShortcuts = "shortcuts"
)

// SyncDomains 全部合法数据域。新增域时只改这一处，handler 的入参校验与
// repository 的快照判定都从这里取，避免两边各维护一份白名单而漏掉新域。
var SyncDomains = []string{
	SyncDomainCanvas,
	SyncDomainAssets,
	SyncDomainImageWorkbench,
	SyncDomainVideoWorkbench,
	SyncDomainPresets,
	SyncDomainShortcuts,
}

// IsSyncDomain 是否为合法数据域。
func IsSyncDomain(domain string) bool {
	for _, d := range SyncDomains {
		if d == domain {
			return true
		}
	}
	return false
}

// SyncData 用户某个数据域的全量 JSON 清单（前端按 id 合并后整体保存）。
type SyncData struct {
	ID        string `json:"id" gorm:"primaryKey"`
	UserID    string `json:"userId" gorm:"uniqueIndex:idx_sync_user_domain"`
	Domain    string `json:"domain" gorm:"uniqueIndex:idx_sync_user_domain"`
	Data      string `json:"data" gorm:"type:text"`
	UpdatedAt string `json:"updatedAt"`
}

// SyncFile 用户媒体文件索引，实际内容存磁盘 data/sync-files/{userID}/ 下。
type SyncFile struct {
	ID         string `json:"id" gorm:"primaryKey"`
	UserID     string `json:"userId" gorm:"uniqueIndex:idx_syncfile_user_key"`
	StorageKey string `json:"storageKey" gorm:"uniqueIndex:idx_syncfile_user_key"`
	Path       string `json:"path"`
	MimeType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
	CreatedAt  string `json:"createdAt"`
}

// SyncSnapshot 用户某数据域的历史版本快照（仅 canvas 域写入），用于丢数据时的服务端兜底。
// 不设唯一键：同 user+domain 允许多行 = 多个历史版本，按 CreatedAt 区分。
// SyncSnapshot 数据域的历史版本快照。
//
// 索引说明：idx_snapshot_user_domain_created 把 created_at 也纳入复合索引，
// 专治 LatestSnapshot 的 `WHERE user_id=? AND domain=? ORDER BY created_at DESC LIMIT 1`。
// 只有 (user_id, domain) 两列时，SQLite 会 USE TEMP B-TREE FOR ORDER BY——为了排序把该用户
// 的全部快照行翻一遍，而每行内联着 MB 级的 Data，实测单次查询 460ms。
// 这个查询在【每次推送的每个域】都会跑一次（去重+节流判断），5 个域就是 2 秒多。
// 三列索引让 SQLite 直接沿索引倒序取第一条，不再触碰行数据。
// 旧的两列索引保留不动：AutoMigrate 不会改已存在的同名索引，故这里用新名字新增。
type SyncSnapshot struct {
	ID        string `json:"id" gorm:"primaryKey"`
	UserID    string `json:"userId" gorm:"index:idx_snapshot_user_domain,priority:1;index:idx_snapshot_user_domain_created,priority:1;index:idx_snapshot_user_domain_nodes,priority:1"`
	Domain    string `json:"domain" gorm:"index:idx_snapshot_user_domain,priority:2;index:idx_snapshot_user_domain_created,priority:2;index:idx_snapshot_user_domain_nodes,priority:2"`
	Data      string `json:"data" gorm:"type:text"`
	Hash      string `json:"hash"`
	Bytes     int    `json:"bytes"`
	CreatedAt string `json:"createdAt" gorm:"index;index:idx_snapshot_user_domain_created,priority:3"`
	// Projects/Nodes 该快照的画布规模，写入时算好。
	//
	// 为什么必须存下来：找「历史峰值」如果要把每份快照的正文读出来数一遍，
	// 用户数 × 最多 30 份 × 单份最大 20MB，一轮扫描就是几个 GB 的 JSON 解析——
	// 实测这条路在 SQLite 上跑十分钟都跑不完，等于把服务器拖垮。
	// 存成列之后，找峰值是一条带索引的 ORDER BY nodes DESC LIMIT 1，正文一个字节都不用读。
	Projects int `json:"projects"`
	Nodes    int `json:"nodes" gorm:"index:idx_snapshot_user_domain_nodes,priority:3"`
	// Pinned 钉住的快照【永不被 PruneSnapshots 清理】。
	//
	// 为什么需要：每个 user+domain 只保留最新 30 份，而快照 10 分钟节流一次——
	// 活跃编辑约 5 小时就轮换一整圈。用户画布出问题往往几天后才被发现，
	// 那时「出问题之前的那份好数据」早被轮掉了，想恢复也无从恢复。
	// 当前版本没有自动钉住的调用方（本版本不含画布丢失兜底扫描），
	// 该列只由 PruneSnapshots 读取：值为真的快照一律不参与轮换清理。
	Pinned bool `json:"pinned" gorm:"index"`
	// PinReason 为什么钉住，便于后台展示与人工判断（如「疑似画布丢失，峰值 12 项目/3400 节点」）。
	PinReason string `json:"pinReason"`
}

// CanvasShare 画布分享：项目 JSON 快照 + 引用的媒体文件键（复制后与原画布互不干扰）。
type CanvasShare struct {
	Code      string `json:"code" gorm:"primaryKey"`
	OwnerID   string `json:"ownerId" gorm:"index"`
	Title     string `json:"title"`
	Project   string `json:"project" gorm:"type:text"`
	FileKeys  string `json:"fileKeys" gorm:"type:text"`
	CreatedAt string `json:"createdAt"`
}
