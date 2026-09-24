package model

// GenerationStatMember 某用户在选定时间段内的生成情况统计。
type GenerationStatMember struct {
	UserID           string `json:"userId"`
	UserName         string `json:"userName"`
	GroupName        string `json:"groupName"`
	VideoOK          int    `json:"videoOk"`          // 成功视频数（提交成功且未退款）
	VideoOKSeconds   int    `json:"videoOkSeconds"`   // 成功视频总时长（秒）
	VideoFail        int    `json:"videoFail"`        // 失败视频数（提交成功但生成失败、已退款）
	VideoFailSeconds int    `json:"videoFailSeconds"` // 失败视频总时长（秒）
	ImageCount       int    `json:"imageCount"`       // 成功生成图片数
	AudioCount       int    `json:"audioCount"`       // 成功生成音频数
	CreditsUsed      int    `json:"creditsUsed"`      // 净消耗点数（消费−返还）
	// Breakdown 按「类型+模型+分辨率」的明细（前端展开用），已排序（视频秒数/次数降序）。
	Breakdown []GenStatBreakdownRow `json:"breakdown"`
}

// GenStatBreakdownRow 某用户按「类型+模型+分辨率」的生成明细一行。
type GenStatBreakdownRow struct {
	Kind    string `json:"kind"`    // video / image / audio
	Model   string `json:"model"`   // 模型名（取自 upstream_logs.model 列）
	Spec    string `json:"spec"`    // 视频=分辨率(如 720p)；图片=尺寸(如 2560x1440)；音频=空
	Count   int    `json:"count"`   // 成功次数
	Seconds int    `json:"seconds"` // 视频总时长(秒)；图片/音频为 0
	Fail    int    `json:"fail"`    // 视频失败(已退款)次数；图片/音频为 0
}

// GenerationStatResult 生成情况统计结果：某二级管理员下辖成员的明细 + 合计 + 当期无任何生成的成员名单。
type GenerationStatResult struct {
	OwnerID   string                 `json:"ownerId"`   // 归属的二级管理员 ID（空=超管直属/未分配创建者的用户）
	OwnerName string                 `json:"ownerName"` // 归属二级管理员用户名
	Members   []GenerationStatMember `json:"members"`   // 当期有生成的成员（已排序）
	Total     GenerationStatMember   `json:"total"`     // 合计（UserID/UserName 为空）
	IdleUsers []string               `json:"idleUsers"` // 当期无任何生成的下辖成员用户名
}
