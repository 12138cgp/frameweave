"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, BookOpen, Ellipsis, LoaderCircle, Maximize2, Minimize2, RotateCcw, Sparkles, X } from "@/components/icons";
import { Button, Dropdown, Image, message } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { checkVideoModePromptKeywords, clampVideoConfigForModel, isSeedanceVideoModel, normalizeSeedanceResolution, resolveVideoModeForCounts, videoModeAvailable, videoSecondsCap } from "@/lib/seedance-video";
import { optimizePrompt } from "@/services/api/image";
import { defaultConfig, modelMatchesCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { audioRequestCreditCost, CreditSymbol, requestCreditCost, videoRequestCreditCost } from "@/constant/credits";
import { audioTextStats, isSeedAudioModel, seedAudioLimits } from "@/lib/audio-generation";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasStylePopover } from "./canvas-style-popover";
import { CanvasViewPopover } from "./canvas-view-popover";
import { getImageViewPreset } from "@/lib/image-style-presets";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasTemplatePicker } from "./canvas-template-picker";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasMentionComposer, MENTION_TOKEN_PATTERN, type ComposerItem } from "./canvas-mention-composer";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

// 提示词输入字体：默认 PingFang 400 字重偏细，改用更厚实的黑体栈 + 600 字重，读感更实、不发瘦。
// 行高 / 字间距统一放在这份 inline 样式里，textarea 与 @ 高亮 overlay 共用同一来源，避免 Tailwind class
// 与 antd textarea reset 的行高差导致光标错位。
const PROMPT_FONT_STYLE = {
    fontFamily: '"Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", "Heiti SC", system-ui, sans-serif',
    fontWeight: 600,
    lineHeight: 1.5,
    letterSpacing: "0.08em",
} as const;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onImageSettingsOpenChange?: (open: boolean) => void;
    onRemoveReference?: (sourceNodeId: string) => void;
};

export function CanvasNodePromptPanel({ node, isRunning, onConfigChange, onGenerate, mentionReferences = [], onImageSettingsOpenChange, onRemoveReference }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    // 提示词框高度：偏好里可调，越界值一律落回默认，避免存了个 0 或负数把输入框压没。
    const promptBoxHeight = (() => {
        const n = Number(globalConfig.canvasPanelPromptHeight);
        if (!Number.isFinite(n) || n < 60 || n > 400) return 96;
        return Math.round(n);
    })();
    const modelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.modelCosts);
    const videoModelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.videoModelCosts);
    const audioModelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.audioModelCosts);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    // 输入框内容优先用持久化的草稿（promptDraft），生成后与刷新后都不丢；
    // 仅在切换到另一个节点时重置，节点从空变为有内容（生成完成）不清空输入。
    const readNodePrompt = () => node.metadata?.promptDraft ?? (isEditingExistingContent ? "" : node.metadata?.prompt || "");
    const [prompt, setPrompt] = useState(readNodePrompt);
    const [expanded, setExpanded] = useState(false);
    // ✨优化提示词：优化中（防重复点）+ 优化前原文（用于「还原」，按节点维度暂存）
    const [optimizing, setOptimizing] = useState(false);
    const [promptBeforeOptimize, setPromptBeforeOptimize] = useState<string | null>(null);
    // 提示词模板弹层开关：由「⋯更多」下拉菜单项触发（CanvasPromptLibrary 受控渲染弹层、不再内联触发按钮）。
    const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
    // mentionReferences 上游已按当前连接 active 过滤并现算编号（canvas-resource-references.ts），直接映射成 ComposerItem。
    const composerItems = useMemo<ComposerItem[]>(
        () =>
            mentionReferences.map((reference) => ({
                nodeId: reference.nodeId,
                type: reference.kind,
                label: reference.label,
                title: reference.title,
                text: reference.text,
                previewUrl: reference.previewUrl,
            })),
        [mentionReferences],
    );
    // 优化是否由本组件触发：区分「用户手动改输入」与「优化写回」，前者隐藏还原入口
    const optimizedByButton = useRef(false);
    // 本组件上一次写回 metadata 的值：用于区分「自己写回的回流」与「外部改了 metadata」（如叉号删参考抹 token）。
    const lastWrittenRef = useRef<string>(prompt);
    // 接了参考视频(视频生视频)则按「带视频输入」价预估,与后端一致;仅视频参考触发,参考图不算。
    const hasVideoInput = mentionReferences.some((reference) => reference.kind === "video");
    // 生成模式的灰选要按「当前接了什么参考素材」判断（素材条件的唯一出处在 lib/seedance-video 的 videoModeAvailable）。
    const imageReferences = useMemo(() => mentionReferences.filter((reference) => reference.kind === "image"), [mentionReferences]);
    const referenceCounts = useMemo(
        () => ({
            images: imageReferences.length,
            videos: mentionReferences.filter((reference) => reference.kind === "video").length,
            audios: mentionReferences.filter((reference) => reference.kind === "audio").length,
        }),
        [imageReferences, mentionReferences],
    );
    // 🔴 模式按【当前接了什么素材】自动落定：没接素材=文生视频，接了参考素材=参考生视频；
    //    用户显式选过的图生/首尾帧/视频编辑/视频延长一律不动。推导只有 resolveVideoModeForCounts 一处。
    //
    //    为什么要自动落定：「自动」那一档的语义是【后端按参考素材数量推断任务类型】——
    //    用户只要不主动去点模式选择器、随手接两张图，就会被推断成首尾帧
    //    （接「场景图 + 人物图」出一段从 A 渐变到 B 的片子）。
    //    把这一步挪到界面上，用户马上看得见这单是「参考生视频」，也随时能改成别的。
    const resolvedVideoMode = resolveVideoModeForCounts(config.videoMode, config.model || config.videoModel, referenceCounts);
    // 算出来的值要【写回节点 metadata】，不是只在提交时偷偷换：
    // 不写回的话，生成用的是请求层再钳一次的结果，而界面上显示的仍是老值——又变回"隐式推断"。
    // ⚠️ 只在真的不一样时才写：写回会把画布标脏并触发云同步，相等还写就是每开一个节点白同步一次。
    //    resolveVideoModeForCounts 是幂等的（对自己的输出再算一次还是它），所以不会写回→重算→再写回地震荡。
    useEffect(() => {
        if (mode !== "video" || resolvedVideoMode === config.videoMode) return;
        onConfigChange(node.id, { videoMode: resolvedVideoMode });
    }, [mode, resolvedVideoMode, config.videoMode, node.id, onConfigChange]);
    // 首尾帧：参考素材本身是个扁平数组、没有「角色」这回事，所以「哪张是首帧」只能另外记一份。
    // 默认按接入顺序（第一张=首帧、第二张=尾帧）——不配置也必须能用；要换就点缩略图下方的角标对调。
    //
    // ⭐ 1 张图也要挂角标。Seedance 的首尾帧收 1~2 张：「输入 1 张图作为首帧生成视频，
    //    或输入 2 张图分别作为首帧和尾帧」，1 张就是【只定首帧】（请求层只发 role=first_frame）。
    //    这时候不给角标的话，界面看上去和「图生视频」一模一样，用户没法确认这张被当成了首帧。
    // ⚠️ 用 videoModeAvailable 判「这个模式此刻成不成立」，不自己数张数：素材要求是【模型相关】的，
    //    同样是首尾帧，别的上游完全可能只收恰好 2 张（少 1 张直接整单拒收）。
    //    在那种模型下给 1 张图挂个「首帧」角标就是在骗用户。判据只有 lib/seedance-video 那一处。
    // ⚠️ 读 resolvedVideoMode 而不是 config.videoMode：存量节点存的是 "auto"，写回是下一拍的事，
    //    这一拍就按落定后的值走，界面不会闪一下"没有角标"。首尾帧是显式模式、推导不会动它，两者一致。
    const frameRoleBadges = mode === "video" && resolvedVideoMode === "first_last_frame" && videoModeAvailable("first_last_frame", config.model || config.videoModel, referenceCounts).ok;
    // 对调只有两张图时才成立（一张没得调）。
    const frameRolesEditable = frameRoleBadges && imageReferences.length === 2;
    const frameRoles = resolveFrameRoles(node.metadata?.videoFrameRoles, imageReferences);
    const frameRoleOf = (reference: CanvasResourceReference) => {
        if (!frameRoleBadges) return undefined;
        if (reference.nodeId === frameRoles.firstNodeId) return "first" as const;
        // 只有一张图时 resolveFrameRoles 的 lastNodeId 是 undefined，而 reference.nodeId 恒为字符串，
        // 这一行自然不会命中 —— 那张图只会拿到「首帧」角标，不会凭空多出个「尾帧」。
        if (reference.nodeId === frameRoles.lastNodeId) return "last" as const;
        return undefined;
    };
    const swapFrameRoles = () => {
        const nextFirst = imageReferences.find((reference) => reference.nodeId === frameRoles.lastNodeId);
        const nextLast = imageReferences.find((reference) => reference.nodeId === frameRoles.firstNodeId);
        if (!nextFirst || !nextLast) return;
        // 两张都显式写下来：只写 first 的话，下次两张图的接入顺序一变，尾帧又会漂到别的素材上。
        onConfigChange(node.id, { videoFrameRoles: { first: frameRoleKey(nextFirst), last: frameRoleKey(nextLast) } });
    };
    // 选中「首尾帧」的那一刻，就把默认角色（接入顺序：第一张=首帧）显式写进 metadata。
    //
    // 为什么不能让两边各自「按顺序兜底」就算了：界面这边的顺序是【连线顺序】（mentionReferences），
    // 而请求层在提示词里带 @[node:] token 时走的是 buildComposerGenerationContext，
    // 参考图按【token 出现顺序】重排 —— 两个顺序完全可以不一样。于是角标写着「首帧」的那张，
    // 发出去却成了尾帧，片子倒着走，而界面上一点异常都看不出来。
    // 一旦把 nodeId 显式写下来，两边就都按 id 对，谁都不用再猜顺序。
    // ⚠️ 已经有记录就不覆盖（用户可能刚点过对调），所以只在 metadata 里没有这份记录时写。
    // ⚠️ 1 张图也写：写下来的是「这张是首帧」。之后用户再接第二张时，resolveFrameRoles 会认住这条记录，
    //    新接的那张才是尾帧 —— 不写的话两张的先后完全取决于连线顺序，先接的那张可能反而变成尾帧。
    const writeDefaultFrameRoles = (key: keyof AiConfig, value: string) => {
        if (key !== "videoMode" || value !== "first_last_frame") return;
        if (imageReferences.length < 1 || imageReferences.length > 2 || node.metadata?.videoFrameRoles) return;
        const last = imageReferences[1] ? { last: frameRoleKey(imageReferences[1]) } : {};
        onConfigChange(node.id, { videoFrameRoles: { first: frameRoleKey(imageReferences[0]), ...last } });
    };
    // 视频编辑 / 视频延长：上游【除了】看我们显式声明的 omni_reference_task_type，还会再按提示词
    // 复判一次任务类型，判出来不一致就异步报错（InvalidParameter.TaskTypeMismatch）——
    // 那时候积分已经扣了，用户只看到一句英文错误。所以在他写提示词的地方先提醒一句。
    // ⚠️ 只提醒、不拦截：关键词表是文档给的示例不是白名单，强拦会误伤「把画面里的狗换个颜色」
    //    这种明显是编辑、只是没写"替换"二字的写法。判据在 lib/seedance-video，界面不另写一份。
    // 同样读落定后的值：关键词提醒只对视频编辑/延长这两档生效，它们是显式模式、推导不会动，
    // 但存量节点写回前的那一拍也该按落定值判，免得提醒晚一拍出现。
    const promptKeywordCheck = mode === "video" ? checkVideoModePromptKeywords(resolvedVideoMode, prompt) : null;
    // 音频按字数计价：计数、预计时长、积分都随输入实时算，让用户自己看得见有没有超。
    const audioStats = audioTextStats(prompt);
    const credits = promptPanelCreditCost({ mode, config, modelCosts, videoModelCosts, audioModelCosts, hasVideoInput, audioChars: audioStats.chars });
    // 🔴 视频编辑这一档【算不出预估价】，所以不显示数字。
    //
    // 它的计费秒数由服务端 ffprobe 探源视频决定（handler/ai.go videoEditBillingSeconds），
    // 与用户在面板上选的秒数无关——上游硬性要求 duration=-1，那个滑杆对这一档本来就不生效。
    // 照常算就会显示一个【必然错】的数字：选 6 秒、源片 22 秒 → 显示 6×单价，实扣 22×单价。
    //
    // ⚠️ 为什么不干脆按源视频时长算准：面板这一层拿不到源视频的秒数——
    //    CanvasResourceReference 只带 id/kind/label/预览图，没有 durationMs；
    //    而且浏览器读不出 H.265 时，时长要等服务端 ffprobe 回填，那一刻根本没有可信值。
    //    与其显示一个有时准有时错的数，不如显示口径本身。
    const creditsUnknown = mode === "video" && resolvedVideoMode === "video_edit";
    const showAudioCounter = mode === "audio" && isSeedAudioModel(config.model || config.audioModel);

    useEffect(() => {
        const next = readNodePrompt();
        setPrompt(next);
        lastWrittenRef.current = next;
        // 切换节点：清掉上一个节点的还原暂存，避免跨节点误还原
        setPromptBeforeOptimize(null);
        optimizedByButton.current = false;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    // 外部抹改 metadata 正文（叉号删参考时 stripMentionToken 抹掉 @[node:] token）后，让输入框跟着刷新——
    // 只在「持久化值 ≠ 本组件上次写回值」（即真外部改动，非自己写回的回流）且 ≠ 当前 prompt 时同步，避免打字被回流覆盖。
    const persistedPrompt = readNodePrompt();
    useEffect(() => {
        if (persistedPrompt === lastWrittenRef.current) return;
        if (persistedPrompt === prompt) return;
        lastWrittenRef.current = persistedPrompt;
        setPrompt(persistedPrompt);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [persistedPrompt]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        lastWrittenRef.current = value;
        // 用户手动改输入框（非优化写回）后隐藏还原入口
        if (optimizedByButton.current) optimizedByButton.current = false;
        else if (promptBeforeOptimize !== null) setPromptBeforeOptimize(null);
        // 草稿始终持久化；空节点同时维持 prompt 字段的旧行为（重试等流程依赖）
        onConfigChange(node.id, isEditingExistingContent ? { promptDraft: value } : { promptDraft: value, prompt: value });
    };

    // ✨ 优化提示词：用可用文本模型在不改变原意前提下润色，写回输入框，并保留原文可还原
    const handleOptimize = async () => {
        const raw = prompt.trim();
        if (!raw || optimizing) return;
        const textModel = globalConfig.textModel || globalConfig.textModels?.find((m) => modelMatchesCapability(m, "text")) || "";
        if (!textModel || !modelMatchesCapability(textModel, "text")) {
            message.error("当前未配置文本模型，无法优化");
            return;
        }
        setOptimizing(true);
        try {
            // 把 @[node:id] 引用 token 换成稀有占位符再送文本模型润色，避免模型改写 / 吞掉 token；润色回来再还原。
            const { masked, tokens } = maskMentionTokens(raw);
            const optimizedRaw = await optimizePrompt({ ...globalConfig, model: textModel }, masked);
            if (!optimizedRaw) {
                message.error("优化失败，请重试");
                return;
            }
            const optimized = restoreMentionTokens(optimizedRaw, tokens);
            setPromptBeforeOptimize(prompt);
            optimizedByButton.current = true;
            updatePrompt(optimized);
            message.success("提示词已优化");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "优化失败");
        } finally {
            setOptimizing(false);
        }
    };

    const restorePrompt = () => {
        if (promptBeforeOptimize === null) return;
        const original = promptBeforeOptimize;
        setPromptBeforeOptimize(null);
        updatePrompt(original);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        onGenerate(node.id, mode, text);
    };

    // 风格 / 视图：单独成一条横排行（不和缩略图同行→不挤压缩略图，也不占竖向空间）。图片模式显示风格+视图，视频模式显示视频风格。
    const renderStyleRow = () => {
        if (mode === "image") {
            return (
                <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <CanvasStylePopover
                        value={config.imageStyle || ""}
                        placement="bottomLeft"
                        buttonClassName="!h-7 !min-w-0 !max-w-[150px] !justify-start !rounded-full !px-2.5"
                        onChange={(id) => onConfigChange(node.id, { imageStyle: id })}
                        onOpenChange={onImageSettingsOpenChange}
                    />
                    <CanvasViewPopover
                        value={config.imageView || ""}
                        placement="bottomLeft"
                        buttonClassName="!h-7 !min-w-0 !max-w-[168px] !justify-start !rounded-full !px-2.5"
                        onChange={(id) => {
                            // 选中视图时，若该视图带推荐比例(如三视图 16:9)，同时把图片比例设上去。
                            const aspect = getImageViewPreset(id)?.aspect;
                            onConfigChange(node.id, aspect ? { imageView: id, size: aspect } : { imageView: id });
                        }}
                        onOpenChange={onImageSettingsOpenChange}
                    />
                    {/* 填空模板：和风格/视图并排，放在用户真正写提示词的地方 ——
                        只挂在提示词模板页里的话，用户基本不会专门跑去看。 */}
                    <CanvasTemplatePicker
                        currentPrompt={prompt}
                        buttonClassName="!h-7 !min-w-0 !justify-start !rounded-full !px-2.5"
                        onInsert={updatePrompt}
                        onOpenChange={onImageSettingsOpenChange}
                    />
                </div>
            );
        }
        if (mode === "video") {
            return (
                <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <CanvasStylePopover
                        kind="video"
                        value={config.videoStyle || ""}
                        placement="bottomLeft"
                        buttonClassName="!h-7 !min-w-0 !max-w-[150px] !justify-start !rounded-full !px-2.5"
                        onChange={(id) => onConfigChange(node.id, { videoStyle: id })}
                        onOpenChange={onImageSettingsOpenChange}
                    />
                    {/* 角标本身在缩略图上，但缩略图小、角标更小，不说一句没人会去点它。
                        只接 1 张图时没什么可对调的，改说清楚这张图的去向——否则界面看着和「图生视频」没区别。 */}
                    {frameRolesEditable ? (
                        <span className="text-[11px] leading-4 opacity-55">点参考图下方的「首帧 / 尾帧」可对调</span>
                    ) : frameRoleBadges ? (
                        <span className="text-[11px] leading-4 opacity-55">当前 1 张参考图：只作首帧，尾帧由模型续写；再接 1 张即为尾帧</span>
                    ) : null}
                </div>
            );
        }
        return null;
    };

    // 提示词框底下那一行提醒。放在输入框【下方】而不是上方：用户是边写边看的，
    // 写完一句抬眼就能看见，提示也随着他补上关键词而立刻消失（含关键词就不提示）。
    const renderPromptNotice = () =>
        promptKeywordCheck && !promptKeywordCheck.ok ? (
            <div className="mt-1.5 text-[11px] leading-4" style={{ color: "#f59e0b" }}>
                {promptKeywordCheck.hint}
            </div>
        ) : null;

    const renderControls = () => (
        <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
            {/* overflow-hidden 兜底：内部按钮收缩到极限后也不允许溢出压到右侧生成按钮 */}
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                {/* 「⋯更多」下拉：收纳「优化」「提示词模板」，给控件行让出空间。提示词模板弹层由受控的 CanvasPromptLibrary 渲染。 */}
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    menu={{
                        items: [
                            {
                                key: "optimize",
                                disabled: optimizing || !prompt.trim(),
                                icon: optimizing ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />,
                                label: "优化",
                                onClick: () => void handleOptimize(),
                            },
                            {
                                key: "prompt-library",
                                icon: <BookOpen className="size-4" />,
                                label: "提示词模板",
                                onClick: () => setPromptLibraryOpen(true),
                            },
                        ],
                    }}
                >
                    <Button className="hover-lift !h-10 shrink-0 !rounded-full" aria-label="更多" title="更多" icon={<Ellipsis className="size-4" />} />
                </Dropdown>
                {promptBeforeOptimize !== null ? (
                    <Button
                        className="hover-lift !h-10 shrink-0 !rounded-full !px-3"
                        disabled={optimizing}
                        onClick={restorePrompt}
                        title="还原为优化前的提示词"
                        aria-label="还原提示词"
                        icon={<RotateCcw className="size-4" />}
                    >
                        还原
                    </Button>
                ) : null}
                {mode === "image" ? (
                    <>
                        <ModelPicker className="min-w-0 shrink" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} />
                        {/* 画质 / 尺寸 / 张数 合并成一个按钮，与视频节点同款：折叠摘要（2K · 1:1 · 1 张），
                            点开是完整面板。三个独立胶囊会把提示词框挤没，信息密度也低。
                            这个合并组件早就有了（Config 节点一直在用），画布节点这边之前没接上。
                            ⚠️ 张数在 AiConfig 里是 string、在旧的 CanvasCountPopover 里是 number，
                               合并后统一走 string，写回 metadata 时按 count 单独转回数字（与 Config 节点同款）。 */}
                        <CanvasImageSettingsPopover
                            config={config}
                            placement="topLeft"
                            buttonClassName="!h-10 shrink-0 !rounded-full !px-3"
                            onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                            onOpenChange={onImageSettingsOpenChange}
                        />
                    </>
                ) : mode === "video" ? (
                    <>
                        <ModelPicker className="min-w-0 shrink" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model, ...videoModelSwitchPatch(config, model) })} capability="video" onMissingConfig={() => openConfigDialog(true)} />

                        {/* 模式 / 比例 / 清晰度 / 时长 / 音频 全部合并成【一个】按钮：
                            折叠时摘要显示关键信息（参考生视频 · 16:9 · 720P · 5s · 🔊），点开是完整面板。
                            原先是三个独立胶囊，节点窄的时候会把提示词框挤没，信息密度也低；
                            而且模式在这个面板里本来就有一段，单独再放一个按钮等于同一件事两个入口。
                            ⚠️ 默认档（文生视频）不在摘要里占位 —— 见 videoModePrefix，
                               天天挂一句"文生视频"只会把后面几段挤掉。 */}
                        <CanvasVideoSettingsPopover
                            config={config}
                            placement="topLeft"
                            buttonClassName="!h-10 shrink-0 !rounded-full !px-3"
                            referenceCounts={referenceCounts}
                            onConfigChange={(key, value) => {
                                onConfigChange(node.id, videoConfigPatch(key, value));
                                // 选中首尾帧时顺手把默认角色落成显式的 nodeId，免得界面顺序与请求层顺序各猜各的。
                                // ⚠️ 这个副作用原先挂在独立的模式按钮上，并按钮时必须跟着搬过来，漏了首尾帧就会"发反"。
                                writeDefaultFrameRoles(key, value);
                            }}
                        />
                    </>
                ) : mode === "audio" ? (
                    <>
                        <ModelPicker className="min-w-0 shrink" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} />
                        <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !min-w-0 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                    </>
                ) : (
                    <ModelPicker className="min-w-0 shrink" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} />
                )}
                {showAudioCounter ? <AudioTextCounter stats={audioStats} theme={theme} /> : null}
            </div>
            <Button
                type="primary"
                className="hover-lift !h-8 shrink-0 !rounded-full !px-2.5"
                disabled={isRunning || !prompt.trim() || (showAudioCounter && audioStats.overLimit)}
                onClick={submit}
                aria-label="生成"
            >
                <span className="flex items-center gap-1">
                    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums">
                        <CreditSymbol />
                        {creditsUnknown ? "按源片时长" : credits.toLocaleString()}
                    </span>
                    {isRunning ? <LoaderCircle className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
                </span>
            </Button>
        </div>
    );

    return (
        <>
            {/* 提示词模板弹层只渲染一份（受控）：避免主面板与展开 modal 两处 renderControls 各挂一个弹层导致双开。 */}
            <CanvasPromptLibrary onSelect={updatePrompt} open={promptLibraryOpen} onOpenChange={setPromptLibraryOpen} />
            <div
                className="anim-pop rounded-2xl border p-3 shadow-[0_18px_54px_rgba(15,23,42,.16)] backdrop-blur dark:shadow-[0_18px_54px_rgba(0,0,0,.5)]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
            >
                {/* 提示词框上方一行：左为该节点参考节点的预览缩略图，右为展开按钮（移出文本框，避免缩放下点不到/被遮挡） */}
                <div className="mb-2 flex items-center gap-2">
                    <div className="thin-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
                        {mentionReferences.map((reference) => (
                            <ReferenceThumb key={reference.id} reference={reference} theme={theme} frameRole={frameRoleOf(reference)} onSwapFrameRole={frameRolesEditable ? swapFrameRoles : undefined} onRemove={onRemoveReference ? () => onRemoveReference(reference.nodeId) : undefined} />
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={() => setExpanded(true)}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg opacity-65 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                        aria-label="展开编辑"
                        title="展开编辑"
                    >
                        <Maximize2 className="size-4" />
                    </button>
                </div>
                {renderStyleRow()}
                <CanvasMentionComposer
                    value={prompt}
                    items={composerItems}
                    onChange={updatePrompt}
                    onSubmit={submit}
                    className="rounded-xl border px-3 py-2 text-sm transition-colors"
                    /* 高度来自「配置与用户偏好」，默认 96（原先写死 h-24）。写长提示词的人要更高、写短的要省地方。 */
                    style={{ height: promptBoxHeight, background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text, ...PROMPT_FONT_STYLE }}
                    placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent)}
                />
                {renderPromptNotice()}
                {renderControls()}
            </div>
            {expanded
                ? createPortal(
                      <div className="anim-fade fixed inset-0 z-[200] flex items-center justify-center bg-[#0D1526]/55 p-6 backdrop-blur-[2px]" onMouseDown={() => setExpanded(false)} onPointerDown={() => setExpanded(false)}>
                          <div
                              className="anim-pop flex h-[80vh] w-[880px] max-w-[92vw] flex-col rounded-2xl border p-3 shadow-[0_24px_72px_rgba(15,23,42,.22)] dark:shadow-[0_24px_72px_rgba(0,0,0,.6)]"
                              style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                              onMouseDown={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                              onWheel={(event) => event.stopPropagation()}
                          >
                              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                                  <div className="thin-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto">
                                      {mentionReferences.length ? (
                                          mentionReferences.map((reference) => <ReferenceThumb key={reference.id} reference={reference} theme={theme} frameRole={frameRoleOf(reference)} onSwapFrameRole={frameRolesEditable ? swapFrameRoles : undefined} onRemove={onRemoveReference ? () => onRemoveReference(reference.nodeId) : undefined} />)
                                      ) : (
                                          <span className="font-heading text-sm font-medium tracking-wide opacity-80">编辑提示词</span>
                                      )}
                                  </div>
                                  <button
                                      type="button"
                                      onClick={() => setExpanded(false)}
                                      className="inline-flex size-7 items-center justify-center rounded-md opacity-70 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                                      style={{ color: theme.node.text }}
                                      aria-label="收起"
                                      title="收起"
                                  >
                                      <Minimize2 className="size-4" />
                                  </button>
                              </div>
                              {renderStyleRow()}
                              <div className="relative min-h-0 flex-1">
                                  <CanvasMentionComposer
                                      value={prompt}
                                      items={composerItems}
                                      onChange={updatePrompt}
                                      onSubmit={submit}
                                      className="h-full rounded-xl border px-3 py-2 text-sm"
                                      style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text, ...PROMPT_FONT_STYLE }}
                                      placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent)}
                                  />
                              </div>
                              {/* 展开编辑这条路也要有：用户多半是在这里写长提示词的，
                                  只在小面板上提醒等于提醒了个寂寞。 */}
                              {renderPromptNotice()}
                              {renderControls()}
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}

// 参考节点预览缩略图：图片节点显示封面，其它类型显示序号标签；左上角角标显示序号（图1/视频1…）
// frameRole 有值时底部多一条「首帧 / 尾帧」角标（首尾帧模式下由调用方传入：Seedance 收 1~2 张，
// 1 张时只有一个「首帧」角标且不可点，2 张时两个角标都可点，点一下对调）。
function ReferenceThumb({ reference, theme, frameRole, onSwapFrameRole, onRemove }: { reference: CanvasResourceReference; theme: (typeof canvasThemes)["light"]; frameRole?: "first" | "last"; onSwapFrameRole?: () => void; onRemove?: () => void }) {
    const [preview, setPreview] = useState(false);
    const isImage = reference.kind === "image" && Boolean(reference.previewUrl);
    return (
        <div
            className="group/thumb relative size-14 shrink-0 overflow-hidden rounded-lg border"
            style={{ borderColor: theme.node.stroke, background: theme.node.fill }}
            title={reference.title}
        >
            {isImage ? (
                <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={reference.previewUrl}
                        alt={reference.label}
                        className="size-full cursor-zoom-in object-cover"
                        onClick={(event) => {
                            event.stopPropagation();
                            setPreview(true);
                        }}
                    />
                    <Image
                        src={reference.previewUrl}
                        alt={reference.label}
                        style={{ display: "none" }}
                        preview={{ open: preview, src: reference.previewUrl, onOpenChange: (open) => !open && setPreview(false) }}
                    />
                </>
            ) : (
                <div className="flex size-full items-center justify-center px-1 text-center text-[10px] leading-tight opacity-70">{reference.label}</div>
            )}
            <span className="absolute left-0 top-0 rounded-br-md bg-black/55 px-1 text-[9px] font-medium leading-tight text-white">{reference.label}</span>
            {/* 首尾帧角标：点一下就把首尾对调。不给这个入口的话，用户只能靠改连线顺序去碰运气，
                而顺序对不对又完全看不出来——首尾帧搞反了片子是倒着走的。
                ⚠️ 只接 1 张图时（Seedance 允许，= 只定首帧）没有可对调的对象，调用方不传 onSwapFrameRole，
                   这里就退化成一块纯展示的角标：还是要让用户看见"这张被当成首帧"，
                   但不能画成可点的样子——点了没反应比没得点更糟。 */}
            {frameRole && onSwapFrameRole ? (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onSwapFrameRole();
                    }}
                    className="absolute inset-x-0 bottom-0 cursor-pointer bg-black/65 py-px text-center text-[9px] font-medium leading-tight text-white transition hover:bg-black/85"
                    title="点击对调首帧 / 尾帧"
                >
                    {frameRole === "first" ? "首帧" : "尾帧"}
                </button>
            ) : frameRole ? (
                // 角色文案与上面那个按钮分支共用同一条判断，不写死「首帧」：
                // 现在只有 1 张图会落到这里（所以恒为首帧），但写死就等于把这个前提焊进了界面，
                // 哪天有别的场景传 frameRole 而不传 onSwapFrameRole，这里会一本正经地把尾帧标成首帧。
                <span className="absolute inset-x-0 bottom-0 bg-black/65 py-px text-center text-[9px] font-medium leading-tight text-white" title={frameRole === "first" ? "这张参考图作首帧" : "这张参考图作尾帧"}>
                    {frameRole === "first" ? "首帧" : "尾帧"}
                </span>
            ) : null}
            {/* 右上角叉号：hover 时显示，点击移除这条参考（删掉源节点→当前节点的连线） */}
            {onRemove ? (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onRemove();
                    }}
                    className="absolute right-0 top-0 hidden size-5 items-center justify-center rounded-bl-md rounded-tr-lg bg-black/60 text-white transition hover:bg-red-600 group-hover/thumb:flex"
                    aria-label="移除参考"
                    title="移除参考"
                >
                    <X className="size-3.5" strokeWidth={3} />
                </button>
            ) : null}
        </div>
    );
}

// 首尾帧角色的存储键：**存节点 id**，不存素材地址。
//
// 键写进 metadata.videoFrameRoles，请求层 services/api/video.ts 的 frameRoleMatches 拿它比四个字段
// （image.id = 节点 id / image.dataUrl = 水合前的 content / image.sourceUrl / image.url = asset:// uri），
// 所以两种键它都认得。但两者的稳定性差了一截：
//   ⚠️ 地址型的键天然会失配——图片自愈换链、blob 重建、肖像授权换成 asset:// 都会换地址，
//      一失配就静默落回接入顺序，用户点过的「对调首尾帧」等于白点，而界面上看不出任何异常，
//      直到片子倒着放才发现。节点 id 在这条画布里从生到死都不变，比对是稳的。
// （nodeId 在 CanvasResourceReference 上是必填 string，不需要再兜一层回退，兜了反而会让返回类型变成
//   string | undefined —— 两边都 undefined 时 `===` 恰好成立，会把没配过角色的素材误判成配过。）
function frameRoleKey(reference: CanvasResourceReference) {
    return reference.nodeId;
}

// 解析「哪张是首帧、哪张是尾帧」：先按存下来的键找，找不到（没配置过 / 地址变了 / 换了素材）就落回接入顺序。
function resolveFrameRoles(saved: { first?: string; last?: string } | undefined, images: CanvasResourceReference[]) {
    const savedLast = images.find((item) => frameRoleKey(item) === saved?.last);
    const first = images.find((item) => frameRoleKey(item) === saved?.first) || images.find((item) => item.nodeId !== savedLast?.nodeId);
    const last = images.find((item) => item.nodeId !== first?.nodeId);
    return { firstNodeId: first?.nodeId, lastNodeId: last?.nodeId };
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
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
        // ⚠️ 新增字段必须一起映射回来。少一行的后果不是「用不了」而是「点了没反应」：
        // 面板的选中态都读 config，而 onConfigChange 写的是 node.metadata——
        // 两边不接通的话，模式面板选了就永远读不回来，请求里也一直是默认值。
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        // ⚠️ 新增字段必须一起映射回来。少一行的后果不是「用不了」而是「点了没反应」：
        // 面板的选中态和输入框都读 config，而 onConfigChange 写的是 node.metadata——
        // 两边不接通的话，写进去的值永远读不回来，请求里也一直是默认值。
        audioSampleRate: node.metadata?.audioSampleRate || globalConfig.audioSampleRate || defaultConfig.audioSampleRate,
        audioLoudness: node.metadata?.audioLoudness || globalConfig.audioLoudness || defaultConfig.audioLoudness,
        audioPitch: node.metadata?.audioPitch || globalConfig.audioPitch || defaultConfig.audioPitch,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
        // 风格预设 id：取节点 metadata，供设置面板回显高亮。
        imageStyle: node.metadata?.imageStyle || "",
        imageView: node.metadata?.imageView || "",
        videoStyle: node.metadata?.videoStyle || "",
        // 首尾帧角色：面板要靠它高亮出「哪张是首帧」，不映射回来角标就永远停在默认的接入顺序上。
        videoFrameRoles: node.metadata?.videoFrameRoles,
    };
}

function promptPlaceholder(mode: CanvasNodeGenerationMode, hasImageContent: boolean, hasTextContent: boolean) {
    if (mode === "video") return "描述要生成的视频内容";
    if (mode === "audio") return "描述要生成的音频内容";
    if (mode === "image") return hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
}

/**
 * 换视频模型时，把「跟着模型走」的配置（时长 / 分辨率 / 输出格式）一并钳回新模型的合法范围。
 *
 * 为什么节点这条路必须单独处理：全局配置走 useConfigStore.updateConfig，那里已经调了
 * clampVideoConfigForModel；但画布节点上的模型下拉是直接写 node.metadata 的，
 * 原先只写 { model } —— 于是「2.0 选 4K → 切到 2.5」之后，
 * 节点上的分辨率标签还停在 2160p，而实际出片和扣费都按新模型的上限走。
 * （用户实际报障就是这个形状。同一类问题在时长上也出现过，当时只补了全局那条路。）
 *
 * 返回的键要从 AiConfig 命名翻成 node.metadata 命名，所以逐个过一遍 videoConfigPatch
 * （videoSeconds → seconds 这类映射就在那里）。
 */
function videoModelSwitchPatch(config: AiConfig, model: string) {
    const clamped = clampVideoConfigForModel({ ...config, model }, model);
    const patch: Partial<CanvasNodeData["metadata"]> = {};
    for (const [key, value] of Object.entries(clamped)) {
        if (value === undefined) continue;
        Object.assign(patch, videoConfigPatch(key as keyof AiConfig, String(value)));
    }
    return patch;
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

// AudioTextCounter 音频按字数计价时的实时计数器：只显示「已用字数 / 上限」。
//
// 刻意【不显示预计时长】——那个数是按语速折算出来的估算值，摆在界面上会被当成承诺。
// 但超长预警保留：文本读完超过上游 120 秒出片上限时，上游会回一个用户看不懂的
// DurationOutOfRange，而字数计数器本身看不出来（中文约 450 字就会撞线，离 2000 字的上限还很远）。
// 所以这里只把数字标黄 + 一句不带具体秒数的提示，不拦（估算不该拦人）。
function AudioTextCounter({ stats, theme }: { stats: ReturnType<typeof audioTextStats>; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    // 显式标 string：theme.node.muted 是字面量联合类型，不标的话下面两个告警色赋不进去。
    let color: string = theme.node.muted;
    if (stats.overDuration) color = "#f59e0b";
    if (stats.overLimit) color = "#d4380d";
    let hint = "";
    if (stats.overDuration) hint = "　文本较长，可能被上游拒收";
    let title = "按每 100 字 1 档计费，不足 100 字按 100 字算";
    if (stats.overDuration) title = `文本较长：读完可能超过上游 ${seedAudioLimits.maxSeconds} 秒的出片上限而被拒，建议分段生成`;
    return (
        <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums" style={{ color }} title={title}>
            {stats.chars}/{seedAudioLimits.maxTextPrompt} 字{hint}
        </span>
    );
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

// promptPanelCreditCost 各模式的预估价。抽成函数而不是嵌套三元——bun 1.3.13 对嵌套三元
// 会在构建期 SIGILL（本项目已知坑）。音频那条按「目标时长 × 每秒单价」估，与后端预扣同口径。
function promptPanelCreditCost(options: {
    mode: CanvasGenerationMode;
    config: AiConfig;
    modelCosts?: Parameters<typeof requestCreditCost>[0]["modelCosts"];
    videoModelCosts?: Parameters<typeof videoRequestCreditCost>[0]["videoModelCosts"];
    audioModelCosts?: Parameters<typeof audioRequestCreditCost>[0]["audioModelCosts"];
    hasVideoInput: boolean;
    audioChars?: number;
}) {
    const { mode, config, modelCosts, videoModelCosts, audioModelCosts, hasVideoInput, audioChars } = options;
    if (mode === "video") {
        return videoRequestCreditCost({ channelMode: config.channelMode, modelCosts, videoModelCosts, model: config.model, seconds: clampedVideoSeconds(config), resolution: clampedVideoResolution(config), hasVideoInput });
    }
    if (mode === "audio") {
        // 不传 seconds：界面已不让用户指定时长，按后端默认秒数预扣，出片后结算差额。
        return audioRequestCreditCost({ channelMode: config.channelMode, modelCosts, audioModelCosts, model: config.model, chars: audioChars });
    }
    if (mode === "image") {
        return requestCreditCost({ channelMode: config.channelMode, modelCosts, model: config.model, count: config.count, quality: config.quality });
    }
    return requestCreditCost({ channelMode: config.channelMode, modelCosts, model: config.model, count: 1 });
}

// 把每个 @[node:id] token 换成稀有占位符 〖REF{n}〗，记录原 token 串以便润色后还原。
// MENTION_TOKEN_PATTERN 带 /g，每次用前复位 lastIndex，避免跨调用的状态污染。
function maskMentionTokens(value: string) {
    const tokens: string[] = [];
    MENTION_TOKEN_PATTERN.lastIndex = 0;
    const masked = value.replace(MENTION_TOKEN_PATTERN, (token) => {
        const placeholder = `〖REF${tokens.length}〗`;
        tokens.push(token);
        return placeholder;
    });
    return { masked, tokens };
}

// 还原占位符为原 token；模型若吞掉了某些占位符（缺失），把对应 token 追加到结尾兜底，保证引用不丢。
function restoreMentionTokens(value: string, tokens: string[]) {
    let restored = value;
    const missing: string[] = [];
    tokens.forEach((token, index) => {
        const placeholder = `〖REF${index}〗`;
        if (restored.includes(placeholder)) restored = restored.split(placeholder).join(token);
        else missing.push(token);
    });
    return missing.length ? `${restored.trimEnd()} ${missing.join(" ")}` : restored;
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
