package service

import (
	"strings"

	"aicanvas/model"
)

// 模型类型名字判据的【唯一数据源】（后端侧）。
//
// 背景：同一个
// 「这个模型是什么类型」的判断在前后端各有一套实现。两边的关键词表一旦分叉，后果不是
// 「显示不一致」那么轻：后端会把自己的判定写进 settings.public.modelChannel.modelMetas，
// 而各读取点读 modelMetas 的优先级【高于】名字启发式 —— 于是后端少认一个词，那个模型就会
// 「加的当天正常、下次重启后从本类下拉里消失」，管理员还看不出原因。
//
// 现在的约定：
//   - 关键词只在本文件里定义，`settings.go` / `model_meta.go` 的判据一律委托到这里；
//   - 前端 `web/src/lib/model-kind-rules.ts` 保存一份【逐字相同】的副本（跨语言无法共享代码）；
//   - 两边共用 `testdata/model-kind-fixture.json` 对拍：
//     后端 `go test ./service -run TestModelKindFixture`
//     前端 `bun web/scripts/check-model-kind-parity.ts`
//     任何一边改了关键词而另一边没跟上，对拍立刻失败。
//
// ⚠️ 改这里的任何一个数组，必须同步改 model-kind-rules.ts，并把新模型名补进 fixture。
var (
	// videoExactKeywords：扩展点。若接入的上游有型号名不含任何通用视频词的视频模型，
	// 在这里精确列出【完整型号名】，否则它会被归成文本模型、视频节点的下拉里根本看不到。
	// ⚠️ 不要只写公共前缀——同一前缀下往往还有【图片】模型，只匹配前缀会把它们一起误判成视频。
	// 在这里加了名字，必须同步加到 web/src/lib/model-kind-rules.ts 的 VIDEO_EXACT_KEYWORDS，
	// 并把该型号名补进 testdata/model-kind-fixture.json，否则对拍检查会失败。
	videoExactKeywords = []string{}

	videoKeywords = []string{"seedance", "video", "sora", "veo", "kling", "wan2.", "hailuo"}
	// ⚠️ 是 "wan2." 不是 "wan"：阿里通义万相的【图片】模型叫 wanx2.1-imageedit / wanx-v1 /
	// wanx2.1-t2i-turbo，只写 "wan" 会把它们全判成视频。本仓库别处认该系列视频模型用的也是
	// wan2.（web/src/lib/seedance-video.ts、web/src/services/api/video.ts）。

	imageKeywords = []string{
		"seedream", "gpt-image", "image", "dall-e", "dalle", "imagen",
		"flux", "sdxl", "stable-diffusion", "midjourney", "banana",
	}

	// audioKeywords：强音频词。名字里出现这些基本可以断定是语音/音乐模型。
	audioKeywords = []string{"tts", "speech", "voice", "music", "sound"}

	// audioAmbiguousKeywords：弱音频词。"audio" 很多时候只是【视频】模型的一个修饰——
	// veo3-audio / wan2.2-t2v-audio 指的是「带声音的视频模型」，不是语音模型。
	// 所以它排在视频关键词【之后】判：名字里同时有视频词和 "audio" 时算视频。
	// ⚠️ 这不是锦上添花：classifyModelKindByName 的结果会被 BackfillModelMetas 落盘，
	// 而 metas 优先级高于一切名字启发式且只增不改。判错一次就是永久错。
	audioAmbiguousKeywords = []string{"audio"}
)

func containsAny(name string, keywords []string) bool {
	for _, kw := range keywords {
		if strings.Contains(name, kw) {
			return true
		}
	}
	return false
}

func normalizedModelName(modelName string) string {
	return strings.ToLower(strings.TrimSpace(modelName))
}

// matchVideoModelName / matchImageModelName / matchAudioModelName 是三条【互相独立】的纯关键词判据，
// 不做任何互斥。互斥交给下面的 classify* 与 inferModelKind 统一处理，避免两处各写一套排除逻辑。
func matchVideoModelName(name string) bool {
	return containsAny(name, videoExactKeywords) || containsAny(name, videoKeywords)
}

func matchImageModelName(name string) bool { return containsAny(name, imageKeywords) }

// matchAudioModelName 任意音频词（强+弱）。只用于「这个名字命中过关键词吗」这类粗判，
// 具体归哪一类由 classifyModelKindByName 的顺序决定。
func matchAudioModelName(name string) bool {
	return containsAny(name, audioKeywords) || containsAny(name, audioAmbiguousKeywords)
}

// classifyModelKindByName 名字启发式的唯一入口。
// 判定顺序 强音频 → 视频 → 弱音频 → 图片 → 文本，与前端 model-kind-rules.ts 完全一致。
func classifyModelKindByName(modelName string) model.ModelKind {
	name := normalizedModelName(modelName)
	switch {
	case containsAny(name, audioKeywords):
		// 强音频词最优先：tts/speech/voice 类名字里可能顺带含 image 之类的词。
		return model.ModelKindAudio
	case matchVideoModelName(name):
		return model.ModelKindVideo
	case containsAny(name, audioAmbiguousKeywords):
		// 到这里说明名字里有 "audio" 但没有任何视频词 —— 那才是真音频模型。
		return model.ModelKindAudio
	case matchImageModelName(name):
		return model.ModelKindImage
	default:
		return model.ModelKindText
	}
}

// modelKindMatchedByName 名字有没有真的命中某条关键词。
// false 表示「一个关键词都没命中、只是落到了 text 这个默认分支」——调用方据此决定
// 要不要把推断结果【持久化】：落到默认分支的猜测不该写进 modelMetas，否则以后
// 关键词表补全了，这个错值也再也不会自愈（见 BackfillModelMetas 的注释）。
func modelKindMatchedByName(modelName string) bool {
	name := normalizedModelName(modelName)
	return matchAudioModelName(name) || matchVideoModelName(name) || matchImageModelName(name)
}
