"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { clampVideoConfigForModel } from "@/lib/seedance-video";
import { inferModelKindFromName, isAudioModelName, isImageModelName, isTextModelName, isVideoModelName } from "@/lib/model-kind-rules";
import { persist } from "zustand/middleware";
import { storageKey } from "@/constant/env";

import { apiGet } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";
import type { AdminPublicSettings } from "@/services/api/admin";

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    /** 音频输出采样率(Hz)。各输出格式支持的取值不同，见 lib/audio-generation 的 seedAudioSampleRates。 */
    audioSampleRate: string;
    /** 音频音量 [-50,100]，0=不调整。仅 seed-audio。 */
    audioLoudness: string;
    /** 音频音调 [-12,12]，0=不调整。仅 seed-audio。 */
    audioPitch: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    /** 视频输出封装格式：mp4 / mov（mov 仅 Seedance 2.5 支持） */
    videoOutputFormat: string;
    /**
     * 视频生成模式：text_to_video / image_to_video / first_last_frame / reference_to_video / video_edit / video_extend。
     * 默认 "text_to_video"（文生视频）；接了参考素材会自动落到「参考生视频」，
     * 用户显式选过的图生/首尾帧/编辑/延长一律不动 —— 判据的唯一出处是 lib/seedance-video 的 resolveVideoModeForCounts。
     *
     * 🔴 这里【不再有「自动」这一档】：auto 的语义是「由后端按参考素材数量推断任务类型」，而那正是要根治的毛病——
     *    只要用户不主动去点模式选择器，接两张图就会被推断成「首尾帧」。所以默认值不能是 auto。
     *    但 "auto" 这个取值仍然要能读：存量浏览器里存的就是它（见下面 merge 的处理）。
     *
     * 为什么要让用户显式选：按参考素材【数量】猜任务类型一定会猜错。
     * 「恰好 2 个且全是图片」这种规则会把用户接的「场景图 + 人物图」两张参考，
     * 静默判成「从 A 图渐变到 B 图」的首尾帧任务——语义整个错掉，连输出画幅都跟着首帧图走
     * （首尾帧下上游按首帧图定画幅，我们发的比例会被无视）。
     * 火山 Seedance 本身是按 content[].role 显式声明任务类型的，我们要做的就是把这个声明权交还给用户。
     */
    videoMode: string;
    systemPrompt: string;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    quality: string;
    size: string;
    count: string;
    canvasImageCount: string;
    // 画布级「新建节点默认」：新建图片/视频节点时优先用这些，空则降级到全局 size/quality/vquality。
    // 图片节点默认比例（同 image-settings-panel 的 aspectOptions），默认与 size 一致。
    canvasImageAspect: string;
    // 图片节点默认质量/分辨率档（1k/2k/4k），默认与 quality 一致。
    canvasImageQuality: string;
    // 视频节点默认比例（同 video/seedance 比例档），默认与 size 一致。
    canvasVideoRatio: string;
    // 视频节点默认分辨率（同 video/seedance 分辨率档），默认与 vquality 一致。
    canvasVideoResolution: string;
    // 生成二级确认：开启后点「生成」前弹窗确认是否生成。全局持久化、所有画布通用，默认关闭。
    confirmBeforeGenerate: boolean;
    /** 画布节点下方那个操作面板的宽度（px）。模型名长时 500 装不下会被裁，做成可调而不是写死一个数。 */
    canvasPanelWidth: string;
    /** 该面板里提示词输入框的高度（px）。写长提示词的人希望更高，写短的希望省地方，口味差别很大。 */
    canvasPanelPromptHeight: string;
    // 未使用参考提醒：节点接入了参考素材但提示词里没 @ 引用到时，生成前弹窗提醒。全局持久化，默认开启。
    warnUnusedReferences: boolean;
    // 复制时保留连线：Ctrl+C 复制节点是否一并带上与前后节点的连线。默认开启。
    copyKeepConnections: boolean;
    // 视频生成前自动肖像授权：点「生成」时把接入的参考素材（图/视频/音频）里没认证过的自动送去火山素材授权，
    // 已认证的跳过。默认开启，理由是这件事几乎全是好处：
    //   ① 认证接口不扣费；实际通过率在 99% 以上、中位耗时约 5 秒；
    //   ② 认证过的素材生成时以 asset:// 引用，上游直接解析——省掉「浏览器下载→重新上传」一整圈往返；
    //   ③ 顺带绕开死链：asset:// 不需要浏览器取像素，content 是失效 blob 也不影响；
    //   ④ 含真人的参考视频/音频本来就【必须】先入库，否则被上游 InputVideoSensitiveContentDetected 拒掉。
    // 仍受后端总开关 publicSettings.portraitAsset.enabled 约束：后台没开肖像授权时本开关不起作用。
    autoEnrollPortraits: boolean;
    // 软字段：当前画布所属的项目积分池 ID（非持久化到 config 存储；由画布页按 CanvasProject.projectId 注入）。
    // remote 渠道创建生成任务时透传为 X-Project-ID，让扣费走项目池而非个人积分。
    projectId?: string;
    // 软字段：当前画布的 id（CanvasProject.id；非持久化）。由画布页与 projectId 同处注入。
    // 生成请求透传为 X-Canvas-ID，供后端做画布维度的使用统计。
    canvasId?: string;
    // 软字段：图片节点所选「风格」预设 id（见 lib/image-style-presets）。空=不注入风格。
    // 生成时把该预设的助提示词追加到用户描述后（composeImagePrompt），不改用户原始 prompt/metadata。由节点 metadata 注入。
    imageStyle?: string;
    // 软字段：图片节点所选「视图(排版)」预设 id（如真人三视图）。空=不注入。与 imageStyle 独立、可叠加。
    imageView?: string;
    // 软字段：视频节点所选「风格」预设 id（见 lib/video-style-presets）。空=不注入。
    // 生成时把该预设助提示词追加到用户描述后（composeVideoPrompt），不改用户原始 prompt/metadata。由节点 metadata 注入。
    videoStyle?: string;
    // 软字段：首尾帧模式下「哪张参考图是首帧、哪张是尾帧」（值 = 该参考素材的节点 id；
    // 请求层 frameRoleMatches 对地址型键另留了兼容兜底，见 services/api/video.ts）。
    // 非持久化，由画布节点 metadata.videoFrameRoles 注入；请求层据此给两张参考图分别标上
    // content[].role = first_frame / last_frame。
    // 没指定（或指定的素材已被换掉）时按接入顺序：第一张=首帧、第二张=尾帧——不配置也要能用。
    videoFrameRoles?: { first?: string; last?: string };
};

export const CONFIG_STORE_KEY = storageKey("ai_config_store");
export type ModelCapability = "image" | "video" | "text" | "audio";

export const defaultConfig: AiConfig = {
    // 新用户默认走「分组渠道（远程）」：自动继承分组聚合的可用模型与后台默认模型。
    // 出厂不预置任何模型名，由部署方在后台「分组管理」里配置渠道后生效。
    channelMode: "remote",
    baseUrl: "",
    apiKey: "",
    model: "",
    imageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    audioVoice: "",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    audioSampleRate: "24000",
    audioLoudness: "0",
    audioPitch: "0",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoOutputFormat: "mp4",
    // 默认文生视频（不是"自动"）：接了参考素材时由 resolveVideoModeForCounts 落到「参考生视频」。
    videoMode: "text_to_video",
    systemPrompt: "",
    models: [],
    imageModels: [],
    videoModels: [],
    textModels: [],
    audioModels: [],
    quality: "2k",
    size: "1:1",
    count: "1",
    canvasImageCount: "1",
    canvasImageAspect: "16:9",
    canvasImageQuality: "2k",
    canvasVideoRatio: "9:16",
    canvasVideoResolution: "720",
    confirmBeforeGenerate: false,
    canvasPanelWidth: "620",
    canvasPanelPromptHeight: "96",
    warnUnusedReferences: true,
    copyKeepConnections: true,
    autoEnrollPortraits: true,
};

type ConfigStore = {
    config: AiConfig;
    publicSettings: AdminPublicSettings | null;
    isPublicSettingsLoading: boolean;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    loadPublicSettings: () => Promise<void>;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
    // 软字段（非持久化，partialize 只存 config）：当前画布所属项目池 ID / 画布 ID。由画布页注入，
    // 供 useEffectiveConfig 合并，让不在画布页 effectiveConfig 作用域内的组件（故事板/AI助手等）的
    // 生成请求也带上 X-Project-ID → 扣项目池而非个人（修复文本类生成对项目制账号报「点数不足」）。
    runtimeProjectId?: string;
    runtimeCanvasId?: string;
    setRuntimeProject: (projectId?: string, canvasId?: string) => void;
};

function resolveEffectiveConfig(config: AiConfig, modelChannel: AdminPublicSettings["modelChannel"] | null) {
    const channelMode = modelChannel?.allowCustomChannel ? config.channelMode : "remote";
    if (channelMode === "local" || !modelChannel) return { ...config, channelMode };
    const models = modelChannel.availableModels;
    const textModels = filterModelsByCapability(models, "text");
    const imageModels = filterModelsByCapability(models, "image");
    const videoModels = filterModelsByCapability(models, "video");
    const audioModels = filterModelsByCapability(models, "audio");
    const fallbackTextModel = validDefault(modelChannel.defaultTextModel, textModels) || preferredModel(textModels, isTextModelName);
    const fallbackModel = validDefault(modelChannel.defaultModel, textModels) || fallbackTextModel;
    const fallbackImageModel = validDefault(modelChannel.defaultImageModel, imageModels) || preferredModel(imageModels, isImageModelName);
    const fallbackVideoModel = validDefault(modelChannel.defaultVideoModel, videoModels) || preferredModel(videoModels, isVideoModelName);
    const fallbackAudioModel = preferredModel(audioModels, isAudioModelName);
    return {
        ...config,
        channelMode,
        models,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        model: textModels.includes(config.model) ? config.model : fallbackModel,
        imageModel: imageModels.includes(config.imageModel) ? config.imageModel : fallbackImageModel,
        videoModel: videoModels.includes(config.videoModel) ? config.videoModel : fallbackVideoModel,
        textModel: textModels.includes(config.textModel) ? config.textModel : fallbackTextModel || fallbackModel,
        audioModel: audioModels.includes(config.audioModel) ? config.audioModel : fallbackAudioModel,
        systemPrompt: modelChannel.systemPrompt,
    };
}

function validDefault(model: string, models: string[]) {
    return models.includes(model) ? model : "";
}

function preferredModel(models: string[], predicate: (model: string) => boolean) {
    return models.find(predicate) || "";
}

// 四个名字判据与 inferModelKindFromName 已搬到 @/lib/model-kind-rules
// —— 那里是前端侧的唯一数据源，且与后端 service/model_kind_rules.go 有对拍测试锁死。
// 这里重新导出，保持既有调用点（含后台分级定价页）的导入路径不变。
export { inferModelKindFromName };

// 后台配的模型类型（/api/settings 下发的 modelMetas）。查不到返回 null，由调用方回落名字启发式。
// 这是把「模型是什么类型」从"猜名字"改成"读配置"的入口：管理员在分级定价页标了类型，
// 前端下拉与档位就以那个为准，加新模型不用再动这里的关键词表。
export function modelKindFromConfig(model: string): ModelCapability | null {
    const name = model.trim();
    if (!name) return null;
    const metas = useConfigStore.getState().publicSettings?.modelChannel?.modelMetas;
    if (!metas) return null;
    const hit = metas.find((m) => (m.model || "").trim() === name);
    if (!hit || !hit.kind) return null;
    if (hit.kind === "image" || hit.kind === "video" || hit.kind === "audio" || hit.kind === "text") return hit.kind;
    return null;
}

// 该模型支持的档位（图片=画质档，视频=分辨率档）。返回空数组表示"不限制"，调用方应当全开。
export function modelResolutionsFromConfig(model: string): string[] {
    const name = model.trim();
    if (!name) return [];
    const metas = useConfigStore.getState().publicSettings?.modelChannel?.modelMetas;
    const hit = metas?.find((m) => (m.model || "").trim() === name);
    return hit?.resolutions || [];
}

// 该视频模型的最长出片秒数。0 表示后台没配，调用方应沿用内置能力表/默认值。
export function modelMaxSecondsFromConfig(model: string): number {
    const name = model.trim();
    if (!name) return 0;
    const metas = useConfigStore.getState().publicSettings?.modelChannel?.modelMetas;
    const hit = metas?.find((m) => (m.model || "").trim() === name);
    return hit?.maxSeconds || 0;
}

export function modelMatchesCapability(model: string, capability?: ModelCapability) {
    if (!capability) return true;
    // 配置里标了类型就以配置为准；没标才回落到下面那套关键词启发式（存量模型在管理员补齐前行为不变）。
    const configured = modelKindFromConfig(model);
    if (configured) return configured === capability;
    if (capability === "image") return isImageModelName(model);
    if (capability === "video") return isVideoModelName(model);
    if (capability === "audio") return isAudioModelName(model);
    return isTextModelName(model);
}

export function filterModelsByCapability(models: string[], capability?: ModelCapability) {
    return capability ? models.filter((model) => modelMatchesCapability(model, capability)) : models;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config[modelListKey(capability)];
}

// 用「分组聚合的可用模型」组装出 ModelPicker 能直接用的 config（四类列表齐全），
// 让默认模型设置/故事板选择器无论本地直连还是分组渠道都能列出后台实际配置的模型。
export function buildPickerConfig(base: AiConfig, available: string[]): AiConfig {
    return {
        ...base,
        models: available,
        textModels: filterModelsByCapability(available, "text"),
        imageModels: filterModelsByCapability(available, "image"),
        videoModels: filterModelsByCapability(available, "video"),
        audioModels: filterModelsByCapability(available, "audio"),
    };
}

function modelListKey(capability: ModelCapability) {
    return `${capability}Models` as "imageModels" | "videoModels" | "textModels" | "audioModels";
}

function isAiConfigReady(config: AiConfig, model: string) {
    return Boolean(model.trim()) && (config.channelMode === "remote" || Boolean(config.baseUrl.trim() && config.apiKey.trim()));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            publicSettings: null,
            isPublicSettingsLoading: false,
            isConfigOpen: false,
            shouldPromptContinue: false,
            runtimeProjectId: undefined,
            runtimeCanvasId: undefined,
            setRuntimeProject: (projectId, canvasId) => set({ runtimeProjectId: projectId, runtimeCanvasId: canvasId }),
            updateConfig: (key, value) =>
                set((state) => {
                    const config = { ...state.config, [key]: value };
                    // 换视频模型时，把跟着模型走的配置（时长/分辨率/输出格式/生成模式）钳回新模型的合法范围。
                    // 模式也必须在这一刻钳：火山 Seedance 的 2.0 代支持四种模式、2.5 代多出视频编辑/视频延长两档，
                    // 而走通用 OpenAI 方言的第三方视频接口只有文生一档。在 2.5 上选了「视频编辑」再切到别的模型，
                    // 界面还写着视频编辑、请求层却只能按文生发，又回到「看到的和发出去的对不上」。
                    // ⚠️ 这里【只】按模型支持钳，不判参考素材数量——换模型这一刻拿不到连线信息，
                    //    素材条件由请求层的 normalizeVideoMode(带 counts) 再钳一次。
                    // 不做这一步的话，2.5 下拉到 30 秒再切回 2.0，界面和预估价还停在 30 秒，
                    // 而实际请求只会发 15 秒 —— 用户看到的和真正扣的对不上。
                    if (key === "model" || key === "videoModel") {
                        Object.assign(config, clampVideoConfigForModel(config, String(value || "")));
                    }
                    return { config };
                }),
            loadPublicSettings: async () => {
                if (get().isPublicSettingsLoading) return;
                set({ isPublicSettingsLoading: true });
                try {
                    // 必须带 token：/api/settings 是 OptionalAuth，不带 token 会返回全局设置（分组自治后 availableModels 为空）
                    set({ publicSettings: await apiGet<AdminPublicSettings>("/api/settings", undefined, useUserStore.getState().token) });
                } finally {
                    set({ isPublicSettingsLoading: false });
                }
            },
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config }),
            // v0.2.8 起画布生图默认 1 张，但更早版本默认 3 张的值会被持久化保留。
            // 一次性迁移把存量 canvasImageCount 重置为 1，让默认张数对所有老浏览器也生效。
            version: 1,
            migrate: (persisted) => {
                const state = (persisted || {}) as { config?: AiConfig };
                return {
                    config: state.config ? { ...state.config, canvasImageCount: "1" } : defaultConfig,
                };
            },
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const config = { ...defaultConfig, ...persistedConfig };
                return {
                    ...current,
                    config: {
                        ...config,
                        // 误落到本地直连（local 但从未填自己的 apiKey，本就无法生成）的存量用户切回分组渠道；
                        // 真正自配了 key 的本地用户保留 local。
                        channelMode: config.channelMode === "local" && !config.apiKey?.trim() ? "remote" : config.channelMode || "remote",
                        imageModel: config.imageModel || config.model,
                        videoModel: config.videoModel || "grok-imagine-video",
                        textModel: config.textModel || config.model,
                        audioModel: config.audioModel || defaultConfig.audioModel,
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        audioInstructions: config.audioInstructions || "",
                        audioSampleRate: config.audioSampleRate || defaultConfig.audioSampleRate,
                        audioLoudness: config.audioLoudness || defaultConfig.audioLoudness,
                        audioPitch: config.audioPitch || defaultConfig.audioPitch,
                        videoSeconds: config.videoSeconds || "6",
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "true",
                        videoWatermark: config.videoWatermark || "false",
                        // 与上面几行同理：{...defaultConfig, ...persistedConfig} 只兜「键不存在」，
                        // 兜不住存量浏览器里存成空串的那份 —— 空串会原样盖掉默认值，一路空到请求层。
                        //
                        // 🔴 "auto" 也要在这里换掉：它的语义是「后端按素材数量推断」= 本轮要去掉的那一档，
                        //    存量浏览器里可能存着它，留着等于默认值改了个寂寞。
                        // ⚠️ 这里【只】归一到默认的「文生视频」，不去猜「是不是该给参考生视频」：
                        //    merge 拿不到任何参考素材信息。接了素材的场景由三个调用点的
                        //    resolveVideoModeForCounts 落定（它认得出 auto，也认得出这里落下来的 text_to_video）。
                        videoMode: config.videoMode && config.videoMode !== "auto" ? config.videoMode : defaultConfig.videoMode,
                        canvasImageCount: config.canvasImageCount || "1",
                        canvasImageAspect: config.canvasImageAspect || defaultConfig.canvasImageAspect,
                        canvasImageQuality: config.canvasImageQuality || defaultConfig.canvasImageQuality,
                        canvasVideoRatio: config.canvasVideoRatio || defaultConfig.canvasVideoRatio,
                        canvasVideoResolution: config.canvasVideoResolution || defaultConfig.canvasVideoResolution,
                        canvasPanelWidth: config.canvasPanelWidth || defaultConfig.canvasPanelWidth,
                        canvasPanelPromptHeight: config.canvasPanelPromptHeight || defaultConfig.canvasPanelPromptHeight,
                        imageModels: Array.isArray(persistedConfig.imageModels) ? normalizeModelList(config.imageModels) : filterModelsByCapability(config.models, "image"),
                        videoModels: Array.isArray(persistedConfig.videoModels) ? normalizeModelList(config.videoModels) : filterModelsByCapability(config.models, "video"),
                        textModels: Array.isArray(persistedConfig.textModels) ? normalizeModelList(config.textModels) : filterModelsByCapability(config.models, "text"),
                        audioModels: Array.isArray(persistedConfig.audioModels) ? normalizeModelList(config.audioModels) : filterModelsByCapability(config.models, "audio"),
                    },
                };
            },
        },
    ),
);

function normalizeModelList(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    const modelChannel = useConfigStore((state) => state.publicSettings?.modelChannel || null);
    // 合并画布页注入的项目/画布 ID（非持久化软字段）：让所有用 useEffectiveConfig 的组件
    // （含故事板/AI助手等不在 ccp effectiveConfig 作用域内的）生成请求也带 projectId → 扣项目池。
    const runtimeProjectId = useConfigStore((state) => state.runtimeProjectId);
    const runtimeCanvasId = useConfigStore((state) => state.runtimeCanvasId);
    return useMemo(() => ({ ...resolveEffectiveConfig(config, modelChannel), projectId: runtimeProjectId, canvasId: runtimeCanvasId }), [config, modelChannel, runtimeProjectId, runtimeCanvasId]);
}

// 模型显示代称：从后台 modelCosts/videoModelCosts 的 label 建「模型名→代称」映射(仅显示，不影响 value/调用/扣费)。
export function useModelLabels(): Record<string, string> {
    const channel = useConfigStore((state) => state.publicSettings?.modelChannel);
    return useMemo(() => {
        const map: Record<string, string> = {};
        (channel?.modelCosts || []).forEach((item) => {
            const label = item.label?.trim();
            if (label) map[item.model] = label;
        });
        (channel?.videoModelCosts || []).forEach((item) => {
            const label = item.label?.trim();
            if (label) map[item.model] = label;
        });
        return map;
    }, [channel]);
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}
