package model

// PortraitAssetStatus 人像资产在火山方舟资产库的审核状态。
type PortraitAssetStatus string

const (
	PortraitAssetProcessing PortraitAssetStatus = "processing"
	PortraitAssetActive     PortraitAssetStatus = "active"
	PortraitAssetFailed     PortraitAssetStatus = "failed"
)

// PortraitAssetKind 素材资产的媒体类型。
// 火山 CreateAsset 的 AssetType 支持 Image / Video / Audio 三种，早期本项目只做了图片。
type PortraitAssetKind string

const (
	PortraitAssetKindImage PortraitAssetKind = "image"
	PortraitAssetKindVideo PortraitAssetKind = "video"
	PortraitAssetKindAudio PortraitAssetKind = "audio"
)

// VolcAssetType 映射成火山 CreateAsset 要求的 AssetType 字面量。
// 空值按图片处理——存量记录建于「只支持图片」的年代，Kind 列为空。
func (k PortraitAssetKind) VolcAssetType() string {
	switch k {
	case PortraitAssetKindVideo:
		return "Video"
	case PortraitAssetKindAudio:
		return "Audio"
	default:
		return "Image"
	}
}

// Label 返回给用户看的中文名。
func (k PortraitAssetKind) Label() string {
	switch k {
	case PortraitAssetKindVideo:
		return "视频"
	case PortraitAssetKindAudio:
		return "音频"
	default:
		return "人设图"
	}
}

// PortraitAsset 素材在火山方舟资产库的入库认证记录。
// 用户上传素材后，后端把公网 URL 提交火山资产库审核，审核通过（Active）后
// 即可在 Seedance 2.0 视频生成中以 asset://<AssetID> 引用。
// 名字保留 Portrait 是历史原因（最初只做人像图），实际已覆盖图片/视频/音频三类。
type PortraitAsset struct {
	ID          string `json:"id" gorm:"primaryKey"`
	UserID      string `json:"userId" gorm:"index"`
	Title       string `json:"title"`
	SourceURL   string `json:"sourceUrl"`
	StorageKey  string `json:"storageKey" gorm:"index"`
	ContentHash string `json:"contentHash" gorm:"index"`
	GroupID     string `json:"groupId"`
	AssetID     string `json:"assetId" gorm:"index"`
	ProjectName string `json:"projectName"`
	// Kind 媒体类型；存量行为空，读取时按图片兜底（见 NormalizedKind）。AutoMigrate 加列，零迁移。
	Kind      PortraitAssetKind   `json:"kind"`
	Status    PortraitAssetStatus `json:"status"`
	ErrorMsg  string              `json:"errorMsg,omitempty"`
	CreatedAt string              `json:"createdAt"`
	UpdatedAt string              `json:"updatedAt"`
}

// NormalizedKind 返回媒体类型，空值兜底为图片。
func (a PortraitAsset) NormalizedKind() PortraitAssetKind {
	switch a.Kind {
	case PortraitAssetKindVideo, PortraitAssetKindAudio:
		return a.Kind
	default:
		return PortraitAssetKindImage
	}
}
