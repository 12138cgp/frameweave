package model

// MediaTranscodeJob 把浏览器放不了（或者大得离谱）的视频转出一份「预览版」。
//
// 起因：用户上传 iPhone 拍的 HEVC(H.265) 1440x2560、206MB 竖屏片这类文件时，
// 文件本身完全正常，下载下来能放、服务端也解得开，
// 唯独在画布里放不出来——Chrome 的 HEVC 支持是硬件门控的，没有硬件解码器就是不支持。
// 视频节点用的是原生 <video>，能不能解完全由浏览器说了算，代码层面无从干预。
//
// 于是换个思路：不动原片，另存一份 H.264 的小预览版专供画布播放。
// 顺带解决一个更大的问题——节点显示区才两三百像素，却在拉 206MB 的源片。
//
// 为什么要落库而不是内存队列：转码要十几秒到几分钟，进程随时可能被部署重启杀掉。
// 只有落库，重启后才捡得回来（参见 ResumeMediaTranscodeJobs）。
type MediaTranscodeJob struct {
	ID     string `json:"id" gorm:"primaryKey"`
	UserID string `json:"userId" gorm:"index:idx_transcode_user_src"`
	// SourceKey 原片的 storageKey。同一个 key 只转一次，重复请求复用既有任务——
	// 转码烧的是本机自己的 CPU，重复转纯属浪费。
	SourceKey string `json:"sourceKey" gorm:"index:idx_transcode_user_src"`
	SourceURL string `json:"-"`
	Status    string `json:"status"`
	// Progress 0-99 的转码进度。用户拖进来一个几分钟的片子要等好一会儿，
	// 没有进度条就只能盯着一个不动的节点猜是不是卡死了——「上云」那一步已经有进度，这里不能没有。
	Progress int `json:"progress"`
	// SourceDurationMs 源片时长，算进度的分母。探不到就是 0，此时前端只显示「转换中」不显示百分比。
	SourceDurationMs int `json:"sourceDurationMs"`
	// PreviewURL 预览版的公网地址。只用于画布里播放；
	// 当参考 / 下载走的都还是原片（它们读 metadata.content，这里不碰）。
	PreviewURL string `json:"previewUrl"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Bytes      int64  `json:"bytes"`
	Error      string `json:"error"`
	DurationMs int    `json:"durationMs"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}
