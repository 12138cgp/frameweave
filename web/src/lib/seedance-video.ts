import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export const seedanceResolutionOptions = [
    { value: "480p", label: "480p" },
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" },
    { value: "2160p", label: "4K" },
] as const;

// Seedance 各代模型的能力差异集中在这里。**加新模型只改这一张表。**
//
// 以前这些是散落的：参考数量是一个扁平常量 SEEDANCE_REFERENCE_LIMITS，
// 时长上限硬编码在 normalizeSeedanceDuration 里（4-15），分辨率限制则是
// normalizeSeedanceResolution 里一句 if (isSeedanceFastModel)。
// 结果就是接入 2.5 代时要在四五个地方分别改，漏一处就会出现
// 「界面让你选 30 秒、请求发出去被上游拒」这类只有用户才碰得到的错。
export type SeedanceCapability = {
    /** 参考素材数量上限 */
    images: number;
    videos: number;
    audios: number;
    /** 单个参考素材体积上限 */
    imageMaxBytes: number;
    videoMaxBytes: number;
    audioMaxBytes: number;
    /** 出片最长秒数 */
    maxDurationSeconds: number;
    /** 参考视频/音频的【总】时长上限（毫秒） */
    referenceVideoTotalMs: number;
    referenceAudioTotalMs: number;
    /**
     * 参考视频【单条】时长上限（毫秒）。
     *
     * 以前这个值在 seedanceVideoReferenceError / assertSeedanceVideoReferences 两处都写死 15000，
     * 于是 2.5 明明允许参考素材总时长 30 秒，单传一条 20 秒的视频反而在【我们自己这边】就被拒了。
     * 官方《视频编辑》一节写得很明确：「参考视频时长必须 4~30 秒」——写死 15 秒等于把 2.5 的
     * 视频编辑/视频延长整条路堵死在前端。下限统一 2 秒（2.0 沿用至今的值），
     * 视频编辑那条 4 秒的硬下限按模式单独判（见 seedanceVideoReferenceError）。
     */
    referenceVideoMaxMs: number;
    /** 音频能否单独作参考（2.0 系列必须搭配图片或视频，2.5 才允许单独用） */
    allowAudioOnly: boolean;
    /** 支持的输出封装格式。2.5 多一个 mov（H.264 + yuv444p + PCM，编辑/延长场景色彩更保真） */
    outputFormats: readonly string[];
    /** 支持的分辨率档（顺序即界面展示顺序） */
    resolutions: readonly string[];
};

const SEEDANCE_2_0: SeedanceCapability = {
    images: 9,
    videos: 3,
    audios: 3,
    imageMaxBytes: 30 * 1024 * 1024,
    videoMaxBytes: 50 * 1024 * 1024,
    audioMaxBytes: 15 * 1024 * 1024,
    maxDurationSeconds: 15,
    referenceVideoTotalMs: 15000,
    referenceAudioTotalMs: 15000,
    referenceVideoMaxMs: 15000,
    allowAudioOnly: false,
    outputFormats: ["mp4"],
    resolutions: ["480p", "720p", "1080p", "2160p"],
};

/**
 * Seedance 2.5（doubao-seedance-2-5-260628）。数值来自火山官方《Doubao Seedance 2.5 教程》能力概述表：
 * 参考素材上限 50 个（30 图 + 10 视频 + 10 音频）、输出时长 4~30 秒、输出分辨率仅 480p/720p、
 * 参考音/视频总时长由 15 秒增至 30 秒、音频可单独作参考。
 */
const SEEDANCE_2_5: SeedanceCapability = {
    ...SEEDANCE_2_0,
    images: 30,
    videos: 10,
    audios: 10,
    maxDurationSeconds: 30,
    referenceVideoTotalMs: 30000,
    referenceAudioTotalMs: 30000,
    // 30 秒的依据是官方《视频编辑》那句「参考视频时长必须 4~30 秒」，不是从总时长推的。
    referenceVideoMaxMs: 30000,
    allowAudioOnly: true,
    outputFormats: ["mp4", "mov"],
    // 2.5 代上游支持到 1080p（上限就是 1080p，没有 4K）。
    // ⚠️ 这张表是前台可选档位的唯一来源：少写一档，用户就再也选不到它，而且不报任何错。
    //    合并分支或回退版本时最容易把已经放开的档位悄悄抹回去，改前先确认上游当前能力。
    // ⚠️ 放开档位前先在后台配好该档单价：缺档时 pickVideoResolutionRate 会静默回退 720p 单价
    //    并返回"命中"，前后端一致地按 720p 收 1080p 的片，日志无痕。
    // ⚠️ 只能整体替换本字段，不能 push——本对象由 {...SEEDANCE_2_0} 展开，数组引用与 2.0/SD 共享。
    resolutions: ["480p", "720p", "1080p"],
};

/** fast / mini：2.0 代的能力，但输出分辨率只有 480p/720p（官方能力概述表）。 */
const SEEDANCE_2_0_SD: SeedanceCapability = { ...SEEDANCE_2_0, resolutions: ["480p", "720p"] };

/**
 * 取某个模型的能力。模型名认不出来时一律回退到最保守的 2.0 档——
 * 宁可让用户少选几个档位，也不能让界面允许上游拒收的参数。
 */
export function seedanceCapability(model = ""): SeedanceCapability {
    if (isSeedance25Model(model)) return SEEDANCE_2_5;
    if (isSeedanceFastModel(model) || isSeedanceMiniModel(model)) return SEEDANCE_2_0_SD;
    return SEEDANCE_2_0;
}

/** 走 OpenAI 方言的视频接口单次能带的参考素材上限。这条路只收参考图——参考视频/音频在更早的守卫里就被拒了。 */
export type VideoRefLimits = { images: number };

/**
 * 走 OpenAI 方言的视频接口，单次能带多少参考素材。
 *
 * 取保守值：宁可少发几个，也不要让上游整单拒收。超出的部分会被丢弃，
 * 但调用方必须提示用户——原先是【静默截断】，用户接了 15 张只发出去 7 张，
 * 成片里那几张参考自然没生效，界面上却一点提示都没有。
 *
 * ⚠️ 不要凭感觉调大 images：这个数是对着上游规格表来的保守下界，
 * 抬高之后原先能过的请求可能被上游整单拒收。确认过你家上游的规格再改。
 */
export function videoRefLimits(_model = ""): VideoRefLimits {
    return { images: 7 };
}

export const seedanceRatioOptions = [
    { value: "16:9", label: "16:9" },
    { value: "9:16", label: "9:16" },
    { value: "1:1", label: "1:1" },
    { value: "4:3", label: "4:3" },
    { value: "3:4", label: "3:4" },
    { value: "21:9", label: "21:9" },
    { value: "adaptive", label: "自适应" },
] as const;

const seedancePixels = {
    "480p": {
        "16:9": "864x496",
        "4:3": "752x560",
        "1:1": "640x640",
        "3:4": "560x752",
        "9:16": "496x864",
        "21:9": "992x432",
    },
    "720p": {
        "16:9": "1280x720",
        "4:3": "1112x834",
        "1:1": "960x960",
        "3:4": "834x1112",
        "9:16": "720x1280",
        "21:9": "1470x630",
    },
    "1080p": {
        "16:9": "1920x1080",
        "4:3": "1664x1248",
        "1:1": "1440x1440",
        "3:4": "1248x1664",
        "9:16": "1080x1920",
        "21:9": "2206x946",
    },
    "2160p": {
        "16:9": "3840x2160",
        "4:3": "3326x2494",
        "1:1": "2880x2880",
        "3:4": "2494x3326",
        "9:16": "2160x3840",
        "21:9": "4398x1886",
    },
} as const;

export function isSeedanceVideoConfig(config: Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    return isSeedanceVideoModel(config.model || config.videoModel) || isArkPlanBaseUrl(config.baseUrl);
}

export function isSeedanceVideoModel(model: string) {
    const value = model.toLowerCase();
    return value.includes("seedance") || value.includes("doubao-seedance");
}

// 匹配 doubao-seedance-2-5-260628 这类命名；2-0 / 2.0 不会误中。
// 用正则而不是 includes("2-5")：避免撞上日期后缀里恰好出现的 "2-5"。
export function isSeedance25Model(model: string) {
    const value = model.toLowerCase();
    return isSeedanceVideoModel(value) && /seedance[-_.]?2[-_.]5(?![0-9])/.test(value);
}

export function isSeedanceFastModel(model: string) {
    const value = model.toLowerCase();
    return isSeedanceVideoModel(value) && value.includes("fast");
}

// mini 和 fast 一样只有 480p/720p（官方能力概述表），别按完整 2.0 处理。
export function isSeedanceMiniModel(model: string) {
    const value = model.toLowerCase();
    return isSeedanceVideoModel(value) && value.includes("mini");
}

export function isArkPlanBaseUrl(baseUrl: string) {
    return baseUrl.toLowerCase().includes("ark.cn-beijing.volces.com/api/plan/v3") || baseUrl.toLowerCase().includes("/api/plan/v3");
}

export function normalizeSeedanceResolution(value: string, model = "") {
    // 该模型支持就用它；不支持（例如 2.5 选了 1080p，或存量配置里留着 4K）就往下钳。
    // 这一步必须在【发请求前】也走一遍，不能只在界面上禁用——用户的旧配置里可能存着当时合法、
    // 换模型后就非法的值。
    return clampVideoResolutionForModel(value, model);
}


/** 认不出厂商的视频模型：不做限制，按四档全开（保持历史行为，不误伤第三方模型）。 */
const GENERIC_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "2160p"] as const;

/** 分辨率从低到高的次序，钳位时用来找「不超过目标的最高档」。 */
const RESOLUTION_ORDER = ["480p", "720p", "1080p", "2160p"] as const;

/** 该模型支持的分辨率档（顺序即由低到高，也是界面展示顺序）。 */
export function videoResolutionsForModel(model: string): readonly string[] {
    if (isSeedanceVideoModel(model)) return seedanceCapability(model).resolutions;
    return GENERIC_VIDEO_RESOLUTIONS;
}

/**
 * 把分辨率钳进该模型支持的范围。
 *
 * 规则是「往下取最接近的档」，不是「一律落回 720p」：
 * 从 2.0 的 4K 切到一个最高只到 1080p 的模型，用户该拿到 1080p，落回 720p 是平白降质。
 * （切到 2.5 时两种算法结果都是 720p，因为 2.5 的上限就是 720p。）
 *
 * 但**认不出来的值一律落 720p**，绝不落到最高档 —— 猜不到就给安全的低档，
 * 不能因为解析失败反而把用户扣到最贵的 4K 上。
 */
export function clampVideoResolutionForModel(value: string, model = "") {
    const allowed = videoResolutionsForModel(model);
    const normalized = normalizeResolutionToken(value);
    if (allowed.includes(normalized)) return normalized;

    const wantIndex = RESOLUTION_ORDER.indexOf(normalized as (typeof RESOLUTION_ORDER)[number]);
    const safeDefault = allowed.includes("720p") ? "720p" : allowed[0];
    if (wantIndex < 0) return safeDefault; // 压根不认识这个档位

    let best = "";
    for (const item of allowed) {
        const index = RESOLUTION_ORDER.indexOf(item as (typeof RESOLUTION_ORDER)[number]);
        if (index < 0 || index > wantIndex) continue;
        if (best === "" || index > RESOLUTION_ORDER.indexOf(best as (typeof RESOLUTION_ORDER)[number])) best = item;
    }
    // 支持的档位全都比目标高（理论上不会发生，四档表里最低是 480p）：取最低的那档。
    return best || allowed[0];
}

export function normalizeResolutionToken(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = String(value || "").replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

/**
 * 该模型允许的最长出片秒数。
 * 目前只有 Seedance 2.5 是 30 秒；Seedance 2.0 系列和其余模型都是 15 秒。
 * 未知模型按 15 秒处理——宁可让用户少选几秒，也不能让界面允许上游拒收的值。
 */
export const NON_SEEDANCE_MAX_SECONDS = 15;

/**
 * 出片秒数的下限，恒为 1。
 *
 * 这里不按模型分叉：现有视频模型的最短出片时长都是 1 秒，没有「最少 N 秒起」的档位差异，
 * 所以形参一个字节都不读。留着它（加下划线标明不读）是为了不改调用点——
 * 将来真接了有下限差异的上游，直接在这里分叉即可，videoSecondsCap 就是这么用的。
 */
export function videoSecondsFloor(_model: string) {
    return 1;
}

export function videoSecondsCap(model: string) {
    if (isSeedanceVideoModel(model)) return seedanceCapability(model).maxDurationSeconds;
    return NON_SEEDANCE_MAX_SECONDS;
}

/**
 * 视频生成【模式】：由用户显式指定「这单是文生视频 / 图生视频 / 首尾帧 / 参考生视频 /
 * 视频编辑 / 视频延长」，而不是让谁去猜。
 *
 * 为什么要有这个：火山 Seedance 的任务意图是靠 content[] 里每一项的 role 声明的
 *（first_frame / last_frame / reference_image …），而我们这边以前【所有参考图一律发 reference_image】，
 * 于是「图生视频」「首尾帧」在 Seedance 上根本发不出正确形态——用户接两张图想做首尾帧，
 * 实际发出去的是「把两张图当内容参考」，语义整个错掉，而且不报任何错。
 * 反过来，把任务类型交给上游按素材数量自行推断也一样危险：接「场景图 + 人物图」两张参考，
 * 会被判成「从 A 图渐变到 B 图」，连输出画幅都跟着首帧图走。
 * 结论是【显式声明任务类型】，一处都不猜。
 *
 * ⚠️ 这些字符串是【前端 store(AiConfig.videoMode) / 画布节点 metadata.videoMode / 请求层】共用的契约，
 *    改名要三处一起改。
 * 🔴 "auto" 已经【不再是默认值，也不再出现在界面上】（VIDEO_MODES 里标了 hidden）。
 *    原因：auto = 「不声明，由上游按素材推断」，而那正是本次要根治的毛病本身——
 *    用户不去动模式选择器、接两张图，照样可能被判成首尾帧。留着 auto 就等于把 bug 留在默认路径上。
 *    现在默认是 text_to_video，接了参考素材自动变成 reference_to_video（见 resolveVideoModeForCounts）。
 * ⚠️ 但这个取值【必须保留在类型里】：存量节点 metadata 里存的就是 "auto"（或者干脆没这个字段），
 *    所有读取路径都要继续认它，不能报错、不能显示成空白。
 *
 * video_edit / video_extend 是 **Seedance 2.5 专属**，对应上游顶层字段
 * omni_reference_task_type = "edit" / "extend"（见 seedanceOmniTaskType）。
 */
export type VideoMode = "auto" | "text_to_video" | "image_to_video" | "first_last_frame" | "reference_to_video" | "video_edit" | "video_extend";

/** 当前接入的参考素材数量，用来判断某个模式现在能不能选。 */
export type VideoModeCounts = { images: number; videos: number; audios: number };

export type VideoModeMeta = {
    value: VideoMode;
    label: string;
    /** 界面上的一句话说明 */
    hint: string;
    /**
     * 不在界面上作为【可选项】出现，但仍然要能被查到中文名。
     *
     * 目前只有 auto 一条：它已经不是默认值、也不该让用户主动去选，
     * 但存量节点 metadata 里存着它，videoModeLabel 还得认得出来（否则界面上冒出一个裸英文或空白）。
     * 界面渲染一律用 VIDEO_MODES_SELECTABLE，别在 UI 里另写一份名单。
     */
    hidden?: boolean;
};

// ⚠️ 这张表里【没有】requiresImages / forbidsVideoAudio 这类字段。
//    素材要求的唯一出处是 videoModeRequirement(mode, model)，界面提示和置灰判据都读它——
//    在这里另留一份写死的数字，迟早被人拿去渲染出一句与实际判据对不上的提示。
export const VIDEO_MODES: readonly VideoModeMeta[] = [
    // 🔴 auto 只保留「认得出这个存量取值」的作用，不再是可选项（hidden）。
    //    它的语义是「不声明任务类型，让上游自己推断」——那正是本轮要根治的东西。
    //    所以默认改成文生视频，有素材时自动落到参考生视频。
    { value: "auto", label: "自动", hint: "沿用旧行为：不声明任务类型，由上游按参考素材推断", hidden: true },
    { value: "text_to_video", label: "文生视频", hint: "不接任何参考素材，纯提示词出片" },
    { value: "image_to_video", label: "图生视频", hint: "用 1 张图作首帧动起来" },
    // ⚠️ 这条 hint 只说【模式本身】是什么，不说比例会怎样：
    //    「输出比例跟不跟随首帧图」是【模型相关】的，模型相关的那句话由 videoModeNotice 给。
    { value: "first_last_frame", label: "首尾帧", hint: "1 张图 = 只定首帧；2 张图 = 首帧 + 尾帧" },
    { value: "reference_to_video", label: "参考生视频", hint: "把参考素材当内容参考（人物/场景/风格），不是首尾帧" },
    // 下面两档是 Seedance 2.5 专属（omni_reference_task_type = edit / extend）。
    // hint 里必须提关键词：上游会再按提示词复判一次任务类型，判出来跟我们声明的不一致就异步报错
    //（InvalidParameter.TaskTypeMismatch），那时钱已经扣了、用户只看到一句英文错误。
    { value: "video_edit", label: "视频编辑", hint: "改写已有视频（增删改画面元素）；提示词里要写清编辑动作，如「删除…」「替换成…」" },
    { value: "video_extend", label: "视频延长", hint: "把已有视频向前或向后续写；提示词里要写清延长意图，如「向后延长」「续写」" },
];

/**
 * 界面上可以【点】的模式清单。
 *
 * 从 VIDEO_MODES 过滤出来而不是另写一份：名单一写两份，迟早一边加了新模式另一边没加，
 * 表现成「请求层支持、界面上压根没有这个选项」。想让某一档从界面消失，只改 VIDEO_MODES 里那条的 hidden。
 * ⚠️ 查中文名 / 查 hint 仍然用 VIDEO_MODES（要能认出 auto 这种存量取值），只有【渲染可选项】用这张表。
 */
export const VIDEO_MODES_SELECTABLE: readonly VideoModeMeta[] = VIDEO_MODES.filter((item) => !item.hidden);

/** 参考素材的种类。 */
export type VideoModeMediaKind = "image" | "video" | "audio";

/** 素材种类的中文名。界面上绝不出现裸的英文。 */
export function videoMediaKindLabel(kind: VideoModeMediaKind) {
    if (kind === "image") return "图片";
    if (kind === "video") return "视频";
    return "音频";
}

/**
 * 一条素材要求。
 *
 * kinds 里有多个种类 = 【任选其一】都能满足这一条（参考生视频：图片/视频/音频接哪种都算）；
 * 只有一个种类 = 就得是那一种。数量按 kinds 里几种素材的【合计】算。
 */
export type VideoModeMediaNeed = {
    kinds: VideoModeMediaKind[];
    min: number;
    /** 数量上限；null = 没有固定上限（只受模型容量约束，请求层会按容量截断） */
    max: number | null;
    /** 这一条的中文说法，例如「图片节点（1~2 个）」。直接拼进 tooltip 用 */
    text: string;
};

/**
 * 某个 模式 × 模型 组合的素材要求。给界面做置灰项的 tooltip 用（「需要连接图片节点（1~2 个）」），
 * 也是 videoModeAvailable 置灰判据的唯一数据来源 —— 两者同源，才不会出现
 * 「tooltip 说要 2 张、判据其实要 1 张」这种只有用户能撞到的错。
 */
export type VideoModeRequirement = {
    mode: VideoMode;
    /** 必须满足的素材条件（逐条都要满足）。空数组 = 对素材没有下限要求 */
    needs: VideoModeMediaNeed[];
    /** 该模式下【不能接】的素材种类 */
    forbidden: VideoModeMediaKind[];
    /** 一句现成的中文要求文案，直接拿去做 tooltip；没有任何要求时是空串 */
    text: string;
};

/** 把一条要求排成中文，例如「图片节点（1~2 个）」「参考素材（图片/视频/音频，至少 1 个）」。 */
function mediaNeedText(kinds: VideoModeMediaKind[], min: number, max: number | null) {
    const name = kinds.length === 1 ? `${videoMediaKindLabel(kinds[0])}节点` : `参考素材（${kinds.map(videoMediaKindLabel).join("/")}）`;
    if (max === null) return `${name}（至少 ${min} 个）`;
    if (max === min) return `${name}（${min} 个）`;
    return `${name}（${min}~${max} 个）`;
}

function mediaNeed(kinds: VideoModeMediaKind[], min: number, max: number | null): VideoModeMediaNeed {
    return { kinds, min, max, text: mediaNeedText(kinds, min, max) };
}

/**
 * 该 模式 × 模型 组合对参考素材的要求。
 *
 * 🔴 首尾帧是【1~2 张】，不是「恰好 2 张」：火山 Seedance 文档原文是
 *    「输入 1 张图作为首帧生成视频，或输入 2 张图分别作为首帧和尾帧」。
 *    写成恰好 2 张，等于把「1 张图定首帧」这个合法用法挡在门外。
 *
 * ⚠️ needs 里的上限是【该模式的固定上限】，不是模型容量上限：
 *    参考生视频 max 写 null（不设上限），容量超了由请求层按 seedanceCapability 截断，维持既有行为；
 *    在这里按容量卡会把「接了 31 张图」从静默截断变成整档置灰，那是另一件事，不在本轮。
 * ⚠️ 形参留着 model 是为了让「素材要求按模型分叉」这条路一直敞着（各代模型的收法本来就可能不同），
 *    当前只有 Seedance 一条上游、各档要求一致，所以暂时读不到它。
 */
export function videoModeRequirement(mode: string, _model: string): VideoModeRequirement {
    const value = (isVideoMode(mode) ? mode : "auto") as VideoMode;
    const built = ((): Pick<VideoModeRequirement, "needs" | "forbidden"> => {
        switch (value) {
            case "text_to_video":
                return { needs: [], forbidden: ["image", "video", "audio"] };
            case "image_to_video":
                return { needs: [mediaNeed(["image"], 1, 1)], forbidden: ["video", "audio"] };
            case "first_last_frame":
                return { needs: [mediaNeed(["image"], 1, 2)], forbidden: ["video", "audio"] };
            case "reference_to_video":
                return { needs: [mediaNeed(["image", "video", "audio"], 1, null)], forbidden: [] };
            // 视频编辑 / 视频延长：官方示例里 content 只有一条 text + 一条 role=reference_video。
            // 图片和音频先不放进来——不是嫌麻烦，是这两种素材在这两个任务类型下文档没写过收不收，
            // 而上游对任务类型是【前置校验 + 异步复判】两道关，形态猜错的代价是扣了钱再异步报错。
            // 哪天文档或实测确认能带图/带音频，把 forbidden 里去掉即可，判据只有这一处。
            case "video_edit":
            case "video_extend":
                return { needs: [mediaNeed(["video"], 1, 1)], forbidden: ["image", "audio"] };
            default:
                // auto：不指定模式，对素材没有任何要求
                return { needs: [], forbidden: [] };
        }
    })();
    const parts: string[] = [];
    if (built.needs.length) parts.push(`需要连接${built.needs.map((item) => item.text).join("、")}`);
    if (built.forbidden.length) parts.push(`不能连接${built.forbidden.map(videoMediaKindLabel).join("/")}节点`);
    return { mode: value, ...built, text: parts.join("；") };
}

/**
 * 视频编辑 / 视频延长的提示词关键词。
 *
 * 🔴 这不是我们加的规矩：文档写明「实际处理任务时，模型仍会进一步结合提示词判断任务类型。
 *    若实际判定的任务类型和指定的不一致，仍会触发异步报错（InvalidParameter.TaskTypeMismatch）」。
 *    也就是说 omni_reference_task_type 只过得了【前置校验】那一关，提示词写得不像编辑/延长，
 *    照样会在任务跑起来之后失败 —— 那时积分已经扣了。
 *
 * ⚠️ 只做【温和提醒】，不做强拦：这份关键词列表未必穷尽（文档给的是示例不是白名单），
 *    强拦会把「把画面里的狗换个颜色」这种明显是编辑、只是没写"替换"二字的提示词误伤掉。
 */
export const VIDEO_EDIT_PROMPT_KEYWORDS = ["编辑视频", "增加", "加上", "删除", "去掉", "修改", "替换", "改成"] as const;
// 「延长」单独列一条是给「把这段视频延长 3 秒」这种写法兜底的：
// 只列「向前延长/向后延长」的话，用户写了"延长"两个字反而会收到一条提醒，那就成了噪音。
export const VIDEO_EXTEND_PROMPT_KEYWORDS = ["向前延长", "向后延长", "延长", "延续", "续写"] as const;

/** 该模式要求提示词里出现的关键词；不要求关键词的模式返回空数组。 */
export function videoModePromptKeywords(mode: string): readonly string[] {
    if (mode === "video_edit") return VIDEO_EDIT_PROMPT_KEYWORDS;
    if (mode === "video_extend") return VIDEO_EXTEND_PROMPT_KEYWORDS;
    return [];
}

export type VideoModePromptCheck = {
    /** 这个模式有没有关键词要求。false 时 ok 恒为 true、hint 恒为空串 */
    required: boolean;
    /** 提示词里有没有出现其中一个关键词 */
    ok: boolean;
    keywords: readonly string[];
    /** 要提醒的话（ok 时为空串）。界面按【提示】渲染，不要拿它去禁用生成按钮 */
    hint: string;
};

/** 当前提示词是否含该模式要求的关键词。给界面做温和提醒用，不参与任何拦截。 */
export function checkVideoModePromptKeywords(mode: string, prompt: string): VideoModePromptCheck {
    const keywords = videoModePromptKeywords(mode);
    if (!keywords.length) return { required: false, ok: true, keywords, hint: "" };
    const text = String(prompt || "");
    const ok = keywords.some((keyword) => text.includes(keyword));
    if (ok) return { required: true, ok: true, keywords, hint: "" };
    // 提醒里【不】把 keywords 整个列出来：关键词表是给匹配用的（含「延长」这种给别的词兜底的条目），
    // 一股脑排进提示里又长又重复。这里手写几个有代表性的动作词。
    const action = mode === "video_edit" ? "编辑动作" : "延长意图";
    const examples = mode === "video_edit" ? "删除… / 增加… / 替换成… / 改成…" : "向后延长 / 向前延长 / 续写";
    return {
        required: true,
        ok: false,
        keywords,
        // 把后果说清楚（异步报错 = 钱先扣了再失败），用户才知道这条提示值得理会。
        hint: `提示词里建议写明${action}（如：${examples}），否则模型可能把这单判成别的任务类型，生成到一半才报错。`,
    };
}

/** 模型不支持该模式时的统一提示文案（界面置灰后显示这一句）。 */
export const VIDEO_MODE_UNSUPPORTED = "该模型暂不支持此模式";

// Seedance（火山方舟）：五种模式全支持。
//
// 依据是火山官方文档《按 content.role 区分任务》那张表：
// 首帧生视频 = role:"first_frame"、首尾帧生视频 = first_frame + last_frame，
// 并注明这两种「ratio 必须为 adaptive，模型自动保持输出宽高比与 first_frame 指定的首帧图片一致」。
const SEEDANCE_VIDEO_MODES: readonly VideoMode[] = ["auto", "text_to_video", "image_to_video", "first_last_frame", "reference_to_video"];

// Seedance 2.5 才有的两档：对应上游顶层字段 omni_reference_task_type = "edit" / "extend"。
// ⚠️ 只给 2.5：2.0 系列的请求体里没有这个字段，多发一个不认识的顶层字段可能整单被拒。
const SEEDANCE_2_5_ONLY_MODES: readonly VideoMode[] = ["video_edit", "video_extend"];

// 其余走 OpenAI 方言的第三方视频接口：没有"模式"这个概念，只留 auto / 文生。
// 它们的请求体里既没有 role 也没有任务类型字段，模式对它们是空转。
const GENERIC_VIDEO_MODES: readonly VideoMode[] = ["auto", "text_to_video"];

/**
 * 该模型支持的模式清单（顺序即界面展示顺序）。
 *
 * ⚠️ 返回的是副本。同文件上面 SEEDANCE_2_5.resolutions 那条注释是血的教训：
 *    共享数组引用被调用方 push 一下，全局都跟着变。
 */
export function videoModeSupportedBy(model: string): VideoMode[] {
    if (isSeedanceVideoModel(model)) return isSeedance25Model(model) ? [...SEEDANCE_VIDEO_MODES, ...SEEDANCE_2_5_ONLY_MODES] : [...SEEDANCE_VIDEO_MODES];
    return [...GENERIC_VIDEO_MODES];
}

function isVideoMode(value: string): value is VideoMode {
    return VIDEO_MODES.some((item) => item.value === value);
}

/** 模式的中文名。认不出来的取值按"自动"显示——界面上绝不能出现裸的英文枚举。 */
export function videoModeLabel(value: string): string {
    return VIDEO_MODES.find((item) => item.value === value)?.label || VIDEO_MODES[0].label;
}

/**
 * 「比例」在某个 模式 × 模型 组合下的处境。两档的差别是【谁定的规矩】，不是我们想不想放开：
 *
 *   free            —— 用户选什么就发什么，上游照办。
 *   forced_adaptive —— 上游【硬性要求】ratio = adaptive。请求层会在发出去的那一刻覆写成 adaptive，
 *                      并在界面上如实告诉用户为什么。⚠️ 只覆写发出去的值，不动用户存着的比例，
 *                      他切回别的模式时原来选的那一档还在。
 */
export type VideoRatioPolicy = "free" | "forced_adaptive";

/**
 * 「时长」在某个 模式 × 模型 组合下的处境。
 *
 *   free         —— 用户选几秒就发几秒。
 *   forced_smart —— 上游【硬性要求】duration = -1（智能时长，由模型按参考视频自己定）。
 *                   目前只有 Seedance 2.5 的【视频编辑】：文档原文「duration 必须 -1」。
 *                   ⚠️ 这是全项目【唯一】允许向上游发 duration=-1 的地方。别处发 -1 就是在漏钱：
 *                      后端把负数读成 0 秒，再按「智能时长」的默认秒数预扣 ——
 *                      出 30 秒的片只收默认那点钱。
 *                      视频编辑这一档之所以能发，是因为计费侧已改成按【源视频真实时长】结算
 *                      （服务端 ProbeVideo 探源视频时长；探不到就报错拒绝，绝不回落到默认秒数）。
 */
export type VideoDurationPolicy = "free" | "forced_smart";

/** 上游「智能时长」的取值。只有 forced_smart 那一档才允许把它发出去。 */
export const SEEDANCE_DURATION_SMART = -1;

export type VideoModeNotice = {
    ratioPolicy: VideoRatioPolicy;
    /** 挂在比例选择器旁边的一句话；空串 = 这个组合没有特殊约束，界面什么都不用显示 */
    ratioHint: string;
    /** 比例选择器要不要挂警示样式。⚠️ 是【警示】不是禁用——本文件不导出任何「把比例灰掉」的信号 */
    ratioWarning: boolean;
    durationPolicy: VideoDurationPolicy;
    /** 挂在时长选择器旁边的一句话；空串 = 没有特殊约束 */
    durationHint: string;
    /** 时长选择器要不要挂警示样式。同样是【警示】不是禁用 */
    durationWarning: boolean;
};

/**
 * 依据是 2026-09 核对过的火山官方文档，不是推测：
 *
 * 《按 content.role 区分任务》表：
 *   「首帧 / 首尾帧生视频」(role = first_frame / last_frame) 一栏写明 **ratio 必须为 adaptive**，
 *   模型自动保持输出宽高比与 first_frame 指定的首帧图片一致；
 *   「文生视频」「全模态·参考生视频」两栏则注明 ratio / duration 无特殊限制。
 *
 * ⚠️ 未知模型一律 free：没有证据说它有约束，就不该平白给用户加一条限制或一句吓人的提示。
 */
export function videoModeRatioPolicy(mode: string, model: string): VideoRatioPolicy {
    // 视频编辑 / 视频延长（Seedance 2.5）：文档两处官方请求示例都写着 "ratio":"adaptive"，
    // 正文也把「ratio 必须 adaptive」列为这两种任务的硬约束 —— 输出画幅跟着源视频走。
    // 这两档只在 2.5 上开放（videoModeSupportedBy），所以不必再判模型。
    if (mode === "video_edit" || mode === "video_extend") return "forced_adaptive";
    // 只有「往 content 里塞首帧图」的两种模式才可能牵动比例；其余模式比例完全自由。
    if (mode !== "image_to_video" && mode !== "first_last_frame") return "free";
    if (isSeedanceVideoModel(model)) return "forced_adaptive";
    return "free";
}

/**
 * 时长在某个 模式 × 模型 组合下的处境。
 *
 * 🔴 只有【视频编辑】是 forced_smart：文档《视频编辑》一节把「ratio 必须 adaptive、duration 必须 -1」
 *    并列写成硬约束，官方请求示例里也确实是 "duration": -1。实测也对得上：源片 4.06 秒、
 *    发 duration=-1，出片 4.06 秒，与源片完全一致。
 * 🔴 【视频延长】不是：它的官方示例是 "duration": 11 —— 真实秒数，不是 -1。
 *    实测同样对得上：源片 4.06 秒、发 duration=6，出片 6.00 秒，即 duration = 输出【总长】，
 *    按用户选的秒数扣费是对的。把延长也一起钉成 -1 是想当然，那会让用户没法决定续多长，
 *    而且 -1 那条计费路是按源视频时长结算的，用在延长上口径也不对。
 */
export function videoDurationPolicy(mode: string, model: string): VideoDurationPolicy {
    // 这里再判一次 2.5，是【计费口径上的保险丝】，不是多余：
    // video_edit 本来就只在 2.5 上开放（videoModeSupportedBy），正常路径下这个判据恒为真。
    // 但万一哪天有人把这档开给别的模型，而那个模型的计费没有「按源视频真实时长结算」这条路，
    // 发出去的 -1 就会被后端按默认秒数预扣 —— 少判一句的代价是直接漏钱。宁可多这一句。
    return mode === "video_edit" && isSeedance25Model(model) ? "forced_smart" : "free";
}

/**
 * 请求层专用：这一单要不要把发出去的 duration 覆写成 -1（智能时长）。
 *
 * 与 videoRatioForcedAdaptive 同一套路：把「覆写」这个动作钉死在唯一判据上。
 * ⚠️ 它紧挨着计费红线，比 ratio 那个还近一步 —— duration 是【计费口径本身】。
 *    能在这里发 -1 的唯一理由是：上游硬性要求，且计费侧已改成按源视频真实时长结算。
 *    任何别的模式、任何别的模型，一律不许走到这条分支上来。
 */
export function videoDurationForcedSmart(mode: string, model: string) {
    return videoDurationPolicy(mode, model) === "forced_smart";
}

/**
 * 请求层专用：这一单要不要把发出去的 ratio 覆写成 adaptive。
 *
 * 单独导出一个布尔函数（而不是让调用方自己去比字符串），是想把「覆写」这个动作钉死在唯一的判据上——
 * 它紧挨着计费红线：ratio 可以改成 adaptive（定价只看 resolution，与 ratio 无关，已实证），
 * 但 resolution / vquality 一个字都不能动（空值或 "adaptive" 会让前后端双双静默落回 720p 档，
 * 等于按 720p 的价收 1080p 的片）。判据散开就迟早有人把这两件事搞混。
 */
export function videoRatioForcedAdaptive(mode: string, model: string) {
    return videoModeRatioPolicy(mode, model) === "forced_adaptive";
}

/** 该 模式 × 模型 组合要在界面上显示的比例/时长说明。给 UI 用；请求层用上面那两个布尔函数。 */
export function videoModeNotice(mode: string, model: string): VideoModeNotice {
    const ratioPolicy = videoModeRatioPolicy(mode, model);
    const durationPolicy = videoDurationPolicy(mode, model);
    // 时长那句话只有一种情形（视频编辑），但仍走同一张表：界面说的和请求真正做的必须同源。
    const duration =
        durationPolicy === "forced_smart"
            ? { durationPolicy, durationWarning: true, durationHint: "视频编辑的输出时长由源视频决定（上游要求），所选秒数不生效；计费按源视频真实时长结算" }
            : { durationPolicy, durationWarning: false, durationHint: "" };
    if (ratioPolicy === "forced_adaptive") {
        // 「跟谁走」两种模式不一样：首帧/首尾帧跟首帧图，编辑/延长跟源视频。写死一句对另一边就是假话。
        const source = mode === "video_edit" || mode === "video_extend" ? "源视频" : "首帧图";
        return { ratioPolicy, ratioWarning: true, ratioHint: `该模型在此模式下输出比例由${source}决定（上游要求），已自动设为自适应`, ...duration };
    }
    return { ratioPolicy, ratioWarning: false, ratioHint: "", ...duration };
}

/**
 * 当前素材条件下这个模式能不能选。不能选时给出中文原因，界面直接拿去做置灰提示。
 *
 * 素材条件写死在这里而不是各自散在界面里：这是两路（界面置灰 / 请求层钳位）唯一的判据出处，
 * 散开就一定会出现「界面让选、请求层又落回 auto」这种自相矛盾。
 */
export function videoModeAvailable(mode: string, model: string, counts: VideoModeCounts): { ok: boolean; reason?: string } {
    if (!isVideoMode(mode) || !videoModeSupportedBy(model).includes(mode)) return { ok: false, reason: VIDEO_MODE_UNSUPPORTED };
    // auto 永远可选（它就是"不指定"），先短路掉，免得下面的要求表有一天写岔了把它也卡住。
    if (mode === "auto") return { ok: true };
    const got: Record<VideoModeMediaKind, number> = {
        image: Math.max(0, Number(counts?.images) || 0),
        video: Math.max(0, Number(counts?.videos) || 0),
        audio: Math.max(0, Number(counts?.audios) || 0),
    };
    // 判据【只】从 videoModeRequirement 取，不在这里另写一份数字：
    // 界面 tooltip 读的是同一张表，两边同源才不会出现「提示说要 1~2 张、判据其实要 2 张」。
    const requirement = videoModeRequirement(mode, model);
    const label = videoModeLabel(mode);
    const present = requirement.forbidden.filter((kind) => got[kind] > 0);
    if (present.length) {
        const names = present.map(videoMediaKindLabel).join("/");
        return { ok: false, reason: `${label}不能接参考${names}，请先断开参考${names}连线` };
    }
    for (const need of requirement.needs) {
        const total = need.kinds.reduce((sum, kind) => sum + got[kind], 0);
        if (total < need.min || (need.max !== null && total > need.max)) {
            return { ok: false, reason: `${label}需要连接${need.text}，当前 ${total} 个` };
        }
    }
    return { ok: true };
}

/**
 * Seedance 顶层字段 omni_reference_task_type 的取值。与 ratio / duration 平级，不是 content 里的 role。
 * 官方取值：auto / reference / edit / extend（我们不发 auto——不发这个字段就是 auto）。
 */
export type SeedanceOmniTaskType = "reference" | "edit" | "extend";

/**
 * 这一单要不要带 omni_reference_task_type，带什么值。null = 不带这个字段（请求体与改动前逐字节一致）。
 *
 * 🔴 为什么参考生视频也要【显式】发 "reference"：
 *    文档说不发（或设 auto）时，模型会「根据提示词意图」自行判定成参考生视频 / 编辑 / 延长。
 *    而编辑和延长都有「ratio 必须 adaptive」的硬约束 —— 用户在参考生视频里写一句
 *    「把背景改成夜晚」，就可能被判成编辑，然后因为我们发的是 16:9 而异步报错。
 *    显式发 reference 把任务类型钉死。**这一步只锁定、不改行为**：
 *    文档里参考生视频的官方示例配的就是 "ratio":"16:9" + "duration":15，与我们现状一致。
 *
 * ⚠️ 只发给 Seedance 2.5：这是 2.5 的全模态字段，2.0 系列的请求体里没有它，
 *    多发一个不认识的顶层字段可能整单被拒（同一份顾虑见 output_format 那行的处理）。
 *    2.0 上选参考生视频仍然不带这个字段 —— 存量请求形态一个字节都不动。
 */
export function seedanceOmniTaskType(mode: string, model: string): SeedanceOmniTaskType | null {
    if (!isSeedance25Model(model)) return null;
    if (mode === "reference_to_video") return "reference";
    if (mode === "video_edit") return "edit";
    if (mode === "video_extend") return "extend";
    return null;
}

/**
 * 用户【显式表达过「这些素材要怎么用」】的那几档。
 *
 * 它们与「参考生视频」是不同的生成语义（把图当帧 vs 把图当内容参考），
 * 只可能是用户自己点出来的 —— 所以 resolveVideoModeForCounts 一个字都不会替他改。
 * ⚠️ text_to_video 不在这里：它是【没有素材】时的默认值，接了素材就说明它已经不成立了
 *    （videoModeAvailable 也会把它判成不可用：文生视频不能接任何参考素材）。
 */
const VIDEO_MODES_EXPLICIT: readonly VideoMode[] = ["image_to_video", "first_last_frame", "video_edit", "video_extend"];

/**
 * 🔴 按当前接入的参考素材把模式落定成一个【具体值】。这是本轮的核心：**界面上不再有「自动」这一档**。
 *
 * 为什么必须在界面这一层落定，而不是留给上游推断：
 * 上游只能按提示词和素材形态去猜，它看不见用户的意图；老的 auto 还会按【数量】猜出首尾帧来——
 * 接「场景图 + 人物图」两张参考，被判成「从 A 渐变到 B」，语义整个错掉还照样扣钱。
 * 把推导挪到界面上，用户马上看得见结果是「参考生视频」，也随时能改。
 *
 * 规则（就这三条，不要再加戏）：
 *   ① 一个素材都没有        → 文生视频（连显式模式也落回来：没素材它们根本发不出去）
 *   ② 有素材 + 显式模式      → 原样不动（图生 / 首尾帧 / 视频编辑 / 视频延长 = 用户的明确意图）
 *   ③ 有素材 + 其余一切取值  → 参考生视频（auto、空、拼错的值、以及不再成立的「文生视频」都在这）
 *
 * ⚠️ 幂等：resolve(resolve(x)) === resolve(x)。调用点都是「算出来不一样就写回去」的写法，
 *    不幂等会变成写回→重算→再写回的死循环。改这里时务必保持。
 * ⚠️ 返回值一定是【当前模型支持】的模式（videoModeSupportedBy）：
 *    走通用 OpenAI 方言的第三方视频接口只有文生这一档，给它落一个 reference_to_video，
 *    界面会把它灰着显示 —— 不会出现「看到的和发出去的不是一回事」。
 * ⚠️ counts 省略 = 【素材数量未知】，那就只做「把 auto/空/非法归一成默认值」这一步，不按素材推导。
 *    没有调用方该走到这条路上（调用点都有准确的素材数量），它只是给显示层兜底，
 *    宁可显示成默认的「文生视频」，也不要凭空猜一个用户没接的素材数。
 */
export function resolveVideoModeForCounts(current: string | undefined, model: string, counts?: VideoModeCounts): VideoMode {
    const supported = videoModeSupportedBy(model);
    const raw = String(current || "").trim();
    // 当前值要同时满足「是合法枚举」+「这个模型支持」才算数。
    // 其余（空串 / 拼错 / 换模型后不再支持的 / auto）一律当作"没选过"，走下面的推导。
    const mode: VideoMode = isVideoMode(raw) && supported.includes(raw) ? raw : "auto";
    // text_to_video 在两张模型清单里都有，正常回落不到 mode；判一句是防着以后有人改那两张表。
    const textMode: VideoMode = supported.includes("text_to_video") ? "text_to_video" : mode;
    if (!counts) return mode === "auto" ? textMode : mode;
    const total = Math.max(0, Number(counts.images) || 0) + Math.max(0, Number(counts.videos) || 0) + Math.max(0, Number(counts.audios) || 0);
    if (total === 0) return textMode;
    if (VIDEO_MODES_EXPLICIT.includes(mode)) return mode;
    if (supported.includes("reference_to_video")) return "reference_to_video";
    // 这个模型压根没有「参考生视频」这一档（只走文生的第三方 OpenAI 方言接口，模式对它是空转）。
    // ⚠️ 此时也【不能返回 auto】：界面上已经没有那一档，返回它会让模式那一段一个胶囊都不高亮、
    //    按钮上还写着「自动」。退回默认的文生视频，至少显示与可选项是自洽的。
    return mode === "auto" ? textMode : mode;
}

/**
 * 请求层专用：把界面上那个模式落定成【真正要发出去的】模式。
 *
 * 🔴 与 normalizeVideoMode 的区别，也是它存在的全部理由：**素材不满足时抛错，而不是静默落回 auto**。
 *
 * 静默落回长这样：用户选了「图生视频」，随后把参考图从 1 张接成 2 张 —— 按钮上仍然写着「图生视频」，
 * 请求层却把模式悄悄换掉再发出去。那正是本轮要根治的毛病换了个楼层重演：
 * 入口从「让上游猜」变成「前端先把用户的声明扔掉、再让上游猜」。
 * 用户看到的和系统做的是两件事，而且没有任何提示。
 *
 * 现在：
 *   · 用户没显式选过（空 / auto / 拼错 / 该模型不支持）→ 按素材落定（0 素材=文生，有素材=参考生视频），
 *     这是界面上本来就显示着的值，不算替他做决定；
 *   · 用户显式选了图生/首尾帧/视频编辑/视频延长，而素材条件不满足 → **抛出 videoModeAvailable
 *     给的那句现成中文原因**，让他自己决定是改素材还是改模式。
 *
 * ⚠️ 正常情况下这里抛不出来：界面已经按同一套判据把不可选的模式灰掉并写明原因了。
 *    它拦的是竞态、老客户端、以及界面与请求层口径万一分叉的情况——
 *    那种时候宁可当场失败，也不要发一个用户没选过的任务出去（照样扣钱）。
 */
export function resolveVideoModeForRequest(current: string | undefined, model: string, counts: VideoModeCounts): VideoMode {
    const mode = resolveVideoModeForCounts(current, model, counts);
    const raw = String(current || "").trim();
    // 🔴 闸门只对【用户自己点出来的】模式生效，不对推导出来的生效。
    //
    // 这个区别是测出来的，不是想出来的：最初写成「对 mode 一律校验」，
    // 结果那些不支持「参考生视频」的第三方视频模型一接参考图就抛错——
    // 而它们改动前是能用的（参考图照发 input_reference[]，用不用由上游决定，我们不拦）。
    // 那等于我们自己加了一条上游根本没要求的限制，正是本轮要清理的那类"画蛇添足"。
    //
    // 所以：用户没点过 → 推导出什么就发什么，绝不拦；
    //       用户点过图生/首尾帧/编辑/延长而素材不满足 → 抛错，让他自己决定改素材还是改模式，
    //       绝不静默换成另一个模式发出去（那是"按钮写着 A、实际发 B"）。
    const userPicked = isVideoMode(raw) && VIDEO_MODES_EXPLICIT.includes(raw) && videoModeSupportedBy(model).includes(raw);
    if (userPicked) {
        const check = videoModeAvailable(mode, model, counts);
        if (!check.ok) {
            throw new Error(check.reason || `当前参考素材不满足「${videoModeLabel(mode)}」的要求，请调整素材或改选其它模式`);
        }
    }
    return mode;
}

/**
 * 把模式钳回合法值：认不出来的、当前模型不支持的、素材条件不满足的，一律落回 "auto"。
 *
 * 为什么落 auto 而不是报错：auto 就是「不指定模式」，退到这里不会让用户的活干不成。
 * 反过来，拿一个素材对不上的模式去发请求才是真危险——
 * 比如首尾帧只发两张具名图，素材少一张就会把内容【静默丢掉】。
 * ⚠️ 回落成 auto 之后，界面那一侧由 resolveVideoModeForCounts 提前落定成一个具体模式
 *    （没素材=文生、有素材=参考生视频），请求层按同一套判据算，两边口径一致，
 *    用户看到的就是发出去的。
 *
 * counts 省略时只校验「枚举合法 + 模型支持」两项：换模型那一刻（clampVideoConfigForModel）
 * 拿不到参考素材数量，素材条件留给请求层再钳一次。
 */
export function normalizeVideoMode(value: string | undefined, model: string, counts?: VideoModeCounts): VideoMode {
    const mode = String(value || "").trim();
    if (!isVideoMode(mode) || mode === "auto") return "auto";
    if (!videoModeSupportedBy(model).includes(mode)) return "auto";
    if (counts && !videoModeAvailable(mode, model, counts).ok) return "auto";
    return mode;
}

/**
 * 换模型时把「跟着模型走」的配置钳回合法范围。
 *
 * 为什么必须在【换模型的那一刻】钳，而不是只在显示和发请求时钳：
 * config 是全局持久化的，2.5 下把时长拉到 30 再切回 2.0，存的仍是 "30"。
 * 显示层和请求层各自钳过（都会变成 15），但**预估价、写进节点 metadata 的记录、
 * 画布上那个按钮的标签**读的都是原始值 —— 于是界面写着 30 秒、按 30 秒报价，
 * 实际只生成 15 秒，扣费和记录全对不上。一处钳掉，这些读取点就都对了。
 */
export function clampVideoConfigForModel(config: { videoSeconds?: string; vquality?: string; videoOutputFormat?: string; videoMode?: string }, model: string) {
    const patch: { videoSeconds?: string; vquality?: string; videoOutputFormat?: string; videoMode?: string } = {};
    const cap = videoSecondsCap(model);
    const seconds = Math.floor(Number(config.videoSeconds) || 0);
    if (seconds > cap) patch.videoSeconds = String(cap);

    // 分辨率对【所有】视频模型都要钳。
    // 原先这段被关在 isSeedanceVideoModel 里，于是从 2.0 选了 4K 再切到只出 1080P 的模型，
    // 标签一直停在 2160p，而上游只出 1080P —— 用户看到的和拿到的对不上。
    const resolution = clampVideoResolutionForModel(config.vquality || "", model);
    if (resolution !== normalizeResolutionToken(config.vquality || "")) patch.vquality = resolution;

    if (isSeedanceVideoModel(model)) {
        const format = normalizeSeedanceOutputFormat(config.videoOutputFormat || "", model);
        if (format !== (config.videoOutputFormat || "mp4")) patch.videoOutputFormat = format;
    }

    // 模式同理，也必须在【换模型的那一刻】钳。
    // 不钳的话：在 Seedance 2.5 上选了「视频编辑」，切到 2.0（不支持该模式），
    // 界面标签还停在「视频编辑」——这种失配由请求层 resolveVideoModeForRequest 抛错拦下，
    // 不会静默换档发出去，但界面得先自己对上。
    // ⚠️ 这里只按【模型支持】钳，不判素材条件：换模型这一刻拿不到参考素材数量。
    //    素材不满足的情况由请求层的 resolveVideoModeForRequest 再判一次。
    const mode = normalizeVideoMode(config.videoMode, model);
    if (mode !== (config.videoMode || "auto")) patch.videoMode = mode;
    return patch;
}

// 归一化输出格式：模型不支持的一律落回 mp4。
// 和分辨率同理，发请求前必须再钳一遍——用户可能在 2.5 下选了 mov，再切回 2.0 生成。
export function normalizeSeedanceOutputFormat(value: string, model = "") {
    const normalized = String(value || "").trim().toLowerCase() || "mp4";
    return seedanceCapability(model).outputFormats.includes(normalized) ? normalized : "mp4";
}

// seedanceUpstreamResolution 把内部分辨率值映射成上游 API 接受的取值。
// 内部统一用 "2160p"(沿用 480p/720p/1080p 的 Xp 命名,像素映射/归一化都靠它),但上游 4K 的取值是 "4k";
// 其余档(480p/720p/1080p)上游原样接受,直接透传。
export function seedanceUpstreamResolution(resolution: string) {
    return resolution === "2160p" ? "4k" : resolution;
}

export function normalizeSeedanceDuration(value: string, model = "") {
    // 已取消「智能时长(-1)」：旧的 -1 存量值统一自愈成 5 秒，请求层不再向上游发 duration=-1。
    const parsed = Math.floor(Number(value) || 5);
    const seconds = parsed >= 1 ? parsed : 5;
    return Math.max(4, Math.min(seedanceCapability(model).maxDurationSeconds, seconds));
}

export function normalizeSeedanceRatio(value: string) {
    if (!value || value === "auto" || value === "adaptive") return "adaptive";
    if (seedanceRatioOptions.some((item) => item.value === value)) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return "adaptive";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "adaptive";
    const ratio = width / height;
    const options = [
        ["16:9", 16 / 9],
        ["4:3", 4 / 3],
        ["1:1", 1],
        ["3:4", 3 / 4],
        ["9:16", 9 / 16],
        ["21:9", 21 / 9],
    ] as const;
    return options.reduce((best, item) => (Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best), options[0])[0];
}

export function seedancePixelLabel(resolution: string, ratio: string) {
    const normalizedResolution = normalizeSeedanceResolution(resolution) as keyof typeof seedancePixels;
    const normalizedRatio = normalizeSeedanceRatio(ratio) as keyof (typeof seedancePixels)[typeof normalizedResolution] | "adaptive";
    if (normalizedRatio === "adaptive") return "自动匹配";
    return seedancePixels[normalizedResolution][normalizedRatio] || "";
}

/**
 * 比例 → 像素串（"宽x高"）。给「只收宽x高、不认比例串」的通用视频协议（走 OpenAI 方言的那条路）用。
 *
 * 为什么不复用 normalizeSeedanceRatio：它只认 seedanceRatioOptions 里的枚举和 "WxH"，
 * 碰上 "2:3" 这种历史遗留取值（从图片比例表里带过来的）会整个当成 adaptive。
 *
 * 固定取 720p 那一行：这个串只用来表达【比例】，真正的清晰度档走 resolution_name 单发，
 * 拿哪一档的像素来表达比例都一样。
 *
 * 认不出来的取值回退 16:9 的像素串（保持历史行为）；"auto"/"adaptive"/空 由调用方先处理，
 * 不要指望本函数区分「自适应」和「没看懂」。
 */
export function videoSizePixels(value: string): string {
    const table = seedancePixels["720p"];
    const raw = String(value || "").trim().toLowerCase();
    if (/^\d+x\d+$/.test(raw)) return raw; // 已经是像素串，原样用
    const direct = (table as Record<string, string | undefined>)[raw];
    if (direct) return direct;
    // "N:M" 形态（含 2:3 这类不在选项表里的）：按数值找最接近的一档。
    const match = raw.match(/^(\d+)\s*[:：]\s*(\d+)$/);
    const width = Number(match?.[1] || 0);
    const height = Number(match?.[2] || 0);
    if (!width || !height) return table["16:9"];
    const ratio = width / height;
    let best: string = table["16:9"];
    let bestDiff = Infinity;
    for (const pixels of Object.values(table) as string[]) {
        const [w, h] = pixels.split("x").map(Number);
        if (!w || !h) continue;
        const diff = Math.abs(w / h - ratio);
        if (diff < bestDiff) {
            best = pixels;
            bestDiff = diff;
        }
    }
    return best;
}

export function boolConfig(value: string | undefined, fallback: boolean) {
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

export function seedanceReferenceLabel(kind: "image" | "video" | "audio", index: number) {
    if (kind === "image") return `图片${index + 1}`;
    if (kind === "video") return `视频${index + 1}`;
    return `音频${index + 1}`;
}

export function buildSeedancePromptText(prompt: string, images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[]) {
    const labels = [
        ...images.map((image, index) => image.label || seedanceReferenceLabel("image", index)),
        ...videos.map((video, index) => video.label || seedanceReferenceLabel("video", index)),
        ...audios.map((audio, index) => audio.label || seedanceReferenceLabel("audio", index)),
    ];
    const text = prompt.trim();
    if (!labels.length) return text;
    return `参考素材编号：${labels.join("、")}。请按这些编号理解提示词中的图片、视频和音频引用。\n\n${text}`;
}

/**
 * 参考视频的前置校验。
 *
 * mode 影响的是【单条时长区间】，别的不影响：
 *   - 视频编辑（video_edit）：文档原文「参考视频时长必须 4~30 秒」，是硬约束；
 *   - 其余模式：沿用 2 秒下限，上限按模型取（2.0 = 15 秒，2.5 = 30 秒，见 referenceVideoMaxMs）。
 * ⚠️ mode 是【可选】形参且默认 "auto"：不传它的调用点行为与改动前一致。
 */
export function seedanceVideoReferenceError(videos: ReferenceVideo[], model = "", mode: string = "auto") {
    const limits = seedanceCapability(model);
    // 单条时长区间。以前这里上下限都写死 2000/15000，于是 2.5 允许的 20 秒参考视频
    // 在【我们自己这边】就被拒了，用户连试都试不成。
    const minMs = mode === "video_edit" ? 4000 : 2000;
    const maxMs = mode === "video_edit" ? Math.min(30000, limits.referenceVideoMaxMs) : limits.referenceVideoMaxMs;
    const rangeText = `${Math.round(minMs / 1000)}-${Math.round(maxMs / 1000)} 秒`;
    let totalDurationMs = 0;
    if (videos.length > limits.videos) return `参考视频最多 ${limits.videos} 个`;
    for (let index = 0; index < videos.length; index += 1) {
        const video = videos[index];
        const label = seedanceReferenceLabel("video", index);
        if (video.bytes && video.bytes > limits.videoMaxBytes) return `${label} 超过 ${Math.round(limits.videoMaxBytes / 1024 / 1024)}MB，请压缩后再上传`;
        if (video.durationMs) {
            if (video.durationMs < minMs || video.durationMs > maxMs) return `${label} 时长需要在 ${rangeText}之间`;
            totalDurationMs += video.durationMs;
        }
        if (video.width && video.height) {
            if (video.width < 300 || video.width > 6000 || video.height < 300 || video.height > 6000) return `${label} 宽高需要在 300-6000px 之间`;
            const ratio = video.width / video.height;
            if (ratio < 0.4 || ratio > 2.5) return `${label} 宽高比需要在 0.4-2.5 之间`;
            const pixels = video.width * video.height;
            if (pixels < 640 * 640 || pixels > 2206 * 946) return `${label} 像素总量不符合 Seedance 要求，请转成 480p/720p/1080p 后再上传`;
        }
    }
    if (totalDurationMs > limits.referenceVideoTotalMs) return `Seedance 参考视频总时长不能超过 ${Math.round(limits.referenceVideoTotalMs / 1000)} 秒`;
    return "";
}

export const seedanceVideoReferenceHint = "参考视频需为 mp4/mov，H.264/H.265，FPS 24-60；含真人人脸素材请使用火山授权 asset:// 素材。";
