"use client";

import { useEffect, type CSSProperties } from "react";
import { Image as ImageIcon, LoaderCircle, MessageSquare, Music2, Play, Settings2, Video } from "@/components/icons";
import { Button, Segmented } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { checkVideoModePromptKeywords, isSeedanceVideoModel, normalizeSeedanceResolution, normalizeVideoMode, resolveVideoModeForCounts, videoModeAvailable, videoSecondsCap } from "@/lib/seedance-video";
import { defaultConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { audioRequestCreditCost, CreditSymbol, requestCreditCost, videoRequestCreditCost } from "@/constant/credits";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "../types";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onComposerToggle: () => void;
};

export function CanvasConfigNodePanel({ node, isRunning, inputSummary, onConfigChange, onGenerate, onComposerToggle }: CanvasConfigNodePanelProps) {
    const globalConfig = useEffectiveConfig();
    const modelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.modelCosts);
    const videoModelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.videoModelCosts);
    const audioModelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.audioModelCosts);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(globalConfig, node, mode);
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    // 接了参考视频(视频生视频)则按「带视频输入」价预估,与后端一致;参考图不算。
    const credits = panelCreditCost({ mode, config, modelCosts, videoModelCosts, audioModelCosts, count, hasVideoInput: inputSummary.videoCount > 0 });
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    // 音频原先只认文本输入（那时候音频生成只有「文本→TTS」一条路）。
    // 音频生成(seed-audio)支持参考音频/参考图片，所以接了参考素材同样算「有输入」。
    //
    // ⚠️ 但音频这条路【必须有文字】：handleGenerateNode 对空提示词的音频模式是直接 return 的
    // （上游 text_prompt 是必填），光接一个图片/音频参考就放开按钮，按钮会变成点了没反应的死键。
    // 所以音频模式要求「有提示词内容，或者接了文本节点」。
    const audioHasText = hasComposerContent || inputSummary.textCount > 0;
    const canGenerate = mode === "audio" ? audioHasText : hasComposerContent || hasAnyInput;
    // 配置节点这条路的参考素材只有【数量】（inputSummary 就是四个计数），模式推导和置灰都只需要数量。
    const referenceCounts = { images: inputSummary.imageCount, videos: inputSummary.videoCount, audios: inputSummary.audioCount };
    // 🔴 模式按素材自动落定：没接素材=文生视频，接了参考素材=参考生视频；
    //    用户显式选过的图生/首尾帧/视频编辑/视频延长不动。推导只有 resolveVideoModeForCounts 一处，
    //    与提示词条那边（canvas-node-prompt-panel）是同一个函数，两条路不会分叉。
    const resolvedVideoMode = resolveVideoModeForCounts(config.videoMode, config.model || config.videoModel, referenceCounts);
    // 写回节点 metadata，让「看到的」就是「发出去的」。
    // ⚠️ 相等就不写：这个面板是每个配置节点的节点体，画布上有几个就渲染几份，
    //    无条件写会把整条画布标脏 + 触发一轮云同步。resolveVideoModeForCounts 幂等，不会来回震荡。
    // ⚠️ 依赖里放的都是原始值（字符串）而不是 referenceCounts 这个对象：
    //    inputSummary 是父组件每次渲染现算的新对象，拿对象当依赖等于每渲染一次就重跑一次。
    useEffect(() => {
        if (mode !== "video" || resolvedVideoMode === config.videoMode) return;
        onConfigChange(node.id, { videoMode: resolvedVideoMode });
    }, [mode, resolvedVideoMode, config.videoMode, node.id, onConfigChange]);
    // 界面各处统一读落定后的值（存量节点存的 "auto" 也在这里变成具体一档；写回是下一拍的事，
    // 这一拍就按落定值显示，免得提示、角标慢一拍才出现）。
    const videoModeValue = mode === "video" ? resolvedVideoMode : "auto";
    // 🔴 视频编辑算不出预估价，不显示数字。理由与 canvas-node-prompt-panel 那一处完全相同：
    //    计费秒数由服务端 ffprobe 探源视频得出，面板这层拿不到，照常算必然显示错的数。
    // ⚠️ 两处判据必须一致，否则同一单在两个面板上显示不同。
    // ⚠️ 必须放在 videoModeValue 之后：写在 credits 那一行旁边会引用到尚未初始化的
    //    resolvedVideoMode（它在下面才声明），是 TDZ 崩溃。
    const creditsUnknown = videoModeValue === "video_edit";
    // 视频编辑 / 视频延长的提示词关键词提醒。这条路的提示词在「组装提示词」里写（composerContent），
    // 没组装过就退回 prompt —— 跟 hasComposerContent 取的是同一份内容，两处判据别分叉。
    // ⚠️ 只提醒、不拦截：它不参与 canGenerate。上游是【前置校验 + 按提示词异步复判】两道关，
    //    复判不一致会在任务跑起来之后报错（那时积分已经扣了），所以值得在这里先说一句。
    const promptKeywordCheck = checkVideoModePromptKeywords(videoModeValue, node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    // 首尾帧的素材条件是【模型相关】的（Seedance 收 1~2 张，别的上游可能只收恰好 2 张），
    // 所以"要不要显示这行说明"也得问 videoModeAvailable，不能在这里自己数张数。
    const frameHintVisible = mode === "video" && videoModeValue === "first_last_frame" && videoModeAvailable("first_last_frame", config.model || config.videoModel, referenceCounts).ok;

    return (
        <div className="flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="shrink-0 text-sm font-semibold">生成配置</div>
                <div className="cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                    <Segmented
                        size="small"
                        className="canvas-config-mode !rounded-full !p-0.5"
                        value={mode}
                        onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode })}
                        options={[
                            {
                                value: "image",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <ImageIcon className="size-3.5" />
                                        生图
                                    </span>
                                ),
                            },
                            {
                                value: "text",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <MessageSquare className="size-3.5" />
                                        文本
                                    </span>
                                ),
                            },
                            {
                                value: "video",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Video className="size-3.5" />
                                        视频
                                    </span>
                                ),
                            },
                            {
                                value: "audio",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="size-3.5" />
                                        音频
                                    </span>
                                ),
                            },
                        ]}
                    />
                </div>
            </div>

            <div className="mb-2 flex flex-wrap gap-1.5">
                <InputChip label="提示词" value={`${inputSummary.textCount} 个`} style={chipStyle} />
                <InputChip label="参考图" value={`${inputSummary.imageCount} 张`} style={chipStyle} />
                <InputChip label="参考视频" value={`${inputSummary.videoCount} 个`} style={chipStyle} />
                <InputChip label="参考音频" value={`${inputSummary.audioCount} 个`} style={chipStyle} />
                <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-[11px] transition hover:brightness-[.97] active:scale-[0.98] dark:hover:brightness-110" style={chipStyle} onMouseDown={(event) => event.stopPropagation()} onClick={onComposerToggle}>
                    <Settings2 className="size-3.5" />
                    组装提示词
                </button>
            </div>

            <div className={`mb-2 grid min-w-0 cursor-default items-center gap-2 ${mode === "image" || mode === "video" || mode === "audio" ? "grid-cols-[minmax(0,1fr)_148px]" : "grid-cols-1"}`} onMouseDown={(event) => event.stopPropagation()}>
                <ModelPicker className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model, ...videoModeSwitchPatch(mode, config, model) })} capability={mode} onMissingConfig={() => openConfigDialog(true)} fullWidth />
                {mode === "video" ? (
                    <CanvasVideoSettingsPopover
                        config={config}
                        placement="topRight"
                        buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2"
                        // 生成模式的「素材条件」灰选、以及模式本身的推导，用的是同一份计数（上面那个 referenceCounts）。
                        referenceCounts={referenceCounts}
                        onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))}
                    />
                ) : mode === "image" ? (
                    <CanvasImageSettingsPopover config={config} placement="topRight" autoAdjustOverflow={false} buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })} />
                ) : mode === "audio" ? (
                    <CanvasAudioSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                ) : null}
            </div>

            {/* 首尾帧：配置节点这条路【只拿得到参考素材的数量】（inputSummary 就是四个计数），拿不到素材本身，
                所以这里做不出「点缩略图角标对调首尾帧」那套交互（那在节点提示词条上，见 canvas-node-prompt-panel）。
                做不了可以，但必须把默认规则说出来——首尾帧搞反了片子是倒着走的，
                而用户在这个面板上完全看不出谁是首、谁是尾，只能靠碰运气。
                接入顺序在「组装提示词」里看得到：那边把参考图按同一顺序编成 图片1 / 图片2。
                ⭐ 1 张图的情况也要说：Seedance 的首尾帧收 1~2 张，1 张 = 只定首帧（请求层只发 role=first_frame）。
                   不说的话用户看不出这张图到底被当成了什么，和「图生视频」完全分不清。 */}
            {frameHintVisible && inputSummary.imageCount >= 2 ? (
                <div className="mb-2 text-[11px] leading-4 opacity-55">首尾帧按参考图的接入顺序取：「组装提示词」里的 图片1 是首帧、图片2 是尾帧。要换首尾请调整接线顺序。</div>
            ) : frameHintVisible && inputSummary.imageCount === 1 ? (
                <div className="mb-2 text-[11px] leading-4 opacity-55">当前 1 张参考图：只作首帧，尾帧由模型续写；再接 1 张即为尾帧。</div>
            ) : null}

            {/* 提示词关键词提醒：这条路的提示词写在「组装提示词」抽屉里，用户回到这个面板才点生成，
                所以提醒挂在生成按钮上方最顺眼。只提醒不拦截，见上面 promptKeywordCheck 的注释。 */}
            {promptKeywordCheck.required && !promptKeywordCheck.ok ? (
                <div className="mb-2 text-[11px] leading-4" style={{ color: "#f59e0b" }}>{promptKeywordCheck.hint}</div>
            ) : null}

            <Button
                type="primary"
                className="hover-lift mt-auto !h-9 !w-full !cursor-pointer !rounded-full"
                disabled={isRunning || !canGenerate}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => onGenerate(node.id)}
            >
                <span className="inline-flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1">
                        <CreditSymbol />
                        {creditsUnknown ? "按源片时长" : credits.toLocaleString()}
                    </span>
                    {isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                    <span>开始生成</span>
                </span>
            </Button>
        </div>
    );
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px]" style={style}>
            <span className="opacity-70">{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? globalConfig.imageModel : mode === "video" ? globalConfig.videoModel : mode === "audio" ? globalConfig.audioModel : globalConfig.textModel;
    return {
        ...globalConfig,
        model: node.metadata?.model || defaultModel || (mode === "audio" ? defaultConfig.audioModel : globalConfig.model || defaultConfig.model),
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        videoOutputFormat: node.metadata?.videoOutputFormat || globalConfig.videoOutputFormat || defaultConfig.videoOutputFormat,
        // 视频生成模式：与上面几行同理，不映射回来的话面板选了模式、下次打开又回到默认值。
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        // 见 canvas-node-prompt-panel 同处注释：漏一行就是「点了没反应」。
        audioSampleRate: node.metadata?.audioSampleRate || globalConfig.audioSampleRate || defaultConfig.audioSampleRate,
        audioLoudness: node.metadata?.audioLoudness || globalConfig.audioLoudness || defaultConfig.audioLoudness,
        audioPitch: node.metadata?.audioPitch || globalConfig.audioPitch || defaultConfig.audioPitch,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

// 换模型时把【模式】钳回新模型支持的范围。
//
// 不钳会怎样：在 Seedance 2.5 上选了「视频编辑」，切到 2.0（那两档是 2.5 专属），
// 节点 metadata 里还留着 video_edit —— 面板把它灰着显示，请求层却按文生发，
// 又是一次「界面显示的和实际发出去的不是一回事」。提示词条那边早就在换模型时钳了
//（videoModelSwitchPatch），这条路一直漏着，2.5 专属模式一开放就会被撞到。
//
// ⚠️ 这里【只】钳 videoMode，不像提示词条那边整份 clampVideoConfigForModel：
//    那个会连 vquality / videoSeconds 一起改，而这两个是计费口径本身（分辨率档挑单价、秒数按秒计价）。
//    本轮不碰钱。这两项在报价(clampedVideoResolution)与请求层各自已有钳位，不钳不会算错账。
// ⚠️ 只按【模型支持】钳，不判参考素材条件：素材是随连线随时变的，
//    把"此刻素材不够"钳进 metadata 会把用户刚选好的模式直接抹掉；那一路由请求层生成时再钳一次。
function videoModeSwitchPatch(mode: CanvasGenerationMode, config: AiConfig, model: string) {
    if (mode !== "video") return {};
    const next = normalizeVideoMode(config.videoMode, model);
    return next === (config.videoMode || "auto") ? {} : { videoMode: next };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    if (key === "audioSampleRate") return { audioSampleRate: value };
    if (key === "audioLoudness") return { audioLoudness: value };
    if (key === "audioPitch") return { audioPitch: value };
    return { audioInstructions: value };
}

// panelCreditCost 三类模式各自的预估价。抽成函数而不是写成嵌套三元：
// bun 1.3.13 对 JSX/常量折叠里的嵌套三元会在构建期 SIGILL（见 lib/audio-generation.ts 同类注释）。
function panelCreditCost(options: {
    mode: CanvasGenerationMode;
    config: AiConfig;
    modelCosts?: Parameters<typeof requestCreditCost>[0]["modelCosts"];
    videoModelCosts?: Parameters<typeof videoRequestCreditCost>[0]["videoModelCosts"];
    audioModelCosts?: Parameters<typeof audioRequestCreditCost>[0]["audioModelCosts"];
    count: number;
    hasVideoInput: boolean;
}) {
    const { mode, config, modelCosts, videoModelCosts, audioModelCosts, count, hasVideoInput } = options;
    if (mode === "video") {
        return videoRequestCreditCost({ channelMode: config.channelMode, modelCosts, videoModelCosts, model: config.model, seconds: clampedVideoSeconds(config), resolution: clampedVideoResolution(config), hasVideoInput });
    }
    if (mode === "audio") {
        // 不传 seconds：界面已不让用户指定时长，按后端默认秒数预扣，出片后结算差额。
        return audioRequestCreditCost({ channelMode: config.channelMode, modelCosts, audioModelCosts, model: config.model });
    }
    if (mode === "image") {
        return requestCreditCost({ channelMode: config.channelMode, modelCosts, model: config.model, count, quality: config.quality });
    }
    return requestCreditCost({ channelMode: config.channelMode, modelCosts, model: config.model, count: 1 });
}

// 预估价必须用【钳过的】时长和分辨率：config 是全局持久化的，2.5 下拉到 30 秒再切回 2.0，
// 存的仍是 30，而实际请求只会发 15 —— 直接拿原始值报价就会「报 30 秒的钱、出 15 秒的片」。
// ⚠️ 取模型必须是 config.model 优先。画布语境下 buildNodeConfig 把【节点上选的模型】放进 config.model，
// 而 config.videoModel 是从 globalConfig 展开来的【全局默认】——顺序写反就会读到全局那个，
// 表现为「节点选了 2.5、滑杆能拉到 30，下面的标签和报价却还按 15 秒算」。
function clampedVideoSeconds(config: AiConfig) {
    const seconds = Math.floor(Number(config.videoSeconds) || 6);
    return String(Math.max(1, Math.min(videoSecondsCap(config.model || config.videoModel), seconds)));
}

function clampedVideoResolution(config: AiConfig) {
    const model = config.model || config.videoModel;
    if (isSeedanceVideoModel(model)) return normalizeSeedanceResolution(config.vquality, model);
    return config.vquality;
}
