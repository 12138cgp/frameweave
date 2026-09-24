"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App, Dropdown, Modal, Segmented, Tooltip } from "antd";
import { BadgeCheck, Download, Ellipsis, FolderPlus, Image as ImageIcon, Info, LoaderCircle, MessageSquare, Minus, Music2, Pencil, Plus, RefreshCw, ScanFace, Scissors, Settings2, Star, Trash2, TriangleAlert, Upload, Users, Video } from "@/components/icons";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes, getDataUrlByteSize } from "@/lib/image-utils";
import { useCopyText } from "@/hooks/use-copy-text";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { fetchTraceCgt } from "@/services/api/trace-cgt";
import { useThemeStore } from "@/stores/use-theme-store";
import { CreditSymbol, requestCreditCost } from "@/constant/credits";
import { useMediaUplink } from "@/hooks/use-media-uplink";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "../types";
import { getTypeLabel } from "../utils/node-naming";
import type { VideoFrameTarget } from "@/lib/video-frame";
import { ImageToolSettingsModal, type ImageToolbarSettingsTool } from "./canvas-image-toolbar-settings-modal";
import { IMAGE_QUICK_TOOLS_STORAGE_KEY, buildImageToolbarTools, defaultImageQuickToolIds, migrateImageQuickToolsConfig, readImageQuickToolsConfig, pickDenoiseModels, type DenoiseVariant, type ImageQuickToolId } from "./canvas-image-toolbar-tools";

type CanvasNodeHoverToolbarProps = {
    node: CanvasNodeData | null;
    viewport: ViewportTransform;
    // 画布可视区尺寸：用于把工具栏夹在视口内，避免极端缩放/平移时被 section 的 overflow-hidden 裁掉
    viewportSize?: { width: number; height: number };
    onKeep: (nodeId: string) => void;
    onLeave: () => void;
    // 工具栏内的下拉菜单开合。父组件要据此冻结工具栏的显示/隐藏，见 toolbarMenuOpenRef。
    onMenuOpenChange?: (open: boolean) => void;
    onInfo: (node: CanvasNodeData) => void;
    onEditText: (node: CanvasNodeData) => void;
    onDecreaseFont: (node: CanvasNodeData) => void;
    onIncreaseFont: (node: CanvasNodeData) => void;
    onToggleDialog: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onUpload: (node: CanvasNodeData) => void;
    onCaptureFrame: (node: CanvasNodeData, target: VideoFrameTarget) => void;
    onExtractAudio: (node: CanvasNodeData) => void;
    onTrimAudio: (node: CanvasNodeData) => void;
    onAddToGroup: (node: CanvasNodeData) => void;
    onDownload: (node: CanvasNodeData) => void;
    onSaveAsset: (node: CanvasNodeData) => void;
    onMaskEdit: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onAnnotate: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onSuperResolve: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onNineGrid: (node: CanvasNodeData) => void;
    onDenoiseRepaint: (node: CanvasNodeData, variant: DenoiseVariant) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onReversePrompt: (node: CanvasNodeData) => void;
    onRetry: (node: CanvasNodeData) => void;
    onToggleFreeResize: (node: CanvasNodeData) => void;
    onPortraitAsset: (node: CanvasNodeData) => void;
    onDelete: (node: CanvasNodeData) => void;
    // 收藏这次生成（提示词 + 参考素材 + 配置）。已收藏时再点＝取消收藏。
    onToggleFavorite: (node: CanvasNodeData) => void;
    // favoritePendingNodeId 正在提交收藏的节点 id：转存参考素材要走服务端，可能几秒，
    // 期间按钮转圈并禁用，避免用户连点重复提交（后端幂等，但白等几次没必要）。
    favoritePendingNodeId?: string;
};

type ToolbarTool = {
    id: string;
    title: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    danger?: boolean;
    // 置灰不可点（当前用于收藏提交中）。渲染处是 {...tool} 展开，加在这里即可透传给 ToolbarAction。
    disabled?: boolean;
    // 该工具点击会调模型扣的预估积分（仅一键调模型的工具有值；按所用模型价算、remote 渠道才有）。
    cost?: number;
    // 有值则渲染成下拉（点按钮出选项），onClick 不生效。当前用于「去噪重绘」选人物/场景道具。
    menu?: { key: string; label: string; onClick: () => void }[];
};

export function CanvasNodeHoverToolbar({
    node,
    viewport,
    viewportSize,
    onKeep,
    onLeave,
    onMenuOpenChange,
    onInfo,
    onEditText,
    onDecreaseFont,
    onIncreaseFont,
    onToggleDialog,
    onGenerateImage,
    onUpload,
    onCaptureFrame,
    onExtractAudio,
    onTrimAudio,
    onAddToGroup,
    onDownload,
    onSaveAsset,
    onMaskEdit,
    onCrop,
    onAnnotate,
    onSplit,
    onUpscale,
    onSuperResolve,
    onAngle,
    onNineGrid,
    onDenoiseRepaint,
    onViewImage,
    onReversePrompt,
    onRetry,
    onToggleFreeResize,
    onPortraitAsset,
    onDelete,
    onToggleFavorite,
    favoritePendingNodeId,
}: CanvasNodeHoverToolbarProps) {
    const [quickImageToolIds, setQuickImageToolIds] = useState<ImageQuickToolId[]>(defaultImageQuickToolIds);
    const [showImageToolLabels, setShowImageToolLabels] = useState(true);
    const [draftImageToolIds, setDraftImageToolIds] = useState<ImageQuickToolId[]>(defaultImageQuickToolIds);
    const [draftShowImageToolLabels, setDraftShowImageToolLabels] = useState(true);
    const [imageToolSettingsOpen, setImageToolSettingsOpen] = useState(false);
    const [captureMenuOpen, setCaptureMenuOpen] = useState(false);
    // 工具按钮自带的下拉（去噪重绘选人物/场景道具）是否展开。菜单在 portal 里、不在工具栏 div 内，
    // 不挡住 onMouseLeave 的话鼠标一往下移工具栏就没了，菜单项永远点不到。
    const [toolMenuOpen, setToolMenuOpen] = useState(false);
    // 已应用过的「补新按钮」迁移标记，保存自定义设置时要原样写回（见 saveImageToolSettings）。
    const appliedToolMigrationsRef = useRef<string[]>([]);
    const { message } = App.useApp();
    const copyText = useCopyText();
    const portraitAssetEnabled = useConfigStore((state) => state.publicSettings?.portraitAsset?.enabled ?? false);
    const effectiveConfig = useEffectiveConfig();
    const modelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.modelCosts);
    const colorTheme = useThemeStore((state) => state.theme);
    const isDark = colorTheme === "dark";
    const theme = canvasThemes[colorTheme];

    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(IMAGE_QUICK_TOOLS_STORAGE_KEY);
            if (!stored) return;
            const parsed = JSON.parse(stored) as unknown;
            const storedConfig = readImageQuickToolsConfig(parsed);
            // 给老配置补上新增按钮（当前是「收藏」）。
            // 图片节点的按钮全部要过这份白名单，而老配置是在新按钮存在之前存下的——
            // 不补的话老用户永远看不到它，且没有任何报错。补过会记标记，只补一次。
            const migrated = migrateImageQuickToolsConfig(storedConfig);
            setQuickImageToolIds(migrated.config.ids);
            setShowImageToolLabels(migrated.config.showLabels);
            appliedToolMigrationsRef.current = migrated.config.migrations || [];
            if (migrated.changed) {
                window.localStorage.setItem(IMAGE_QUICK_TOOLS_STORAGE_KEY, JSON.stringify(migrated.config));
            }
        } catch {
            // 解析失败时不再删除整份配置（一次异常→永久重置，是「刷新就丢」的另一元凶）；保留原值、沿用默认显示，下次自愈。
        }
    }, []);

    useEffect(() => {
        setImageToolSettingsOpen(false);
        setCaptureMenuOpen(false);
        // toolMenuOpen 也必须复位：菜单开着时 node 变了/变 null，工具栏在 `if (!node) return null`
        // 处直接卸载，Dropdown 不会补发 onOpenChange(false)，这个标志位就永久停在 true——
        // 后果是该按钮的说明浮层被永久压掉，且工具栏再也不自动隐藏。
        setToolMenuOpen(false);
        onMenuOpenChange?.(false);
        // 卸载时也要解冻，否则父组件的 toolbarMenuOpenRef 会永久停在 true，
        // 整个画布的工具栏从此不再随 hover 出现/消失。
        return () => onMenuOpenChange?.(false);
    }, [node?.id]);

    if (!node) return null;

    // 一键调模型的工具（九宫格/多角度/局部编辑）点击后会按所用模型扣积分；在按钮上标出单次预估消耗，让用户点前知道花费。
    // 模型解析与各 handler 一致：九宫格钉定按模型名匹配到的合成模型（缺则回退图片模型），多角度/局部编辑用当前图片模型。
    // 仅 remote（平台计费）渠道显示；自带渠道(local) 用户自付上游、平台不计费故不显示。
    const toolCreditCost = (toolId: string): number | undefined => {
        if (effectiveConfig.channelMode !== "remote") return undefined;
        const imageModel = node.metadata?.model || effectiveConfig.imageModel || effectiveConfig.model;
        const geminiModel = (effectiveConfig.imageModels || []).find((name) => name.toLowerCase().includes("gemini"));
        // 画质取源节点自己的（与 denoiseRepaintNode / buildGenerationConfig 的继承口径一致）；
        // 用全局 quality 会让按钮上显示的预估与实际扣费差一档。
        const quality = node.metadata?.quality || effectiveConfig.quality;
        const priceOf = (name: string | undefined) => {
            if (!name) return 0;
            return requestCreditCost({ channelMode: effectiveConfig.channelMode, modelCosts, model: name, count: 1, quality });
        };
        // 去噪重绘按【两步两模型】报价：灰模 Seedream 5 + 另一个重绘模型，不是同一个模型算两次。
        // 模型判据走 pickDenoiseModels——与 denoiseRepaintNode 同源，避免标价和实扣分叉。
        if (toolId === "denoiseRepaint") {
            const denoiseModels = pickDenoiseModels(effectiveConfig.imageModels);
            // 缺任一模型时 handler 会直接拒绝执行，这里也就不该报价。
            if (!denoiseModels.white || !denoiseModels.repaint) return undefined;
            const total = priceOf(denoiseModels.white) + priceOf(denoiseModels.repaint);
            return total > 0 ? total : undefined;
        }
        // 三元写在这里是既有风格，摊平成 if 好读也好改。
        let model: string | undefined = undefined;
        if (toolId === "nineGrid") model = geminiModel || imageModel;
        else if (toolId === "angle" || toolId === "maskEdit") model = imageModel;
        if (!model) return undefined;
        const cost = priceOf(model);
        return cost > 0 ? cost : undefined;
    };

    const rawLeft = viewport.x + (node.position.x + node.width / 2) * viewport.k;
    // 名字标签(NodeNameTag)贴节点顶上方、随节点缩放(约 25px 节点坐标高 + 间距);工具栏底边再上抬这段,避免放大时盖住名字。
    const rawTop = viewport.y + node.position.y * viewport.k - 14 - 29 * viewport.k;
    // 工具栏跟随画布缩放（贴着节点一起缩），避免缩小画布时工具栏不跟着变小、悬在小节点上方显得又大又飘。
    // 上限 1（放大不超过原大小）、下限 0.5（极小缩放下仍能点）。
    const uiScale = viewport.k / 0.9;
    // 工具栏始终钉在节点水平中心（rawLeft），不做水平夹紧——水平夹紧会让靠近视口左右边缘的节点，
    // 工具栏被拉回视口内、脱离节点（放大画布后尤其明显，即“旁边节点漂移”）。改为跟着节点走、不再漂。
    // 垂直仅保留“别被顶部 overflow-hidden 裁掉”的下保护：贴顶节点把锚点压回 8px 仍可见，不向下夹紧。
    const left = rawLeft;
    const top = viewportSize ? Math.max(rawTop, 8) : rawTop;
    const isImage = node.type === CanvasNodeType.Image;
    const isVideo = node.type === CanvasNodeType.Video;
    const isAudio = node.type === CanvasNodeType.Audio;
    const hasImage = isImage && Boolean(node.metadata?.content);
    const hasVideo = isVideo && Boolean(node.metadata?.content);
    const hasAudio = isAudio && Boolean(node.metadata?.content);
    const isText = node.type === CanvasNodeType.Text;
    const isConfig = node.type === CanvasNodeType.Config;
    const isStoryboard = node.type === CanvasNodeType.Storyboard;
    const canRetry = node.metadata?.status === "error";
    const quickImageToolIdSet = new Set(quickImageToolIds);
    const copyImagePrompt = (target: CanvasNodeData) => {
        const prompt = target.metadata?.prompt?.trim();
        if (!prompt) {
            message.warning("暂无可复制的提示词");
            return;
        }
        copyText(prompt, "提示词已复制");
    };
    const imageTools = buildImageToolbarTools(node, { onUpload, onToggleFreeResize, onMaskEdit, onCrop, onAnnotate, onSplit, onSuperResolve, onAngle, onNineGrid, onDenoiseRepaint, onCopyPrompt: copyImagePrompt, onReversePrompt });
    const portraitStatus = node.metadata?.portraitAssetStatus;
    // 火山 CreateAsset 的 AssetType 支持 Image/Video/Audio，参考视频/音频含真人时同样必须先入库
    // 才能以 asset:// 引用，否则一律被 InputVideoSensitiveContentDetected 拒掉。
    // 音频不做素材授权（所有模型都不需要），按钮不再出现在音频节点上。
    const showPortrait = portraitAssetEnabled && (hasImage || hasVideo);
    const portraitKindLabel = hasVideo ? "视频" : hasAudio ? "音频" : "人像";
    const portraitIcon = portraitStatus === "active" ? <BadgeCheck className="size-4 text-[#059669] dark:text-[#34D399]" /> : portraitStatus === "processing" ? <LoaderCircle className="size-4 animate-spin" /> : portraitStatus === "failed" ? <TriangleAlert className="size-4 text-[#DC2626] dark:text-[#EF4444]" /> : <ScanFace className="size-4" />;
    const portraitLabel = portraitStatus === "active" ? "已认证" : portraitStatus === "processing" ? "认证中" : portraitStatus === "failed" ? "认证失败" : `${portraitKindLabel}认证`;
    const portraitTooltip =
        portraitStatus === "active"
            ? "已通过火山方舟素材授权，生成视频时自动以 asset:// 引用"
            : portraitStatus === "processing"
              ? `火山资产库审核中，通过后自动可用${hasVideo ? "（视频类审核耗时明显长于图片）" : ""}`
              : portraitStatus === "failed"
                ? "认证失败，点击重试（确认素材合规且服务端可被火山公网访问）"
                : hasVideo
                  ? "提交到火山方舟素材库认证（含真人的参考视频必须先认证；需 mp4/mov、2~15 秒、总像素 ≤208.7 万）"
                  : hasAudio
                    ? "提交到火山方舟素材库认证（需 wav/mp3、2~15 秒、≤15MB）"
                    : "提交到火山方舟人像资产库认证（用于 Seedance 2.0 真人风格视频）";

    // 「收藏」按钮的三态。按本文件惯例在 return 之前算好——JSX 属性里不写三元/短路，
    // 那是 bun 1.3.13 SSG 段错误的已知触发写法。
    const canFavorite = hasImage || hasVideo;
    const isFavorited = Boolean(node.metadata?.favoriteId);
    const favoritePending = Boolean(favoritePendingNodeId) && favoritePendingNodeId === node.id;
    let favoriteIcon = <Star className="size-4" />;
    if (favoritePending) favoriteIcon = <LoaderCircle className="size-4 animate-spin" />;
    else if (isFavorited) favoriteIcon = <Star className="size-4 fill-[#F59E0B] text-[#F59E0B] dark:fill-[#FCD34D] dark:text-[#FCD34D]" />;
    let favoriteLabel = "收藏";
    if (favoritePending) favoriteLabel = "收藏中";
    else if (isFavorited) favoriteLabel = "已收藏";
    let favoriteTitle = "收藏这次的提示词与参考素材，之后在「我的素材 → 收藏提示词」里可以取回";
    if (favoritePending) favoriteTitle = "正在保存提示词与参考素材…";
    else if (isFavorited) favoriteTitle = "已收藏，点击取消收藏";

    function openImageToolSettings() {
        onKeep(node.id);
        setDraftImageToolIds(quickImageToolIds);
        setDraftShowImageToolLabels(showImageToolLabels);
        setImageToolSettingsOpen(true);
    }

    const baseToolbarTools: ToolbarTool[] = [
        { id: "info", title: "查看节点信息", label: "信息", icon: <Info className="size-4" />, onClick: () => onInfo(node) },
        { id: "delete", title: "移除节点", label: "删除", icon: <Trash2 className="size-4" />, onClick: () => onDelete(node), danger: true },
    ];
    const nodeToolbarTools: ToolbarTool[] = [
        ...(canRetry ? [{ id: "retry", title: "重新生成", label: "重试", icon: <RefreshCw className="size-4" />, onClick: () => onRetry(node) }] : []),
        ...(hasImage || hasVideo || hasAudio || isText ? [{ id: "saveAsset", title: "加入我的素材", label: "存素材", icon: <FolderPlus className="size-4" />, onClick: () => onSaveAsset(node) }] : []),
        // 收藏这次生成。放在 nodeToolbarTools 而不是 imageToolDefinitions，是因为后者被
        // 下面的 hasImage 三元锁死在图片节点上，而收藏要同时覆盖图片和视频。
        ...(canFavorite ? [{ id: "favorite", title: favoriteTitle, label: favoriteLabel, icon: favoriteIcon, active: isFavorited, disabled: favoritePending, onClick: () => onToggleFavorite(node) }] : []),
        ...(hasImage || hasVideo || hasAudio ? [{ id: "addToGroup", title: "加入团队素材（同组成员可取用）", label: "加入团队", icon: <Users className="size-4" />, onClick: () => onAddToGroup(node) }] : []),
        ...(hasImage || hasVideo || hasAudio ? [{ id: "download", title: hasAudio ? "下载音频" : hasVideo ? "下载视频" : "下载图片", label: "下载", icon: <Download className="size-4" />, onClick: () => onDownload(node) }] : []),
        ...(isText ? [{ id: "editText", title: "编辑文本", label: "编辑文字", icon: <Pencil className="size-4" />, onClick: () => onEditText(node) }] : []),
        ...(isText ? [{ id: "generateImage", title: "用文本生图", label: "生图", icon: <ImageIcon className="size-4" />, onClick: () => onGenerateImage(node) }] : []),
        ...(isConfig ? [{ id: "config", title: "生成配置", label: "生成配置", icon: <Settings2 className="size-4" />, onClick: () => onToggleDialog(node) }] : []),
        ...(isStoryboard ? [{ id: "storyboard", title: "编辑分镜故事板", label: "编辑", icon: <MessageSquare className="size-4" />, onClick: () => onToggleDialog(node) }] : []),
        ...(isText ? [{ id: "decreaseFont", title: "减小字号", label: "缩小", icon: <Minus className="size-4" />, onClick: () => onDecreaseFont(node) }] : []),
        ...(isText ? [{ id: "increaseFont", title: "增大字号", label: "放大", icon: <Plus className="size-4" />, onClick: () => onIncreaseFont(node) }] : []),
        ...(isImage && !hasImage ? [{ id: "uploadImage", title: "上传图片", label: "上传图片", icon: <Upload className="size-4" />, onClick: () => onUpload(node) }] : []),
        ...(isVideo ? [{ id: "uploadVideo", title: hasVideo ? "替换视频" : "上传视频", label: hasVideo ? "替换视频" : "上传视频", icon: <Video className="size-4" />, onClick: () => onUpload(node) }] : []),
        ...(isVideo && hasVideo ? [{ id: "extractAudio", title: "提取音频为音频节点", label: "提取音频", icon: <Music2 className="size-4" />, onClick: () => onExtractAudio(node) }] : []),
        ...(isAudio ? [{ id: "uploadAudio", title: hasAudio ? "替换音频" : "上传音频", label: hasAudio ? "替换音频" : "上传音频", icon: <Music2 className="size-4" />, onClick: () => onUpload(node) }] : []),
        ...(isAudio && hasAudio ? [{ id: "trimAudio", title: "裁切音频", label: "裁切", icon: <Scissors className="size-4" />, onClick: () => onTrimAudio(node) }] : []),
        ...(hasImage ? imageTools.map((tool) => ({ id: tool.id, title: tool.title, label: tool.label, icon: tool.icon, active: tool.active, onClick: tool.onClick, menu: tool.menu, cost: toolCreditCost(tool.id) })) : []),
    ];
    const toolbarTools = hasImage ? [...baseToolbarTools, ...nodeToolbarTools].filter((tool) => quickImageToolIdSet.has(tool.id as ImageQuickToolId)) : [...baseToolbarTools, ...nodeToolbarTools];
    const selectableImageToolbarTools = [...baseToolbarTools, ...nodeToolbarTools].filter((tool) => tool.id !== "retry" && tool.id !== "delete") as ImageToolbarSettingsTool[];

    const closeImageToolSettings = () => {
        setImageToolSettingsOpen(false);
        onLeave();
    };

    const setDraftImageToolVisible = (id: ImageQuickToolId, visible: boolean) => {
        setDraftImageToolIds((current) => {
            const selected = new Set(current);
            if (visible) selected.add(id);
            else selected.delete(id);
            return selectableImageToolbarTools.filter((tool) => selected.has(tool.id)).map((tool) => tool.id);
        });
    };

    const saveImageToolSettings = () => {
        // migrations 必须一起写回：漏掉它，下次进来「补新按钮」的迁移会被判为从未执行过，
        // 用户刚刚主动关掉的按钮又会被塞回来。
        const config = { ids: draftImageToolIds, showLabels: draftShowImageToolLabels, migrations: appliedToolMigrationsRef.current };
        setQuickImageToolIds(config.ids);
        setShowImageToolLabels(config.showLabels);
        window.localStorage.setItem(IMAGE_QUICK_TOOLS_STORAGE_KEY, JSON.stringify(config));
        closeImageToolSettings();
    };

    return (
        <>
            <div
                className="anim-pop absolute z-[70] flex h-12 items-center overflow-visible rounded-full border text-[15px]"
                // 定位用独立的 translate/scale CSS 属性而非 transform：anim-pop(paper-pop-in)动画会动 transform 并以 fill:both 钉死成 scale(1)，
                // 若把 -50% 居中平移和缩放写进 transform 会被它整个覆盖（实测 computed transform 退化成单位矩阵→工具栏不居中、偏右半个身位、缩放失效）。
                style={{ left, top, translate: "-50% -100%", scale: `${uiScale}`, transformOrigin: "center bottom", background: isDark ? "#141F36" : "#F8FAFC", color: isDark ? "#E2E8F0" : "#121C30", borderColor: theme.toolbar.border, boxShadow: isDark ? "0 10px 30px rgba(0,0,0,.45)" : "0 8px 28px rgba(15,23,42,.16)" }}
                onMouseEnter={() => onKeep(node.id)}
                onMouseLeave={() => {
                    if (!imageToolSettingsOpen && !captureMenuOpen && !toolMenuOpen) onLeave();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                {toolbarTools.map((tool) => {
                    // 带 menu 的工具渲染成下拉，写法与下面视频「截取」那个 Dropdown 一致。
                    // 用纯 if/return 不用三元：这个文件踩过 bun 编译期 SIGILL。
                    if (tool.menu && tool.menu.length > 0) {
                        return (
                            <Dropdown
                                key={tool.id}
                                trigger={["click"]}
                                placement="top"
                                open={toolMenuOpen}
                                menu={{ items: tool.menu }}
                                onOpenChange={(open) => {
                                    // 受控：toolMenuOpen 是唯一真相。非受控时它只是个影子状态，
                                    // 复位它并不会真的关掉菜单，两者一旦劈叉守卫就全失效。
                                    setToolMenuOpen(open);
                                    // 先通知父组件解除冻结，再走 onLeave，顺序不能反。
                                    onMenuOpenChange?.(open);
                                    if (open) onKeep(node.id);
                                    else onLeave();
                                }}
                            >
                                <span className="inline-flex">
                                    <ToolbarAction {...tool} showLabel={showImageToolLabels} tooltipSuppressed={toolMenuOpen} />
                                </span>
                            </Dropdown>
                        );
                    }
                    return <ToolbarAction key={tool.id} {...tool} showLabel={showImageToolLabels} tooltipSuppressed={toolMenuOpen} />;
                })}
                {hasVideo ? (
                    <Dropdown
                        trigger={["click"]}
                        placement="bottom"
                        menu={{
                            items: [
                                { key: "first", label: "首帧", onClick: () => onCaptureFrame(node, "first") },
                                { key: "current", label: "当前帧", onClick: () => onCaptureFrame(node, "current") },
                                { key: "last", label: "尾帧", onClick: () => onCaptureFrame(node, "last") },
                            ],
                        }}
                        onOpenChange={(open) => {
                            setCaptureMenuOpen(open);
                            if (open) onKeep(node.id);
                            else onLeave();
                        }}
                    >
                        <button type="button" className="group relative flex h-12 items-center whitespace-nowrap px-1.5" aria-label="截取视频帧">
                            <span className={`flex h-9 items-center ${showImageToolLabels ? "gap-2 px-2.5" : "justify-center px-2"} rounded-full transition duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:bg-[#E5EAF1] dark:group-hover:bg-[#E2E8F0]/8`}>
                                <Scissors className="size-4" />
                                {showImageToolLabels ? <span>截取</span> : null}
                            </span>
                        </button>
                    </Dropdown>
                ) : null}
                {showPortrait ? <ToolbarAction id="portrait" title={portraitTooltip} label={portraitLabel} icon={portraitIcon} active={portraitStatus === "processing"} disabled={portraitStatus === "processing"} onClick={() => onPortraitAsset(node)} showLabel={showImageToolLabels} tooltipSuppressed={toolMenuOpen} /> : null}
                {hasImage ? <ToolbarAction id="more" title="配置快捷工具" label="更多" icon={<Ellipsis className="size-4" />} active={imageToolSettingsOpen} onClick={openImageToolSettings} showLabel={showImageToolLabels} tooltipSuppressed={toolMenuOpen} /> : null}
            </div>
            {hasImage ? (
                <ImageToolSettingsModal
                    open={imageToolSettingsOpen}
                    tools={selectableImageToolbarTools}
                    selectedIds={draftImageToolIds}
                    showLabels={draftShowImageToolLabels}
                    onToggle={setDraftImageToolVisible}
                    onShowLabelsChange={setDraftShowImageToolLabels}
                    onCancel={closeImageToolSettings}
                    onSave={saveImageToolSettings}
                />
            ) : null}
        </>
    );
}

export function CanvasNodeInfoModal({ node, open, onClose }: { node: CanvasNodeData | null; open: boolean; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [view, setView] = useState<"info" | "json">("info");
    const copyText = useCopyText();
    const imageBytes = node?.type === CanvasNodeType.Image && node.metadata?.content ? getDataUrlByteSize(node.metadata.content) : 0;
    const batchCount = node?.type === CanvasNodeType.Image ? node.metadata?.batchChildIds?.length || 0 : 0;
    // 图片真人认证通过后火山方舟给的人像资产引用（asset:// 开头），展示 + 可复制。
    const portraitAssetUri = node?.type === CanvasNodeType.Image && node.metadata?.portraitAssetStatus === "active" ? node.metadata?.portraitAssetUri : undefined;
    const json = useMemo(() => {
        if (!node) return "";
        return JSON.stringify(
            node,
            (key, value) => {
                if (key === "title") return undefined;
                if (key === "content" && typeof value === "string" && value.startsWith("data:image/")) {
                    return "[base64 image]";
                }
                return value;
            },
            2,
        );
    }, [node]);

    useEffect(() => {
        if (open) setView("info");
    }, [node?.id, open]);

    // 视频/生成节点的追踪码换成对应的火山 cgt 任务号（后端按 trace_id 查、会话内缓存）。查到 cgt 就显示 cgt，否则回退显示原追踪码。
    const traceId = node?.metadata?.traceId;
    const [cgt, setCgt] = useState("");
    useEffect(() => {
        setCgt("");
        if (!open || !traceId) return;
        let alive = true;
        void fetchTraceCgt(traceId).then((value) => {
            if (alive) setCgt(value);
        });
        return () => {
            alive = false;
        };
    }, [open, traceId]);
    let traceLabel = "追踪码";
    let traceTitle = "点击复制，用于在后台日志查询这次 AI 调用";
    let traceCopyMsg = "已复制追踪码";
    if (cgt) {
        traceLabel = "火山任务号";
        traceTitle = "火山方舟任务号（cgt），点击复制；可在火山后台查该任务 / 账单";
        traceCopyMsg = "已复制火山任务号";
    }
    const traceValue = cgt || traceId || "";

    const title = (
        <div className="flex items-center justify-between gap-4 pr-12">
            <span className="font-heading font-medium tracking-wide">节点信息</span>
            <Segmented
                size="small"
                value={view}
                onChange={(value) => setView(value as "info" | "json")}
                options={[
                    { label: "信息", value: "info" },
                    { label: "JSON", value: "json" },
                ]}
            />
        </div>
    );

    return (
        <Modal className="canvas-node-info-modal" title={title} open={open && Boolean(node)} centered footer={null} onCancel={onClose}>
            {node ? (
                <div className="h-[56vh] min-h-[360px] text-sm">
                    {view === "info" ? (
                        <div className="thin-scrollbar h-full space-y-3 overflow-auto pr-1">
                            <InfoRow label="ID" value={node.id} />
                            {/* 用统一的标签表，别再写三元链：原来的兜底是「生成配置」，
                                分镜、场景机位、场景台都会被显示成错误的类型名。 */}
                            <InfoRow label="类型" value={getTypeLabel(node.type)} />
                            <InfoRow label="尺寸" value={`${Math.round(node.width)} x ${Math.round(node.height)}`} />
                            <InfoRow label="位置" value={`${Math.round(node.position.x)}, ${Math.round(node.position.y)}`} />
                            <InfoRow label="状态" value={node.metadata?.status || "idle"} />
                            {typeof node.metadata?.generationMs === "number" && node.metadata.generationMs > 0 ? <InfoRow label="生成耗时" value={formatGenDuration(node.metadata.generationMs)} /> : null}
                            {traceId ? (
                                <InfoRow
                                    label={traceLabel}
                                    value={
                                        <span className="cursor-pointer select-all font-mono underline-offset-2 hover:underline" title={traceTitle} onClick={() => copyText(traceValue, traceCopyMsg)}>
                                            {traceValue}
                                        </span>
                                    }
                                />
                            ) : null}
                            {/* 上游返回的音频时长（original_duration）。
                                ⚠️ 别在这里写「扣费依据」：音频当前是按次一口价，时长不参与计费。
                                只有后台把该模型配了「每秒点数」时才按秒结算，而那时账以点数日志为准。 */}
                            {typeof node.metadata?.audioBilledSeconds === "number" && node.metadata.audioBilledSeconds > 0 ? (
                                <InfoRow label="音频时长" value={`${node.metadata.audioBilledSeconds.toFixed(1)} 秒`} />
                            ) : null}
                            {batchCount > 1 ? <InfoRow label="图片组" value={`${batchCount} 张`} /> : null}
                            {node.metadata?.prompt ? <InfoRow label="提示词" value={node.metadata.prompt} /> : null}
                            {imageBytes ? <InfoRow label="图片大小" value={formatBytes(imageBytes)} /> : null}
                            {portraitAssetUri ? (
                                <InfoRow
                                    label="认证链接"
                                    value={
                                        <span className="cursor-pointer select-all break-all font-mono text-xs underline-offset-2 hover:underline" title="真人认证通过后的火山方舟人像资产 asset:// 引用，生成视频时自动以它引用；点击复制" onClick={() => copyText(portraitAssetUri, "已复制认证链接")}>
                                            {portraitAssetUri}
                                        </span>
                                    }
                                />
                            ) : null}
                            {node.metadata?.errorDetails ? (
                                <div className="rounded-lg border p-3 text-[#DC2626] dark:text-[#EF4444]" style={{ borderColor: theme.node.stroke }}>
                                    {node.metadata.errorDetails}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <pre className="thin-scrollbar h-full overflow-auto rounded-lg border p-3 text-xs leading-5" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}>
                            {json}
                        </pre>
                    )}
                </div>
            ) : null}
        </Modal>
    );
}

function ToolbarAction({ title, label, icon, onClick, showLabel, active = false, danger = false, disabled = false, cost, tooltipSuppressed = false }: ToolbarTool & { showLabel: boolean; disabled?: boolean; tooltipSuppressed?: boolean }) {
    const hasText = showLabel && Boolean(label);
    // 下拉展开时压掉这层说明浮层：菜单上弹，而 Tooltip 也是 placement="top"，两者会叠在一起。
    // 传空 title 时 antd 内部直接把浮层判死（antd/es/tooltip/index.js 的 noTitle 分支），
    // 不用条件渲染 Tooltip——那样 button 会 remount，可能打断 Dropdown 注入到子元素上的 ref 与事件。
    // aria-label 仍用原 title，压掉的只是视觉浮层，读屏不受影响。
    let tooltipTitle: string = title;
    if (tooltipSuppressed) tooltipTitle = "";
    return (
        <Tooltip title={tooltipTitle} placement="top" mouseEnterDelay={0.2} styles={{ body: { fontSize: 13, fontWeight: 500 } }}>
            <button type="button" disabled={disabled} className={`group relative flex h-12 items-center whitespace-nowrap px-1.5 ${danger ? "text-[#DC2626] dark:text-[#EF4444]" : ""} ${disabled ? "cursor-default opacity-70" : ""}`} onClick={onClick} aria-label={title}>
                <span className={`flex h-9 items-center ${hasText ? "gap-2 px-2.5" : "justify-center px-2"} rounded-full transition duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:bg-[#E5EAF1] dark:group-hover:bg-[#E2E8F0]/8 ${active ? "bg-[#E2E8F0] dark:bg-[#243049]" : ""}`}>
                    {icon}
                    {hasText ? <span>{label}</span> : null}
                    {typeof cost === "number" ? (
                        <span className="inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums opacity-70" title={`预计消耗 ${cost} 积分（按所用模型计费，失败自动退回）`}>
                            <CreditSymbol className="text-[0.85em]" />
                            {cost}
                        </span>
                    ) : null}
                </span>
            </button>
        </Tooltip>
    );
}

// 生成耗时格式化：<60s 显示带一位小数的秒，否则「M 分 S 秒」。纯 if 避免 bun 三元 SIGILL。
function formatGenDuration(ms: number) {
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + " 秒";
    const totalSec = Math.round(s);
    const m = Math.floor(totalSec / 60);
    const rem = totalSec % 60;
    return m + " 分 " + rem + " 秒";
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
            <span className="opacity-50">{label}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
        </div>
    );
}
