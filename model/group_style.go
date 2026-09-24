package model

// GroupStyle 团队共享的自定义风格（图片 / 视频）。
//
// 与「我的风格」的关系：个人风格存在用户自己的 sync_data "presets" 域里（私有、跨设备同步）；
// 分享到团队是【复制】一份到这张表，个人那份保留。所以取消共享不会连带删掉本人的风格。
//
// 预览图为什么要另存一份、而不是直接引用创建者的 previewStorageKey：
// serveSyncFile 的跨账号回退（handler/sync.go:507）只对公共读桶的文件生效，
// 落到本地磁盘的文件仍按账号隔离；实际部署中会有相当一部分文件落在磁盘上，直接引用会让组内其他人看到空白缩略图。
// 所以分享时把预览图字节一并复制进 group-styles/<groupId>/，与 GroupAsset 同款做法。
type GroupStyle struct {
	ID          string `json:"id" gorm:"primaryKey"`
	GroupID     string `json:"groupId" gorm:"index"`
	OwnerUserID string `json:"ownerUserId" gorm:"index"`
	OwnerName   string `json:"ownerName"` // 分享者展示名（displayName 优先，回退 username）
	Kind        string `json:"kind"`      // image | video

	NameZh         string `json:"nameZh"`
	Description    string `json:"description"`
	PrefixPrompt   string `json:"prefixPrompt"` // 仅视频风格用：放在用户描述【之前】
	InjectPrompt   string `json:"injectPrompt"`
	NegativePrompt string `json:"negativePrompt"`

	PreviewURL      string `json:"previewUrl"` // TOS 公网 URL；落盘时为磁盘路径（列表时换成 content 端点）
	PreviewMimeType string `json:"previewMimeType"`

	// SourceStyleID 记录它是从哪个个人风格分享来的，用于「已分享」状态判断与去重。
	SourceStyleID string `json:"sourceStyleId" gorm:"index"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}
