package model

// GroupAsset 团队共享素材：同一分组的成员把图片/视频/音频上传到组内共享区，组内可见、可取用到各自画布。
// OwnerName / SourceCanvasName 反范式化存储，列表展示「用户·画布名 自定义名」无需联表，且来源画布/用户重命名后仍稳定。
type GroupAsset struct {
	ID                  string `json:"id" gorm:"primaryKey"`
	GroupID             string `json:"groupId" gorm:"index"`
	OwnerUserID         string `json:"ownerUserId" gorm:"index"`
	OwnerName           string `json:"ownerName"`        // 上传者展示名（displayName 优先，回退 username）
	SourceCanvasName    string `json:"sourceCanvasName"` // 资产来源画布名
	CustomName          string `json:"customName"`       // 上传者自定义名
	Kind                string `json:"kind"`             // image | video | audio
	URL                 string `json:"url"`              // TOS 公网 URL；本地磁盘存储时为磁盘路径（列表/取内容时换成 content 端点）
	StorageKey          string `json:"storageKey"`       // 唯一对象 key（同时用作本地磁盘文件名）
	MimeType            string `json:"mimeType"`
	Bytes               int64  `json:"bytes"`
	Width               int    `json:"width"`
	Height              int    `json:"height"`
	DurationMs          int    `json:"durationMs"`
	PortraitAssetID     string `json:"portraitAssetId"`        // 肖像授权：火山资产 ID（仅认证通过 active 的图片素材有值）
	PortraitAssetStatus string `json:"portraitAssetStatus"`    // 肖像授权状态，目前仅存 "active"（已认证）
	PortraitAssetURI    string `json:"portraitAssetUri"`       // 肖像授权 asset:// URI
	ProjectID           string `json:"projectId" gorm:"index"` // 来源项目 id（画布所属积分池项目；个人积分/无项目=空=未分类），供团队素材按项目筛选
	ProjectName         string `json:"projectName"`            // 反范式化项目名，供筛选下拉展示（项目改名后仍稳定）
	CreatedAt           string `json:"createdAt"`
}
