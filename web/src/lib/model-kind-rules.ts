// 模型类型名字判据的【唯一数据源】（前端侧）。
//
// 这是 service/model_kind_rules.go 的逐字副本。跨语言没法共享代码，所以靠对拍测试锁死：
//   后端 `go test ./service -run TestModelKindFixture`
//   前端 `bun web/scripts/check-model-kind-parity.ts`
// 两边共用同一份 `testdata/model-kind-fixture.json`，任何一边改了关键词而另一边没跟上，
// 对拍立刻失败。
//
// 背景：两边的关键词表一旦分叉，后果不是「显示不一致」那么轻 —— 后端会把自己的判定写进
// settings.public.modelChannel.modelMetas，而各读取点读 modelMetas 的优先级【高于】名字
// 启发式，于是后端少认一个词，那个模型就会「加的当天正常、下次重启后从本类下拉里消失」。
//
// ⚠️ 改这里的任何一个数组，必须同步改 model_kind_rules.go，并把新模型名补进 fixture。

export type ModelKindName = "image" | "video" | "text" | "audio";

// VIDEO_EXACT_KEYWORDS：扩展点。若接入的上游有型号名不含任何通用视频词的视频模型，
// 在这里精确列出【完整型号名】，否则它会被归成文本模型、视频节点的下拉里根本看不到。
// ⚠️ 不要只写公共前缀——同一前缀下往往还有【图片】模型，只匹配前缀会把它们一起误判成视频。
// 在这里加了名字，必须同步加到 service/model_kind_rules.go 的 videoExactKeywords，
// 并把该型号名补进 testdata/model-kind-fixture.json，否则对拍检查会失败。
export const VIDEO_EXACT_KEYWORDS: string[] = [];

// ⚠️ 是 "wan2." 不是 "wan"：阿里通义万相的【图片】模型叫 wanx2.1-imageedit / wanx-v1 /
// wanx2.1-t2i-turbo，只写 "wan" 会把它们全判成视频。本仓库别处认该系列视频模型用的也是 wan2.
export const VIDEO_KEYWORDS = ["seedance", "video", "sora", "veo", "kling", "wan2.", "hailuo"];

export const IMAGE_KEYWORDS = [
    "seedream", "gpt-image", "image", "dall-e", "dalle", "imagen",
    "flux", "sdxl", "stable-diffusion", "midjourney", "banana",
];

// AUDIO_KEYWORDS：强音频词。名字里出现这些基本可以断定是语音/音乐模型。
export const AUDIO_KEYWORDS = ["tts", "speech", "voice", "music", "sound"];

// AUDIO_AMBIGUOUS_KEYWORDS：弱音频词。"audio" 很多时候只是【视频】模型的一个修饰——
// veo3-audio / wan2.2-t2v-audio 指的是「带声音的视频模型」，不是语音模型。
// 所以它排在视频关键词【之后】判：名字里同时有视频词和 "audio" 时算视频。
export const AUDIO_AMBIGUOUS_KEYWORDS = ["audio"];

function containsAny(name: string, keywords: string[]) {
    return keywords.some((kw) => name.includes(kw));
}

function normalizedModelName(model: string) {
    return (model || "").toLowerCase().trim();
}

// 三条【互相独立】的纯关键词判据，不做任何互斥；互斥交给下面的 classifyModelKindByName 统一处理。
function matchVideoModelName(name: string) {
    return containsAny(name, VIDEO_EXACT_KEYWORDS) || containsAny(name, VIDEO_KEYWORDS);
}

function matchImageModelName(name: string) {
    return containsAny(name, IMAGE_KEYWORDS);
}

function matchAudioModelName(name: string) {
    return containsAny(name, AUDIO_KEYWORDS) || containsAny(name, AUDIO_AMBIGUOUS_KEYWORDS);
}

// classifyModelKindByName 名字启发式的唯一入口。
// 判定顺序 强音频 → 视频 → 弱音频 → 图片 → 文本，与后端 classifyModelKindByName 完全一致。
export function classifyModelKindByName(model: string): ModelKindName {
    const name = normalizedModelName(model);
    // 强音频词最优先：tts/speech/voice 类名字里可能顺带含 image 之类的词。
    if (containsAny(name, AUDIO_KEYWORDS)) return "audio";
    if (matchVideoModelName(name)) return "video";
    // 到这里说明名字里有 "audio" 但没有任何视频词 —— 那才是真音频模型。
    if (containsAny(name, AUDIO_AMBIGUOUS_KEYWORDS)) return "audio";
    if (matchImageModelName(name)) return "image";
    return "text";
}

// 四个具名判据一律写成「分类结果等于某一类」，和后端 settings.go 里那四个结构完全对应。
export const isVideoModelName = (model: string) => classifyModelKindByName(model) === "video";
export const isImageModelName = (model: string) => classifyModelKindByName(model) === "image";
export const isAudioModelName = (model: string) => classifyModelKindByName(model) === "audio";
export const isTextModelName = (model: string) => classifyModelKindByName(model) === "text";

// inferModelKindFromName 给「手里已有一份 metas 草稿、不能用全局 store」的调用方用
// （后台分级定价页编辑的是还没保存的 editMetas）。就是 classifyModelKindByName 的别名。
export const inferModelKindFromName = classifyModelKindByName;
