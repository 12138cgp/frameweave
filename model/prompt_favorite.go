package model

// PromptFavorite 用户收藏的「这一次生成」——提示词 + 参考素材 + 配置 + 成品。
//
// 为什么单独建表，而不是塞进「我的素材」：
// 「我的素材」整体是前端 IndexedDB 里的一坨 JSON，同步进 sync_data 后服务端从不解析
// （见 model/sync.go）。而本功能明确要求「管理员能从系统中直接批量提取」，
// 让后端去逐个用户解析前端的 JSON 结构，既慢又和前端结构强耦合——前端改个字段后台就崩。
// 单独落表后：管理员可直接分页/筛选/导出，用户侧也不再撑大那份本就是带宽大头的同步清单。
//
// ⚠️ 参考素材存的是「转存副本」而不是引用。
// 收藏那一刻把参考图/参考音频/成品各复制一份到 data/favorite-files/{userID}/，
// 彻底脱离原素材的生命周期。理由是引用的坑已经踩过：现有「团队素材取用」是引用，
// 上传者一删取用方就成死链；对收藏来说后果更重——管理员事后提取时文件已经不在了。
type PromptFavorite struct {
	ID string `json:"id" gorm:"primaryKey"`

	// —— 归属 ——
	// Username / GroupName 是冗余快照：管理员导出时不必联表，
	// 也保证用户日后改名、换组之后，导出的历史记录仍是收藏当时的样子。
	UserID    string `json:"userId" gorm:"index"`
	Username  string `json:"username"`
	GroupID   string `json:"groupId" gorm:"index"`
	GroupName string `json:"groupName"`

	// —— 来源 ——
	// UserID + CanvasID + SourceNodeID 构成幂等键：同一个节点重复点收藏是「更新」不是「新增」。
	// 幂等是必需的而不是优化：前端把「已收藏」标记写在节点 metadata 上，
	// 而节点 metadata 的这一拍写入有被 skipNextPersist 吞掉的可能，
	// 标记一旦被吞，用户重开画布会看到未收藏、再点一次——没有幂等就会攒出重复垃圾。
	CanvasID     string `json:"canvasId" gorm:"index"`
	CanvasTitle  string `json:"canvasTitle"`
	SourceNodeID string `json:"sourceNodeId" gorm:"index"`
	// Kind image=图片节点 / video=视频节点
	Kind string `json:"kind" gorm:"index"`

	// —— 提示词三层 ——
	// 这个项目里「提示词」其实是三个不同的东西，收藏必须存下前两个（第三个从来没落过盘）：
	//   PromptDraft 用户手打的原文，保留 @[node:xxx] 引用 token —— 回填画布重新生成要用它
	//   Prompt      烘焙版，@token 已被替换成「图片1 / 视频2」这类编号 —— 给人读、给管理员导出读
	//   styled      再套上风格前缀/后缀/负面词之后真正发给上游的那一版，是纯内存变量，全项目不存盘
	// 所以要复现当时那次生成的效果，必须靠 StyleSnapshot 把风格重新 compose 出来。
	PromptDraft string `json:"promptDraft" gorm:"type:text"`
	Prompt      string `json:"prompt" gorm:"type:text"`

	// Config 生成配置 JSON（模型 / 比例 / 画质 / 时长 / 是否生成音频 …）。
	// 存 JSON 而不拆列：视频配置项本身就散在六处且还在增加（见前端 buildGenerationConfig），
	// 拆成列的话每加一个配置项都要动表结构，必然跟不上。
	Config string `json:"config" gorm:"type:text"`

	// StyleSnapshot 风格预设的整份快照 JSON，不是只存 id。
	// 自定义风格属于用户自己、随时可删；只存 id 的话用户一删，这条收藏就永远还原不出当时的效果。
	StyleSnapshot string `json:"styleSnapshot" gorm:"type:text"`

	// References 参考素材 JSON 数组，元素为 PromptFavoriteRef。
	References string `json:"references" gorm:"type:text"`

	// —— 成品：用户觉得「效果好」的那张图 / 那个视频，同样是转存副本 ——
	ResultFileKey  string `json:"resultFileKey"`
	ResultMimeType string `json:"resultMimeType"`
	ResultBytes    int64  `json:"resultBytes"`
	// ResultFilePath 见 PromptFavoriteRef.FilePath 的说明，同样禁止下发。
	ResultFilePath string `json:"resultFilePath,omitempty"`

	Title string `json:"title"`
	Note  string `json:"note"`

	CreatedAt string `json:"createdAt" gorm:"index"`
	UpdatedAt string `json:"updatedAt"`
}

// PromptFavoriteRef 一条参考素材，是 PromptFavorite.References 里的数组元素。
//
// Label 必须存。它是「图片1」「音频2」这种编号，提示词正文里引用的就是这个编号
// （见前端 canvas-node-generation.ts 的烘焙逻辑）——丢了 Label，Prompt 里的
// 「请参考图片2的构图」就再也对不上是哪张图了。
type PromptFavoriteRef struct {
	// Kind image | video | audio | text
	Kind  string `json:"kind"`
	Label string `json:"label"`
	// Text 仅 kind=text 时有值（文本节点作为参考被引用时的正文）。
	Text string `json:"text"`
	// FileKey 转存副本的逻辑标识，前端凭它走 /api/v1/prompt-favorites/{id}/files/{fileKey} 取内容。
	// kind=text 时为空。
	FileKey    string `json:"fileKey"`
	MimeType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
	DurationMs int64  `json:"durationMs"`
	// FilePath 转存副本的实际位置：对象存储公网 URL，或服务器本地路径。
	//
	// ⚠️ 仅服务端使用，下发前必须由 handler 的 sanitize 清空。
	// 本地路径会暴露服务器目录结构，且这个字段是库里那份 JSON 的一部分、天然会跟着记录一起被读出来，
	// 所以「默认不下发」必须由代码保证，不能指望调用方记得。
	FilePath string `json:"filePath,omitempty"`
	// Missing 转存失败的标记。
	//
	// 收藏绝不能因为一张参考图取不到就整个失败——那会让用户白点一次、还不知道为什么。
	// 取不到就把这一项标记出来、其余照常存，前端据此提示「部分参考素材未能保存」。
	Missing bool `json:"missing,omitempty"`
	// SourceNodeID 原参考节点 id，仅用于回填画布时尽力匹配；原节点可能早已删除，不可依赖。
	SourceNodeID string `json:"sourceNodeId"`
	// SourceStorageKey 转存前的原始 storageKey。
	// 留着是为了重复收藏时能认出「这一项没变」，直接复用已转存的副本而不是再存一份——
	// 用户取消收藏再收藏、或改完提示词重新收藏都很常见，不复用就会在桶里攒出一堆同图副本。
	SourceStorageKey string `json:"sourceStorageKey"`
}

// PromptFavoriteNodeRef 「这个画布里哪些节点已收藏」的轻量投影。
//
// 必须同时给出收藏 id：前端拿它校正节点上的本地标记，而那个标记正是取消收藏时要用的 id。
// 只回节点 id 的话，校正之后用户点「取消收藏」就没有 id 可用了。
type PromptFavoriteNodeRef struct {
	ID           string `json:"id"`
	SourceNodeID string `json:"sourceNodeId"`
}

// PromptFavoriteKinds 允许的节点类型。收藏只对「出了成品」的图片/视频节点开放。
var PromptFavoriteKinds = map[string]bool{
	"image": true,
	"video": true,
}
