"use client";

import { RequireAuth } from "@/components/require-auth";
import { APP_NAME } from "@/constant/env";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Box, CircleDot, Clapperboard, Eraser, FolderKanban, Grid2x2, Home, ImageIcon, Images, Info, List, Map as MapIcon, Menu, MessageSquare, Music2, Palette, Plus, Redo2, Settings2, SlidersHorizontal, Square, Trash2, Undo2, Upload, Video, Share2 } from "@/components/icons";
import { saveAs } from "file-saver";

import { requestEdit, requestGeneration, requestImageQuestion, resumeImageGenerationJob } from "@/services/api/image";
import { isRetryableJobError } from "@/services/api/generation-jobs";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { requestVideoGeneration, storeGeneratedVideo, waitVideoGenerationTask } from "@/services/api/video";
import { fetchPendingVideoTasks } from "@/services/api/video-recovery";
import { buildPickerConfig, defaultConfig, modelMatchesCapability, type AiConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { imageToDataUrl, resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { errorTraceId } from "@/services/api/trace";
import { ensureVideoPreview, readVideoMeta, resolveMediaUrl, uploadMediaFile, VIDEO_META_PROBED_EVENT, VIDEO_PREVIEW_READY_EVENT, type UploadedFile } from "@/services/file-storage";
import { getMediaUplinkState, waitMediaUploaded } from "@/services/media-uplink";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, dataUrlToFile, readImageMeta, downscaleToPixelBudget } from "@/lib/image-utils";
import { composeImagePrompt, getImageStylePreset, getImageViewPreset } from "@/lib/image-style-presets";
import { composeVideoPrompt, getVideoStylePreset } from "@/lib/video-style-presets";
import { createPromptFavorite, deletePromptFavorite, fetchMyFavoriteNodes, parsePromptFavoriteJSON, type PromptFavorite, type PromptFavoriteAssetInput } from "@/services/api/prompt-favorite";
import { captureVideoFrame, VideoFrameCorsError, type VideoFrameTarget } from "@/lib/video-frame";
import { decodeAudioFromUrl, audioBufferToWavBlob, AudioDecodeError } from "@/lib/audio-utils";
import {
    compressPortraitImage,
    getPortraitAsset,
    hashImageFile,
    listPortraitAssets,
    submitPortraitAsset,
    submitPortraitAssetByUrl,
    submitPortraitAssetFromUrl,
    validateVolcAssetMedia,
    type PortraitAssetKind,
} from "@/services/api/portrait-asset";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore, CREDITS_REFRESHED_EVENT } from "@/stores/use-user-store";
import { useShortcutStore } from "@/stores/use-shortcut-store";
import { eventToChord, matchCommand, resolveShortcutChords, shouldSkipShortcut } from "@/constant/shortcuts";
import { ShortcutSettingsModal } from "@/components/shortcut-settings-modal";
import { useMyProjectsStore } from "../stores/use-my-projects-store";
import { CanvasCreditSourceDialog } from "../components/canvas-credit-source-dialog";
import { combineGridDataUrl, cropDataUrl, splitDataUrl, upscaleDataUrl } from "../utils/canvas-image-data";
import { computeGridSlots, gridColumnsForCount, inferGridFromPositions } from "../utils/canvas-grid-merge";
import { backfillNameSeq, collectDisplayNames, deriveCopyName, getNodeDisplayName } from "../utils/node-naming";
import { isSeedanceVideoConfig, videoRefLimits } from "@/lib/seedance-video";
import { buildSeedAudioRequest } from "@/lib/audio-generation";
import { createStageState, type DirectorCapture, type DirectorVideoResult } from "../utils/canvas-stage";
import { guardedNavigate, registerLeaveGuard } from "../utils/leave-guard";
import { computeSortLayout, type SortMode } from "../utils/canvas-sort-layout";
import { expectedMediaSizeFromRatio, fitNodeSize, standardMediaSize, STANDARD_NODE_HEIGHT, AUDIO_NODE_HEIGHT } from "../utils/canvas-node-size";
import { buildObstacles, placeBatch, FREE_GAP_X, FREE_GAP_Y } from "../utils/canvas-free-space";
import { App, Button, Dropdown, Input, Modal, Segmented, Select, Switch } from "antd";
import copy from "copy-to-clipboard";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "../constants";
import { ActiveConnectionPath, ConnectionPath } from "../components/canvas-connections";
import { pickDenoiseModels } from "../components/canvas-image-toolbar-tools";
import { CanvasConfigComposer } from "../components/canvas-config-composer";
import { CanvasConfigNodePanel } from "../components/canvas-config-node-panel";
const CanvasAssistantPanel = dynamic(() => import("../components/canvas-assistant-panel").then((m) => m.CanvasAssistantPanel), { ssr: false });
import { CanvasNodeContextMenu } from "../components/canvas-context-menu";
import { useAgentCanvasApi } from "../agent/use-agent-canvas-api";
import { CanvasGroupBox, computeGroupBounds } from "../components/canvas-group-box";
import { CanvasSelectionToolbar } from "../components/canvas-selection-toolbar";
import type { CanvasImageAngleParams } from "../components/canvas-node-angle-dialog";
const CanvasNodeAngleDialog = dynamic(() => import("../components/canvas-node-angle-dialog").then((m) => m.CanvasNodeAngleDialog), { ssr: false });
import type { CanvasImageCropRect } from "../components/canvas-node-crop-dialog";
const CanvasNodeCropDialog = dynamic(() => import("../components/canvas-node-crop-dialog").then((m) => m.CanvasNodeCropDialog), { ssr: false });
import type { CanvasImageAnnotatePayload } from "../components/canvas-node-annotate-dialog";
const CanvasNodeAnnotateDialog = dynamic(() => import("../components/canvas-node-annotate-dialog").then((m) => m.CanvasNodeAnnotateDialog), { ssr: false });
import { CanvasGroupAssetNameDialog } from "../components/canvas-group-asset-name-dialog";
import { GROUP_ASSETS_QUERY_KEY } from "../components/canvas-team-assets-tab";
import { uploadGroupAsset, groupAssetDisplayName, type GroupAsset } from "@/services/api/group-assets";
import { useQueryClient } from "@tanstack/react-query";
import type { CanvasImageMaskEditPayload } from "../components/canvas-node-mask-edit-dialog";
const CanvasNodeMaskEditDialog = dynamic(() => import("../components/canvas-node-mask-edit-dialog").then((m) => m.CanvasNodeMaskEditDialog), { ssr: false });
import type { CanvasImageSplitParams } from "../components/canvas-node-split-dialog";
const CanvasNodeSplitDialog = dynamic(() => import("../components/canvas-node-split-dialog").then((m) => m.CanvasNodeSplitDialog), { ssr: false });
import type { CanvasImageUpscaleParams } from "../components/canvas-node-upscale-dialog";
const CanvasNodeUpscaleDialog = dynamic(() => import("../components/canvas-node-upscale-dialog").then((m) => m.CanvasNodeUpscaleDialog), { ssr: false });
import { buildNodeChatMessages, buildNodeGenerationContext, buildNodeGenerationInputs, findUnusedReferenceInputs, hydrateNodeGenerationContext, type NodeGenerationInput } from "../components/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "../components/canvas-node-hover-toolbar";
import { CanvasSurface } from "../components/canvas-surface";
import { Minimap } from "../components/canvas-mini-map";
import { CanvasNode } from "../components/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "../components/canvas-node-prompt-panel";
import { CanvasToolbar } from "../components/canvas-toolbar";
import { AssetPickerModal, type AssetPickerTab, type InsertAssetPayload } from "../components/asset-picker-modal";
import { CanvasAssetSidebar } from "../components/canvas-asset-sidebar";
import { CanvasSubCanvasSwitcher } from "../components/canvas-subcanvas-switcher";
import { CanvasCopyFromSiblingDialog } from "../components/canvas-copy-from-sibling-dialog";
import { useCanvasStore } from "../stores/use-canvas-store";
import { buildCanvasResourceReferences, buildNodeMentionReferences, stripMentionToken, type CanvasResourceReference } from "../utils/canvas-resource-references";
import { computeAlignedPositions, computeAlignmentSnap, type AlignActionMode, type AlignmentGuide } from "../utils/canvas-alignment";
import { computeGroupLayout } from "../utils/canvas-group-layout";
import { CLOUD_REMOTE_MERGED_EVENT, CLOUD_SYNCED_EVENT, hasPendingCloudPush, scheduleCloudSync } from "@/services/cloud-sync";
import { reportPersistSwallow } from "@/services/api/diag";
import { shareCanvasProject } from "@/services/canvas-share";
import { buildScriptText, buildStoryboardImagePrompt, buildStoryboardParserMessages, buildStoryboardPlannerMessages, buildVideoPrompt, parseStoryboardPlan, type StoryboardNodeState, type StoryboardPlan } from "../utils/canvas-storyboard";
const CanvasStoryboardComposer = dynamic(() => import("../components/canvas-storyboard-composer").then((m) => m.CanvasStoryboardComposer), { ssr: false });
const CanvasStoryboardNodePanel = dynamic(() => import("../components/canvas-storyboard-node-panel").then((m) => m.CanvasStoryboardNodePanel), { ssr: false });
const CanvasSceneCameraNodePanel = dynamic(() => import("../components/canvas-scene-camera-node-panel").then((m) => m.CanvasSceneCameraNodePanel), { ssr: false });
const CanvasRoomSceneDialog = dynamic(() => import("../components/canvas-room-scene-dialog").then((m) => m.CanvasRoomSceneDialog), { ssr: false });
// 3D 场景台：面板轻、弹窗里是 iframe，都走懒加载，不进首屏包。
const CanvasStageNodePanel = dynamic(() => import("../components/canvas-stage-node-panel").then((m) => m.CanvasStageNodePanel), { ssr: false });
const CanvasStageDialog = dynamic(() => import("../components/canvas-stage-dialog").then((m) => m.CanvasStageDialog), { ssr: false });
// 新功能引导：只在没看过的用户身上出现一次，走懒加载不占首屏。
// const CanvasFeatureGuide = dynamic(() => import("../components/canvas-feature-guide").then((m) => m.CanvasFeatureGuide), { ssr: false });

// 低于该缩放不渲染连线。缩放范围是 0.05~5，连线线宽固定 2~3 世界单位，
// 该缩放下不到 0.4 个屏幕像素，肉眼已看不见，但两千条连线仍是四千多个 SVG 元素的实际开销。
//
// 阈值从 0.2 下调到 0.12：0.2 太激进——用户确实会在缩得较小的视图里连线，
// 连完却看不见线会以为没连上。0.12 已经贴近缩放下限 0.05，那个区间是纯粹的「看全局」。
const CONNECTION_RENDER_MIN_ZOOM = 0.12;
import { parseRoomPlan, normalizeRoomScene, buildRoomPlanUserPrompt, ROOM_PLAN_SYSTEM_PROMPT, buildViewSystemPrompt, buildViewUserPrompt, buildRoomImagePrompt, type RoomSceneState } from "../utils/canvas-room-scene";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasGroup,
    type CanvasImageGenerationType,
    type CanvasNodeData,
    type CanvasNodeMetadata,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "../types";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

// ============================================================================
// 【新增】画布剪贴板「归属裁判」标记 —— 让系统剪贴板成为「最近一次复制赢」的唯一裁判。
// 放置位置：紧跟文件顶部 CanvasClipboard 类型定义（:98-101）之后、组件函数体之外（模块级常量/纯函数，零依赖、bun 安全）。
//
// 设计要点（隐私优先）：系统剪贴板里【只写一段短签名标记】，绝不写任何节点 JSON /
// metadata.content / 远程签名 URL。节点真实数据仍主存在内存 clipboardRef（blob: 保活、
// 连线/命名/避让逻辑全复用）。粘贴时标记命中即用 clipboardRef 活数据；标记失配（外部复制
// 覆盖了系统剪贴板）则走外部图/文分支。token 仅用于「本会话本次复制」的弱校验，无敏感信息。
// ============================================================================

// 写进系统剪贴板的签名前缀。复制画布节点时连同一个随机 token 写成纯文本；
// 粘贴时据此判断当前系统剪贴板归属「本应用画布节点」还是「外部图/文」。
// 故意不带任何节点内容：用户复制节点后到画布外 Ctrl+V 最多粘出这串短标记，不泄露资源 URL。
const CANVAS_CLIPBOARD_MARKER = "__HUIJING_CANVAS_NODES__::";

// 稳定的空引用集合：节点无 @ 引用时统一返回同一个数组，避免每次渲染新建 [] 击穿 CanvasNode 的 React.memo。
const EMPTY_MENTION_REFS: CanvasResourceReference[] = [];
const SORT_MODE_LABELS: Record<SortMode, string> = { grid: "网格整理", type: "按类型分区", lineage: "按连线族谱", name: "按名称编号" };

// 生成一次复制用的随机 token（仅本会话内存比对，无需可逆/无敏感信息）。
function makeCanvasClipboardToken(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 组装写入系统剪贴板的标记文本（前缀 + token）。
function buildCanvasClipboardMarker(token: string): string {
    return `${CANVAS_CLIPBOARD_MARKER}${token}`;
}

// 判定一段系统剪贴板文本是否由本应用画布复制写入（前缀命中即可）。
function isCanvasClipboardMarker(text: string | null | undefined): boolean {
    if (!text) return false;
    return text.indexOf(CANVAS_CLIPBOARD_MARKER) === 0;
}

// 把标记写进系统剪贴板。安全上下文优先 navigator.clipboard.writeText（可 await 判定、不弹 prompt）；
// 非安全上下文(HTTP，navigator.clipboard 为 undefined)直接跳过——读侧 HTTP 永远走内存 ref，
// 写进去也读不回，反而抢焦点/可能弹 window.prompt，故不降级 copy()。返回是否真正写入系统剪贴板。
async function writeCanvasClipboardMarker(text: string): Promise<boolean> {
    try {
        if (typeof navigator === "undefined") return false;
        if (!navigator.clipboard) return false;
        if (typeof navigator.clipboard.writeText !== "function") return false;
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    groups: CanvasGroup[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
// 生成视频前自动认证参考素材的【整体】等待上限。到点就走，不阻断出片。
const AUTO_ENROLL_TIMEOUT_MS = 40_000;

const NODE_STATUS_ERROR = "error" as const;
// 参考图像素上限:超过上游会被拒(seedance 报 "Maximum allowed: 36000000 pixels",gpt-image 同量级);生成前自检、超了让用户一键压缩。
const REFERENCE_IMAGE_MAX_PIXELS = 36_000_000;
const IMAGE_PROMPT_REVERSE_PRESET = `请根据参考图片反推一段适合用于 AI 生图的提示词。

要求：
1. 只输出提示词正文，不要解释。
2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。
3. 尽量写成可直接用于生图模型的完整提示词。`;

// 新建/粘贴节点的级联避让步长（世界坐标）；两点中心距离小于阈值即视为「几乎重合」。
const NODE_DODGE_STEP = 32;
const NODE_OVERLAP_THRESHOLD = 12;

// 取生成结果的第一张图；上游偶发返回 200 但空数组（如内容审核拦截 / 上游 flaky），
// 此时不要让调用方读 undefined.dataUrl 抛含糊的 TypeError，统一抛清晰的可重试错误。
function firstGeneratedImage<T extends { dataUrl?: string }>(items: T[]): T {
    const first = items?.[0];
    if (!first?.dataUrl) throw new Error("生成结果为空，请重试");
    return first;
}

// 给定一个期望的「节点中心」落点：若与某个已存在节点的中心几乎重合，就沿 +32,+32 级联偏移，
// 直到找到一个不与任何已有节点中心重合的位置。避免新建/粘贴的节点完全盖住下层够不到。
function findFreeCenter(center: Position, existingNodes: CanvasNodeData[]): Position {
    const occupied = existingNodes.map((node) => ({ x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 }));
    let next = { ...center };
    // 上限防御:节点极多且恰好排满时不至于死循环
    for (let i = 0; i < 200; i++) {
        const clash = occupied.some((point) => Math.abs(point.x - next.x) < NODE_OVERLAP_THRESHOLD && Math.abs(point.y - next.y) < NODE_OVERLAP_THRESHOLD);
        if (!clash) return next;
        next = { x: next.x + NODE_DODGE_STEP, y: next.y + NODE_DODGE_STEP };
    }
    return next;
}

function createCanvasNode(type: CanvasNodeType, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // 未生成的图片/视频节点：占位直接按**终态**尺寸成形（与出图后 standardMediaSize 的结果一致）。
    // 原先这里走 nodeSizeFromRatio(把比例塞进 340×240 的默认盒子)，和成品的基准不同，
    // 于是每次生成完节点都要 resize：1:1 从 240×240 跳到 360×360、16:9 从 340×191 跳到 640×360。
    let width = spec.width;
    let height = spec.height;
    if ((type === CanvasNodeType.Image || type === CanvasNodeType.Video) && typeof metadata?.size === "string") {
        const sized = expectedMediaSizeFromRatio(metadata.size);
        if (sized) {
            width = sized.width;
            height = sized.height;
        }
    }

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - width / 2,
            y: position.y - height / 2,
        },
        width,
        height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

// 新建图片/视频节点时，把「配置与用户偏好」里的默认比例 + 分辨率注入 metadata，让占位即按偏好成形、面板回显与生成一致(未生成也对)。
// 直接读 store(getState 非 hook)取最新值，无闭包陈旧、无需 deps。
function defaultAspectMeta(type: CanvasNodeType): CanvasNodeMetadata | undefined {
    const cfg = useConfigStore.getState().config;
    if (type === CanvasNodeType.Image) {
        const meta: CanvasNodeMetadata = {};
        if (cfg.canvasImageAspect) meta.size = cfg.canvasImageAspect;
        if (cfg.canvasImageQuality) meta.quality = cfg.canvasImageQuality;
        return Object.keys(meta).length ? meta : undefined;
    }
    if (type === CanvasNodeType.Video) {
        const meta: CanvasNodeMetadata = {};
        if (cfg.canvasVideoRatio) meta.size = cfg.canvasVideoRatio;
        if (cfg.canvasVideoResolution) meta.vquality = cfg.canvasVideoResolution;
        return Object.keys(meta).length ? meta : undefined;
    }
    return undefined;
}

export default function CanvasPage() {
    return (
        <RequireAuth>
            <CanvasPageInner />
        </RequireAuth>
    );
}

function CanvasPageInner() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <CanvasSurfacePage />;
}

function CanvasRefreshShell() {
    return (
        <main className="anim-fade relative h-full min-h-0 overflow-hidden bg-background text-foreground">
            <div className="bg-paper-grid absolute inset-0 opacity-60" />

            <div className="absolute inset-0 z-40 grid place-items-center" aria-hidden="true">
                <span className="select-none font-heading text-2xl font-medium tracking-[0.5em] text-foreground opacity-15">{APP_NAME}</span>
            </div>

            <div className="absolute bottom-[calc(1.25rem+var(--app-banner-h,0px))] left-1/2 z-50 flex h-14 -translate-x-1/2 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div>

            <div className="absolute bottom-[calc(6rem+var(--app-banner-h,0px))] left-6 z-50 h-40 w-[240px] rounded-lg border shadow-2xl backdrop-blur-sm" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="absolute left-7 top-7 h-5 w-12 rounded-sm bg-current opacity-10" />
                <div className="absolute left-28 top-16 h-6 w-16 rounded-sm bg-current opacity-10" />
                <div className="absolute bottom-7 left-16 h-8 w-20 rounded-sm bg-current opacity-10" />
                <div className="absolute inset-5 rounded border border-current opacity-15" />
            </div>

            <div className="absolute bottom-[calc(1.25rem+var(--app-banner-h,0px))] left-5 z-50 flex h-14 w-[260px] items-center gap-2 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-1 flex-1 rounded-full bg-current opacity-10" />
                <div className="h-4 w-10 rounded bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
            </div>
        </main>
    );
}

function ConnectionCreateMenu({ position, title = "引用该节点生成", onCreate, onClose, onUpload, onOpenStoryboard, onOpenSceneCamera, onOpenStage }: { position: Position; title?: string; onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio) => void; onClose: () => void; onUpload?: () => void; onOpenStoryboard?: () => void; onOpenSceneCamera?: () => void; onOpenStage?: () => void }) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    return (
        <div
            className="anim-pop absolute z-[120] w-[300px] rounded-2xl border p-3 backdrop-blur"
            data-connection-create-menu
            style={{
                left: position.x,
                top: position.y,
                background: theme.toolbar.panel,
                borderColor: theme.toolbar.border,
                color: theme.node.text,
                boxShadow: colorTheme === "dark" ? "0 2px 8px rgba(0,0,0,.3), 0 24px 56px rgba(0,0,0,.45)" : "0 2px 8px rgba(15,23,42,.08), 0 24px 56px rgba(15,23,42,.18)",
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {title}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" onClick={onClose} aria-label="关闭">
                    ×
                </button>
            </div>
            {/* grid-cols-1 不是装饰：隐式 auto 轨道的下限受 item 的 min-width:auto 约束，
                会被里面那个 flex 按钮的 min-content 撑到比面板还宽（实测 274px 的容器里轨道变成 304px），
                于是 hover 高亮整条右边溢出面板一截。grid-cols-1 = repeat(1, minmax(0,1fr))，
                minmax 的下限 0 允许轨道压到 min-content 以下，才是这类溢出的标准解法。
                ⚠️ 改按钮（去掉 w-full / 加 box-border）都没用 —— 按钮只是被 stretch 到轨道宽，问题在轨道。 */}
            <div className="grid grid-cols-1 gap-1">
                <ConnectionCreateOption theme={theme} icon={<List className="size-5" />} title="文本生成" description="脚本、广告词、品牌文案" onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-5" />} title="图片生成" onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Video className="size-5" />} title="视频生成" onClick={() => onCreate(CanvasNodeType.Video)} />
                <ConnectionCreateOption theme={theme} icon={<Music2 className="size-5" />} title="音频参考" onClick={() => onCreate(CanvasNodeType.Audio)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-5" />} title="配置节点" description="模型、尺寸、数量和输入顺序" onClick={() => onCreate(CanvasNodeType.Config)} />
                {onUpload || onOpenStoryboard || onOpenSceneCamera || onOpenStage ? <div className="my-1 h-px" style={{ background: theme.toolbar.border }} /> : null}
                {onUpload ? <ConnectionCreateOption theme={theme} icon={<Upload className="size-5" />} title="上传素材" description="图片、视频、音频" onClick={onUpload} /> : null}
                {onOpenStoryboard ? <ConnectionCreateOption theme={theme} icon={<Clapperboard className="size-5" />} title="分镜故事板" description="自动拆解脚本生成分镜" onClick={onOpenStoryboard} /> : null}
{onOpenSceneCamera ? <ConnectionCreateOption theme={theme} icon={<MapIcon className="size-5" />} title="场景机位" description="房间平面图 + 拖相机出各角度" onClick={onOpenSceneCamera} /> : null}
                {onOpenStage ? <ConnectionCreateOption theme={theme} icon={<Box className="size-5" />} title="3D 场景台" description="摆人物走位、掌镜运镜，截图回画布" onClick={onOpenStage} /> : null}
            </div>
        </div>
    );
}

function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: React.ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button type="button" className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition" style={{ color: theme.node.text }} onClick={onClick} onMouseEnter={(event) => (event.currentTarget.style.background = theme.toolbar.itemHover)} onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}>
            <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.activeStroke }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-semibold leading-5">{title}</span>
                {description ? <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>{description}</span> : null}
            </span>
        </button>
    );
}

function CanvasSurfacePage() {
    const { message, modal } = App.useApp();
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const projectId = params.id;
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    // 最近一次写入系统剪贴板的画布标记 token（仅本会话内存弱校验，无敏感信息）；写标记成功才赋值。
    const clipboardTokenRef = useRef<string | null>(null);
    // unifiedPaste 并发互斥：连按/长按 Cmd+V 时避免两个异步实例交错双粘贴或争用 clipboardRef。
    const isPastingRef = useRef(false);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    // 当前撤回历史属于哪个子画布：用来区分「换画布」（该清空）和「同画布重新加载」（必须保留）。
    const historyProjectRef = useRef<string>("");
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        // 最近一帧应用到节点上的位移（含对齐吸附修正），mouseup 时按它提交，保证落点和预览一致。
        lastDx: number;
        lastDy: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        lastDx: 0,
        lastDy: 0,
        initialSelectedNodes: [],
    });

    const config = useConfigStore((state) => state.config);
    const rawEffectiveConfig = useEffectiveConfig();

    // 节点操作面板宽度：偏好里可调。写成 :root 的 CSS 变量，而不是把 config 透传进 CanvasNode——
    // 那个组件【每个节点都渲染一遍】，多一个 store 订阅就会破坏 memo（画布卡顿是老账，别再添）。
    // 越界值落回默认，避免存了个 0 把面板压没。
    useEffect(() => {
        const raw = Number(rawEffectiveConfig.canvasPanelWidth);
        const width = Number.isFinite(raw) && raw >= 420 && raw <= 1400 ? Math.round(raw) : 620;
        document.documentElement.style.setProperty("--canvas-panel-w", `${width}px`);
    }, [rawEffectiveConfig.canvasPanelWidth]);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    // 火山肖像授权总开关（与单图节点工具栏同源）：关时不显示「整组一键肖像授权」入口。
    const portraitAssetEnabled = publicSettings?.portraitAsset?.enabled ?? false;
    // 从别人分享处取用的画布，节点上带的是【原作者账号下】的 asset://。肖像授权绑火山账号+项目，
    // 换个账号那个 assetId 就不存在，一生成就被上游拒：InvalidParameter ... asset ... is not found。
    // 这里检出这些「外人的认证」并给一键重认入口。
    const [foreignPortraitNodes, setForeignPortraitNodes] = useState<string[]>([]);
    const [foreignPortraitDismissed, setForeignPortraitDismissed] = useState(false);
    const [reauthRunning, setReauthRunning] = useState(false);
    const foreignPortraitCheckedRef = useRef("");
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    // 把当前画布所属项目积分池 ID 注入生成配置：所有生成请求最终 spread 此 config，
    // remote 渠道创建任务时透传为 X-Project-ID，让扣费走项目池。无所属项目则不带（走个人积分）。
    // 同时注入当前画布 id（CanvasProject.id），生成请求透传为 X-Canvas-ID 供后端做画布维度统计。
    const effectiveConfig = useMemo(() => ({ ...rawEffectiveConfig, projectId: currentProject?.projectId, canvasId: currentProject?.id }), [rawEffectiveConfig, currentProject?.projectId, currentProject?.id]);
    // 把项目/画布 ID 同步进 config store（非持久化软字段），让不在本页 effectiveConfig 作用域内的组件
    // （故事板/AI助手，经 useEffectiveConfig 取 config）的文本/图片生成也带 projectId → 扣项目池而非个人。
    useEffect(() => {
        useConfigStore.getState().setRuntimeProject(currentProject?.projectId, currentProject?.id);
        // 卸载/切画布时清空：避免残留 projectId 泄漏到画布外的个人生成页（/image、/video 也经 useEffectiveConfig
        // 读它 → 会误扣「上次访问项目」的积分池而非个人）。切画布时先 cleanup 清旧、再 effect 设新，无副作用。
        return () => useConfigStore.getState().setRuntimeProject(undefined, undefined);
    }, [currentProject?.projectId, currentProject?.id]);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [groups, setGroups] = useState<CanvasGroup[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    // 双击画布空白弹出的「添加节点」菜单（世界坐标）
    const [canvasCreateMenu, setCanvasCreateMenu] = useState<Position | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    // 批量「一键生成」会同时跑多个节点，loading 态用 Set 记录所有进行中的节点 id，互不覆盖。
    const [runningNodeIds, setRunningNodeIds] = useState<Set<string>>(new Set());
    const addRunningNodeId = useCallback((id: string) => setRunningNodeIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), []);
    const removeRunningNodeId = useCallback(
        (id: string) =>
            setRunningNodeIds((prev) => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
            }),
        [],
    );
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [assetPickerTab, setAssetPickerTab] = useState<AssetPickerTab>("my-assets");
    const [assetSidebarOpen, setAssetSidebarOpen] = useState(false);
    const [assetSidebarTab, setAssetSidebarTab] = useState<AssetPickerTab>("my-assets");
    const [groupAssetSourceNodeId, setGroupAssetSourceNodeId] = useState<string | null>(null);
    const [groupAssetBusy, setGroupAssetBusy] = useState(false);
    // 正在提交收藏的节点 id。转存参考素材走服务端、可能要几秒，期间按钮转圈并禁用。
    const [favoritePendingNodeId, setFavoritePendingNodeId] = useState("");
    // 当前生效的快捷键：用户自定义覆盖在注册表的默认值之上。
    // 没自定义过的命令拿到的就是默认键位，所以以后调整默认值，老用户会自动跟上。
    const shortcutBindings = useShortcutStore((state) => state.bindings);
    const activeShortcutChords = useMemo(() => resolveShortcutChords(shortcutBindings), [shortcutBindings]);
    const queryClient = useQueryClient();
    const [projectLoaded, setProjectLoaded] = useState(false);
    // 远端更新回灌：记录本次加载的项目时间戳；云同步拉到更新版本且本地无待推送编辑时重新 restore
    const [restoreEpoch, setRestoreEpoch] = useState(0);
    // 拖动期间到达的云端回灌先记在这里，mouseup 后补做——避免重载把正在拖的节点拉回旧坐标。
    // ref 用于拖动过程中记录（不触发渲染），state 用于把补做时机交给 effect 顺序（见持久化 effect 之后那个 effect）。
    const pendingRestoreRef = useRef(false);
    const [pendingRestore, setPendingRestore] = useState(false);
    const loadedProjectStampRef = useRef<string>("");
    const loadedProjectIdRef = useRef<string>("");
    // 打开页面的首次回写不算编辑：跳过持久化，避免把旧内容 bump 成"最新"赢得 LWW
    const skipNextPersistRef = useRef(false);
    // 每次 restore 递增：媒体后台水合完成时校验 seq 未变，防「快速重载/切画布」的迟到水合写脏当前画布
    const restoreSeqRef = useRef(0);
    // 生成二级确认：批量「一键生成」统一确认一次后置位，避免内层 handleGenerateNode 对每个节点再弹窗。
    const bypassGenerateConfirmRef = useRef(false);
    // 防连点：同一源节点在冷却时间内的重复「生成」点击直接忽略——已生成节点重生成会 spawn 新节点且源立即恢复可点，
    // 卡顿时用户狂点会一下 spawn 出一大批（浪费点数/塞满画布）。按 nodeId 记上次触发时刻做冷却；提示做节流不刷屏。
    const generateCooldownRef = useRef<Map<string, number>>(new Map());
    const generateCooldownToastRef = useRef(0);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    // 故事板「解析中」状态放父组件（运行时态，不入 metadata）：请求在父跑，点别处关浮层/重开都不中断
    const [parsingStoryboardIds, setParsingStoryboardIds] = useState<Set<string>>(new Set());
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editRequestNonce, setEditRequestNonce] = useState(0);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [annotateNodeId, setAnnotateNodeId] = useState<string | null>(null);
    const [audioTrimNodeId, setAudioTrimNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const previewVideoRef = useRef<HTMLVideoElement>(null);
    const [sceneDialogNodeId, setSceneDialogNodeId] = useState<string | null>(null);
    const [stageDialogNodeId, setStageDialogNodeId] = useState<string | null>(null);
    const [roomPlanBusyIds, setRoomPlanBusyIds] = useState<Set<string>>(new Set());
    const [roomAngleBusyIds, setRoomAngleBusyIds] = useState<Set<string>>(new Set());
    const [assistantCollapsed, setAssistantCollapsed] = useState(true);
    const [assistantMounted, setAssistantMounted] = useState(false);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    // 画布积分来源：建画布前选定写入 CanvasProject.projectId，之后只读不可改。
    const userToken = useUserStore((state) => state.token);
    const refreshMyProjects = useMyProjectsStore((state) => state.refresh);
    // 当前画布所属项目（在我参与的项目里命中才算有效），用于徽标显示项目余额 + 菜单只读展示。
    const currentSourceProject = useMyProjectsStore((state) => (currentProject?.projectId ? state.projects.find((item) => item.id === currentProject.projectId) : undefined));
    const [creditSourceOpen, setCreditSourceOpen] = useState(false);
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [collapsingBatchIds, setCollapsingBatchIds] = useState<Set<string>>(new Set());
    const [openingBatchIds, setOpeningBatchIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);

    // 项目积分徽标刷新：打开画布时拉一次；每次生成完成（hydrateUser 广播 CREDITS_REFRESHED_EVENT）后重拉，
    // 让项目池扣费后徽标数字跟着变小。无 token 时跳过。
    useEffect(() => {
        if (!userToken) return;
        void refreshMyProjects(userToken);
        const onRefresh = () => void refreshMyProjects(userToken);
        window.addEventListener(CREDITS_REFRESHED_EVENT, onRefresh);
        return () => window.removeEventListener(CREDITS_REFRESHED_EVENT, onRefresh);
    }, [userToken, refreshMyProjects]);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const groupsRef = useRef(groups);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    // 助手读「视口内有哪些节点」要用到当前画布尺寸；跟其它几个 ref 一样在下面的 effect 里同步。
    const sizeRef = useRef(size);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const canvasCreateMenuRef = useRef<Position | null>(null);
    const lastMouseScreenRef = useRef<Position | null>(null);

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            groups: groupsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    useEffect(() => {
        if (!hydrated) return;
        skipNextPersistRef.current = true;
        setProjectLoaded(false);
        const project = openProject(projectId);
        if (!project) {
            router.replace("/canvas");
            return;
        }

        const restore = async () => {
            const seq = (restoreSeqRef.current += 1);
            // 只做同步的结构变换即可上屏；节点媒体（尤其不自愈的视频/音频）改到后台水合，不再阻塞骨架。
            const baseNodes = normalizeMediaNodeSizes(healDegenerateNodes(resetInterruptedGeneration(project.nodes)));
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            if (restoreSeqRef.current !== seq) return;
            setNodes(baseNodes);
            setConnections(project.connections);
            setGroups(project.groups || []);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            // 只有【换了子画布】才清空撤回历史。同一个画布因为合并云端内容而重新加载时必须保留——
            // 否则用户为了让同步恢复正常而重载一次，就把整条撤回链丢了（实际反馈：「一刷新撤回就没用了」）。
            if (historyProjectRef.current !== projectId) {
                historyProjectRef.current = projectId;
                historyRef.current = { past: [], future: [] };
            }
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: baseNodes,
                connections: project.connections,
                groups: project.groups || [],
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            loadedProjectStampRef.current = project.updatedAt || "";
            loadedProjectIdRef.current = project.id;
            skipNextPersistRef.current = true;
            setProjectLoaded(true);
            // 媒体后台水合：不阻塞画布显示。完成后按 id 只补 content（视频/音频不自愈、依赖此步；图片另有 onError 自愈兜底），
            // 只改 content、不改结构；同步 lastHistoryRef 基线避免误入 undo，skipNextPersistRef 跳持久化/云推送避免 churn。
            const baseContentById = new Map<string, string | undefined>();
            for (const item of baseNodes) baseContentById.set(item.id, item.metadata?.content);
            void (async () => {
                const hydratedNodes = await hydrateCanvasImages(baseNodes);
                if (restoreSeqRef.current !== seq || loadedProjectIdRef.current !== project.id) return;
                const hydratedById = new Map<string, CanvasNodeData>();
                for (const item of hydratedNodes) hydratedById.set(item.id, item);
                let changed = false;
                const nextNodes = nodesRef.current.map((node) => {
                    const hydrated = hydratedById.get(node.id);
                    if (!hydrated) return node; // 用户在水合期间新增的节点：不动
                    if (node.metadata?.content !== baseContentById.get(node.id)) return node; // 期间被用户编辑 / 已被图片 onError 自愈：尊重现值
                    if (!node.metadata?.storageKey && hydrated.metadata?.storageKey) {
                        changed = true; // data: 图片迁移支路（新拿到 storageKey）：采用完整水合 metadata
                        return { ...node, metadata: { ...node.metadata, ...hydrated.metadata } };
                    }
                    const resolved = hydrated.metadata?.content;
                    if (node.metadata?.content === resolved) return node;
                    changed = true;
                    return { ...node, metadata: { ...node.metadata, content: resolved } };
                });
                if (!changed) return;
                lastHistoryRef.current = { ...lastHistoryRef.current, nodes: nextNodes };
                skipNextPersistRef.current = true;
                setNodes(nextNodes);
            })();
        };
        void restore();
    }, [hydrated, openProject, projectId, restoreEpoch, router]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (previous?.nodes === next.nodes && previous.connections === next.connections && previous.groups === next.groups && previous.chatSessions === next.chatSessions && previous.activeChatId === next.activeChatId && previous.backgroundMode === next.backgroundMode && previous.showImageInfo === next.showImageInfo) return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, groups, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded) return;
        // 画布内切换项目（同段导航不卸载组件）时，本 effect 可能以「旧项目内容 + 新 projectId」抢跑——
        // 必须校验当前 React 态确实来自这个 projectId，否则会把 A 画布内容写进 B 并经 LWW 扩散到全部设备
        if (loadedProjectIdRef.current !== projectId) return;
        if (skipNextPersistRef.current) {
            skipNextPersistRef.current = false;
            // 【纯观测，不改行为】把这次被吞掉的内容报给服务端。
            //
            // 这个一次性标志本意是「别把 restore 自己那次 setNodes 又写回去」，但它是盲吞下一次：
            // 恰好落在这一拍的真实用户改动会被整个丢掉（store / IndexedDB / 云端都没有）。
            // 拖动落点已确认会撞上并已单独修掉；怀疑肖像授权的写回也会撞上
            //（用户报「认证完显示未认证，反复点了好几次」），但那只是推断。
            // 先把「每次到底吞了什么」记下来，跑一两天看真实分布，再决定怎么根治，
            // 免得凭猜去动这个核心机制。
            try {
                const stored = useCanvasStore.getState().projects.find((p) => p.id === projectId);
                const storedById = new Map((stored?.nodes || []).map((n) => [n.id, n]));
                // 与 store 现状逐节点比对，找出「这次本该写进去、但被吞掉」的节点
                const changed = nodes
                    .filter((n) => JSON.stringify(storedById.get(n.id)?.metadata ?? null) !== JSON.stringify(n.metadata ?? null))
                    .map((n) => `${n.id}:${Object.keys(n.metadata || {}).filter((k) => k.startsWith("portrait")).join(",") || "meta"}`);
                if (changed.length) {
                    void reportPersistSwallow({ projectId, reason: "skipNextPersist", nodeCount: nodes.length, changed: changed.slice(0, 10) });
                }
            } catch {
                /* 诊断本身绝不能影响正常流程 */
            }
            return;
        }
        if (historyPausedRef.current) return;
        const stamp = new Date().toISOString();
        updateProject(projectId, { nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo, updatedAt: stamp }, { touch: false });
        loadedProjectStampRef.current = stamp;
        // 编辑后防抖推送云端，跨设备同步
        scheduleCloudSync();
    }, [activeChatId, backgroundMode, chatSessions, connections, groups, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    // 拖动期间被推迟的云端回灌，在这里补做。
    //
    // 这个 effect 必须声明在【上面那个持久化 effect 之后】——React 按声明顺序执行 effect，
    // 所以同一次 commit 里一定是「先把拖动落点写进 store（上方 updateProject），再触发重载」。
    // 若顺序反过来（或在 mouseup 里直接 setRestoreEpoch），restore effect 会抢先置起
    // skipNextPersistRef 把这次落点整个吞掉，用户松手后节点弹回拖动前坐标、改动彻底丢失。
    useEffect(() => {
        if (!pendingRestore) return;
        setPendingRestore(false);
        setRestoreEpoch((value) => value + 1);
    }, [pendingRestore]);

    // 生成计时(所有节点)：进 loading 记 generationStartedAt(持久化,抗刷新)、出 loading 算 generationMs。
    // 中心化避免改十几个生成起点；写回只在真正发生进/出 loading 时，写后字段满足条件即不再重写，故不循环。
    useEffect(() => {
        if (!projectLoaded) return;
        // 拖拽/整组拖动期间跳过：这一 effect 每帧对全部节点做 O(n) 状态扫描，而拖拽不改生成状态、扫了也没用。
        // 持久化/历史 effect 已由 historyPausedRef 挡住(拖拽起点置 true、finishNodeDrag 复位),这里补齐同一守卫。
        if (historyPausedRef.current) return;
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const starting: string[] = [];
        const ending: Array<{ id: string; ms: number }> = [];
        for (const node of nodes) {
            // 失败(error)即视为结束:失败态没清 imageJobId/videoTaskId,若不排除会让计时不停、且重试时 startedAt 仍在导致不重记
            const inProgress = node.metadata?.status !== NODE_STATUS_ERROR && (node.metadata?.status === NODE_STATUS_LOADING || Boolean(node.metadata?.imageJobId) || Boolean(node.metadata?.videoTaskId));
            if (inProgress && !node.metadata?.generationStartedAt) {
                starting.push(node.id);
            } else if (!inProgress && node.metadata?.generationStartedAt) {
                ending.push({ id: node.id, ms: Math.max(0, nowMs - (Date.parse(node.metadata.generationStartedAt) || nowMs)) });
            }
        }
        if (!starting.length && !ending.length) return;
        setNodes((prev) =>
            prev.map((node) => {
                if (starting.includes(node.id)) return { ...node, metadata: { ...node.metadata, generationStartedAt: nowIso, generationMs: undefined } };
                const end = ending.find((item) => item.id === node.id);
                if (end) return { ...node, metadata: { ...node.metadata, generationStartedAt: undefined, generationMs: end.ms } };
                return node;
            }),
        );
    }, [nodes, projectLoaded]);

    // 云同步完成后：远端有更新且本地没有待推送的编辑时，重新加载项目（让常开页面看得到其它设备的改动）
    useEffect(() => {
        // 回灌 = 整个画布重载（restore 会 setNodes 重建全部节点）。若此刻用户正在拖节点，
        // 被拖的那个会被拉回 store 里的旧坐标——用户看到的就是「拖着拖着卡一下、跳到别处」。
        // 所以拖动期间只记一个待办，等 mouseup 再补做，既不打断操作也不丢远端更新。
        const deferIfDragging = () => {
            if (!dragRef.current.isDraggingNode) return false;
            pendingRestoreRef.current = true;
            return true;
        };
        const onSynced = () => {
            if (!projectLoaded || hasPendingCloudPush()) return;
            const fresh = useCanvasStore.getState().projects.find((item) => item.id === projectId);
            if (!fresh) return;
            if (!fresh.updatedAt || fresh.updatedAt <= loadedProjectStampRef.current) return;
            if (deferIfDragging()) return;
            setRestoreEpoch((value) => value + 1);
        };
        // 推送被拒（收缩护栏）但合并已落地时也要回灌：此时 store 里已经是正确的合并结果，
        // 编辑器却还拿着旧状态；不接过来的话，用户一编辑又写回旧状态，下次推送继续被拦，死循环。
        // 这里【不能】沿用 onSynced 的 hasPendingCloudPush 守卫——被拦时必然有待推送内容，
        // 用那个守卫就永远回灌不了。合并结果本身已经包含本地改动（mergeData(local, remote)），不会丢东西。
        // 回灌不再清空撤回历史（见 historyProjectRef），所以用户不必刷新页面、也不会丢撤回。
        const onRemoteMerged = () => {
            if (!projectLoaded) return;
            const fresh = useCanvasStore.getState().projects.find((item) => item.id === projectId);
            if (!fresh) return;
            if (!fresh.updatedAt || fresh.updatedAt <= loadedProjectStampRef.current) return;
            if (deferIfDragging()) return;
            setRestoreEpoch((value) => value + 1);
        };
        window.addEventListener(CLOUD_SYNCED_EVENT, onSynced);
        window.addEventListener(CLOUD_REMOTE_MERGED_EVENT, onRemoteMerged);
        return () => {
            window.removeEventListener(CLOUD_SYNCED_EVENT, onSynced);
            window.removeEventListener(CLOUD_REMOTE_MERGED_EVENT, onRemoteMerged);
        };
    }, [projectId, projectLoaded]);

    // 图片自愈回写：某 storageKey 被自愈拉回新 URL（image-storage 广播 image-blob-healed）时，把仍是
    // 死 blob: 的节点 content 回写成活链——让参考图缩略图 / 下载 / 图片详情随大图 onError 自愈一起恢复
    // （content 是它们唯一数据源）。skipNextPersistRef 跳过持久化+云推送：纯本会话内存修复，避免把会话级
    // blob URL 持久化引发跨设备 sync churn。
    useEffect(() => {
        const onHealed = (event: Event) => {
            const detail = (event as CustomEvent<{ storageKey?: string; url?: string }>).detail;
            const key = detail?.storageKey;
            const url = detail?.url;
            if (!key || !url) return;
            if (!nodesRef.current.some((node) => node.metadata?.storageKey === key && node.metadata?.content !== url && (node.metadata?.content || "").startsWith("blob:"))) return;
            skipNextPersistRef.current = true;
            setNodes((prev) => prev.map((node) => (node.metadata?.storageKey === key && node.metadata?.content !== url && (node.metadata?.content || "").startsWith("blob:") ? { ...node, metadata: { ...node.metadata, content: url } } : node)));
        };
        window.addEventListener("image-blob-healed", onHealed);
        return () => window.removeEventListener("image-blob-healed", onHealed);
    }, []);

    // 服务端 ffprobe 回来的真实视频规格：把当初因为浏览器解不了、只能按兜底值画出来的节点框改正。
    // 广播源见 services/file-storage.ts 的 scheduleServerVideoProbe。
    //
    // 与上面 image-blob-healed 的关键区别：这里【不】跳过持久化。
    // 那边修的是会话级的 blob: 活链，存下来反而会引发跨设备 churn；
    // 这里改正的宽高是这个视频客观正确的尺寸，本来就该存进画布数据里，否则下次进来又是黑边。
    useEffect(() => {
        const onVideoProbed = (event: Event) => {
            const detail = (event as CustomEvent<{ storageKey?: string; width?: number; height?: number; durationMs?: number; videoCodec?: string; browserPlayable?: boolean }>).detail;
            const key = (detail?.storageKey || "").trim();
            const width = detail?.width || 0;
            const height = detail?.height || 0;
            if (!key || width <= 0 || height <= 0) return;
            if (!nodesRef.current.some((node) => node.metadata?.storageKey === key)) return;
            const size = standardMediaSize(width, height);
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.metadata?.storageKey !== key) return node;
                    const nextMeta = { ...node.metadata, naturalWidth: width, naturalHeight: height, browserPlayable: detail?.browserPlayable === true, videoCodec: detail?.videoCodec };
                    if (detail?.durationMs) nextMeta.durationMs = detail.durationMs;
                    return { ...node, width: size.width, height: size.height, metadata: nextMeta };
                }),
            );
            if (detail?.browserPlayable === false) {
                // 三元写在这里没问题（不是 JSX 属性），但仍摊平成 if——这个文件对 bun 的编译期崩溃格外敏感。
                let codec = (detail?.videoCodec || "").toUpperCase();
                if (!codec) codec = "浏览器不支持的";
                message.warning("这个视频是 " + codec + " 编码，浏览器里播放不了（文件本身没问题，下载下来能正常播）。节点比例已按真实尺寸改正；如果需要在画布里预览或做后续处理，建议先转成 H.264。", 10);
            }
        };
        window.addEventListener(VIDEO_META_PROBED_EVENT, onVideoProbed);
        return () => window.removeEventListener(VIDEO_META_PROBED_EVENT, onVideoProbed);
    }, []);

    // 预览版转好了：把这个节点的播放源换成预览版。
    // ⚠️ 只写 previewContent，绝不动 content——当参考 / 下载 / 后续处理读的都是 content，
    //    那条路必须一直是原片，否则用户会拿 720p 的预览版去做后续处理。
    useEffect(() => {
        const onPreviewReady = (event: Event) => {
            const detail = (event as CustomEvent<{ storageKey?: string; previewUrl?: string }>).detail;
            const key = (detail?.storageKey || "").trim();
            const previewUrl = (detail?.previewUrl || "").trim();
            if (!key || !previewUrl) return;
            if (!nodesRef.current.some((node) => node.metadata?.storageKey === key && node.metadata?.previewContent !== previewUrl)) return;
            setNodes((prev) => prev.map((node) => (node.metadata?.storageKey === key ? { ...node, metadata: { ...node.metadata, previewContent: previewUrl } } : node)));
            message.success("这个视频已生成可播放的预览版，现在可以在画布里播放了（原片未改动，后续处理仍用原片）", 6);
        };
        window.addEventListener(VIDEO_PREVIEW_READY_EVENT, onPreviewReady);
        return () => window.removeEventListener(VIDEO_PREVIEW_READY_EVENT, onPreviewReady);
    }, [message]);

    // 已经在画布里、浏览器放不了、又还没有预览版的视频：补排一次转码。
    // 覆盖两种情况：这个功能上线之前就传进来的，以及转码那次失败了的。
    // 两道去重（本地 Set + 服务端按 storageKey 复用任务）保证不会重复烧 CPU。
    const previewScanRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Video) return;
            const meta = node.metadata;
            if (!meta || meta.browserPlayable !== false || meta.previewContent) return;
            const key = (meta.storageKey || "").trim();
            if (!key || previewScanRef.current.has(key)) return;
            previewScanRef.current.add(key);
            ensureVideoPreview(key);
        });
    }, [nodes]);

    // 找回刷新/切页前进行中的生图任务结果（服务端结果保留 48 小时）
    const resumeImageJobNode = useCallback(
        async (node: CanvasNodeData) => {
            const jobId = node.metadata?.imageJobId;
            if (!jobId) return;
            try {
                const image = (await resumeImageGenerationJob(jobId))[0];
                const uploaded = await uploadImage(image.dataUrl);
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const imageSize = standardMediaSize(uploaded.width, uploaded.height);
                setNodes((prev) =>
                    prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Image, width: imageSize.width, height: imageSize.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), imageJobId: undefined } } : item)),
                );
                message.success("已找回刷新前的生图结果");
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            }
        },
        [message],
    );

    // 找回刷新/切页前进行中的视频任务结果（云端任务保留 48 小时；之前需要手动点重试）
    const resumeVideoTaskNode = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.videoTaskId;
            if (!taskId) return;
            try {
                const config = { ...effectiveConfig, model: node.metadata?.model || effectiveConfig.videoModel || effectiveConfig.model };
                const video = await storeGeneratedVideo(await waitVideoGenerationTask(config, { id: taskId, provider: node.metadata?.videoTaskProvider || "seedance", model: config.model }), config);
                const videoSize = standardMediaSize(video.width || node.width, video.height || node.height);
                setNodes((prev) =>
                    prev.map((item) => (item.id === node.id ? { ...item, width: videoSize.width, height: videoSize.height, metadata: { ...item.metadata, ...videoMetadata(video), videoTaskId: undefined, videoTaskProvider: undefined } } : item)),
                );
                message.success("已找回刷新前的视频生成结果");
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "视频生成失败";
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            }
        },
        [effectiveConfig, message],
    );

    // 画布载入后自动续查进行中的生成任务，刷新/切页不再丢任务。
    // 关键：只恢复「首次载入完成那一刻就已在进行中」的孤儿任务（orphanResumeKeysRef 快照）；
    // 本次会话内新发起的生成由 handleGenerateNode 自己 await，绝不能被这里当成「找回」捞走
    //（否则 effect 因 effectiveConfig 变化重跑时会撞上正在生成的节点，误报「已找回」）。
    const resumedGenerationKeysRef = useRef(new Set<string>());
    const orphanResumeKeysRef = useRef<Set<string> | null>(null);
    useEffect(() => {
        if (!projectLoaded) return;
        // 快照只拍一次、永不重置：生成触发的云端同步会瞬间翻动 projectLoaded，若每次都重拍快照，
        // 就会把「此刻正在生成的本会话任务」也圈进孤儿集→被当成「找回」捞走。只认首次载入那一刻的孤儿。
        const loadingKey = (node: CanvasNodeData) => (node.metadata?.status === NODE_STATUS_LOADING ? node.metadata?.imageJobId || node.metadata?.videoTaskId : undefined);
        if (orphanResumeKeysRef.current === null) {
            orphanResumeKeysRef.current = new Set(nodesRef.current.map(loadingKey).filter((key): key is string => Boolean(key)));
        }
        const orphanKeys = orphanResumeKeysRef.current;
        nodesRef.current.forEach((node) => {
            const resumeKey = loadingKey(node);
            if (!resumeKey || !orphanKeys.has(resumeKey) || resumedGenerationKeysRef.current.has(resumeKey)) return;
            resumedGenerationKeysRef.current.add(resumeKey);
            if (node.metadata?.imageJobId) void resumeImageJobNode(node);
            else void resumeVideoTaskNode(node);
        });
    }, [projectLoaded, resumeImageJobNode, resumeVideoTaskNode]);

    // 服务端兜底：把「本地任务号丢了」的视频节点接回来。
    //
    // 上面那套续查有个前提——节点自己带着 videoTaskId。而 resetInterruptedGeneration 判
    //「页面刷新后生成已中断」也只看这一个字段，从不问服务端。任务号有两条路会丢：
    //   ① 持久化被吞：skipNextPersistRef 是「盲吞下一拍」，任务号写入正好落在那一拍就没了
    //      （触发频率远高于直觉，见本文件 reportPersistSwallow 那处埋点）；
    //   ② 用户在提交请求返回之前就刷新了，任务号压根还没拿到。
    // 一丢，正在正常生成的任务就被判死，用户以为白扣钱、又重新点一遍
    //（典型表现是一分钟内连发三次、白扣三笔，而三个视频后来其实全部生成成功了）。
    //
    // 服务端在提交那一刻就把 canvasId + nodeId 记进了退款候选，这里直接问它要。
    // 三个原则：不阻塞首屏（载入完成后才异步补）、只补「没成片也没任务号」的节点、失败静默。
    const pendingVideoProbeRef = useRef("");
    useEffect(() => {
        if (!projectLoaded || !projectId) return;
        // 一块画布只问一次：生成触发的云端同步会反复翻动 projectLoaded，不设闸会打出一串请求。
        if (pendingVideoProbeRef.current === projectId) return;
        pendingVideoProbeRef.current = projectId;
        let cancelled = false;
        void (async () => {
            // 兜底路径，问不到就维持原样——绝不能因为它让画布出错。
            const pending = await fetchPendingVideoTasks(projectId).catch(() => []);
            if (cancelled || !pending.length) return;
            const taskByNodeId = new Map(pending.map((item) => [item.nodeId, item]));
            const recovered: CanvasNodeData[] = [];
            setNodes((prev) =>
                prev.map((node) => {
                    const hit = taskByNodeId.get(node.id);
                    // 已经拿到成片的、或本来就带着任务号在跑的，一律不碰。
                    if (!hit || node.metadata?.content || node.metadata?.videoTaskId) return node;
                    const next: CanvasNodeData = {
                        ...node,
                        metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, videoTaskId: hit.taskId },
                    };
                    recovered.push(next);
                    return next;
                }),
            );
            // 上面那个续查 effect 的孤儿快照在首屏就拍好了，认不出这批后补的任务号，
            // 所以这里直接交给 resumeVideoTaskNode，别指望它自己发现。
            recovered.forEach((node) => void resumeVideoTaskNode(node));
        })();
        return () => {
            cancelled = true;
        };
    }, [projectLoaded, projectId, resumeVideoTaskNode]);

    // 视频生成中离开画布 → 拦一下。视频的轮询是浏览器在做的：页面一走就没人接收结果，
    // 上游照常出片、点数照扣，片子却认领不回来（孤儿任务，上游约 24h 后删除）。
    // 只对「视频」提醒：图片走后端 job，关页面可续查、完全安全，拦它只会平白骚扰用户。
    const countGeneratingVideos = useCallback(() => nodesRef.current.filter((node) => node.type === CanvasNodeType.Video && node.metadata?.status === NODE_STATUS_LOADING).length, []);

    // ① 关标签页 / 刷新：浏览器原生拦截（文案由浏览器决定，不可自定义）
    useEffect(() => {
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            if (countGeneratingVideos() <= 0) return;
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [countGeneratingVideos]);

    // ② 站内跳转（切子画布/回项目列表/回首页）：beforeunload 不触发，自己拦，文案可自定义
    useEffect(
        () =>
            registerLeaveGuard(countGeneratingVideos, (count, onConfirm) => {
                modal.confirm({
                    title: `还有 ${count} 个视频正在生成`,
                    content: "离开这个画布会中断接收，生成中的视频将无法自动保存到画布（点数已扣除且不会退还）。建议等生成完成后再离开。",
                    okText: "仍要离开",
                    okButtonProps: { danger: true },
                    cancelText: "留在此页",
                    onOk: onConfirm,
                });
            }),
        [countGeneratingVideos, modal],
    );

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            // 纯视角移动不应让项目"变新"参与 LWW 仲裁
            updateProject(projectId, { viewport: viewportRef.current }, { touch: false });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        groupsRef.current = groups;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        sizeRef.current = size;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
        canvasCreateMenuRef.current = canvasCreateMenu;
    }, [nodes, connections, groups, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate, canvasCreateMenu]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    // 工具栏里的下拉菜单（去噪重绘）是否展开。展开期间必须冻结工具栏的切换与隐藏：
    // 菜单是向上弹的，鼠标从按钮移向菜单项的必经之路会掠过【上方那个节点】，
    // 触发 handleNodeHoverStart/End → 工具栏跳到那个节点、或被 hideNodeToolbar 的 120ms 定时器收走，
    // 菜单跟着卸载。更糟的是菜单项是按当前 node 重建的，工具栏一跳，点下去就作用到错误的节点上，
    // 而且按「灰模 + 重绘」两步扣费。
    const toolbarMenuOpenRef = useRef(false);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (toolbarMenuOpenRef.current) return;
            if (nodeDraggingRef.current || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarMenuOpenRef.current) return;
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            setToolbarNodeId(null);
            toolbarHideTimerRef.current = null;
        }, 120);
    }, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [message],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count) } : defaultAspectMeta(type);
            // 连续在同一手柄创建下一步节点时落点相同会重合,级联偏移开
            const newNode = createCanvasNode(type, findFreeCenter(pending.position, nodesRef.current), metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);


    // 双击画布空白：在双击处弹出节点类型菜单
    const handleCanvasDoubleClick = useCallback(
        (clientX: number, clientY: number) => {
            setCanvasCreateMenu(screenToCanvas(clientX, clientY));
        },
        [screenToCanvas],
    );

    const createNodeAtMenu = useCallback((type: CanvasNodeType) => {
        const position = canvasCreateMenuRef.current;
        if (!position) return;
        // 双击/菜单落点尽量保留;落点已被占则级联偏移开,避免完全盖住下层节点
        const node = createCanvasNode(type, findFreeCenter(position, nodesRef.current), defaultAspectMeta(type));
        setNodes((prev) => [...prev, node]);
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setCanvasCreateMenu(null);
    }, []);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current]
                .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                .reverse()
                .forEach((node) => {
                    const anchor = getConnectionTargetAnchor(node, current);
                    const dx = world.x - anchor.x;
                    const dy = world.y - anchor.y;
                    const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                    const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                    const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                    if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                    isNearNode = true;
                    if (node.id === current.nodeId || !normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)) return;

                    const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                    if (priority < bestPriority) {
                        bestNodeId = node.id;
                        bestPriority = priority;
                    }
                });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    // 拖动连线时鼠标贴近画布边缘 → 自动平移视口（方便从顶部节点连到很远的底部节点，无需手动缩小）
    const edgeScrollRafRef = useRef<number | null>(null);
    const edgeScrollVelRef = useRef({ x: 0, y: 0 });
    const lastPointerRef = useRef({ x: 0, y: 0 });

    const stopEdgeAutoScroll = useCallback(() => {
        if (edgeScrollRafRef.current != null) {
            cancelAnimationFrame(edgeScrollRafRef.current);
            edgeScrollRafRef.current = null;
        }
        edgeScrollVelRef.current = { x: 0, y: 0 };
    }, []);

    const runEdgeAutoScroll = useCallback(() => {
        const step = () => {
            const vel = edgeScrollVelRef.current;
            if (!connectingParamsRef.current || pendingConnectionCreateRef.current || (vel.x === 0 && vel.y === 0)) {
                edgeScrollRafRef.current = null;
                return;
            }
            // 平移视口揭示边缘外内容；视口变化后光标处世界坐标随之改变，同步预览线端点与落点高亮
            setViewport((prev) => ({ ...prev, x: prev.x + vel.x, y: prev.y + vel.y }));
            const { x: cx, y: cy } = lastPointerRef.current;
            setMouseWorld(screenToCanvas(cx, cy));
            const dropTarget = getConnectionDropTarget(cx, cy, connectingParamsRef.current);
            connectionTargetNodeIdRef.current = dropTarget.nodeId;
            setConnectionTargetNodeId(dropTarget.nodeId);
            edgeScrollRafRef.current = requestAnimationFrame(step);
        };
        edgeScrollRafRef.current = requestAnimationFrame(step);
    }, [getConnectionDropTarget, screenToCanvas]);

    const updateEdgeAutoScroll = useCallback(
        (clientX: number, clientY: number) => {
            lastPointerRef.current = { x: clientX, y: clientY };
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const margin = 64; // 边缘触发区宽度
            const maxSpeed = 22; // 每帧最大平移像素（越贴边越快）
            const speedAt = (dist: number) => (dist >= margin ? 0 : maxSpeed * (1 - Math.max(0, dist) / margin));
            let vx = 0;
            let vy = 0;
            const leftDist = clientX - rect.left;
            const rightDist = rect.right - clientX;
            const topDist = clientY - rect.top;
            const bottomDist = rect.bottom - clientY;
            if (leftDist < margin) vx = speedAt(leftDist);
            else if (rightDist < margin) vx = -speedAt(rightDist);
            if (topDist < margin) vy = speedAt(topDist);
            else if (bottomDist < margin) vy = -speedAt(bottomDist);
            edgeScrollVelRef.current = { x: vx, y: vy };
            if ((vx !== 0 || vy !== 0) && edgeScrollRafRef.current == null) runEdgeAutoScroll();
            else if (vx === 0 && vy === 0) stopEdgeAutoScroll();
        },
        [runEdgeAutoScroll, stopEdgeAutoScroll],
    );

    const visibleNodes = useMemo(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        // 视口裁剪边距（世界坐标）：约一屏。故意偏大——imperative 平移期裁剪冻结，边距大才能让拖动方向上的
        // 节点提前挂载(用户拖过去立刻看到内容，不至于拖进空白不知道到哪了)。首次进画布多加载的图会被 IndexedDB 缓存，再进秒显。
        const padding = Math.max(width, height) / viewport.k;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return nodes.filter((node) => !isHiddenBatchChild(node, nodes, collapsingBatchIds) && node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
    }, [collapsingBatchIds, nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    // 节点 → 所属组（一节点最多一组）
    const groupByNodeId = useMemo(() => {
        const map = new Map<string, CanvasGroup>();
        groups.forEach((group) => group.memberNodeIds.forEach((id) => map.set(id, group)));
        return map;
    }, [groups]);

    // 连线视口裁剪：贝塞尔曲线一定落在四个控制点的凸包内，用凸包包围盒与视口判交，
    // 数千连线时平移只渲染可见部分（节点的裁剪在 visibleNodes）。
    const visibleConnections = useMemo(() => {
        // 缩得很小时不渲染连线。缩放下限 0.05，而连线线宽是固定的 2~3 世界单位，
        // 该缩放下渲染出来不到半个屏幕像素——本来就看不见，却是实打实的 DOM 开销：
        // 每条连线两个 path（可见线 + strokeWidth=16 的命中区），两千条连线就是四千多个元素。
        //
        // ⚠️ 正在拉线时必须照常渲染：用户在小缩放下连完线却看不见，会以为没连上而反复重连。
        if (!connectingParams && viewport.k < CONNECTION_RENDER_MIN_ZOOM) return [];
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        // 视口裁剪边距（世界坐标）：约一屏，与 visibleNodes 一致（imperative 平移期裁剪冻结，边距大才不 pop-in）。
        const padding = Math.max(width, height) / viewport.k;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return connections.filter((connection) => {
            const from = nodeById.get(connection.fromNodeId);
            const to = nodeById.get(connection.toNodeId);
            if (!from || !to || isHiddenBatchConnectionEndpoint(from, nodes) || isHiddenBatchConnectionEndpoint(to, nodes)) return false;
            const startX = from.position.x + from.width;
            const startY = from.position.y + from.height / 2;
            const endX = to.position.x;
            const endY = to.position.y + to.height / 2;
            const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
            const minX = Math.min(startX, endX - curvature);
            const maxX = Math.max(endX, startX + curvature);
            const minY = Math.min(startY, endY);
            const maxY = Math.max(startY, endY);
            return maxX > viewLeft && minX < viewRight && maxY > viewTop && minY < viewBottom;
        });
    }, [connectingParams, connections, nodeById, nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);
    // 选中单个节点时工具栏常驻显示（直到点空白处或选别的节点）；未选中时回退到悬停显示。
    const selectedSingleNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNodeIdEffective = selectedSingleNodeId ?? toolbarNodeId;
    const toolbarNode = toolbarNodeIdEffective ? nodeById.get(toolbarNodeIdEffective) || null : null;
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const annotateNode = annotateNodeId ? nodeById.get(annotateNodeId) || null : null;
    const groupAssetSourceNode = groupAssetSourceNodeId ? nodeById.get(groupAssetSourceNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const sceneNode = sceneDialogNodeId ? nodeById.get(sceneDialogNodeId) || null : null;
    const stageNode = stageDialogNodeId ? nodeById.get(stageDialogNodeId) || null : null;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const batchChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            if (node.metadata?.isBatchRoot) map.set(node.id, node.metadata.batchChildIds?.length || 0);
        });
        return map;
    }, [nodes]);
    const batchMotionById = useMemo(() => {
        const map = new Map<string, { x: number; y: number; index: number }>();
        nodes.forEach((node) => {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) return;
            const root = nodeById.get(rootId);
            const index = root?.metadata?.batchChildIds?.indexOf(node.id) ?? 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            map.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
        });
        return map;
    }, [nodeById, nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);
    const resourceContextNodeId = dialogNodeId || activeNodeId;
    const canvasResourceReferences = useMemo(() => buildCanvasResourceReferences(nodes, connections, resourceContextNodeId), [connections, nodes, resourceContextNodeId]);
    const resourceReferenceByNodeId = useMemo(() => new Map(canvasResourceReferences.map((reference) => [reference.nodeId, reference])), [canvasResourceReferences]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        nodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, nodes, connections)));
        return map;
    }, [connections, nodes]);
    // 选区浮动工具栏：模式 + 世界包围盒（顶边居中处浮出）
    const selectionToolbar = useMemo(() => {
        const empty = { mode: null as "group" | "ungroup" | null, bounds: null, groupId: null as string | null, canGenerateImage: false, canGenerateVideo: false, canCombineGrid: false, canFaceAuth: false, regenIds: [] as string[], emptyGenIds: [] as string[] };
        if (selectedNodeIds.size < 2 || selectionBox || isNodeDragging) return empty;
        const ids = Array.from(selectedNodeIds).filter((id) => {
            const node = nodeById.get(id);
            return node && !isHiddenBatchChild(node, nodes);
        });
        if (ids.length < 2) return empty;
        // 选中是否全部落在同一个组内 → 显示「解组」；否则显示「打组」
        const groupIds = new Set(ids.map((id) => groupByNodeId.get(id)?.id));
        const allSameGroup = groupIds.size === 1 && !groupIds.has(undefined);
        const groupId = allSameGroup ? (groupByNodeId.get(ids[0])?.id ?? null) : null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        for (const id of ids) {
            const node = nodeById.get(id);
            if (!node) continue;
            minX = Math.min(minX, node.position.x);
            minY = Math.min(minY, node.position.y);
            maxX = Math.max(maxX, node.position.x + node.width);
        }
        // 组内「待生成」节点统计：空内容 + 非进行中的图片/视频节点 → 决定一键生图/生视频是否亮起
        let canGenerateImage = false;
        let canGenerateVideo = false;
        // 肖像授权亮起：组内存在「已出图、且未认证 / 非认证中」的图片节点（与待生成判据相反，认的是有内容的图）
        let canFaceAuth = false;
        if (groupId) {
            const group = groups.find((item) => item.id === groupId);
            for (const memberId of group?.memberNodeIds ?? []) {
                const node = nodeById.get(memberId);
                if (!node) continue;
                if (node.type === CanvasNodeType.Image && node.metadata?.content && node.metadata?.portraitAssetStatus !== "active" && node.metadata?.portraitAssetStatus !== "processing") canFaceAuth = true;
                if (node.metadata?.content || node.metadata?.status === NODE_STATUS_LOADING || node.metadata?.imageJobId || node.metadata?.videoTaskId) continue;
                if (node.type === CanvasNodeType.Image) canGenerateImage = true;
                else if (node.type === CanvasNodeType.Video) canGenerateVideo = true;
            }
        }
        // 拼合按钮：选中里含 ≥2 张「有内容的图片」节点即可亮起。
        const canCombineGrid = ids.filter((id) => { const node = nodeById.get(id); return node?.type === CanvasNodeType.Image && Boolean(node.metadata?.content); }).length >= 2;
        // 批量生成（新按钮）：一律按【当前选中集】算，不走上面那套「成组后按整组成员」的老判据。
        //   regenIds    = 已出内容、可重跑一遍的节点（图片/视频/音频）
        //   emptyGenIds = 还没内容、等着被生成的节点（与老的 canGenerateImage/Video 同义，但作用域是选中集）
        // 进行中的一律排除：判据与 :1527 和 isNodeInProgress(:5611) 逐字同源，三处必须一起改。
        const regenIds: string[] = [];
        const emptyGenIds: string[] = [];
        for (const id of ids) {
            const node = nodeById.get(id);
            if (!node) continue;
            if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) continue;
            if (node.metadata?.status === NODE_STATUS_LOADING || node.metadata?.imageJobId || node.metadata?.videoTaskId) continue;
            if (node.metadata?.content) regenIds.push(id);
            else if (node.type !== CanvasNodeType.Audio) emptyGenIds.push(id);
        }
        return { mode: (allSameGroup ? "ungroup" : "group") as "group" | "ungroup", bounds: { left: minX, top: minY, width: maxX - minX }, groupId, canGenerateImage, canGenerateVideo, canCombineGrid, canFaceAuth, regenIds, emptyGenIds };
    }, [groupByNodeId, groups, isNodeDragging, nodeById, nodes, selectedNodeIds, selectionBox]);

    // 节点自定义命名：给任何缺 nameSeq 的节点(新建/上传/切图/拼合子节点/老项目加载)按出现顺序补「同类型稳定序号」。
    // 幂等：全部已有序号时返回同一引用、不触发额外渲染；删除节点不回收序号，符合「按创建顺序」直觉。
    useEffect(() => {
        setNodes((prev) => (prev.every((node) => typeof node.nameSeq === "number") ? prev : backfillNameSeq(prev)));
    }, [nodes]);

    // 节点重命名：value 为空 → 还原默认名(清自定义)；否则存为自定义名。
    const renameNode = useCallback((id: string, value: string) => {
        const trimmed = value.trim();
        setNodes((prev) => prev.map((node) => (node.id === id ? { ...node, name: trimmed || undefined, nameIsCustom: Boolean(trimmed) } : node)));
    }, []);

    const createNode = useCallback(
        (type: CanvasNodeType, position?: Position) => {
            // 落点已被占(如重复在视口中心新建)则级联偏移,避免与已有节点完全重合
            const targetPosition = findFreeCenter(position || getCanvasCenter(), nodesRef.current);
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : defaultAspectMeta(type);
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    const createSceneCameraNode = useCallback(
        (position?: Position) => {
            const node = createCanvasNode(CanvasNodeType.SceneCamera, findFreeCenter(position || getCanvasCenter(), nodesRef.current), { roomScene: normalizeRoomScene(undefined) });
            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setSceneDialogNodeId(node.id);
        },
        [getCanvasCenter],
    );
    // 接收场景台回传的机位截图，落成画布图片节点。
    //
    // 关键取舍：先把 dataUrl 走 uploadImage 落成正式素材（拿到 storageKey），再建节点。
    // 不直接把 base64 塞进 metadata.content——那会把几 MB 的字符串写进画布数据、
    // 跟着每次云同步来回传，正是本项目历史上撑爆同步清单的做法。
    const handleStageCaptures = useCallback(
        async (stageNodeId: string, captures: DirectorCapture[]) => {
            const source = nodesRef.current.find((item) => item.id === stageNodeId);
            if (!source) return;
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const created: CanvasNodeData[] = [];
            let failed = 0;
            // 截图放在场景台节点右侧，纵向排开，避免叠在一起。
            let anchorX = source.position.x + source.width + 60;
            let anchorY = source.position.y;

            for (const capture of captures) {
                try {
                    // uploadImage 直接吃 dataUrl 字符串（内部会转 blob 落 IndexedDB 并即时推一份到云端）。
                    const uploaded = await uploadImage(capture.dataUrl);
                    const size = standardMediaSize(uploaded.width || spec.width, uploaded.height || spec.height, STANDARD_NODE_HEIGHT);
                    created.push({
                        id: `image-${Date.now()}-${created.length}-${Math.random().toString(36).slice(2, 7)}`,
                        type: CanvasNodeType.Image,
                        title: capture.fileName,
                        position: { x: anchorX, y: anchorY },
                        width: size.width,
                        height: size.height,
                        metadata: {
                            content: uploaded.url,
                            storageKey: uploaded.storageKey,
                            status: NODE_STATUS_SUCCESS,
                            naturalWidth: uploaded.width,
                            naturalHeight: uploaded.height,
                            mimeType: "image/png",
                            // 记一下来源，用户日后在节点信息里能看出这张图是场景台出的。
                            generationMode: "image",
                        },
                    });
                    anchorY += size.height + 24;
                } catch {
                    failed += 1;
                }
            }

            if (!created.length) {
                message.error("截图保存失败，请重试");
                return;
            }

            const cover = created[0];
            setNodes((prev) => {
                const next = [...prev, ...created];
                return next.map((item) => {
                    if (item.id !== stageNodeId) return item;
                    const stage = item.metadata?.stage;
                    return {
                        ...item,
                        metadata: {
                            ...item.metadata,
                            stage: {
                                instanceId: stage?.instanceId || item.id,
                                captureCount: (stage?.captureCount ?? 0) + created.length,
                                coverStorageKey: cover.metadata?.storageKey,
                                coverUrl: cover.metadata?.content,
                                updatedAt: new Date().toISOString(),
                            },
                        },
                    };
                });
            });
            // 连线：场景台 → 各张截图，让来源关系在画布上看得见，也让截图能直接当下游生成的参考。
            setConnections((prev) => [...prev, ...created.map((node, index) => ({ id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`, fromNodeId: stageNodeId, toNodeId: node.id }))]);
            setSelectedNodeIds(new Set(created.map((node) => node.id)));

            if (failed > 0) {
                message.warning(`已保存 ${created.length} 张，${failed} 张失败`);
                return;
            }
            message.success(`已保存 ${created.length} 张机位截图到画布`);
        },
        [message],
    );

    // 接收场景台录好的运镜视频，落成画布上的视频节点。
    //
    // 视频是通过 postMessage 以 Blob 原样传回来的（结构化克隆原生支持 Blob，
    // 不必转 base64——几十 MB 的视频转 base64 会膨胀三分之一还卡主线程）。
    // 这里和截图那条路一样：先 uploadMediaFile 落成正式素材拿到 storageKey，再建节点，
    // 绝不把媒体本身塞进画布数据。
    const handleStageVideo = useCallback(
        async (stageNodeId: string, result: DirectorVideoResult) => {
            const source = nodesRef.current.find((item) => item.id === stageNodeId);
            if (!source) return;
            const uploaded = await uploadMediaFile(result.blob, "video");
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
            const size = standardMediaSize(uploaded.width || result.width || spec.width, uploaded.height || result.height || spec.height, STANDARD_NODE_HEIGHT);
            const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            // 放在场景台节点右侧；和截图落点错开一点，避免两种产出叠在一起。
            const position = { x: source.position.x + source.width + 60, y: source.position.y - size.height - 24 };
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Video,
                title: result.fileName || `${getNodeDisplayName(source)}-运镜`,
                position,
                width: size.width,
                height: size.height,
                metadata: videoMetadata(uploaded),
            };
            setNodes((prev) => [...prev, node]);
            // 连一条来源线，和截图那条一致：只是血缘标记，不参与生成。
            setConnections((prev) => [...prev, { id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, fromNodeId: stageNodeId, toNodeId: id }]);
            setSelectedNodeIds(new Set([id]));
        },
        [],
    );

    // 新功能引导的「带我去看收藏」：把收藏按钮真的亮给用户看。
    //
    // 收藏按钮长在节点的悬浮工具栏里，平时要 hover 才出现、而且那个节点得已经出了图。
    // 所以这里优先挑一个已出图的图片/视频节点，选中它并把工具栏亮出来——用户一眼就看到按钮在哪。
    // 画布上没有可收藏的节点时（比如新画布），退而打开素材侧栏的「收藏提示词」，
    // 至少让他知道收藏的东西以后去哪儿找。
    const revealFavoriteEntry = useCallback(() => {
        const target = nodesRef.current.find((node) => (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && Boolean(node.metadata?.content));
        if (!target) {
            setAssetSidebarTab("prompt-favorites");
            setAssetSidebarOpen(true);
            message.info("画布上还没有生成好的图片或视频。等出图后，把鼠标移到节点上就能看到「收藏」按钮");
            return;
        }
        setSelectedNodeIds(new Set([target.id]));
        setSelectedConnectionId(null);
        setToolbarNodeId(target.id);
        message.info("鼠标移到节点上方的工具栏，点「收藏」就能把这次的提示词和参考素材存下来");
    }, [message]);

    // 新建 3D 场景台节点。
    //
    // instanceId 直接用节点 id：场景台按这个键在浏览器本地隔离工程，一个节点＝一份独立场景，
    // 而节点 id 本身会随画布同步到其它设备（工程内容不会，见 canvas-stage.ts 的说明）。
    const createStageNode = useCallback(
        (position?: Position) => {
            const node = createCanvasNode(CanvasNodeType.Stage, findFreeCenter(position || getCanvasCenter(), nodesRef.current), {});
            const withStage: CanvasNodeData = { ...node, metadata: { ...node.metadata, stage: createStageState(node.id) } };
            setNodes((prev) => [...prev, withStage]);
            setSelectedNodeIds(new Set([withStage.id]));
            setSelectedConnectionId(null);
            setStageDialogNodeId(withStage.id);
        },
        [getCanvasCenter],
    );
    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            nodesRef.current.forEach((node) => {
                if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
            });
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const childIds = node.metadata?.batchChildIds?.filter((childId) => !allIds.has(childId));
                    if (!node.metadata?.isBatchRoot || childIds?.length === node.metadata.batchChildIds?.length) return node;
                    const primaryImageId = childIds?.includes(node.metadata.primaryImageId || "") ? node.metadata.primaryImageId : childIds?.[0];
                    const primaryNode = next.find((item) => item.id === primaryImageId);
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            batchChildIds: childIds,
                            primaryImageId,
                            content: primaryNode?.metadata?.content || node.metadata.content,
                            naturalWidth: primaryNode?.metadata?.naturalWidth || node.metadata.naturalWidth,
                            naturalHeight: primaryNode?.metadata?.naturalHeight || node.metadata.naturalHeight,
                        },
                    };
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            // 被删节点从所属组移除；成员清空的组自动删除
            setGroups((prev) =>
                prev
                    .map((group) => ({ ...group, memberNodeIds: group.memberNodeIds.filter((id) => !allIds.has(id)) }))
                    .filter((group) => group.memberNodeIds.length > 0),
            );
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setAnnotateNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeIds((current) => {
                if (!Array.from(current).some((id) => allIds.has(id))) return current;
                return new Set(Array.from(current).filter((id) => !allIds.has(id)));
            });
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    // 稳定的连线事件处理器（按 id 分发）：让传给 ConnectionPath 的 props 在平移/缩放期恒定不变，
    // 配合 memo(ConnectionPath) 避免每帧重渲全部可见连线（重连线画布卡顿的头号来源）。onDelete 直接复用 deleteConnection（已 useCallback）。
    const handleConnectionSelect = useCallback((connectionId: string) => {
        setSelectedConnectionId(connectionId);
        setSelectedNodeIds(new Set());
        setContextMenu(null);
    }, []);
    const handleConnectionContextMenu = useCallback((connectionId: string, event: ReactMouseEvent<SVGPathElement>) => {
        setSelectedConnectionId(connectionId);
        setSelectedNodeIds(new Set());
        setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId });
    }, []);

    // 移除某节点的一条参考：删掉「源节点 → 目标节点」的连线（提示词框参考缩略图右上角叉号触发），
    // 同时从目标节点正文里抹掉对应 @[node:sourceNodeId] token，避免正文残留无对应 chip 的裸引用（bug ⑤）。
    const removeNodeReference = useCallback(
        (targetNodeId: string, sourceNodeId: string) => {
            const conn = connectionsRef.current.find((item) => item.fromNodeId === sourceNodeId && item.toNodeId === targetNodeId);
            if (conn) deleteConnection(conn.id);
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id !== targetNodeId) return node;
                    const metadata = node.metadata;
                    if (!metadata) return node;
                    const patch: Partial<CanvasNodeData["metadata"]> = {};
                    // 只改原本含该 token 的字段：promptDraft（草稿）、composerContent（Config 编排）、prompt（生效版）。
                    if (typeof metadata.promptDraft === "string" && metadata.promptDraft.includes(`@[node:${sourceNodeId}]`)) patch.promptDraft = stripMentionToken(metadata.promptDraft, sourceNodeId);
                    if (typeof metadata.composerContent === "string" && metadata.composerContent.includes(`@[node:${sourceNodeId}]`)) patch.composerContent = stripMentionToken(metadata.composerContent, sourceNodeId);
                    if (typeof metadata.prompt === "string" && metadata.prompt.includes(`@[node:${sourceNodeId}]`)) patch.prompt = stripMentionToken(metadata.prompt, sourceNodeId);
                    return Object.keys(patch).length ? { ...node, metadata: { ...metadata, ...patch } } : node;
                }),
            );
        },
        [deleteConnection],
    );

    // 当前选中节点是否可打组：>1 个有效成员，且未全部已在同一个现有组内
    const groupableSelectedIds = useCallback(() => {
        const selected = selectedNodeIdsRef.current;
        const currentNodes = nodesRef.current;
        const groupMap = new Map<string, CanvasGroup>();
        groupsRef.current.forEach((group) => group.memberNodeIds.forEach((id) => groupMap.set(id, group)));
        // 过滤掉折叠批次的隐藏子节点（它们随根节点动，单独成组无意义）
        const ids = Array.from(selected).filter((id) => {
            const node = currentNodes.find((item) => item.id === id);
            return node && !isHiddenBatchChild(node, currentNodes);
        });
        return ids;
    }, []);

    // 组内排序：复用画布那套 computeSortLayout（空 groupByNode → 组内每个成员各自为单元、在组内部重排），支持 4 模式。
    // 注意：必须定义在 arrangeGroup 之前——arrangeGroup 的依赖数组引用它，顺序颠倒会触发 TDZ。
    const arrangeGroupMembers = useCallback((memberNodeIds: string[], mode: SortMode) => {
        const currentNodes = nodesRef.current;
        const memberSet = new Set(memberNodeIds);
        // 只对「可见成员」（排除折叠批次的隐藏子节点）做布局
        const layoutMembers = currentNodes.filter((node) => memberSet.has(node.id) && !isHiddenBatchChild(node, currentNodes));
        if (layoutMembers.length < 2) return;
        const patches = computeSortLayout(layoutMembers, connectionsRef.current, new Map(), mode);
        if (!patches.size) return;
        const deltaById = new Map<string, Position>();
        layoutMembers.forEach((node) => {
            const next = patches.get(node.id);
            if (!next) return;
            const delta = { x: next.x - node.position.x, y: next.y - node.position.y };
            deltaById.set(node.id, delta);
            // 批次子节点跟随其根节点一起位移
            node.metadata?.batchChildIds?.forEach((childId) => {
                if (!deltaById.has(childId)) deltaById.set(childId, delta);
            });
        });
        setNodes((prev) =>
            prev.map((node) => {
                const delta = deltaById.get(node.id);
                return delta ? { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } } : node;
            }),
        );
    }, []);

    const createGroupFromSelection = useCallback(() => {
        const ids = groupableSelectedIds();
        if (ids.length < 2) return;
        // 把被选中根节点的批次子节点一并纳入组，保证整组拖动/背景框覆盖完整
        const currentNodes = nodesRef.current;
        const memberSet = new Set(ids);
        currentNodes.forEach((node) => {
            if (memberSet.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => memberSet.add(childId));
        });
        const memberNodeIds = Array.from(memberSet);
        // 成员从其它已有组中迁出（一节点最多一组），随后清理因此被掏空的旧组
        const newGroup: CanvasGroup = { id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, memberNodeIds, createdAt: new Date().toISOString() };
        setGroups((prev) => {
            const moved = new Set(memberNodeIds);
            const trimmed = prev
                .map((group) => ({ ...group, memberNodeIds: group.memberNodeIds.filter((id) => !moved.has(id)) }))
                .filter((group) => group.memberNodeIds.length > 0);
            return [...trimmed, newGroup];
        });
        setContextMenu(null);
    }, [groupableSelectedIds]);

    const ungroupNodes = useCallback((groupId: string) => {
        // 解组只移除组实体，成员节点位置保持不变
        setGroups((prev) => prev.filter((group) => group.id !== groupId));
        setContextMenu(null);
    }, []);

    const renameGroup = useCallback((groupId: string, title: string) => {
        setGroups((prev) => prev.map((group) => (group.id === groupId ? { ...group, title } : group)));
    }, []);

    const arrangeGroup = useCallback(
        (groupId: string, mode: SortMode) => {
            const group = groupsRef.current.find((item) => item.id === groupId);
            if (!group) return;
            arrangeGroupMembers(group.memberNodeIds, mode);
            setContextMenu(null);
        },
        [arrangeGroupMembers],
    );

    // 整组存入「我的素材」：打包组成员节点 + 内部连线为一个 group 素材（个人素材、云同步），跨画布调回时重建（见 handleAssetInsert 的 group 分支）。
    const serializeGroupToAsset = useCallback(
        (groupId: string) => {
            const group = groupsRef.current.find((item) => item.id === groupId);
            if (!group) return;
            const memberSet = new Set(group.memberNodeIds);
            const members = nodesRef.current.filter((node) => memberSet.has(node.id));
            if (!members.length) return;
            // 只保留组内部连线（两端都在组内）
            const internalConnections = connectionsRef.current.filter((c) => memberSet.has(c.fromNodeId) && memberSet.has(c.toNodeId));
            // 封面：首个有内容的图片成员（没有则空，卡片显标题占位）
            const coverNode = members.find((node) => node.type === CanvasNodeType.Image && node.metadata?.content);
            addAsset({
                kind: "group",
                title: group.title?.trim() || `画布组（${members.length} 个节点）`,
                coverUrl: coverNode?.metadata?.content || "",
                tags: [],
                source: "Canvas",
                data: {
                    title: group.title || "",
                    nodes: members.map((node) => ({ ...node, metadata: node.metadata ? { ...node.metadata } : undefined })),
                    connections: internalConnections.map((c) => ({ ...c })),
                },
                metadata: { source: "canvas", groupId: group.id, nodeCount: members.length, coverStorageKey: coverNode?.metadata?.storageKey },
            });
            message.success("已把整组存入「我的素材」");
            setContextMenu(null);
        },
        [addAsset, message],
    );

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setCanvasCreateMenu(null);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setGroups([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeIds(new Set());
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        // 复制与原节点相连的连线：上游参考照样垫入副本，下游引用也保持
        const copiedConnections = connectionsRef.current.flatMap((connection) => {
            if (connection.fromNodeId !== nodeId && connection.toNodeId !== nodeId) return [];
            return [
                {
                    id: nanoid(),
                    fromNodeId: connection.fromNodeId === nodeId ? id : connection.fromNodeId,
                    toNodeId: connection.toNodeId === nodeId ? id : connection.toNodeId,
                },
            ];
        });
        // 副本若有上游参考输入，清掉已生成输出 → 点生成在原地重出
        const hasUpstreamInput = copiedConnections.some((connection) => connection.toNodeId === id);
        const next = resetCopiedGenerationOutput(
            {
                ...source,
                id,
                title: `${source.title} Copy`,
                // 自定义命名：副本叫「<原名>副本 / 副本2…」，新分配 nameSeq（置空交给 backfill 补）。
                name: deriveCopyName(getNodeDisplayName(source), collectDisplayNames(nodesRef.current)),
                nameIsCustom: true,
                nameSeq: undefined,
                position: { x: source.position.x + 36, y: source.position.y + 36 },
                metadata: source.metadata ? { ...source.metadata } : undefined,
            },
            hasUpstreamInput,
        );

        setNodes((prev) => [...prev, next]);
        if (copiedConnections.length) setConnections((prev) => [...prev, ...copiedConnections]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    // 复制节点「不含连线」：纯独立副本，不复制任何上/下游连线、保留已生成内容（图片/视频原样带走）。
    const duplicateNodeNoConnections = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;
        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next = resetCopiedGenerationOutput(
            {
                ...source,
                id,
                title: `${source.title} Copy`,
                name: deriveCopyName(getNodeDisplayName(source), collectDisplayNames(nodesRef.current)),
                nameIsCustom: true,
                nameSeq: undefined,
                position: { x: source.position.x + 36, y: source.position.y + 36 },
                metadata: source.metadata ? { ...source.metadata } : undefined,
            },
            false, // 无上游输入 → 保留已生成输出
        );
        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        // 复制时保留连线偏好（配置与用户偏好）。零三元避 bun SIGILL。
        const keepConnections = useConfigStore.getState().config.copyKeepConnections !== false;
        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => {
                let metadata: CanvasNodeData["metadata"] = undefined;
                if (node.metadata) metadata = { ...node.metadata };
                // 复制不带连线：一并清掉「重生成会复刻的缓存上游参考」(metadata.references)，保证不仅画布无连线、
                // 真正送模型的也不带上游图/视频（task3 复核补丁：resolveMetadataReferences 会绕过连线复刻缓存参考）。
                if (!keepConnections && metadata) {
                    metadata = { ...metadata, references: undefined };
                    if (metadata.generationType === "edit") metadata.generationType = "generation";
                }
                return { ...node, position: { ...node.position }, metadata };
            });

        if (!copiedNodes.length) return;

        let clipboardConnections: CanvasConnection[] = [];
        if (keepConnections) {
            clipboardConnections = connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) || selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection }));
        }
        clipboardRef.current = {
            nodes: copiedNodes,
            connections: clipboardConnections,
        };

        // 同步往系统剪贴板写一段【短签名标记】（只有前缀+随机 token，绝不含节点内容/URL），
        // 让系统剪贴板成为「最近一次复制」的唯一裁判：外部复制图/文会覆盖它→粘贴走外部分支；
        // 再次复制节点又写回标记→粘贴走内部分支。安全上下文优先 writeText（可判定、不弹 prompt），
        // HTTP/写失败则静默回退（语义退化为内部优先，不影响内部复制本身）。
        const token = makeCanvasClipboardToken();
        clipboardTokenRef.current = null;
        void writeCanvasClipboardMarker(buildCanvasClipboardMarker(token)).then((ok) => {
            if (ok) clipboardTokenRef.current = token;
        });
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        // 粘贴位置：优先鼠标所在处，鼠标不在画布上时退回视口中心
        const mouse = lastMouseScreenRef.current;
        const containerRect = containerRef.current?.getBoundingClientRect();
        const mouseInCanvas = mouse && containerRect && mouse.x >= containerRect.left && mouse.x <= containerRect.right && mouse.y >= containerRect.top && mouse.y <= containerRect.bottom;
        // 连续粘贴(同一落点)会层层重合,把目标中心级联避让开
        const center = findFreeCenter(mouseInCanvas && mouse ? screenToCanvas(mouse.x, mouse.y) : getCanvasCenter(), nodesRef.current);
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const usedNames = collectDisplayNames(nodesRef.current);
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            // 自定义命名：粘贴的副本叫「<原名>副本 / 副本2…」，对已存在节点 + 本批已分配名去重。
            const copyName = deriveCopyName(getNodeDisplayName(node), usedNames);
            usedNames.add(copyName);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                name: copyName,
                nameIsCustom: true,
                nameSeq: undefined,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const existingNodeIds = new Set(nodesRef.current.map((node) => node.id));
        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            // 选中端映射到副本；未选中的外部端沿用原节点（仍存在时），实现副本自动接回原有连线
            const fromNodeId = idMap.get(connection.fromNodeId) || (existingNodeIds.has(connection.fromNodeId) ? connection.fromNodeId : null);
            const toNodeId = idMap.get(connection.toNodeId) || (existingNodeIds.has(connection.toNodeId) ? connection.toNodeId : null);
            if (!fromNodeId || !toNodeId || (fromNodeId === connection.fromNodeId && toNodeId === connection.toNodeId)) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        // 复制粘贴 = 完整副本：保留已生成内容（视频/图片连同输出一起复制，而不是清空重生成）。
        // 此时 idMap 已建全，把每个副本 metadata 里正文的 @[node:旧id] 引用重映射到副本新 id（promptDraft/composerContent/prompt）：
        // 否则副本重生成时这些 token 仍指向原始节点、命中不到当前连线→参考被静默丢弃/错位。未被一起复制的引用保持原样（生成时会被一致丢弃，不会错配）。
        const resetNodes = nextNodes.map((item) => (item.metadata ? { ...item, metadata: remapMetadataMentionIds(item.metadata, idMap) } : item));

        setNodes((prev) => [...prev, ...resetNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(resetNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(nextNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter, screenToCanvas]);

    // 从其它子画布复制节点：把选中节点塞进 clipboardRef 后复用粘贴逻辑（重映射 id / 偏移 / 去重命名），用完还原不污染用户剪贴板。
    const [copyFromSiblingOpen, setCopyFromSiblingOpen] = useState(false);
    const copyNodesFromSibling = useCallback(
        (nodes: CanvasNodeData[], connections: CanvasConnection[]) => {
            if (!nodes.length) return;
            const previous = clipboardRef.current;
            clipboardRef.current = { nodes, connections };
            pasteCopiedNodes();
            clipboardRef.current = previous;
        },
        [pasteCopiedNodes],
    );

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setGroups(entry.groups);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    // 新建画布：先弹「选积分来源」，确认后才创建并跳转（projectId ""=个人积分）
    const createAndOpenProject = useCallback(() => setCreditSourceOpen(true), []);
    const confirmCreateProject = useCallback(
        (nextProjectId: string) => {
            setCreditSourceOpen(false);
            const id = createProject(`${APP_NAME} ${useCanvasStore.getState().projects.length + 1}`, nextProjectId || undefined);
            router.push(`/canvas/${id}`);
        },
        [createProject, router],
    );

    // 删除当前画布（二级确认）。
    //
    // ⚠️ 这里必须有二级确认。一个很自然的写法是菜单项 onClick 直接调用、不做任何确认，
    // 删完还立刻 router.push 跳走。而画布删除是 undo 够不着的（deleteProjects 走 zustand store，
    // 撤销栈里根本没有它），一次误点就是整张画布连同全部节点、连线、分组一起消失。
    // 同一个动作在子画布下拉里是有二级确认的（canvas-subcanvas-switcher.tsx 的 confirmDeleteCurrent），
    // 三个删画布的入口里唯独这个漏了，而它恰好是最狠的那个。
    const deleteCurrentProject = useCallback(() => {
        let name = currentProject?.title || "";
        if (!name) name = "未命名画布";
        const nodeCount = nodesRef.current.length;
        modal.confirm({
            title: "删除当前画布？",
            content: "「" + name + "」及其 " + nodeCount + " 个节点将被删除。删除后不可恢复，撤销也找不回。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => {
                deleteProjects([projectId]);
                cleanupAssetImages();
                router.push("/canvas");
            },
        });
    }, [cleanupAssetImages, currentProject?.title, deleteProjects, modal, projectId, router]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            // 左键在空白处拖动 = 框选(rubber-band)。Shift = 累加选择;否则先清空当前选中。
            // 单击不拖动时:起始即清空选中,pointerup 时框消失,等价于"点空白取消选中"。
            if (!event.shiftKey) {
                deselectCanvas();
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, deselectCanvas, screenToCanvas],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        // 仅左键选中/拖动节点;中键(平移)、右键(上下文菜单)不应触发节点拖拽
        if (event.button !== 0) return;
        event.stopPropagation();
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setSelectedConnectionId(null);

        const currentSelected = selectedNodeIdsRef.current;
        const currentNodes = nodesRef.current;
        const nextSelected = new Set(currentSelected);

        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) {
                nextSelected.delete(nodeId);
            } else {
                nextSelected.add(nodeId);
            }
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }

        setSelectedNodeIds(nextSelected);
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (nextSelected.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => dragIds.add(childId));
        });
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            lastDx: 0,
            lastDy: 0,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    // 整组拖动：拖组背景框 = 选中并拖动组内全部成员（含批次子节点），复用 dragRef + handleGlobalMouseMove/finishNodeDrag。
    const handleGroupMouseDown = useCallback((event: ReactMouseEvent, groupId: string) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setSelectedConnectionId(null);

        const group = groupsRef.current.find((item) => item.id === groupId);
        if (!group) return;
        const currentNodes = nodesRef.current;
        const memberSet = new Set(group.memberNodeIds);
        // 把组内根节点的批次隐藏子节点也纳入拖动集合，与单节点拖动同样的扩展逻辑
        currentNodes.forEach((node) => {
            if (memberSet.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => memberSet.add(childId));
        });

        setSelectedNodeIds(new Set(memberSet));
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            lastDx: 0,
            lastDy: 0,
            initialSelectedNodes: currentNodes.filter((node) => memberSet.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const dx = clientX == null ? 0 : dragRef.current.lastDx;
        const dy = clientY == null ? 0 : dragRef.current.lastDy;
        const initialPositions = dragRef.current.initialSelectedNodes;
        setAlignmentGuides([]);

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            setNodes((prev) =>
                prev.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    if (!initial) return node;
                    return { ...node, position: { x: initial.x + dx, y: initial.y + dy } };
                }),
            );
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        // 拖动期间被推迟的云端回灌：这里只置一个 state 标志，真正的重载交给声明在
        // 【持久化 effect 之后】的那个 effect 触发（见下方 pendingRestore 的 useEffect）。
        //
        // ⚠️ 不能在这里直接 setRestoreEpoch：mouseup 里的 setNodes(落点) 与它会被 React
        // 批处理进同一次 commit，而 restore effect 声明在持久化 effect 【之前】，会先跑并置起
        // skipNextPersistRef，紧随其后的持久化 effect 命中该标志直接 return —— 这次拖动的落点
        // 既不进 store、也不进 IndexedDB、更不会上云，随后异步 restore 把节点拉回拖动前坐标，
        // 整次拖动白做。用 effect 声明顺序来保证「先落盘、再重载」，比 setTimeout 赌任务调度顺序可靠。
        if (pendingRestoreRef.current) {
            pendingRestoreRef.current = false;
            setPendingRestore(true);
        }
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            if (clickedNode?.type === CanvasNodeType.Text) {
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, []);

    // ── 一键排序(自动排布):4 种模式 + 一键撤回 ──
    const sortSnapshotRef = useRef<Map<string, Position> | null>(null);
    const sortToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [sortToast, setSortToast] = useState<{ mode: SortMode } | null>(null);
    const sortNodes = useCallback((mode: SortMode) => {
        const allNodes = nodesRef.current;
        const selected = selectedNodeIdsRef.current;
        // 范围:选中 ≥2 个 → 只排选中;否则排全部可见节点(排除折叠批次隐藏子,它们随根移动)
        const useSelection = selected.size >= 2;
        let scopeIds: Set<string> | null = null;
        if (useSelection) {
            const ids = new Set(selected);
            // 部分选中某组的成员时,把该组其余成员一并纳入范围,保证组整体平移、不被拆散
            groupsRef.current.forEach((group) => {
                if (group.memberNodeIds.some((id) => ids.has(id))) group.memberNodeIds.forEach((id) => ids.add(id));
            });
            scopeIds = ids;
        }
        const scopeNodes = allNodes.filter((node) => !isHiddenBatchChild(node, allNodes) && (scopeIds ? scopeIds.has(node.id) : true));
        if (scopeNodes.length < 2) return;
        const groupByNode = new Map<string, string>();
        groupsRef.current.forEach((group) => group.memberNodeIds.forEach((id) => groupByNode.set(id, group.id)));
        const layout = computeSortLayout(scopeNodes, connectionsRef.current, groupByNode, mode);
        if (!layout.size) return;
        // 算 delta,让折叠批次隐藏子节点跟随根一起移动(与 alignSelectedNodes 同款范式)
        const deltaById = new Map<string, Position>();
        allNodes.forEach((node) => {
            const next = layout.get(node.id);
            if (!next) return;
            const delta = { x: next.x - node.position.x, y: next.y - node.position.y };
            deltaById.set(node.id, delta);
            node.metadata?.batchChildIds?.forEach((childId) => {
                if (!layout.has(childId) && !deltaById.has(childId)) deltaById.set(childId, delta);
            });
        });
        if (!deltaById.size) return;
        // 记录排序前位置(含被带动的批次子)供一键撤回
        const snapshot = new Map<string, Position>();
        allNodes.forEach((node) => {
            if (deltaById.has(node.id)) snapshot.set(node.id, { x: node.position.x, y: node.position.y });
        });
        sortSnapshotRef.current = snapshot;
        // 单次 setNodes → 自动落一步历史,普通撤销/Cmd+Z 也能整体还原
        setNodes((prev) =>
            prev.map((node) => {
                const delta = deltaById.get(node.id);
                return delta ? { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } } : node;
            }),
        );
        if (sortToastTimerRef.current) clearTimeout(sortToastTimerRef.current);
        setSortToast({ mode });
        sortToastTimerRef.current = setTimeout(() => setSortToast(null), 6000);
    }, []);

    const undoSortNodes = useCallback(() => {
        const snapshot = sortSnapshotRef.current;
        if (!snapshot) return;
        setNodes((prev) =>
            prev.map((node) => {
                const pos = snapshot.get(node.id);
                return pos ? { ...node, position: { x: pos.x, y: pos.y } } : node;
            }),
        );
        sortSnapshotRef.current = null;
        if (sortToastTimerRef.current) clearTimeout(sortToastTimerRef.current);
        setSortToast(null);
    }, []);

    useEffect(() => {
        return () => {
            if (sortToastTimerRef.current) clearTimeout(sortToastTimerRef.current);
        };
    }, []);

    const alignSelectedNodes = useCallback((mode: AlignActionMode) => {
        const selectedIds = selectedNodeIdsRef.current;
        const currentNodes = nodesRef.current;
        const targets = currentNodes.filter((node) => selectedIds.has(node.id) && !isHiddenBatchChild(node, currentNodes));
        const patches = computeAlignedPositions(targets, mode);
        if (!patches.size) return;
        const deltaById = new Map<string, Position>();
        targets.forEach((node) => {
            const next = patches.get(node.id);
            if (!next) return;
            const delta = { x: next.x - node.position.x, y: next.y - node.position.y };
            deltaById.set(node.id, delta);
            // 图片组子节点跟随组根一起移动
            node.metadata?.batchChildIds?.forEach((childId) => {
                if (!patches.has(childId) && !deltaById.has(childId)) deltaById.set(childId, delta);
            });
        });
        setNodes((prev) =>
            prev.map((node) => {
                const delta = deltaById.get(node.id);
                return delta ? { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } } : node;
            }),
        );
    }, []);

    // 分享当前画布：同步后生成只读分享链接（对方可复制为自己的项目）
    const shareCurrentProject = useCallback(async () => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) {
            message.warning("画布尚未保存，无法分享");
            return;
        }
        const hide = message.loading("正在同步数据并生成分享链接…", 0);
        try {
            const url = await shareCanvasProject(project);
            hide();
            // copy-to-clipboard 内置 execCommand 降级，在 http(非安全上下文)下也能复制（同步副作用，不取返回值避免类型坑）
            copy(url);
            modal.success({
                title: "分享链接已生成",
                width: 560,
                content: (
                    <div className="mt-2 space-y-2">
                        <p className="text-sm text-stone-500">链接已复制到剪贴板。把链接发给对方，对方登录后点「复制到我的画布」即可存进自己账号。</p>
                        <div className="flex items-center gap-2">
                            <Input readOnly value={url} onFocus={(event) => event.target.select()} />
                            <Button
                                type="primary"
                                onClick={() => {
                                    copy(url);
                                    message.success("已复制");
                                }}
                            >
                                复制链接
                            </Button>
                        </div>
                    </div>
                ),
            });
        } catch (error) {
            hide();
            message.error(error instanceof Error ? error.message : "分享失败");
        }
    }, [message, modal, projectId]);

    // 分镜故事板向导：按教程「定妆图 → 场景图 → 故事板」的依赖关系铺设节点并连线垫图
    const applyStoryboardPlan = useCallback(
        (plan: StoryboardPlan, assetUploads?: Record<string, UploadedImage>) => {
            const center = getCanvasCenter();
            const colGap = 140;
            const rowGap = 48;
            const sheetSize = { width: 360, height: 240 }; // 人物/场景节点（3:2）
            const boardSize = { width: 520, height: 292 }; // 故事板节点（16:9）
            const scriptSize = { width: 380, height: 300 };
            const leftRows = Math.max(plan.characters.length, 1) + Math.max(plan.scenes.length, 1);
            const columnHeight = Math.max(leftRows * (sheetSize.height + rowGap), plan.segments.length * (boardSize.height + rowGap));
            const originX = center.x - (scriptSize.width + sheetSize.width + boardSize.width + colGap * 2) / 2;
            const originY = center.y - columnHeight / 2;

            const newNodes: CanvasNodeData[] = [];
            const newConnections: CanvasConnection[] = [];
            const nodeIdByName = new Map<string, string>();
            const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

            const scriptNode: CanvasNodeData = {
                id: makeId(CanvasNodeType.Text),
                type: CanvasNodeType.Text,
                title: `《${plan.title}》分镜脚本`,
                position: { x: originX, y: originY },
                width: scriptSize.width,
                height: scriptSize.height,
                metadata: { content: buildScriptText(plan), prompt: "", status: NODE_STATUS_SUCCESS, fontSize: 12 },
            };
            newNodes.push(scriptNode);

            const sheetX = originX + scriptSize.width + colGap;
            // 资产节点：用户上传了图 → 带图节点（status success）；否则 → 待生成节点（带提示词）
            plan.characters.forEach((character, index) => {
                const uploaded = assetUploads?.[character.name];
                const nodeSize = uploaded ? fitNodeSize(uploaded.width, uploaded.height, sheetSize.width, sheetSize.height) : sheetSize;
                const node: CanvasNodeData = {
                    id: makeId(CanvasNodeType.Image),
                    type: CanvasNodeType.Image,
                    title: `${character.name} · 定妆图`,
                    position: { x: sheetX, y: originY + index * (sheetSize.height + rowGap) },
                    width: nodeSize.width,
                    height: nodeSize.height,
                    metadata: uploaded ? imageMetadata(uploaded) : { prompt: character.prompt, size: "3:2" },
                };
                nodeIdByName.set(character.name, node.id);
                newNodes.push(node);
            });
            plan.scenes.forEach((scene, index) => {
                const uploaded = assetUploads?.[scene.name];
                const nodeSize = uploaded ? fitNodeSize(uploaded.width, uploaded.height, sheetSize.width, sheetSize.height) : sheetSize;
                const node: CanvasNodeData = {
                    id: makeId(CanvasNodeType.Image),
                    type: CanvasNodeType.Image,
                    title: `${scene.name} · 场景图`,
                    position: { x: sheetX, y: originY + (plan.characters.length + index) * (sheetSize.height + rowGap) },
                    width: nodeSize.width,
                    height: nodeSize.height,
                    metadata: uploaded ? imageMetadata(uploaded) : { prompt: scene.prompt, size: "16:9" },
                };
                nodeIdByName.set(scene.name, node.id);
                newNodes.push(node);
            });

            const boardX = sheetX + sheetSize.width + colGap;
            plan.segments.forEach((segment, index) => {
                const node: CanvasNodeData = {
                    id: makeId(CanvasNodeType.Image),
                    type: CanvasNodeType.Image,
                    title: `第${index + 1}段 · 分镜故事板`,
                    position: { x: boardX, y: originY + index * (boardSize.height + rowGap) },
                    width: boardSize.width,
                    height: boardSize.height,
                    metadata: { prompt: buildStoryboardImagePrompt(plan, segment), size: "16:9", videoPrompt: buildVideoPrompt(plan, segment) },
                };
                newNodes.push(node);
                // 该段引用的人物/场景连线垫图；名字对不上时退回连接全部参考图
                const refNames = [...segment.characters, ...segment.scenes].filter((name) => nodeIdByName.has(name));
                const refIds = (refNames.length ? refNames : Array.from(nodeIdByName.keys())).map((name) => nodeIdByName.get(name)!);
                Array.from(new Set(refIds)).forEach((fromNodeId) => newConnections.push({ id: nanoid(), fromNodeId, toNodeId: node.id }));
            });

            setNodes((prev) => [...prev, ...newNodes]);
            setConnections((prev) => [...prev, ...newConnections]);
            setSelectedNodeIds(new Set());
            setDialogNodeId(null);
            const uploadedCount = assetUploads ? Object.keys(assetUploads).length : 0;
            message.success(uploadedCount ? `已插入《${plan.title}》：${uploadedCount} 个资产用你上传的图、其余待生成，故事板已连线垫图` : `已插入《${plan.title}》：先生成定妆图与场景图，再生成故事板（参考图自动垫入）`);
        },
        [getCanvasCenter, message],
    );

    // 故事板节点「展开到画布」：从节点 metadata 取方案与已上传资产，铺出脚本/人物/场景/故事板节点
    const expandStoryboardNode = useCallback(
        async (node: CanvasNodeData) => {
            const state = node.metadata?.storyboard;
            if (!state?.plan) {
                message.warning("请先在节点里解析出分镜方案");
                return;
            }
            const assetUploads: Record<string, UploadedImage> = {};
            for (const [name, asset] of Object.entries(state.assets ?? {})) {
                const url = await resolveImageUrl(asset.storageKey);
                assetUploads[name] = { url, storageKey: asset.storageKey, width: asset.width, height: asset.height, bytes: asset.bytes, mimeType: asset.mimeType };
            }
            applyStoryboardPlan(state.plan, assetUploads);
        },
        [applyStoryboardPlan, message],
    );

    // 故事板解析：在父组件跑，状态/结果写节点 metadata，点别处关浮层或刷新都不中断
    const parseStoryboardNode = useCallback(
        async (node: CanvasNodeData) => {
            const current = node.metadata?.storyboard ?? { mode: "auto" as const };
            // 故事板解析必须用「文本模型」，不能 fallback 到画布当前选中的图像/视频模型（否则会拿 gpt-image-2 之类去做文本解析，返回绘图）
            const textModel = current.model || effectiveConfig.textModel || effectiveConfig.textModels?.find((m) => modelMatchesCapability(m, "text")) || "";
            if (!textModel || !modelMatchesCapability(textModel, "text")) {
                message.error("分镜解析需要「文本模型」，但当前配置里没有可用文本模型（你现在选的是图像模型）。请在配置里选择文本模型，或切换到含文本模型的分组渠道后重试。");
                return;
            }
            const textConfig = { ...effectiveConfig, model: textModel };
            if (!isAiConfigReady(textConfig, textConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const isCustom = (current.mode ?? "auto") === "custom";
            if (isCustom ? !current.script?.trim() : !current.story?.trim()) {
                message.warning(isCustom ? "请先粘贴分镜脚本" : "请先填写故事创意");
                return;
            }
            const messages = isCustom
                ? buildStoryboardParserMessages({ script: current.script!.trim(), style: current.style?.trim() ?? "" })
                : buildStoryboardPlannerMessages({ story: current.story!.trim(), genre: current.genre?.trim() ?? "", tone: current.tone?.trim() ?? "", duration: current.duration ?? "15s", characters: current.characters?.trim() ?? "", extra: current.extra?.trim() ?? "" });
            const failLabel = isCustom ? "镜头解析失败" : "分镜方案生成失败";
            // 合并写 storyboard 以「最新 metadata」为基（解析期间用户可能改了资产/输入）
            const patchStoryboard = (patch: Partial<StoryboardNodeState>) => {
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, storyboard: { ...(item.metadata?.storyboard ?? current), ...patch } } } : item)));
            };
            const clearParsing = () =>
                setParsingStoryboardIds((prev) => {
                    const next = new Set(prev);
                    next.delete(node.id);
                    return next;
                });
            setParsingStoryboardIds((prev) => new Set(prev).add(node.id));
            patchStoryboard({ parseError: undefined });
            let answer = "";
            try {
                // 故事板是结构化 JSON（最多 64 镜 + 人物/场景提示词，体量大），给足 max_tokens 防止被截断；
                // thinkingOverride 已对豆包 seed 关推理，其它模型靠 max_tokens 兜底。
                answer = await requestImageQuestion(textConfig, messages, () => {}, { max_tokens: 8192 });
            } catch (error) {
                const trace = errorTraceId(error);
                patchStoryboard({ parseError: `${failLabel}（请求失败）：${error instanceof Error ? error.message : "未知错误"}${trace ? `　追踪码：${trace}` : ""}` });
                clearParsing();
                return;
            }
            try {
                const plan = parseStoryboardPlan(answer);
                patchStoryboard({ plan, parseError: undefined });
            } catch (error) {
                console.error("[storyboard] 解析模型输出失败：", error, "\n模型原始输出：\n", answer);
                const preview = answer.trim().slice(0, 400);
                patchStoryboard({ parseError: `${failLabel}（解析失败）：${error instanceof Error ? error.message : "未知错误"}。\n模型返回开头：${preview || "（空，未拿到任何内容）"}` });
            } finally {
                clearParsing();
            }
        },
        [effectiveConfig, isAiConfigReady, openConfigDialog, message],
    );

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;
            lastMouseScreenRef.current = { x: event.clientX, y: event.clientY };

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }
                dragRef.current.lastDx = dx;
                dragRef.current.lastDy = dy;
                const snapDisabled = event.altKey; // 按住 Alt 临时关闭对齐吸附

                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    let snappedDx = dx;
                    let snappedDy = dy;
                    let guides: AlignmentGuide[] = [];
                    if (!snapDisabled && dragRef.current.hasMoved && initialPositions.length) {
                        const currentNodes = nodesRef.current;
                        const draggedIds = new Set(initialPositions.map((item) => item.id));
                        const nodeMap = new Map(currentNodes.map((node) => [node.id, node]));
                        let left = Infinity;
                        let top = Infinity;
                        let right = -Infinity;
                        let bottom = -Infinity;
                        initialPositions.forEach((item) => {
                            const node = nodeMap.get(item.id);
                            if (!node) return;
                            left = Math.min(left, item.x + dx);
                            top = Math.min(top, item.y + dy);
                            right = Math.max(right, item.x + dx + node.width);
                            bottom = Math.max(bottom, item.y + dy + node.height);
                        });
                        if (left < right) {
                            // 只与视口内（含少量边距）的节点对齐，避免吸附到远处看不见的节点。
                            const rect = containerRef.current?.getBoundingClientRect();
                            const viewLeft = -currentViewport.x / currentViewport.k - 120;
                            const viewTop = -currentViewport.y / currentViewport.k - 120;
                            const viewRight = viewLeft + (rect?.width || 1200) / currentViewport.k + 240;
                            const viewBottom = viewTop + (rect?.height || 720) / currentViewport.k + 240;
                            const targets = currentNodes
                                .filter(
                                    (node) =>
                                        !draggedIds.has(node.id) &&
                                        !isHiddenBatchChild(node, currentNodes) &&
                                        node.position.x + node.width > viewLeft &&
                                        node.position.x < viewRight &&
                                        node.position.y + node.height > viewTop &&
                                        node.position.y < viewBottom,
                                )
                                .map((node) => ({ left: node.position.x, top: node.position.y, right: node.position.x + node.width, bottom: node.position.y + node.height }));
                            const snap = computeAlignmentSnap({ left, top, right, bottom }, targets, 8 / currentViewport.k);
                            snappedDx = dx + snap.dx;
                            snappedDy = dy + snap.dy;
                            guides = snap.guides;
                        }
                    }
                    dragRef.current.lastDx = snappedDx;
                    dragRef.current.lastDy = snappedDy;
                    setAlignmentGuides(guides);
                    const initialPositionMap = new Map(initialPositions.map((item) => [item.id, item]));
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositionMap.get(node.id);
                            return initial ? { ...node, position: { x: initial.x + snappedDx, y: initial.y + snappedDy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                updateEdgeAutoScroll(event.clientX, event.clientY);
            }
        },
        [finishNodeDrag, getConnectionDropTarget, screenToCanvas, updateEdgeAutoScroll],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);
            stopEdgeAutoScroll();

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting, stopEdgeAutoScroll],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => {
            stopEdgeAutoScroll();
            finishNodeDrag(event.clientX, event.clientY);
        };
        const cancelNodeDrag = () => {
            stopEdgeAutoScroll();
            finishNodeDrag();
        };
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove, stopEdgeAutoScroll]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        const size = standardMediaSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        // 重复粘贴同一剪贴板图片时落点相同会完全重合,级联偏移开
        const center = findFreeCenter(position, nodesRef.current);
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = standardMediaSize(video.width || 1280, video.height || 720);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const center = findFreeCenter(position, nodesRef.current);
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const center = findFreeCenter(position, nodesRef.current);
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    // 多文件上传：把单个文件按类型构建成节点对象(放在指定中心、不自己 setNodes/选中)，失败返回 null。供 createFileNodesBatch 复用。
    const buildImageFileNode = useCallback(async (file: File, center: Position): Promise<CanvasNodeData | null> => {
        try {
            const image = await uploadImage(file);
            const size = standardMediaSize(image.width, image.height);
            return { id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type: CanvasNodeType.Image, title: file.name, position: { x: center.x - size.width / 2, y: center.y - size.height / 2 }, width: size.width, height: size.height, metadata: imageMetadata(image) };
        } catch {
            return null;
        }
    }, []);
    const buildVideoFileNode = useCallback(async (file: File, center: Position): Promise<CanvasNodeData | null> => {
        try {
            const video = await uploadMediaFile(file, "video");
            const size = standardMediaSize(video.width || 1280, video.height || 720);
            return { id: `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type: CanvasNodeType.Video, title: file.name, position: { x: center.x - size.width / 2, y: center.y - size.height / 2 }, width: size.width, height: size.height, metadata: videoMetadata(video) };
        } catch {
            return null;
        }
    }, []);
    const buildAudioFileNode = useCallback(async (file: File, center: Position): Promise<CanvasNodeData | null> => {
        try {
            const audio = await uploadMediaFile(file, "audio");
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
            return { id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type: CanvasNodeType.Audio, title: file.name, position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 }, width: spec.width, height: spec.height, metadata: audioMetadata(audio) };
        } catch {
            return null;
        }
    }, []);

    // 一次拖入/选择多个、多种类型的文件：逐个按类型建对应节点，按拖入顺序铺成网格(不重叠)，并发 3 上传、单个失败不影响其余。
    const createFileNodesBatch = useCallback(
        async (files: File[], anchor: Position) => {
            const supported = files.filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f));
            const unsupported = files.length - supported.length;
            if (!supported.length) {
                if (files.length) message.warning("没有可导入的文件（仅支持图片/视频/音频）");
                return;
            }
            const MAX_FILES = 30;
            let accepted = supported;
            let overCap = 0;
            if (accepted.length > MAX_FILES) {
                overCap = accepted.length - MAX_FILES;
                accepted = accepted.slice(0, MAX_FILES);
            }
            // 与 Next 代理 MAX_UPLOAD_BYTES、后端 syncFileMaxBytes 保持同一个数；只是提前拦一下，省得传半天才失败。
            const MAX_BYTES = 300 * 1024 * 1024;
            const oversized = accepted.filter((f) => f.size > MAX_BYTES).length;
            accepted = accepted.filter((f) => f.size <= MAX_BYTES);
            if (!accepted.length) {
                message.warning("文件均超过 300MB 上限，请压缩后再传");
                return;
            }
            // 统一用「图片/视频最大节点格(720×360)」做槽位，音频(340×240)居中放入同样格子，混合尺寸也零重叠。
            const CELL_W = 720;
            const CELL_H = 360;
            const GAP = 36;
            const slots = computeGridSlots(accepted.length, anchor, CELL_W, CELL_H, GAP);
            const built: (CanvasNodeData | null)[] = new Array(accepted.length).fill(null);
            let failed = 0;
            const tasks = accepted.map((file, index) => ({ file, index }));
            await runGroupConcurrency(tasks, 3, async ({ file, index }) => {
                const slot = slots[index];
                const center = { x: slot.cx, y: slot.cy };
                const node = isAudioFile(file) ? await buildAudioFileNode(file, center) : file.type.startsWith("video/") ? await buildVideoFileNode(file, center) : await buildImageFileNode(file, center);
                if (node) built[index] = node;
                else failed += 1;
            });
            const newNodes = built.filter((n): n is CanvasNodeData => Boolean(n));
            if (newNodes.length) {
                setNodes((prev) => [...prev, ...newNodes]);
                setSelectedNodeIds(new Set(newNodes.map((n) => n.id)));
                setSelectedConnectionId(null);
                setDialogNodeId(null);
            }
            const parts: string[] = [];
            if (newNodes.length) parts.push(`已导入 ${newNodes.length} 个文件`);
            if (failed) parts.push(`${failed} 个失败`);
            if (oversized) parts.push(`${oversized} 个超 300MB 已跳过`);
            if (unsupported) parts.push(`${unsupported} 个不支持已跳过`);
            if (overCap) parts.push(`超出一次 ${MAX_FILES} 个上限的 ${overCap} 个未处理`);
            if (parts.length) (failed ? message.warning : message.success)(parts.join("，"));
        },
        [buildAudioFileNode, buildImageFileNode, buildVideoFileNode, message],
    );

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, findFreeCenter(getCanvasCenter(), nodesRef.current), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter],
    );

    // 仅处理「外部图/文」的系统剪贴板粘贴（不涉及内部节点判定）。返回是否成功贴入外部内容。
    // 图片优先（与现状一致）；图片上传失败【绝不穿透】到文本分支，单独 message.error 后返回 false。
    const pasteSystemClipboard = useCallback(async (): Promise<boolean> => {
        if (typeof navigator === "undefined" || !navigator.clipboard) return false;

        // 1) 图片：能力探测 + try/catch；命中 image/* 即贴图，上传失败独立兜底，绝不继续读文本。
        if (typeof navigator.clipboard.read === "function") {
            let imageBlob: { blob: Blob; type: string } | null = null;
            try {
                const items = await navigator.clipboard.read();
                const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
                if (imageItem) {
                    const imageType = imageItem.types.find((type) => type.startsWith("image/"));
                    if (imageType) {
                        const blob = await imageItem.getType(imageType);
                        imageBlob = { blob, type: imageType };
                    }
                }
            } catch {
                // read 不支持/权限拒绝/无手势：跳到文本分支，不在此处报错。
                imageBlob = null;
            }
            if (imageBlob) {
                try {
                    const file = new File([imageBlob.blob], "clipboard-image.png", { type: imageBlob.type });
                    await createImageFileNode(file, getCanvasCenter());
                    message.success("已从剪切板添加图片");
                    return true;
                } catch {
                    // 图片上传/建节点失败：独立兜底，绝不穿透到文本分支造成错误粘贴。
                    message.error("剪切板图片粘贴失败，请重试");
                    return false;
                }
            }
        }

        // 2) 文本：能力探测 + try/catch。
        if (typeof navigator.clipboard.readText === "function") {
            try {
                const text = await navigator.clipboard.readText();
                if (createTextNodeFromClipboard(text)) {
                    message.success("已从剪切板添加文本");
                    return true;
                }
            } catch {
                // readText 权限拒绝等：交由 unifiedPaste 统一兜底/提示。
                return false;
            }
        }
        return false;
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message]);

    // 统一粘贴入口（Ctrl/Cmd+V 唯一调用）：以系统剪贴板为唯一裁判，实现「最近一次复制赢」。
    // 流程：① 并发互斥；② 非安全上下文(HTTP) → 内部 ref 兜底；③ 读系统剪贴板文本，命中本应用标记
    // → 贴内部节点(用 clipboardRef 活数据)；④ 否则 → 贴外部图/文；⑤ 全失败 → 内部 ref 兜底 + 提示。
    const unifiedPaste = useCallback(async () => {
        if (isPastingRef.current) return;
        isPastingRef.current = true;
        try {
            // 非安全上下文/老浏览器：navigator.clipboard 不可用 → 读侧无降级，回退内部剪贴板（同会话仍能粘节点）。
            if (typeof navigator === "undefined" || !navigator.clipboard) {
                if (pasteCopiedNodes()) return;
                message.warning("当前环境无法读取系统剪切板，请使用 HTTPS 访问");
                return;
            }

            // 先读文本判定归属（本应用标记是纯文本）。readText 失败不致命，落到外部/兜底分支。
            let clipboardText: string | null = null;
            if (typeof navigator.clipboard.readText === "function") {
                try {
                    clipboardText = await navigator.clipboard.readText();
                } catch {
                    clipboardText = null;
                }
            }

            // 命中本应用标记 → 「最近一次是内部复制节点」→ 用内存 clipboardRef 活数据粘贴（blob: 保活、连线/命名/避让全复用）。
            if (isCanvasClipboardMarker(clipboardText)) {
                if (pasteCopiedNodes()) return;
                // 标记在但内存 ref 已失效（极少见：刷新后系统剪贴板仍是本会话标记）→ 提示，不静默。
                message.warning("画布剪切板内容已失效，请重新复制");
                return;
            }

            // 非本应用标记 → 外部内容：贴图/文（pasteSystemClipboard 内部图片优先 + 独立兜底）。
            const pasted = await pasteSystemClipboard();
            if (pasted) return;

            // 外部既无可用图/文 → 内部剪贴板兜底（同会话曾复制过节点、但 read 被拒/剪贴板空的场景）。
            if (clipboardRef.current?.nodes.length) {
                if (pasteCopiedNodes()) return;
            }
            message.info("剪切板为空或无法读取");
        } finally {
            isPastingRef.current = false;
        }
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, pasteCopiedNodes, pasteSystemClipboard]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            // 焦点在可输入元素里时一律不接管。判断收在 constant/shortcuts 里，
            // 与 画布组件那个监听空格的地方共用同一份——原先两处各写各的，
            // 那份弱化版漏了 select 和 contenteditable。
            if (shouldSkipShortcut(event)) return;

            // 按用户当前的键位表分发。activeShortcutChords 已经把自定义覆盖在默认之上，
            // 没自定义过的命令拿到的就是注册表里的默认值。
            const chord = eventToChord(event);
            const command = matchCommand(activeShortcutChords, chord);

            if (command === "undo") {
                event.preventDefault();
                undoCanvas();
                return;
            }

            if (command === "redo") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (command === "selectAll") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (command === "copy") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (command === "paste") {
                event.preventDefault();
                void unifiedPaste();
                return;
            }

            if (command === "delete") {
                // 原先这里没有 preventDefault，Backspace 在部分浏览器会触发「后退」。
                event.preventDefault();
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
                return;
            }

            // Escape 不进注册表、不可自定义：它同时被 antd 的 Modal 消费，
            // 改掉会让画布里的裁剪/蒙版/标注弹窗与画布本身行为不一致（见 constant/shortcuts 的说明）。
            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [activeShortcutChords, copySelectedNodes, deleteConnection, deleteNodes, pasteCopiedNodes, unifiedPaste, redoCanvas, selectedConnectionId, setConnecting, undoCanvas]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position, metadata: { ...node.metadata, manualSize: true } } : node)));
    }, []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        const isExpanded = Boolean(nodesRef.current.find((node) => node.id === nodeId)?.metadata?.imageBatchExpanded);
        if (isExpanded) {
            setCollapsingBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setCollapsingBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 320);
        } else {
            setOpeningBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setOpeningBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 260);
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                return { ...node, metadata: { ...node.metadata, imageBatchExpanded: !node.metadata?.imageBatchExpanded } };
            }),
        );
    }, []);

    const setBatchPrimary = useCallback((child: CanvasNodeData) => {
        const rootId = child.metadata?.batchRootId;
        if (!rootId || !child.metadata?.content) return;
        setNodes((prev) =>
            prev.map((node) =>
                node.id === rootId
                    ? {
                          ...node,
                          width: child.width,
                          height: child.height,
                          metadata: {
                              ...node.metadata,
                              content: child.metadata?.content,
                              primaryImageId: child.id,
                              naturalWidth: child.metadata?.naturalWidth,
                              naturalHeight: child.metadata?.naturalHeight,
                              freeResize: child.metadata?.freeResize,
                          },
                      }
                    : node,
            ),
        );
    }, []);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const downloadNodeImage = useCallback((node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        const ext = node.type === CanvasNodeType.Video ? "mp4" : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content, node.metadata.mimeType);
        // 下载文件名跟随节点自定义名（非法字符/空白替换为 _，空则回退节点 id）。
        const baseName = getNodeDisplayName(node).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || node.id;
        saveAs(node.metadata.content, `${baseName}.${ext}`);
    }, []);

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error("没有可保存的文本");
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || "画布文本", coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success("已加入我的素材");
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error("没有可保存的视频");
                addAsset({ kind: "video", title: node.metadata?.prompt?.slice(0, 24) || "画布视频", coverUrl: "", tags: [], source: "Canvas", data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" }, metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt } });
                message.success("已加入我的素材");
                return;
            }
            if (node.type === CanvasNodeType.Audio) {
                if (!node.metadata?.content) return message.error("没有可保存的音频");
                addAsset({ kind: "audio", title: node.metadata?.prompt?.slice(0, 24) || "画布音频", coverUrl: "", tags: [], source: "Canvas", data: { url: node.metadata.content, storageKey: node.metadata.storageKey, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "audio/mpeg", durationMs: node.metadata.durationMs || 0 }, metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt } });
                message.success("已加入我的素材");
                return;
            }
            if (!node.metadata?.content) return message.error("没有可保存的图片");
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || "画布图片",
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: {
                    source: "canvas",
                    nodeId: node.id,
                    prompt: node.metadata?.prompt,
                    // 已通过肖像授权(active)的图片：认证字段一并存进素材,取用时还原免重认证
                    ...(node.metadata?.portraitAssetStatus === "active" && node.metadata?.portraitAssetId
                        ? { portraitAssetId: node.metadata.portraitAssetId, portraitAssetStatus: node.metadata.portraitAssetStatus, portraitAssetUri: node.metadata.portraitAssetUri }
                        : {}),
                },
            });
            message.success("已加入我的素材");
        },
        [addAsset, message],
    );

    const patchNodeMetadata = useCallback(
        (nodeId: string, patch: Partial<CanvasNodeMetadata>) => {
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...patch } } : node)));
        },
        [setNodes],
    );

    // ——「收藏这次生成」——
    //
    // 一条收藏 = 提示词（用户原文 + 烘焙版）+ 生成配置 + 风格预设快照 + 参考素材副本 + 成品副本。
    //
    // 关键点：**参考素材关系并不存在节点上**。它是「连线 + 提示词里的 @[node:] token」每次现算的
    // （见 buildNodeGenerationContext）。所以必须在收藏这一刻把推导结果固化下来——否则日后连线一改、
    // 原参考节点一删，就再也复原不出「当时用了哪几张图、编号各是几」。而编号是有意义的：
    // 提示词正文里写的就是「参考图片2的构图」，编号对不上，提示词就废了。
    const toggleNodeFavorite = useCallback(
        async (node: CanvasNodeData) => {
            const isVideo = node.type === CanvasNodeType.Video;
            if (!isVideo && node.type !== CanvasNodeType.Image) return;
            if (!node.metadata?.content) {
                message.error(isVideo ? "这个节点还没有视频，无法收藏" : "这个节点还没有图片，无法收藏");
                return;
            }

            // 已收藏 → 取消收藏。
            const favoriteId = node.metadata?.favoriteId;
            if (favoriteId) {
                try {
                    await deletePromptFavorite(favoriteId, userToken || undefined);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : "";
                    // 服务端已经没有这条了（在别的设备删过、或本地标记是陈旧的）：仍按取消处理并清掉标记，
                    // 否则按钮会一直亮着、再也取消不掉。
                    if (!reason.includes("不存在")) {
                        message.error(reason || "取消收藏失败");
                        return;
                    }
                }
                patchNodeMetadata(node.id, { favoriteId: undefined });
                message.success("已取消收藏");
                return;
            }

            // 推导参考素材要用 promptDraft（用户原文、保留 @token）。
            // metadata.prompt 是烘焙版、@token 已被替换成编号，拿它去推导会走错分支（非 composer 分支），
            // 结果是「把接入的参考全发一遍」而不是用户实际 @ 的那几个。
            const promptDraft = (node.metadata?.promptDraft || node.metadata?.prompt || "").trim();
            const bakedPrompt = (node.metadata?.prompt || promptDraft).trim();
            if (!promptDraft && !bakedPrompt) {
                message.error("这个节点没有提示词，无法收藏");
                return;
            }

            setFavoritePendingNodeId(node.id);
            try {
                const kind = isVideo ? ("video" as const) : ("image" as const);
                const nodes = nodesRef.current;
                const result = await createPromptFavorite(
                    {
                        canvasId: projectId,
                        canvasTitle: currentProject?.title || "",
                        nodeId: node.id,
                        kind,
                        title: (bakedPrompt || promptDraft).slice(0, 40),
                        promptDraft,
                        prompt: bakedPrompt,
                        config: buildFavoriteConfig(node),
                        styleSnapshot: buildFavoriteStyleSnapshot(node),
                        references: collectFavoriteReferences(nodes, connectionsRef.current, node.id, promptDraft),
                        result: buildFavoriteAssetInput(nodes, kind, "成品", node.id, node.metadata?.mimeType),
                    },
                    userToken || undefined,
                );
                patchNodeMetadata(node.id, { favoriteId: result.favorite.id });
                if (result.missing > 0) {
                    // 如实说。有素材没存下来就别让用户以为全留住了——他可能正指望这份收藏以后还能用。
                    message.warning(`已收藏，但有 ${result.missing} 项素材没能保存（服务端取不到源文件）`);
                    return;
                }
                message.success("已收藏，可在「我的素材 → 收藏提示词」里取回");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "收藏失败");
            } finally {
                setFavoritePendingNodeId("");
            }
        },
        [currentProject?.title, message, patchNodeMetadata, projectId, userToken],
    );

    // 校正节点上的「已收藏」标记。
    //
    // 标记存在 node.metadata.favoriteId 里，而本项目的持久化有个已知缺陷会盲吞下一拍写入
    // （skipNextPersistRef，触发得并不罕见），标记被吞掉后按钮就不亮了，用户会以为收藏没成功。
    // 服务端那张表才是唯一真相，进画布时拉一次对齐（收藏接口本身也做了幂等，所以即使用户
    // 在标记丢失后又点一次，也不会攒出重复记录）。
    //
    // 三条原则与本文件其它兜底一致：不阻塞首屏、一块画布只问一次、失败静默。
    const favoriteSyncRef = useRef("");
    useEffect(() => {
        if (!projectLoaded || !projectId || !userToken) return;
        // 生成触发的云端同步会反复翻动 projectLoaded，不设闸会打出一串请求。
        if (favoriteSyncRef.current === projectId) return;
        favoriteSyncRef.current = projectId;
        let cancelled = false;
        void (async () => {
            const data = await fetchMyFavoriteNodes(projectId, userToken).catch(() => null);
            if (cancelled || !data) return;
            const favoriteIdByNodeId = new Map((data.nodes || []).map((item) => [item.sourceNodeId, item.id]));
            setNodes((prev) => {
                let changed = false;
                const next = prev.map((item) => {
                    const serverId = favoriteIdByNodeId.get(item.id);
                    const localId = item.metadata?.favoriteId;
                    if ((serverId || undefined) === (localId || undefined)) return item;
                    changed = true;
                    return { ...item, metadata: { ...item.metadata, favoriteId: serverId } };
                });
                // 一致就原样返回，别白白触发一次持久化和云同步。
                if (!changed) return prev;
                return next;
            });
        })();
        return () => {
            cancelled = true;
        };
    }, [projectLoaded, projectId, userToken, setNodes]);

    const pollPortraitAsset = useCallback(
        // silent：整组批量认证时逐节点静默轮询，只回写节点状态标签、不逐个弹 toast（由整组汇总 toast 代之）。
        async (nodeId: string, recordId: string, silent = false) => {
            for (let attempt = 0; attempt < 40; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
                let record;
                try {
                    record = await getPortraitAsset(recordId);
                } catch {
                    continue;
                }
                if (record.status === "active") {
                    patchNodeMetadata(nodeId, { portraitAssetStatus: "active", portraitAssetId: record.assetId, portraitAssetUri: record.assetId ? `asset://${record.assetId}` : undefined, portraitAssetError: "" });
                    if (!silent) message.success({ content: "人像资产已认证，可用于真人风格视频", key: `portrait-${nodeId}` });
                    return;
                }
                if (record.status === "failed") {
                    patchNodeMetadata(nodeId, { portraitAssetStatus: "failed", portraitAssetError: record.errorMsg || "审核未通过" });
                    if (!silent) message.error({ content: record.errorMsg || "人像资产审核未通过", key: `portrait-${nodeId}` });
                    return;
                }
            }
        },
        [message, patchNodeMetadata],
    );

    // enrollPortraitAsset 提交单张图片肖像授权。silent=true 时(整组批量用)不弹单节点 toast，只回写节点状态标签；
    // 返回本次结果供整组汇总计数：skipped=空图/已在认证中、active=当场通过、failed=当场失败、submitted=已提交待审核。
    const enrollPortraitAsset = useCallback(
        async (node: CanvasNodeData, silent = false): Promise<"skipped" | "active" | "failed" | "submitted"> => {
            // 火山 CreateAsset 支持 Image/Video/Audio 三类；含真人的参考视频/音频同样必须先入库
            // 才能以 asset:// 引用，否则被 InputVideoSensitiveContentDetected 拒绝。
            // 音频一律不认证（所有模型都不需要），在入口就挡掉，兜住任何调用方。
            if (node.type === CanvasNodeType.Audio) return "skipped";
            const kind: PortraitAssetKind = node.type === CanvasNodeType.Video ? "video" : "image";
            const isMedia = kind !== "image";
            const kindLabel = kind === "video" ? "视频" : "人像图片";
            if ((node.type !== CanvasNodeType.Image && !isMedia) || !node.metadata?.content) {
                if (!silent) message.warning(`请先在该节点上传或生成${kindLabel}`);
                return "skipped";
            }
            if (node.metadata.portraitAssetStatus === "processing") return "skipped";
            // 规格前置自查：火山审核是异步的，等几分钟才回一句没有原因的 Failed，体验极差。
            // 本地元数据够判的先判掉（时长/尺寸/总像素/宽高比/体积），拿不到的字段放行交火山判。
            if (isMedia) {
                const reason = validateVolcAssetMedia(kind, {
                    durationMs: node.metadata.durationMs,
                    width: node.metadata.naturalWidth,
                    height: node.metadata.naturalHeight,
                    bytes: node.metadata.bytes,
                    mimeType: node.metadata.mimeType,
                    name: node.title,
                });
                if (reason) {
                    patchNodeMetadata(node.id, { portraitAssetStatus: "failed", portraitAssetError: reason });
                    if (!silent) message.error(reason);
                    return "failed";
                }
            }
            try {
                patchNodeMetadata(node.id, { portraitAsset: true, portraitAssetStatus: "processing", portraitAssetError: "" });
                let titleHint = node.title;
                if (node.metadata.prompt) titleHint = node.metadata.prompt.slice(0, 24);
                let record!: Awaited<ReturnType<typeof submitPortraitAsset>>;
                if (isMedia) {
                    // 视频/音频不压缩也不重复搬运：画布上的这类节点基本都已经在公共读的桶里，
                    // 直接把现成公网地址交火山拉取即可（火山本来就只收 URL）。只有纯本地 blob 才上传一次。
                    const content = (node.metadata.content || "").trim();
                    let publicUrl = /^https?:\/\//i.test(content) ? content : "";
                    if (!publicUrl && node.metadata.storageKey) {
                        const resolved = await resolveMediaUrl(node.metadata.storageKey, content);
                        if (resolved && /^https?:\/\//i.test(resolved)) publicUrl = resolved;
                    }
                    if (publicUrl) {
                        record = await submitPortraitAssetByUrl({ url: publicUrl, storageKey: node.metadata.storageKey, title: titleHint, kind });
                    } else {
                        // ⚠️ 自愈结果优先、content 兜底，顺序不能反：content 是非空的死 blob 时，
                        // 原先的 `content || …` 会把上面刚自愈出来的活链直接短路丢掉。
                        const localUrl = (await resolveNodeMediaSrc(node)) || content;
                        if (!localUrl) throw new Error(`读取${kindLabel}失败`);
                        let blob: Blob;
                        try {
                            blob = await (await fetch(localUrl)).blob();
                        } catch {
                            throw new Error(`读取${kindLabel}失败：素材已失效且无法从云端取回`);
                        }
                        if (!blob.size) throw new Error(`读取${kindLabel}失败`);
                        const ext = kind === "video" ? "mp4" : "mp3";
                        const file = new File([blob], `${node.title || node.id}.${ext}`, { type: node.metadata.mimeType || blob.type });
                        record = await submitPortraitAsset({ file, storageKey: node.metadata.storageKey, title: titleHint, kind });
                    }
                } else {
                    // 图片主路径：本地读像素→压缩→上传→入库。失败时回退：若 content 是公网 http 地址（如画布从他人分享/下载
                    // 导入、图仍在对方桶、浏览器跨域取不到像素），交服务端抓取转存进本用户桶后再认证（对方桶公共读，服务端能 GET）。
                    try {
                        const rawDataUrl = await imageToDataUrl({ dataUrl: node.metadata.content, storageKey: node.metadata.storageKey });
                        if (!rawDataUrl) throw new Error("读取人像图片失败");
                        // 入库前压缩，避免大图经慢链路被火山拉取超时
                        const dataUrl = await compressPortraitImage(rawDataUrl);
                        const file = dataUrlToFile({ id: node.id, name: `${node.title || node.id}.jpg`, type: "image/jpeg", dataUrl, storageKey: node.metadata.storageKey });
                        const contentHash = await hashImageFile(file);
                        record = await submitPortraitAsset({ file, storageKey: node.metadata.storageKey, contentHash, title: titleHint, kind: "image" });
                    } catch (clientErr) {
                        const src = (node.metadata.content || "").trim();
                        const isHttpSrc = src.startsWith("http://") || src.startsWith("https://");
                        if (!isHttpSrc) throw clientErr;
                        record = await submitPortraitAssetFromUrl({ sourceUrl: src, storageKey: node.metadata.storageKey, title: titleHint, kind: "image" });
                    }
                }
                patchNodeMetadata(node.id, {
                    portraitAsset: true,
                    portraitAssetId: record.assetId,
                    portraitAssetStatus: record.status,
                    portraitAssetUri: record.assetId ? `asset://${record.assetId}` : undefined,
                    portraitAssetError: record.errorMsg || "",
                });
                if (record.status === "active") {
                    if (!silent) message.success(`${kindLabel}素材已认证，可直接用于真人风格视频`);
                    return "active";
                }
                if (record.status === "failed") {
                    if (!silent) message.error(record.errorMsg || `${kindLabel}素材审核未通过`);
                    return "failed";
                }
                // 火山文档明确「视频类素材处理时间更长、不承诺 SLA」，这里如实告诉用户，别让他以为卡死了。
                if (!silent) {
                    message.loading({
                        content: kind === "video" ? "已提交火山审核，视频类审核较慢，通过后自动可用" : "已提交火山审核，通过后自动可用",
                        key: `portrait-${node.id}`,
                        duration: 2,
                    });
                }
                void pollPortraitAsset(node.id, record.id, silent);
                return "submitted";
            } catch (error) {
                patchNodeMetadata(node.id, { portraitAssetStatus: "failed", portraitAssetError: error instanceof Error ? error.message : "提交失败" });
                if (!silent) message.error(error instanceof Error ? error.message : `提交${kindLabel}素材授权失败`);
                return "failed";
            }
        },
        [message, patchNodeMetadata, pollPortraitAsset],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning("图片节点为空，无法反推提示词");
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(
                    CanvasNodeType.Text,
                    { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY },
                    { content: IMAGE_PROMPT_REVERSE_PRESET, prompt: IMAGE_PROMPT_REVERSE_PRESET, status: NODE_STATUS_SUCCESS, fontSize: 14 },
                ),
                title: "反推提示词",
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: `参考图片：@[node:${node.id}]\n任务说明：@[node:${textNode.id}]`,
                    },
                ),
                title: "反推提示词配置",
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [
                ...prev,
                { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id },
                { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id },
            ]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        // 与「拼合」一致走 imageToDataUrl：它在 content 是死 blob 时会按 storageKey 从服务端自愈重取像素。
        const cropped = await cropDataUrl(await imageToDataUrl({ dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }), crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    // 文字标注：把可视化编辑器合成出的带标注图（与原图同分辨率）存为新图片节点，落在原图旁、连线 原图→标注图。原图保留。
    const annotateImageNode = useCallback(async (node: CanvasNodeData, payload: CanvasImageAnnotatePayload) => {
        if (!node.metadata?.content) return;
        const image = await uploadImage(payload.dataUrl);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "标注图",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setAnnotateNodeId(null);
    }, []);

    // 视频截取帧：首帧/尾帧/当前帧 → 抓取画面 → 存成图片节点（落在视频节点旁，连线 视频→图片 表来源）。
    const captureVideoFrameNode = useCallback(
        async (node: CanvasNodeData, target: VideoFrameTarget) => {
            if (node.type !== CanvasNodeType.Video || !node.metadata?.content) {
                message.warning("当前视频节点暂无可截取的画面");
                return;
            }
            // 「当前帧」从主播放器读 currentTime；首帧/尾帧由 captureVideoFrame 内部按 duration 计算。
            let currentTime = 0;
            if (target === "current") {
                const player = document.querySelector<HTMLVideoElement>(`[data-node-id="${node.id}"] video`);
                currentTime = player?.currentTime ?? 0;
            }
            const loading = message.loading("正在截取视频画面…", 0);
            try {
                // 先按 storageKey 自愈：直接用 content 里的旧 blob: 会被 captureVideoFrame 当成
                // 加载/跨域失败，报出「需配置存储 CORS」——把排查方向带偏。
                const src = await resolveNodeMediaSrc(node);
                const blob = await captureVideoFrame(src, target, currentTime);
                const image = await uploadImage(blob);
                const width = Math.min(node.width, Math.max(220, image.width));
                const childId = nanoid();
                const labelMap: Record<VideoFrameTarget, string> = { first: "首帧", last: "尾帧", current: "当前帧" };
                const child: CanvasNodeData = {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: `${node.title || "视频"} - ${labelMap[target]}`,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width,
                    height: width * (image.height / image.width),
                    metadata: imageMetadata(image),
                };
                // findFreeCenter 防与已有节点完全重合
                const center = findFreeCenter({ x: child.position.x + width / 2, y: child.position.y + child.height / 2 }, nodesRef.current);
                child.position = { x: center.x - width / 2, y: center.y - child.height / 2 };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
                setSelectedNodeIds(new Set([childId]));
                setSelectedConnectionId(null);
                loading();
                message.success(`已截取${labelMap[target]}`);
            } catch (error) {
                loading();
                if (error instanceof VideoFrameCorsError) message.error("该视频跨域暂无法截取（需配置存储 CORS）");
                else message.error(error instanceof Error ? error.message : "视频截取失败");
            }
        },
        [message],
    );


    const extractVideoAudioNode = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Video || !node.metadata?.content) {
                message.warning("当前视频节点暂无可提取的音频");
                return;
            }
            const loading = message.loading("正在提取音频…", 0);
            try {
                // 先按 storageKey 自愈：死 blob 会被 decodeAudioFromUrl 一律归成
                // 「资源下载失败，可能是跨域限制（CORS）」，那句文案会让人白查一遍桶配置。
                const src = await resolveNodeMediaSrc(node);
                const buffer = await decodeAudioFromUrl(src);
                if (!buffer.length || buffer.duration < 0.05) throw new AudioDecodeError("该视频没有可提取的音轨");
                const wav = audioBufferToWavBlob(buffer);
                const uploaded = await uploadMediaFile(wav, "audio");
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                const childId = nanoid();
                const base = { x: node.position.x + node.width + 96, y: node.position.y };
                const center = findFreeCenter({ x: base.x + spec.width / 2, y: base.y + spec.height / 2 }, nodesRef.current);
                const child: CanvasNodeData = {
                    id: childId,
                    type: CanvasNodeType.Audio,
                    title: `${node.title || "视频"} - 音频`,
                    position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
                    width: spec.width,
                    height: spec.height,
                    metadata: audioMetadata(uploaded),
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
                setSelectedNodeIds(new Set([childId]));
                setSelectedConnectionId(null);
                loading();
                message.success("已提取音频");
            } catch (error) {
                loading();
                message.error(error instanceof AudioDecodeError ? error.message : error instanceof Error ? error.message : "音频提取失败");
            }
        },
        [message],
    );

    // 音频裁切：弹窗已生成裁切后的 WAV，这里转存并就地替换该音频节点内容。
    // 音频裁切：弹窗已生成裁切后的 WAV，这里转存并新建一个音频子节点（不动原节点），连线原→新并选中新节点。
    const trimAudioNode = useCallback(
        async (node: CanvasNodeData, blob: Blob, durationMs: number) => {
            setAudioTrimNodeId(null);
            const loading = message.loading("正在生成裁切音频…", 0);
            try {
                const uploaded = await uploadMediaFile(blob, "audio");
                const childId = nanoid();
                const child: CanvasNodeData = {
                    id: childId,
                    type: CanvasNodeType.Audio,
                    title: `${node.title || "音频"} 裁切`,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { ...audioMetadata(uploaded), durationMs },
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
                setSelectedNodeIds(new Set([childId]));
                setSelectedConnectionId(null);
                loading();
                message.success("已生成裁切音频");
            } catch (error) {
                loading();
                message.error(error instanceof Error ? error.message : "音频裁切保存失败");
            }
        },
        [message],
    );

    // 团队素材 → 取用到当前画布：用稳定 URL 直接建对应类型节点（标题＝上传时输入的名字）。
    const insertGroupAssetToCanvas = useCallback(
        async (asset: GroupAsset) => {
            const title = groupAssetDisplayName(asset);
            const type = asset.kind === "video" ? CanvasNodeType.Video : asset.kind === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Image;
            let w = asset.width;
            let h = asset.height;
            // 旧素材可能没存宽高 → 现读固有尺寸，避免取用时退化成 1:1
            if (asset.kind !== "audio" && (!w || !h)) {
                const dims = asset.kind === "video" ? await readVideoMetaDims(asset.url) : await readImageMeta(asset.url).catch(() => null);
                w = dims?.width || 0;
                h = dims?.height || 0;
            }
            const size = asset.kind === "audio" ? { width: NODE_DEFAULT_SIZE[CanvasNodeType.Audio].width, height: NODE_DEFAULT_SIZE[CanvasNodeType.Audio].height } : standardMediaSize(w || undefined, h || undefined);
            const center = findFreeCenter(getCanvasCenter(), nodesRef.current);
            const id = `${asset.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            // 组素材取用还原：后端按 contentHash 去重,active 状态随素材回来直接回填(零点击免重认证)
            const portraitPatch: Partial<CanvasNodeMetadata> =
                asset.portraitAssetStatus === "active" && asset.portraitAssetId
                    ? { portraitAsset: true, portraitAssetId: asset.portraitAssetId, portraitAssetStatus: "active", portraitAssetUri: asset.portraitAssetUri || `asset://${asset.portraitAssetId}` }
                    : {};
            const node: CanvasNodeData = {
                id,
                type,
                title,
                position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: { content: asset.url, status: NODE_STATUS_SUCCESS, mimeType: asset.mimeType, naturalWidth: w || undefined, naturalHeight: h || undefined, durationMs: asset.durationMs || undefined, ...portraitPatch },
            };
            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            message.success("已取用到画布");
        },
        [getCanvasCenter, message],
    );

    // 节点「加入团队」：抓取节点媒体字节，连同来源画布名 + 自定义名上传到组内共享区。
    const addNodeToGroup = useCallback(
        async (node: CanvasNodeData, name: string) => {
            if (!node.metadata?.content) return;
            const kind: "image" | "video" | "audio" = node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image";
            setGroupAssetBusy(true);
            try {
                // 先按 storageKey 自愈再取字节：直接 fetch 节点上那条跨会话失效的 blob:
                // 只会把裸的「Failed to fetch」弹给用户，而 storageKey 就在手边。
                const src = await resolveNodeMediaSrc(node);
                let blob: Blob;
                try {
                    blob = await (await fetch(src)).blob();
                } catch {
                    throw new Error("素材已失效且无法从云端取回，请重新上传后再加入团队");
                }
                // 已认证(active)的图片节点：认证字段随素材上传(后端存 3 列),取用时自动还原免重认证
                const portraitActive = node.metadata?.portraitAssetStatus === "active" && !!node.metadata?.portraitAssetId;
                await uploadGroupAsset({
                    blob,
                    kind,
                    customName: name,
                    sourceCanvasName: currentProject?.title || "",
                    projectId: currentProject?.projectId,
                    mimeType: node.metadata?.mimeType || blob.type,
                    // 固有宽高缺失时退回节点 box 尺寸（规范化后已是正确比例），避免取用时丢比例变 1:1
                    width: node.metadata?.naturalWidth || node.width,
                    height: node.metadata?.naturalHeight || node.height,
                    durationMs: node.metadata?.durationMs,
                    ...(portraitActive
                        ? { portraitAssetId: node.metadata?.portraitAssetId, portraitAssetStatus: node.metadata?.portraitAssetStatus, portraitAssetUri: node.metadata?.portraitAssetUri }
                        : {}),
                });
                await queryClient.invalidateQueries({ queryKey: GROUP_ASSETS_QUERY_KEY });
                setGroupAssetSourceNodeId(null);
                message.success("已加入团队素材");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加入团队失败");
            } finally {
                setGroupAssetBusy(false);
            }
        },
        [currentProject?.title, currentProject?.projectId, queryClient, message],
    );

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(await imageToDataUrl({ dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }), params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: `${node.title || "图片"} ${piece.row + 1}-${piece.column + 1}`,
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                            // 切图单元格是按网格显式定的尺寸(cellWidth/Height)，标记 manualSize 让加载时 normalizeMediaNodeSizes 跳过，
                            // 否则刷新后会被按 naturalWidth/Height 重算成标准尺寸而「自动变大」。
                            manualSize: true,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(`已切分为 ${childNodes.length} 个子节点`);
        },
        [message],
    );

    // 拼合：切图的逆操作。把选中的多张图片节点按画布位置推断的网格(失败则按阅读顺序+近似列数)无缝拼成一张图，
    // 落 1 个新图片节点。纯前端 canvas 合成、不走 AI、不扣费；远程/TOS 图先 imageToDataUrl 解析成同源避免 canvas 污染。
    const combineSelectedImagesToGrid = useCallback(async () => {
        const selectedIds = selectedNodeIdsRef.current;
        const currentNodes = nodesRef.current;
        const targets = currentNodes.filter((node) => selectedIds.has(node.id) && node.type === CanvasNodeType.Image && node.metadata?.content && !isHiddenBatchChild(node, currentNodes));
        if (targets.length < 2) {
            message.warning("请选中至少 2 张图片再拼合");
            return;
        }
        // 1) 推断网格：优先按节点画布位置(聚类成行列、保留你摆放的顺序)；排不出干净网格则按阅读顺序(先上后下、先左后右)+近似列数兜底。
        let rows: number;
        let cols: number;
        let cellIds: (string | null)[][];
        const inferred = inferGridFromPositions(targets);
        if (inferred) {
            rows = inferred.rows;
            cols = inferred.cols;
            cellIds = inferred.cells;
        } else {
            cols = gridColumnsForCount(targets.length);
            rows = Math.ceil(targets.length / cols);
            const ordered = [...targets].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
            cellIds = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ordered[r * cols + c]?.id ?? null));
        }
        const nodeById2 = new Map(currentNodes.map((node) => [node.id, node]));
        const hide = message.loading(`正在拼合 ${targets.length} 张图片…`, 0);
        try {
            // 2) 每格解析成可画的同源 dataURL(避免远程图污染 canvas 导不出)，并发 3。
            const cellUrls: (string | null)[][] = cellIds.map((row) => row.map(() => null));
            const flat: { r: number; c: number; node: CanvasNodeData }[] = [];
            cellIds.forEach((row, r) => row.forEach((id, c) => {
                const node = id ? nodeById2.get(id) : undefined;
                if (node) flat.push({ r, c, node });
            }));
            await runGroupConcurrency(flat, 3, async ({ r, c, node }) => {
                try {
                    cellUrls[r][c] = await imageToDataUrl({ dataUrl: node.metadata?.content, storageKey: node.metadata?.storageKey });
                } catch {
                    cellUrls[r][c] = null;
                }
            });
            // 3) 无缝拼成一张网格图(裁切填满、gap=0)。
            const gridDataUrl = await combineGridDataUrl(cellUrls, { gap: 0 });
            const uploaded = await uploadImage(gridDataUrl);
            const size = standardMediaSize(uploaded.width, uploaded.height);
            const maxX = Math.max(...targets.map((node) => node.position.x + node.width));
            const minY = Math.min(...targets.map((node) => node.position.y));
            const id = nanoid();
            const merged: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: `拼合 ${rows}×${cols}`,
                position: { x: maxX + 96, y: minY },
                width: size.width,
                height: size.height,
                metadata: imageMetadata(uploaded),
            };
            setNodes((prev) => [...prev, merged]);
            setConnections((prev) => [...prev, ...targets.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: id }))]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            message.success(`已拼合为一张 ${rows}×${cols} 网格图`);
        } catch {
            message.error("拼合失败，请重试");
        } finally {
            hide();
        }
    }, [message]);

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = `只修改蒙版透明区域，其他区域保持不变。${userPrompt}`;
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            addRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || "局部编辑结果",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            try {
                const onJobCreated = (jobId: string) => {
                    setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, imageJobId: jobId } } : item)));
                };
                const image = await requestEdit(generationConfig, prompt, [source], { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl }, onJobCreated).then(firstGeneratedImage);
                const uploaded = await uploadImage(image.dataUrl);
                const size = standardMediaSize(uploaded.width, uploaded.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), imageJobId: undefined, prompt, ...generationMetadata } } : item)));
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "局部修改失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                removeRunningNodeId(childId);
            }
        },
        [addRunningNodeId, effectiveConfig, isAiConfigReady, message, openConfigDialog, removeRunningNodeId],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(await imageToDataUrl({ dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }), params);
        const image = await uploadImage(upscaled);
        const size = standardMediaSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    }, []);

    // 九宫格机位：选中一张图 → 一键把同一主体按 9 个不同相机机位合成成一张 3×3 九宫格图。
    // 需要一个支持多机位合成的图片模型；取不到时按当前图片模型发。
    // 复刻 generateAngleNode 链路（loading/连线/单图落地/error）；区别：① 无参数弹窗（预设固定、一键直发）；
    // ② 钉定支持多机位合成的图像模型（按模型名从可用模型里挑，缺失则回退默认模型）；③ 强制 1:1 方形画幅 + 4k，保证九格不被压扁、单格细节够。
    // 去噪重绘：一次点击跑两步（原图 → 白模 → 重绘），产出两个可见节点。
    //
    // 为什么白模要作为可见节点留下：白模跑没跑偏，只有人眼看得出来。藏起来的话，
    // 第 3 步出了坏图也不知道该怪白模还是怪重绘。留着还顺带能只重跑其中一步。
    const denoiseRepaintNode = useCallback(
        async (node: CanvasNodeData, variant: DenoiseVariant) => {
            if (!node.metadata?.content) return;
            // 两步两模型：灰模走 Seedream 5、重绘走另一个图像模型。判据在 pickDenoiseModels 里统一维护。
            const denoiseModels = pickDenoiseModels(effectiveConfig.imageModels);
            const whiteModel = denoiseModels.white;
            const geminiModel = denoiseModels.repaint;
            if (!whiteModel) {
                message.warning("当前分组没有配置 Seedream 图片模型，无法生成灰模，请联系管理员");
                return;
            }
            if (!geminiModel) {
                message.warning("当前分组还没有配置可用于重绘的图片模型，无法去噪重绘，请联系管理员在分组渠道里添加");
                return;
            }
            // 画幅与画质【沿用被处理的这张图自己的参数】：buildGenerationConfig 已经从 node.metadata
            // 继承 quality/size，这里不再另行指定——重绘的目标是同一张图的干净版本，
            // 换个档位出来的图跟原图没法直接比较，也会让面板上的显示与源节点对不上。
            //
            // ⚠️ 唯一的例外是 size 继承不到或继承到 auto 时必须兜底：那样后端不下发 aspectRatio，
            //    白模会被模型自行取景（常跑成方形），第 3 步再以这张跑偏的白模为几何基底，
            //    整套方法当场失效且全程不报错。后端接受 "宽x高" 形式的画幅并贴到最近的合法比例，
            //    所以兜底直接传源图真实像素即可，不要在前端自己算比例——
            //    「前端算一套、后端算另一套」是这套代码里最容易变成钱的一类分叉（参见 constant/credits.tsx 的说明）。
            const preset = DENOISE_VARIANTS[variant];
            const inherited = buildGenerationConfig(effectiveConfig, node, "image");
            let size = (inherited.size || "").trim();
            if (!size || size.toLowerCase() === "auto") {
                const natW = node.metadata.naturalWidth || 0;
                const natH = node.metadata.naturalHeight || 0;
                if (natW > 0 && natH > 0) size = `${natW}x${natH}`;
            }
            // count 必须钉死 1：重绘那条路只返回一张图，n 会被后端忽略，
            // 而下单时是按 n 预扣的，多填只会白走一次退差额流程。灰模那步同样只要一张。
            const baseConfig = { ...inherited, count: "1", ...(size ? { size } : {}) };
            const whiteConfig = { ...baseConfig, model: whiteModel };
            const repaintConfig = { ...baseConfig, model: geminiModel };
            if (!isAiConfigReady(whiteConfig, whiteConfig.model) || !isAiConfigReady(repaintConfig, repaintConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const gap = node.width + 96;
            const sourceRef = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };

            // ── 第 1 步：转白模 ──────────────────────────────────────────
            const whiteId = nanoid();
            const whiteMeta = buildImageGenerationMetadata("edit", whiteConfig, 1, [sourceRef]);
            addRunningNodeId(whiteId);
            setNodes((prev) => [
                ...prev,
                {
                    id: whiteId,
                    type: CanvasNodeType.Image,
                    title: `${node.title || "图片"} - 灰模·${preset.label}`,
                    position: { x: node.position.x + gap, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt: preset.white, status: NODE_STATUS_LOADING, ...whiteMeta },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: whiteId }]);
            setSelectedNodeIds(new Set([whiteId]));

            let whiteRef: typeof sourceRef;
            try {
                const onJob = (jobId: string) => setNodes((prev) => prev.map((it) => (it.id === whiteId ? { ...it, metadata: { ...it.metadata, imageJobId: jobId } } : it)));
                const image = await requestEdit(whiteConfig, preset.white, [sourceRef], undefined, onJob).then(firstGeneratedImage);
                const uploaded = await uploadImage(image.dataUrl);
                const size = standardMediaSize(uploaded.width, uploaded.height);
                setNodes((prev) => prev.map((it) => (it.id === whiteId ? { ...it, width: size.width, height: size.height, metadata: { ...it.metadata, ...imageMetadata(uploaded), imageJobId: undefined, prompt: preset.white, ...whiteMeta } } : it)));
                // 文件名跟随实际类型：灰模那步的上游（seedream）会无视 output_format=png 返回 JPEG，
                // 硬写 .png 会让文件名与内容长期不一致（Content-Type 已由 MIME 嗅探修正，这里补齐命名）。
                const whiteMime = uploaded.mimeType || "image/png";
                const whiteExt = whiteMime === "image/jpeg" ? "jpg" : whiteMime.replace("image/", "") || "png";
                whiteRef = { id: whiteId, name: `white-model.${whiteExt}`, type: whiteMime, dataUrl: uploaded.url, storageKey: uploaded.storageKey };
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "转白模失败";
                setNodes((prev) => prev.map((it) => (it.id === whiteId ? { ...it, metadata: { ...it.metadata, status: NODE_STATUS_ERROR, errorDetails } } : it)));
                message.error(`转白模失败：${errorDetails}。第二步未执行，未产生额外扣费。`);
                return; // 白模没成就不跑第 2 步——拿一张坏白模去重绘，只是多花一次钱换一张坏图
            } finally {
                removeRunningNodeId(whiteId);
            }

            // ── 第 2 步：以 [白模, 原图] 重绘 ────────────────────────────
            // ⚠️ 数组顺序 = 提示词里的「图片1 / 图片2」编号，两者同源（generationLabel 按下标生成）。
            //    调换这两项而不改提示词，模型会拿原图当结构、白模当外观，输出一张灰图。
            //
            // 这里【不】对原图做降采样。曾经加过 512 降采样，动机是「防止模型照抄原图」，
            // 但该动机已被证伪：高频残差相关性 r(原图, 重绘)=0.486，低于「确实重画过」的
            // 基线 r(原图, 灰模)=0.609 —— 模型本来就没有复制像素，降采样解的是不存在的问题，
            // 反而引入「把缩略图超分成模糊猜测版」和身份信息不足两个新风险。
            const repaintRefs = [whiteRef, sourceRef];
            const repaintId = nanoid();
            const repaintMeta = buildImageGenerationMetadata("edit", repaintConfig, 1, repaintRefs);
            addRunningNodeId(repaintId);
            setNodes((prev) => [
                ...prev,
                {
                    id: repaintId,
                    type: CanvasNodeType.Image,
                    title: `${node.title || "图片"} - 重绘·${preset.label}`,
                    position: { x: node.position.x + gap * 2, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt: preset.repaint, status: NODE_STATUS_LOADING, ...repaintMeta },
                },
            ]);
            setConnections((prev) => [
                ...prev,
                { id: nanoid(), fromNodeId: whiteId, toNodeId: repaintId },
                { id: nanoid(), fromNodeId: node.id, toNodeId: repaintId },
            ]);
            setSelectedNodeIds(new Set([repaintId]));
            setDialogNodeId(repaintId);
            try {
                const onJob = (jobId: string) => setNodes((prev) => prev.map((it) => (it.id === repaintId ? { ...it, metadata: { ...it.metadata, imageJobId: jobId } } : it)));
                const image = await requestEdit(repaintConfig, preset.repaint, repaintRefs, undefined, onJob).then(firstGeneratedImage);
                const uploaded = await uploadImage(image.dataUrl);
                const size = standardMediaSize(uploaded.width, uploaded.height);
                setNodes((prev) => prev.map((it) => (it.id === repaintId ? { ...it, width: size.width, height: size.height, metadata: { ...it.metadata, ...imageMetadata(uploaded), imageJobId: undefined, prompt: preset.repaint, ...repaintMeta } } : it)));
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "重绘失败";
                setNodes((prev) => prev.map((it) => (it.id === repaintId ? { ...it, metadata: { ...it.metadata, status: NODE_STATUS_ERROR, errorDetails } } : it)));
            } finally {
                removeRunningNodeId(repaintId);
            }
        },
        [addRunningNodeId, effectiveConfig, message, openConfigDialog, removeRunningNodeId],
    );

    const generateNineGridNode = useCallback(
        async (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            const geminiModel = (effectiveConfig.imageModels || []).find((name) => name.toLowerCase().includes("gemini"));
            // ⚠️ 没有可用模型时【必须中止】，不能沿用当前图片模型继续跑。
            // 原先是静默回退：拼不出 3×3，出来一张普通图，而点数照扣，
            // 用户既不知道为什么不对、也不知道要配什么。与「去噪重绘」的处理保持一致。
            if (!geminiModel) {
                message.warning("九宫格需要一个模型名里含 gemini 的图片模型（任何 OpenAI 兼容渠道提供的都可以）。当前可用模型里没有，请联系管理员在「分组管理 → 渠道 → 模型列表」里添加。", 8);
                return;
            }
            const generationConfig = {
                ...buildGenerationConfig(effectiveConfig, node, "image"),
                count: "1",
                size: "1:1",
                model: geminiModel,
                quality: "4k",
            };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = "九宫格机位";
            const prompt = NINE_GRID_PROMPT;
            const references = [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ];
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references);
            addRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            try {
                const onJobCreated = (jobId: string) => {
                    setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, imageJobId: jobId } } : item)));
                };
                const image = await requestEdit(generationConfig, prompt, references, undefined, onJobCreated).then(firstGeneratedImage);
                const uploaded = await uploadImage(image.dataUrl);
                const size = standardMediaSize(uploaded.width, uploaded.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), imageJobId: undefined, prompt, ...generationMetadata } } : item)));
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                removeRunningNodeId(childId);
            }
        },
        [addRunningNodeId, effectiveConfig, openConfigDialog, removeRunningNodeId],
    );

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            addRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            try {
                const onJobCreated = (jobId: string) => {
                    setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, imageJobId: jobId } } : item)));
                };
                const image = await requestEdit(
                    generationConfig,
                    prompt,
                    [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }],
                    undefined,
                    onJobCreated,
                ).then(firstGeneratedImage);
                const uploaded = await uploadImage(image.dataUrl);
                const size = standardMediaSize(uploaded.width, uploaded.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), imageJobId: undefined, prompt, ...generationMetadata } } : item)));
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                removeRunningNodeId(childId);
            }
        },
        [addRunningNodeId, effectiveConfig, openConfigDialog, removeRunningNodeId],
    );

    // 场景机位：文本模型根据描述出房间俯视平面布局 JSON → 解析后存入节点 metadata.roomScene.plan
    const generateRoomPlan = useCallback(
        async (sceneNodeId: string, prompt: string) => {
            const sceneNode = nodesRef.current.find((item) => item.id === sceneNodeId);
            const refScene = normalizeRoomScene(sceneNode?.metadata?.roomScene);
            const refImageUrl = refScene.refImageUrl;
            const trimmed = prompt.trim();
            if (!trimmed && !refImageUrl) {
                message.warning("请先填写房间描述或上传房间照片");
                return;
            }
            const textModel = effectiveConfig.textModel || effectiveConfig.textModels?.find((m) => modelMatchesCapability(m, "text")) || "";
            if (!textModel || !modelMatchesCapability(textModel, "text")) {
                message.error("生成平面图需要「文本模型」，当前没有可用文本模型，请在配置里选择文本模型或切换到含文本模型的分组渠道。");
                return;
            }
            const textConfig = { ...effectiveConfig, model: textModel };
            if (!isAiConfigReady(textConfig, textConfig.model)) {
                openConfigDialog(true);
                return;
            }
            setNodes((prev) => prev.map((item) => (item.id === sceneNodeId ? { ...item, metadata: { ...item.metadata, roomScene: { ...normalizeRoomScene(item.metadata?.roomScene), prompt: trimmed } } } : item)));
            setRoomPlanBusyIds((prev) => new Set(prev).add(sceneNodeId));
            try {
                // 有房间参考照片：图+文一起喂(vision)。上游只认 base64 / http(s)，故先把上传后的(应用内)地址转成 base64 data URL。
                const refImageData = refImageUrl ? await imageToDataUrl({ url: refImageUrl, storageKey: refScene.refImageStorageKey }) : "";
                const userContent = refImageData
                    ? [
                          { type: "text" as const, text: buildRoomPlanUserPrompt(trimmed || "（房间布局以照片为准）") },
                          { type: "image_url" as const, image_url: { url: refImageData } },
                      ]
                    : buildRoomPlanUserPrompt(trimmed);
                const messages = [
                    { role: "system" as const, content: ROOM_PLAN_SYSTEM_PROMPT },
                    { role: "user" as const, content: userContent },
                ];
                const answer = await requestImageQuestion(textConfig, messages, () => {}, { max_tokens: 4096 });
                const plan = parseRoomPlan(answer);
                if (!plan) {
                    message.error("平面图解析失败，请重试或调整房间描述");
                    return;
                }
                setNodes((prev) => prev.map((item) => (item.id === sceneNodeId ? { ...item, metadata: { ...item.metadata, roomScene: { ...normalizeRoomScene(item.metadata?.roomScene), prompt: trimmed, plan } } } : item)));
                message.success("平面图已生成");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "平面图生成失败");
            } finally {
                setRoomPlanBusyIds((prev) => {
                    const next = new Set(prev);
                    next.delete(sceneNodeId);
                    return next;
                });
            }
        },
        [effectiveConfig, isAiConfigReady, openConfigDialog, message],
    );

    // 场景机位：文+图双路出该机位角度图 —— 文本模型先把机位翻成视角描述(可选增强)，再 requestEdit(平面图标注截图 + 可选场景参考图)出图，建图片子节点并连线。
    const generateRoomSceneAngle = useCallback(
        async (roomNode: CanvasNodeData, scene: RoomSceneState, snapshotDataUrl: string) => {
            if (!scene.plan) {
                message.warning("请先生成平面图");
                return;
            }
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, roomNode, "image"), count: "1", ...(scene.imageModel ? { model: scene.imageModel } : {}) };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            let viewDescription = "";
            const textModel = effectiveConfig.textModel || effectiveConfig.textModels?.find((m) => modelMatchesCapability(m, "text")) || "";
            if (textModel && modelMatchesCapability(textModel, "text")) {
                try {
                    const viewMessages = [
                        { role: "system" as const, content: buildViewSystemPrompt() },
                        { role: "user" as const, content: buildViewUserPrompt(scene) },
                    ];
                    viewDescription = (await requestImageQuestion({ ...effectiveConfig, model: textModel }, viewMessages, () => {}, { max_tokens: 800 })).trim();
                } catch {
                    // 视角描述失败不阻断，退化为仅用平面图截图 + 原始描述出图
                }
            }
            const imagePrompt = buildRoomImagePrompt(scene, viewDescription);
            const references: ReferenceImage[] = [{ id: `${roomNode.id}-plan`, name: "room-plan.png", type: "image/png", dataUrl: snapshotDataUrl }];
            if (scene.sceneImageUrl) references.push({ id: `${roomNode.id}-scene`, name: "room-scene.png", type: "image/png", dataUrl: scene.sceneImageUrl, storageKey: scene.sceneStorageKey });
            const existingFrameCount = connectionsRef.current.filter((conn) => conn.fromNodeId === roomNode.id).length;
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const childId = nanoid();
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references);
            addRunningNodeId(childId);
            setRoomAngleBusyIds((prev) => new Set(prev).add(roomNode.id));
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: `场景机位 ${existingFrameCount + 1}`,
                    position: { x: roomNode.position.x + roomNode.width + 96, y: roomNode.position.y + existingFrameCount * (imageConfig.height + 48) },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt: imagePrompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: roomNode.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            try {
                const onJobCreated = (jobId: string) => {
                    setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, imageJobId: jobId } } : item)));
                };
                const image = await requestEdit(generationConfig, imagePrompt, references, undefined, onJobCreated).then(firstGeneratedImage);
                const uploaded = await uploadImage(image.dataUrl);
                const size = standardMediaSize(uploaded.width, uploaded.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), imageJobId: undefined, prompt: imagePrompt, ...generationMetadata } } : item)));
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                removeRunningNodeId(childId);
                setRoomAngleBusyIds((prev) => {
                    const next = new Set(prev);
                    next.delete(roomNode.id);
                    return next;
                });
            }
        },
        [addRunningNodeId, effectiveConfig, isAiConfigReady, openConfigDialog, removeRunningNodeId, message],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const selectedFiles = Array.from(event.target.files || []);
            const file = selectedFiles[0];
            const target = uploadTargetRef.current;
            if (!file) return;
            // 替换已有节点只用第一个文件且需类型受支持；新建则走多文件批量(自行过滤类型)。
            if (target?.nodeId && !file.type.startsWith("image/") && !file.type.startsWith("video/") && !isAudioFile(file)) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            if (target?.nodeId) {
                if (isAudioFile(file)) {
                    const audio = await uploadMediaFile(file, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) => prev.map((node) => (node.id === target.nodeId ? { ...node, type: CanvasNodeType.Audio, title: file.name, width: spec.width, height: spec.height, metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined } } : node)));
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                    uploadTargetRef.current = null;
                    event.target.value = "";
                    return;
                }
                if (file.type.startsWith("video/")) {
                    const video = await uploadMediaFile(file, "video");
                    const nextSize = standardMediaSize(video.width || 1280, video.height || 720);
                    setNodes((prev) => prev.map((node) => (node.id === target.nodeId ? { ...node, type: CanvasNodeType.Video, title: file.name, width: nextSize.width, height: nextSize.height, metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined } } : node)));
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(target.nodeId);
                    uploadTargetRef.current = null;
                    event.target.value = "";
                    return;
                }
                const image = await uploadImage(file);
                const size = standardMediaSize(image.width, image.height);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === target.nodeId
                            ? {
                                  ...node,
                                  type: CanvasNodeType.Image,
                                  title: file.name,
                                  width: size.width,
                                  height: size.height,
                                  metadata: {
                                      ...node.metadata,
                                      ...imageMetadata(image),
                                      errorDetails: undefined,
                                      freeResize: false,
                                      isBatchRoot: undefined,
                                      batchRootId: undefined,
                                      batchChildIds: undefined,
                                      batchUsesReferenceImages: undefined,
                                      generationType: undefined,
                                      model: undefined,
                                      size: undefined,
                                      quality: undefined,
                                      count: undefined,
                                      references: undefined,
                                      primaryImageId: undefined,
                                      imageBatchExpanded: undefined,
                                  },
                              }
                            : node,
                    ),
                );
                setSelectedNodeIds(new Set([target.nodeId]));
                setSelectedConnectionId(null);
                setDialogNodeId(target.nodeId);
            } else {
                const anchor = target?.position || getCanvasCenter();
                void createFileNodesBatch(selectedFiles, anchor);
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createFileNodesBatch, getCanvasCenter],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files);
            if (!files.length) return;
            // 落点在任何 await 之前同步算好，避免异步上传期间视口平移导致网格起点漂移。
            const pos = screenToCanvas(event.clientX, event.clientY);
            void createFileNodesBatch(files, pos);
        },
        [createFileNodesBatch, screenToCanvas],
    );

    const pasteAssistantImage = useCallback(
        (file: File) => {
            const position = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            void createImageFileNode(file, position);
            message.success("已从剪切板添加图片");
        },
        [createImageFileNode, message, screenToCanvas, size.height, size.width],
    );

    const handleAssistantSessionsChange = useCallback((sessions: CanvasAssistantSession[], activeId: string | null) => {
        setChatSessions(sessions);
        setActiveChatId(activeId);
    }, []);

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    // 当前画布积分来源的只读展示文案（建画布时已锁定，进画布后不可改）。
    const creditSourceLabel = currentProject?.projectId ? `积分来源：项目「${currentSourceProject?.name ?? currentProject.projectId}」` : "积分来源：个人积分";

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    // 生成前保证参考图在上游像素上限内:超了弹窗让用户「一键压缩」(不可逆替换为压缩版)或「自己改」(取消)。
    // 返回 false=用户取消、应中止本次生成;true=可继续(超大图已就地压缩+回写节点)。仅用于视频(seedance 36M 实测上限)。
    const ensureReferencesWithinLimit = useCallback(
        async (refImages: ReferenceImage[]): Promise<boolean> => {
            const oversized = await findOversizedReferenceImages(refImages, nodesRef.current);
            if (!oversized.length) return true;
            const proceed = await new Promise<boolean>((resolve) => {
                modal.confirm({
                    title: "参考图尺寸过大",
                    content: (
                        <div className="text-[13px] leading-6">
                            <div>有 {oversized.length} 张参考图超过上游像素上限（3600 万像素），直接生成会被拒绝：</div>
                            <div className="my-2 flex flex-wrap gap-x-3 gap-y-1">
                                {oversized.map((item) => {
                                    const node = nodesRef.current.find((n) => n.id === item.image.id);
                                    let label = item.image.name || item.image.id;
                                    if (node) label = getNodeDisplayName(node);
                                    return (
                                        <span
                                            key={item.image.id}
                                            className="cursor-pointer text-[#2563EB] underline underline-offset-2 hover:opacity-80"
                                            title="点击预览这张图"
                                            onClick={() => setPreviewNodeId(item.image.id)}
                                        >
                                            {label}（{item.width}×{item.height}）
                                        </span>
                                    );
                                })}
                            </div>
                            <div>「一键压缩」会把这些参考图不可逆地替换为压缩版（原始大图不再保留）；<span className="font-medium">更推荐点「我自己改」，自行缩小后再用，以保留原图质量</span>。</div>
                        </div>
                    ),
                    okText: "一键压缩并继续",
                    cancelText: "我自己改",
                    onOk: () => resolve(true),
                    onCancel: () => resolve(false),
                });
            });
            if (!proceed) return false;
            let done = 0;
            for (const { image } of oversized) {
                try {
                    const compressed = await downscaleToPixelBudget(await imageToDataUrl(image), REFERENCE_IMAGE_MAX_PIXELS, 0.9);
                    const uploaded = await uploadImage(compressed);
                    if (uploaded.width * uploaded.height > REFERENCE_IMAGE_MAX_PIXELS) continue; // 复核:没真压下去不算数、不误报
                    // 就地更新本次生成用的参考图对象 + 回写画布节点(持久化,下次也用小图)
                    image.dataUrl = compressed;
                    image.url = uploaded.url;
                    image.storageKey = uploaded.storageKey;
                    const size = standardMediaSize(uploaded.width, uploaded.height);
                    setNodes((prev) => prev.map((n) => (n.id === image.id ? { ...n, width: size.width, height: size.height, metadata: { ...n.metadata, content: uploaded.url, storageKey: uploaded.storageKey, naturalWidth: uploaded.width, naturalHeight: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType } } : n)));
                    done += 1;
                } catch {
                    // 单张压缩失败不阻断整轮
                }
            }
            if (done) message.success(`已压缩 ${done} 张参考图`);
            if (done < oversized.length) message.warning(`${oversized.length - done} 张压缩失败，可能仍会被上游拒绝`);
            return true;
        },
        [modal, message],
    );

    // autoEnrollReferences 生成视频前自动认证参考素材，返回「nodeId → asset:// 地址」映射和失败素材名。
    //
    // 收益：认证过的素材以 asset:// 交给上游，省掉「浏览器下载 → 转 dataURL → 重新上传」整圈往返，
    // 且天然免疫死链（根本不取像素）。含真人的参考视频/音频更是必须先入库，否则被上游
    // InputVideoSensitiveContentDetected 拒掉。认证接口不扣费。
    //
    // ⚠️ 返回映射而不是让调用方重建 generationContext：重建会把「参考编号」的取值时刻从点击那一刻
    // 推迟最多 40 秒，而这期间上游空节点可能刚出图、云同步可能整画布回灌、用户可能拖连线——
    // 任何一个都会让编号重排，于是用户手打的「图片2的构图」指到别的图上（串脸且照扣费）。
    // 就地回填 url 则把编号冻结在点击那一刻，与 readReferenceImage 里「active 时 url=assetUri」逐字等价。
    const autoEnrollReferences = useCallback(
        async (nodeIds: string[]): Promise<{ assetUriByNodeId: Record<string, string>; failedNames: string[] }> => {
            const empty = { assetUriByNodeId: {} as Record<string, string>, failedNames: [] as string[] };
            const candidates = nodeIds
                .map((id) => nodesRef.current.find((n) => n.id === id))
                .filter((node): node is CanvasNodeData => {
                    if (!node?.metadata?.content) return false;
                    const status = node.metadata.portraitAssetStatus;
                    // active=已认证；processing=有人在轮询；failed=后端对终态一律「重新入库」，
                    // 不跳过的话每次生成都要重新压缩+上传+调认证，白烧存储和流量，还重弹同一条失败提示。
                    // 手动那个「肖像授权」按钮不受影响，用户想重试仍可主动点。
                    if (status === "active" || status === "processing" || status === "failed") return false;
                    // 音频不做素材授权：所有模型都不需要它，而认证会把节点 url 改写成火山专有的
                    // asset://，反而让非火山的模型拿不到素材。
                    return node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video;
                });
            if (!candidates.length) return empty;

            // 规格预筛（只读，不写 metadata）：火山对参考视频/音频有 2~15 秒、尺寸、体积等硬要求。
            // 一段 20 秒的参考视频是完全正常的用法，只是不该走认证——直接跳过，
            // 绝不给它打上会持久化并云同步的「认证失败」标签，也不计入失败点名。
            const runnable = candidates.filter((node) => {
                if (node.type === CanvasNodeType.Image) return true;
                const kind = node.type === CanvasNodeType.Video ? "video" : "audio";
                return !validateVolcAssetMedia(kind, {
                    durationMs: node.metadata?.durationMs,
                    width: node.metadata?.naturalWidth,
                    height: node.metadata?.naturalHeight,
                    bytes: node.metadata?.bytes,
                    mimeType: node.metadata?.mimeType,
                    name: node.title,
                });
            });
            if (!runnable.length) return empty;

            const submitted = new Set<string>();
            const work = (async () => {
                // ⚠️ runGroupConcurrency 不吞异常（worker 抛出会让整个 Promise.all reject），worker 必须自己兜住。
                await runGroupConcurrency(runnable, 3, async (node) => {
                    try {
                        const result = await enrollPortraitAsset(node, true);
                        if (result === "submitted" || result === "active") submitted.add(node.id);
                    } catch {
                        /* 自动认证是增强不是必需：单个失败不影响其它，也不影响出片 */
                    }
                });
                // 等已提交的转成 active。轮询由 enrollPortraitAsset 内部的 pollPortraitAsset 负责，这里只盯 metadata。
                while (true) {
                    const done = Array.from(submitted).every((id) => {
                        const st = nodesRef.current.find((n) => n.id === id)?.metadata?.portraitAssetStatus;
                        return st === "active" || st === "failed";
                    });
                    if (done) return;
                    await new Promise((resolve) => setTimeout(resolve, 800));
                }
            })();

            // ⚠️ 真正的硬上限只能靠 race：认证那几个接口全是裸 axios、没设 timeout（默认无限等），
            // 光在派发前判 deadline 挡不住已经在飞的请求，最坏能卡好几分钟。
            // 超时后后台该跑的继续跑（下次生成自然受益），这里只是不再等。
            await Promise.race([work, new Promise((resolve) => setTimeout(resolve, AUTO_ENROLL_TIMEOUT_MS))]);

            const assetUriByNodeId: Record<string, string> = {};
            const failedNames: string[] = [];
            for (const node of runnable) {
                const fresh = nodesRef.current.find((n) => n.id === node.id);
                const uri = fresh?.metadata?.portraitAssetStatus === "active" ? fresh?.metadata?.portraitAssetUri : "";
                if (uri) assetUriByNodeId[node.id] = uri;
                else failedNames.push(getNodeDisplayName(fresh || node));
            }
            return { assetUriByNodeId, failedNames };
        },
        [enrollPortraitAsset],
    );

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, opts?: GenerateNodeOptions) => {
            // 防连点：同一源节点在冷却时间内的重复「生成」点击直接忽略。已生成节点重生成会 spawn 新节点且源立即恢复可点，
            // 卡顿时用户狂点会瞬间 spawn 一大批（浪费点数、塞满画布）。批量「一键生成」逐个节点各自独立、互不影响。
            {
                const GEN_COOLDOWN_MS = 5000;
                const nowMs = Date.now();
                const lastMs = generateCooldownRef.current.get(nodeId) ?? 0;
                if (nowMs - lastMs < GEN_COOLDOWN_MS) {
                    if (nowMs - generateCooldownToastRef.current > 2000) {
                        generateCooldownToastRef.current = nowMs;
                        message.info("操作太快啦，生成请求已提交，请勿连续点击");
                    }
                    return;
                }
                generateCooldownRef.current.set(nodeId, nowMs);
            }
            // 生成二级确认（全局开关，默认关）：开启时点「生成」先弹窗确认；批量生成由批量入口统一确认一次后置 bypass。
            if (useConfigStore.getState().config.confirmBeforeGenerate && !bypassGenerateConfirmRef.current) {
                const confirmed = await new Promise<boolean>((resolve) => {
                    modal.confirm({
                        title: "确认生成？",
                        content: "已开启生成二级确认，确定要执行本次生成吗？",
                        okText: "生成",
                        cancelText: "取消",
                        onOk: () => resolve(true),
                        onCancel: () => resolve(false),
                    });
                });
                if (!confirmed) return;
            }
            // 未使用参考提醒（全局开关，默认开）：连线接入了参考素材但提示词没 @ 引用到 → 弹窗提醒避免漏用。
            // 批量入口已统一汇总检查并置 bypass，内层逐个跳过。
            if (useConfigStore.getState().config.warnUnusedReferences !== false && !bypassGenerateConfirmRef.current) {
                const unusedRefs = findUnusedReferenceInputs(nodeId, nodesRef.current, connectionsRef.current, prompt);
                if (unusedRefs.length) {
                    const unusedNames = unusedRefs
                        .map((input) => nodesRef.current.find((node) => node.id === input.nodeId))
                        .filter((node): node is CanvasNodeData => Boolean(node))
                        .map((node) => getNodeDisplayName(node))
                        .join("、");
                    const proceedUnused = await new Promise<boolean>((resolve) => {
                        modal.confirm({
                            title: "有参考素材没用到",
                            content: `你接入了「${unusedNames}」但提示词里没提到，确定直接生成吗？`,
                            okText: "仍然生成",
                            cancelText: "返回检查",
                            onOk: () => resolve(true),
                            onCancel: () => resolve(false),
                        });
                    });
                    if (!proceedUnused) return;
                }
            }
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            addRunningNodeId(nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? `请根据要求修改以下文本。\n\n原文：\n${sourceTextContent}\n\n修改要求：\n${prompt}` : prompt),
            );
            const effectivePrompt = generationContext.prompt.trim();
            // 图片风格：把所选预设的助提示词追加到用户描述后，仅用于发给上游的 prompt；
            // 不改 effectivePrompt（节点 metadata/标题/草稿仍保留用户原文，风格切换/重生成不污染）。
            const styledImagePrompt = mode === "image" ? composeImagePrompt(effectivePrompt, generationConfig.imageStyle, generationConfig.imageView) : effectivePrompt;
            // 视频风格：同理把所选视频风格助提示词追加到用户描述后（仅发给上游，节点原文不动）。
            const styledVideoPrompt = mode === "video" ? composeVideoPrompt(effectivePrompt, generationConfig.videoStyle) : effectivePrompt;
            // 在「已生成的视频/音频节点」上重生成会另起新节点(spawn)；原节点必须保留其已生成内容。
            // 把「已生成媒体源」(有 content 的 video/audio)排除出源状态标记：否则新节点失败时下方
            // error 写回会把原节点也写成 error(videoUrl 虽仍在 metadata、但状态被覆盖→显示报错、内容像丢失)。
            // 仅「空媒体节点就地生成(源=目标)」「文本/config」才标记源状态；图片始终单独处理。
            const isReusedMediaSource =
                (sourceNode?.type === CanvasNodeType.Video || sourceNode?.type === CanvasNodeType.Audio) &&
                Boolean(sourceNode?.metadata?.content);
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode && !isReusedMediaSource;
            const statusPrompt = sourceNode?.type === CanvasNodeType.Config ? effectivePrompt : prompt;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                // 音频必须有文字：上游 text_prompt 是必填，光给参考音频/参考图片生成不出东西。
                // 原先这里是静默 return——按钮点下去毫无反应，用户只会以为功能坏了。
                if (mode === "audio") message.warning("请先描述要生成的音频内容：只接参考素材、不写文字是生成不了的", 6);
                removeRunningNodeId(nodeId);
                return;
            }
            // 参考图超大自检(仅视频/seedance:36M 是其实测上限;gpt-image 上限未确认,不对图片强制压缩以免误伤)。
            // 取消则中止本次生成;确认则超大图已在 ensureReferencesWithinLimit 内就地压缩(mutate generationContext.referenceImages,视频发送直接读它)。
            if (mode === "video" && !(await ensureReferencesWithinLimit(generationContext.referenceImages))) {
                removeRunningNodeId(nodeId);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: statusPrompt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = opts?.forceCount ?? getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    // 在「已生成的图片节点」上再点生成：复刻它当初的参考结构进行生成（沿用它的原始 references），
                    // 而不是把它自己的输出图当作新参考——edit 节点复刻原参考、纯文生图复刻为纯文生图；
                    // 原参考丢失时退回画布上游连入的参考。上传的图片（无生成元数据）仍按「拿自身当参考做图生图」处理。
                    const sourceWasGenerated = isImageNode && Boolean(sourceNode?.metadata?.generationType);
                    let referenceImages: ReferenceImage[];
                    if (sourceWasGenerated) {
                        // 快照过期(用户换了上游图/改了连线)时不复刻，直接落到下面「以当前连线为准」的分支。
                        const staleSnapshot = referenceSnapshotStale(sourceNode?.metadata?.references, generationReferenceUrls(generationContext));
                        const reproduced = sourceNode?.metadata?.generationType === "edit" && !staleSnapshot ? await resolveMetadataReferences(sourceNode.metadata) : [];
                        referenceImages = reproduced && reproduced.length ? reproduced : sourceNode?.metadata?.generationType === "edit" ? generationContext.referenceImages : [];
                    } else {
                        const sourceReference =
                            isImageNode && sourceNode?.metadata?.content
                                ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata.mimeType || "image/png", dataUrl: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey }]
                                : [];
                        referenceImages = sourceReference.length ? sourceReference : generationContext.referenceImages;
                    }
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    // 新生成图片节点的占位尺寸：按本次生成比例预判最终标准尺寸（同一批共用 config、尺寸一致），
                    // 使占位即终态（避免占位 340×240 → 实际高 360 的 resize 跳动），网格间距也据此算、不再重叠。
                    const expectedSize = expectedImageNodeSize(generationConfig);
                    // 定位锚点用源节点的【真实】宽高（参考图源本身是 203×360 等真实尺寸），而非默认 340×240，
                    // 否则源是图片节点时新节点会压到源图上（参考图场景重叠的主因）。
                    const parentWidth = sourceNode?.width || parentConfig.width;
                    const parentHeight = sourceNode?.height || parentConfig.height;
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const gap = 96;
                    const colGap = 36;
                    const rowGap = 36;
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const childIds = count > 1 ? Array.from({ length: count }, () => nanoid()) : [];
                    const targetIds = count > 1 ? childIds : [rootId];
                    pendingChildIds = isEmptyImageNode ? childIds : [rootId, ...childIds];
                    // 落点：默认「源节点右侧 +96」；批量生成会算好互不遮挡的空位从 opts 传进来。
                    let rootPosition: Position = {
                        x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentWidth + gap,
                        y: parentPosition.y + parentHeight / 2 - expectedSize.height / 2,
                    };
                    if (opts?.spawnPosition && !isEmptyImageNode) rootPosition = { x: opts.spawnPosition.x, y: opts.spawnPosition.y };
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: rootPosition,
                        width: isEmptyImageNode ? sourceNode?.width || expectedSize.width : expectedSize.width,
                        height: isEmptyImageNode ? sourceNode?.height || expectedSize.height : expectedSize.height,
                        metadata: {
                            prompt: effectivePrompt,
                            // 生成出的节点都带上用户的原始输入，点开任意一张（含批量子图）都能查看提示词
                            promptDraft: prompt,
                            status: NODE_STATUS_LOADING,
                            isBatchRoot: count > 1,
                            batchChildIds: count > 1 ? childIds : undefined,
                            batchUsesReferenceImages: referenceImages.length > 0,
                            ...generationMetadata,
                            imageBatchExpanded: count > 1 ? true : undefined,
                        },
                    };
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: rootNode.position.x + rootNode.width + 120 + (index % 2) * (expectedSize.width + colGap),
                            y: rootNode.position.y + Math.floor(index / 2) * (expectedSize.height + rowGap),
                        },
                        width: expectedSize.width,
                        height: expectedSize.height,
                        metadata: { prompt: effectivePrompt, promptDraft: prompt, status: NODE_STATUS_LOADING, batchRootId: count > 1 ? rootId : undefined, ...generationMetadata },
                    }));
                    // 已生成的图片节点再生成：副本复制原节点的全部入边（原节点的参考来源 → 新节点），
                    // 而不是把原节点自己当成新节点的父；空节点首次生成不加入边。
                    const rootInbound = isEmptyImageNode ? [] : connectionsRef.current.filter((c) => c.toNodeId === nodeId).map((c) => ({ id: nanoid(), fromNodeId: c.fromNodeId, toNodeId: rootId }));
                    const batchConnections = [...rootInbound, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId }))];

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, prompt: effectivePrompt, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                        ...childNodes,
                    ]);
                    setConnections((prev) => [...prev, ...batchConnections]);
                    if (pendingChildIds.length) opts?.onSpawn?.(pendingChildIds);
                    if (!opts?.silentSelection) {
                        setSelectedNodeIds(new Set([nodeId]));
                        setSelectedConnectionId(null);
                        setDialogNodeId(nodeId);
                    }
                    // 在「已生成节点」上重生成会另起新节点，新节点自带 LOADING 转圈。把 running 从源节点
                    // 转移到新节点：源立即恢复可点（可连续从同一张发起多次生成），不再「原节点按钮一直转圈无法生成」。
                    // 仅 spawn 新节点的情形转移；空图节点首次生成=就地生成(源即目标)、config 节点保持原有锁定。
                    if (!isEmptyImageNode && !isConfigNode) {
                        removeRunningNodeId(nodeId);
                        pendingChildIds.forEach(addRunningNodeId);
                    }

                    let hasSuccess = false;
                    let hasFailure = false;
                    await Promise.all(
                        targetIds.map(async (targetId) => {
                            try {
                                const onJobCreated = (jobId: string) => {
                                    setNodes((prev) => prev.map((item) => (item.id === targetId ? { ...item, metadata: { ...item.metadata, imageJobId: jobId, traceId: jobId } } : item)));
                                };
                                const image = referenceImages.length
                                    ? await requestEdit({ ...generationConfig, count: "1" }, styledImagePrompt, referenceImages, undefined, onJobCreated).then(firstGeneratedImage)
                                    : await requestGeneration({ ...generationConfig, count: "1" }, styledImagePrompt, onJobCreated).then(firstGeneratedImage);
                                const uploaded = await uploadImage(image.dataUrl);
                                const imageSize = standardMediaSize(uploaded.width, uploaded.height);
                                setNodes((prev) => {
                                    const root = prev.find((node) => node.id === rootId);
                                    return prev.map((node) => {
                                        if (node.id !== targetId && node.id !== rootId) return node;
                                        if (node.id === rootId && (targetId === rootId || !root?.metadata?.primaryImageId))
                                            return {
                                                ...node,
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...imageMetadata(uploaded), primaryImageId: targetId },
                                            };
                                        if (node.id === targetId)
                                            return {
                                                ...node,
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...imageMetadata(uploaded), imageJobId: undefined },
                                            };
                                        return node;
                                    });
                                });
                                hasSuccess = true;
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                const errorDetails = error instanceof Error ? error.message : "生成失败";
                                const traceId = errorTraceId(error);
                                hasFailure = true;
                                setNodes((prev) => prev.map((node) => (node.id === targetId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails, ...(traceId ? { traceId } : {}) } } : node)));
                                return false;
                            }
                        }),
                    );
                    if (hasFailure) message.error(hasSuccess ? "部分图片生成失败" : "全部图片生成失败");
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : "全部图片生成失败" } }
                                : node.id === nodeId && isEmptyImageNode
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : "全部图片生成失败" } }
                                  : node.id === rootId && !hasSuccess
                                    ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: "全部图片生成失败" } }
                                    : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    // 生成前自动认证参考素材。三道闸门缺一不可：
                    //   ① 后端总开关 portraitAsset.enabled；② 用户偏好 autoEnrollPortraits；
                    //   ③ ⚠️ 必须是 Seedance —— asset:// 只有 Seedance 认。其它视频模型
                    //      会把它当普通参考地址发出去，后端 IsPublicHTTPURL 一校验就报
                    //      「参考视频必须是公网可访问地址」，任务建不起来；而节点已被写成 active，
                    //      之后每次生成都取到 asset://，那个参考视频在这批模型上就【永久废了】。
                    if (
                        portraitAssetEnabled &&
                        useConfigStore.getState().config.autoEnrollPortraits !== false &&
                        isSeedanceVideoConfig({ ...generationConfig, model: (generationConfig.model || generationConfig.videoModel || "").trim() })
                    ) {
                        const refBuckets = [generationContext.referenceImages, generationContext.referenceVideos, generationContext.referenceAudios];
                        const refIds = refBuckets.flat().map((ref) => ref.id).filter(Boolean);
                        if (refIds.length) {
                            const hide = message.loading({ content: "正在核验参考素材…", key: `auto-enroll-${nodeId}`, duration: 0 });
                            let enrolled: { assetUriByNodeId: Record<string, string>; failedNames: string[] } = { assetUriByNodeId: {}, failedNames: [] };
                            try {
                                enrolled = await autoEnrollReferences(refIds);
                            } catch {
                                // 自动认证是增强、不是必需：任何异常都不许挡住出片。
                            }
                            hide();
                            // 就地回填，不重建 context——数组身份/长度/顺序/label 全不动，编号冻结在点击那一刻。
                            // 只在拿到 uri 时才赋值：失败/超时的保持原 url，照旧走下载+上传的老路。
                            for (const bucket of refBuckets) {
                                for (const ref of bucket) {
                                    const uri = enrolled.assetUriByNodeId[ref.id];
                                    if (uri) ref.url = uri;
                                }
                            }
                            if (enrolled.failedNames.length) {
                                message.warning(`${enrolled.failedNames.join("、")} 未能通过素材授权，本次按普通参考素材使用（不影响出片）`);
                            }
                        }
                    }
                    // 视频占位也按终态算：默认盒子 640×360 在常见比例下碰巧和 standardMediaSize 一致，
                    // 但 21:9 这种超宽会差（640×274 vs 720×309），统一走同一个函数免得偶发跳动。
                    const spec = expectedMediaSizeFromRatio(generationConfig.size) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    // ⚠️ 该节点上已经有在跑的任务 → 接回原任务，绝不再开一个。
                    //
                    // 下面构建 videoNode 时 metadata 是全新对象、不带 videoTaskId，等于把原任务号抹掉：
                    // 旧任务在上游照跑，却再没人轮询它，于是变成孤儿（只能靠服务端兜底救援捡回「我的素材」），
                    // 同时新任务又扣一份钱。用户还以为「我没点过生成」——
                    // 他点的是卡住时的第二次「生成」，5 秒防连点冷却挡不住（间隔 15~25 秒）。
                    // 重试路径早就是「有 taskId 就续查」，生成路径以前漏了这道守卫。
                    // ⚠️ 必须排除 error：失败时【不会】清掉 videoTaskId（留着供诊断与服务端孤儿救援），
                    // 于是「已失败」的节点同样满足「无 content + 有 taskId」，会被这道守卫当成"还在跑"，
                    // 接回一个早已终结的任务——用户点重试永远回到同一句「已接回原任务」，再也生成不了。
                    // 这类「已失败但仍留着 taskId」的节点会越积越多，数量甚至能超过真正在跑的任务。
                    // 同一处判据在计时器那边（inProgress）早就写对了，这里当初漏了。
                    const videoFailed = sourceNode?.metadata?.status === NODE_STATUS_ERROR;
                    const inflightVideoTaskId = isEmptyVideoNode && !videoFailed ? (sourceNode?.metadata?.videoTaskId || "").trim() : "";
                    if (inflightVideoTaskId && sourceNode) {
                        const resumeConfig = { ...generationConfig, model: sourceNode.metadata?.model || generationConfig.model };
                        message.info({ content: "该节点已有正在生成的视频，已接回原任务（不会重复扣费）", key: `resume-${nodeId}` });
                        const resumed = await storeGeneratedVideo(
                            await waitVideoGenerationTask(resumeConfig, { id: inflightVideoTaskId, provider: sourceNode.metadata?.videoTaskProvider || "seedance", model: resumeConfig.model }),
                            resumeConfig,
                        );
                        const resumedSize = standardMediaSize(resumed.width || sourceNode.width, resumed.height || sourceNode.height);
                        setNodes((prev) =>
                            prev.map((item) =>
                                item.id === nodeId
                                    ? { ...item, width: resumedSize.width, height: resumedSize.height, metadata: { ...item.metadata, ...videoMetadata(resumed), videoTaskId: undefined, videoTaskProvider: undefined } }
                                    : item,
                            ),
                        );
                        return;
                    }
                    const videoId = isEmptyVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    let videoPosition: Position = { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y };
                    if (isEmptyVideoNode && sourceNode) videoPosition = sourceNode.position;
                    else if (opts?.spawnPosition) videoPosition = { x: opts.spawnPosition.x, y: opts.spawnPosition.y };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: videoPosition,
                        width: isEmptyVideoNode ? sourceNode.width : spec.width,
                        height: isEmptyVideoNode ? sourceNode.height : spec.height,
                        // ⚠️ videoFrameRoles 必须跟着 videoMode 一起落到新节点上。这里是【新建】节点、
                        // 不是在原 metadata 上打补丁，漏一个字段就永远补不回来：用户在源节点上点过「对调首尾帧」，
                        // 首次生成用的是对调后的顺序，可这个新视频节点上没有这份记录——之后一点「重试」，
                        // 请求层找不到角色就落回接入顺序，片子悄悄倒着重生成一遍，界面上一点异常都看不出来。
                        //（角色的键是参考图的节点 id，新节点的入边是从源节点整份复制过来的，所以键在这边照样对得上。）
                        metadata: { prompt: effectivePrompt, promptDraft: prompt, status: NODE_STATUS_LOADING, model: generationConfig.model, size: generationConfig.size, seconds: generationConfig.videoSeconds, vquality: generationConfig.vquality, generateAudio: generationConfig.videoGenerateAudio, watermark: generationConfig.videoWatermark, videoOutputFormat: generationConfig.videoOutputFormat, videoMode: generationConfig.videoMode, videoFrameRoles: generationConfig.videoFrameRoles, videoStyle: generationConfig.videoStyle, references: generationReferenceUrls(generationContext) },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) => (isEmptyVideoNode ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node)) : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode]));
                    // 已生成的视频节点再生成：副本复制原节点的全部入边（原参考来源 → 新节点），而非把原节点当父
                    if (!isEmptyVideoNode) {
                        const videoInbound = connectionsRef.current.filter((c) => c.toNodeId === nodeId).map((c) => ({ id: nanoid(), fromNodeId: c.fromNodeId, toNodeId: videoId }));
                        if (videoInbound.length) setConnections((prev) => [...prev, ...videoInbound]);
                    }
                    // 在已生成视频节点上重生成=另起新节点：把 running 从源转移到新节点，源立即恢复可点。
                    if (!isEmptyVideoNode) {
                        removeRunningNodeId(nodeId);
                        addRunningNodeId(videoId);
                        opts?.onSpawn?.([videoId]);
                    }
                    // 超出上限的参考图会被丢掉。丢可以，但必须让用户知道——
                    // 原先是静默截断（写死 7 张），用户只能靠肉眼发现参考没生效。
                    // 只有走 OpenAI 方言那条路才会截断：Seedance 那条路自有规格，
                    // 而参考视频/音频在 createVideoGenerationTask 里就已经被挡下并明确报错了。
                    if (!isSeedanceVideoConfig(generationConfig)) {
                        const limits = videoRefLimits(generationConfig.model || "");
                        const extra = generationContext.referenceImages.length - limits.images;
                        if (extra > 0) {
                            message.warning(`参考图超出上限，已按顺序只取前 ${limits.images} 张，本次丢弃 ${extra} 张。`, 8);
                        }
                    }
                    const video = await storeGeneratedVideo(
                        await requestVideoGeneration(generationConfig, styledVideoPrompt, generationContext.referenceImages, generationContext.referenceVideos, generationContext.referenceAudios, (task) => {
                            // 任务 ID 立即落节点：超时/刷新后重试可续查原任务
                            setNodes((prev) => prev.map((item) => (item.id === videoId ? { ...item, metadata: { ...item.metadata, videoTaskId: task.id, videoTaskProvider: task.provider, ...(task.traceId ? { traceId: task.traceId } : {}) } } : item)));
                        }, { nodeId: videoId, x: videoNode.position.x, y: videoNode.position.y, width: videoNode.width, height: videoNode.height }),
                        generationConfig,
                    );
                    const videoSize = standardMediaSize(video.width || spec.width, video.height || spec.height);
                    setNodes((prev) => prev.map((node) => (node.id === videoId ? { ...node, width: videoSize.width, height: videoSize.height, metadata: { ...node.metadata, ...videoMetadata(video), videoTaskId: undefined, videoTaskProvider: undefined, prompt: effectivePrompt, model: generationConfig.model, size: generationConfig.size, seconds: generationConfig.videoSeconds, vquality: generationConfig.vquality, generateAudio: generationConfig.videoGenerateAudio, watermark: generationConfig.videoWatermark, videoOutputFormat: generationConfig.videoOutputFormat, videoMode: generationConfig.videoMode, videoFrameRoles: generationConfig.videoFrameRoles, videoStyle: generationConfig.videoStyle, references: generationReferenceUrls(generationContext) } } : node)));
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const audioId = isEmptyAudioNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    let audioPosition: Position = { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 };
                    if (isEmptyAudioNode && sourceNode) audioPosition = sourceNode.position;
                    else if (opts?.spawnPosition) audioPosition = { x: opts.spawnPosition.x, y: opts.spawnPosition.y };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: audioPosition,
                        width: isEmptyAudioNode ? sourceNode.width : spec.width,
                        height: isEmptyAudioNode ? sourceNode.height : spec.height,
                        metadata: { prompt: effectivePrompt, promptDraft: prompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) => (isEmptyAudioNode ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node)) : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode]));
                    // 已生成的音频节点再生成：副本复制原节点的全部入边（原参考来源 → 新节点），而非把原节点当父
                    if (!isEmptyAudioNode) {
                        const audioInbound = connectionsRef.current.filter((c) => c.toNodeId === nodeId).map((c) => ({ id: nanoid(), fromNodeId: c.fromNodeId, toNodeId: audioId }));
                        if (audioInbound.length) setConnections((prev) => [...prev, ...audioInbound]);
                    }
                    // 在已生成音频节点上重生成=另起新节点：把 running 从源转移到新节点，源立即恢复可点。
                    if (!isEmptyAudioNode) {
                        removeRunningNodeId(nodeId);
                        addRunningNodeId(audioId);
                        opts?.onSpawn?.([audioId]);
                    }
                    // seed-audio(音频生成)：带参考素材。裁到上游上限、把标签改写成 @音频N，
                    // 被丢掉的东西一律弹出来告诉用户（不做静默截断）。非 seed-audio 模型原样走老路。
                    const audioRequest = buildSeedAudioRequest({
                        prompt: effectivePrompt,
                        model: generationConfig.model || generationConfig.audioModel,
                        audios: generationContext.referenceAudios,
                        images: generationContext.referenceImages,
                    });
                    for (const warning of audioRequest.warnings) message.warning(warning, 8);
                    if (audioRequest.blocked) throw new Error(audioRequest.blocked);
                    const audioResult = await requestAudioGeneration(generationConfig, audioRequest.prompt, { audios: audioRequest.audios as typeof generationContext.referenceAudios, images: audioRequest.images as typeof generationContext.referenceImages });
                    const audio = await storeGeneratedAudio(audioResult.blob, generationConfig.audioFormat);
                    setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...(audioResult.traceId ? { traceId: audioResult.traceId } : {}), ...(audioResult.billedSeconds ? { audioBilledSeconds: audioResult.billedSeconds } : {}), ...buildAudioGenerationMetadata(generationConfig), references: generationReferenceUrls(generationContext) } } : node)));
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = isConfigNode ? getGenerationCount(generationConfig.count) : 1;
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = isConfigNode || editingTextNode ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (isConfigNode || editingTextNode) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: effectivePrompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, fontSize: 14 },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, prompt: effectivePrompt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))]);
                }

                const answers = await Promise.all(
                    (childIds.length ? childIds : [nodeId]).map((targetNodeId) => {
                        let localStreamed = "";
                        return requestImageQuestion(generationConfig, buildNodeChatMessages({ ...generationContext, prompt: effectivePrompt }), (text) => {
                            localStreamed = text;
                            streamed = text;
                            if (isConfigNode) return;
                            setNodes((prev) => prev.map((node) => (node.id === targetNodeId ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node)));
                        }).then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }));
                    }),
                );
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode
                                ? { ...node, type: CanvasNodeType.Text, title: prompt.slice(0, 32) || "Generated Text", metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                                : node,
                    ),
                );
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                const traceId = errorTraceId(error);
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails, ...(traceId ? { traceId } : {}) } }) : node)),
                );
            } finally {
                removeRunningNodeId(nodeId);
                // 清理已转移到新节点的 running id，防止泄漏（非 spawn 情形 pendingChildIds 为空，等价无操作）。
                pendingChildIds.forEach(removeRunningNodeId);
            }
        },
        [addRunningNodeId, effectiveConfig, message, openConfigDialog, removeRunningNodeId],
    );

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData) => {
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const batchRoot = node.metadata?.batchRootId ? nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            // 重生成取值优先原始草稿(composerContent/promptDraft，含 @[node:] token)，而非已解析烘焙版 prompt：
            // 复制的已生成节点其 prompt 里烘焙了旧编号(如"角色A图片3")，若直接喂它 buildNodeGenerationContext 会走非 composer 分支、
            // 只按当前连线重编参考图 图片1..N 却不改正文标签 → 号与图错位串脸。改用草稿则标签与参考图同一遍解析、编号=位置一致。
            const retryPromptSource = sourceNode.metadata?.composerContent || sourceNode.metadata?.promptDraft || sourceNode.metadata?.prompt || node.metadata?.composerContent || node.metadata?.promptDraft || node.metadata?.prompt || "";
            // 无条件按当前连线解析一次上下文：既供「无存档元数据」的原路径使用，也用来判断存档里的
            // 参考快照是否已经过期（用户换掉上游图/改了连线后，存档里的 references 仍是旧的）。
            const context = await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, retryPromptSource));
            // 只有存在【原始草稿】(含 @[node:] token)时才允许改用当前连线重试：
            // 草稿能让「正文标签」与「参考图集合」在同一遍解析里生成，编号=位置一定对齐；
            // 若只剩烘焙版 prompt（正文里写死了旧编号"图片1/图片2"），换参考图会造成号与图错位串脸，
            // 那种情况宁可保持复刻存档的老行为。
            const hasRetryDraft = Boolean(sourceNode.metadata?.composerContent || sourceNode.metadata?.promptDraft || node.metadata?.composerContent || node.metadata?.promptDraft);
            const savedSnapshotStale = hasSavedImageMetadata && savedImageMetadata ? referenceSnapshotStale(savedImageMetadata.references, generationReferenceUrls(context)) : false;
            // 存档可用 = 有存档 且 不是「快照过期且能安全重解析」的情况
            const useSavedMetadata = Boolean(hasSavedImageMetadata && savedImageMetadata) && !(savedSnapshotStale && hasRetryDraft);
            const prompt = ((useSavedMetadata ? savedImageMetadata?.prompt : "") || context?.prompt || "").trim();
            if (!prompt) {
                message.warning("找不到提示词，无法重试");
                return;
            }
            const generationType = useSavedMetadata ? savedImageMetadata?.generationType : undefined;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                useSavedMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(batchRoot || sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error("参考图片已丢失，无法继续重试");
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "参考图片已丢失，无法继续重试" } } : item)));
                return;
            }
            const retryImages = retryReferenceImages || [];
            // 视频重试同样自检参考图超大(与首次生成一致);取消则不进入生成
            if (node.type === CanvasNodeType.Video && !(await ensureReferencesWithinLimit(retryImages))) return;

            addRunningNodeId(node.id);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(generationConfig, buildNodeChatMessages({ ...context, prompt }), (text) => {
                        streamed = text;
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                    });
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    // 有未完成的任务 ID：先续查原任务（云端保留 48 小时），查不到/已失败才重新创建
                    let video: Awaited<ReturnType<typeof storeGeneratedVideo>> | null = null;
                    if (node.metadata?.videoTaskId && !node.metadata?.content) {
                        try {
                            video = await storeGeneratedVideo(await waitVideoGenerationTask(generationConfig, { id: node.metadata.videoTaskId, provider: node.metadata.videoTaskProvider || "seedance", model: generationConfig.model }), generationConfig);
                        } catch (resumeError) {
                            // 原任务确实失败/过期：清除任务标记，落回重新生成
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, videoTaskId: undefined, videoTaskProvider: undefined } } : item)));
                            message.warning(`原任务无法恢复（${resumeError instanceof Error ? resumeError.message : "未知原因"}），将重新生成`);
                        }
                    }
                    if (!video) {
                        video = await storeGeneratedVideo(
                            await requestVideoGeneration(generationConfig, composeVideoPrompt(prompt, node.metadata?.videoStyle || generationConfig.videoStyle), retryImages, context?.referenceVideos || [], context?.referenceAudios || [], (task) => {
                                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, videoTaskId: task.id, videoTaskProvider: task.provider, ...(task.traceId ? { traceId: task.traceId } : {}) } } : item)));
                            }, { nodeId: node.id, x: node.position.x, y: node.position.y, width: node.width, height: node.height }),
                            generationConfig,
                        );
                    }
                    const videoSize = standardMediaSize(video.width || node.width, video.height || node.height);
                    // ⚠️ 这里【故意不写】videoFrameRoles，与上面「生成」那两处不同，不是漏的：
                    //    重试改的是【原节点自己】，`...item.metadata` 已经把它原样带着了。
                    //    反倒是显式写回更危险 —— generationConfig 是【点重试那一刻的快照】，
                    //    而视频往往要跑几分钟，用户完全可能在等待期间点了「对调首尾帧」；
                    //    拿快照盖回去就是把他这几分钟里做的修改悄悄回滚掉。
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, width: videoSize.width, height: videoSize.height, metadata: { ...item.metadata, ...videoMetadata(video), videoTaskId: undefined, videoTaskProvider: undefined, prompt, model: generationConfig.model, size: generationConfig.size, seconds: generationConfig.videoSeconds, vquality: generationConfig.vquality, generateAudio: generationConfig.videoGenerateAudio, watermark: generationConfig.videoWatermark, videoOutputFormat: generationConfig.videoOutputFormat, videoMode: generationConfig.videoMode } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    // 重试同样要带参考，否则「重试」会变成一次参数不同的生成。
                    const audioRequest = buildSeedAudioRequest({
                        prompt,
                        model: generationConfig.model || generationConfig.audioModel,
                        audios: context?.referenceAudios || [],
                        images: retryImages,
                    });
                    for (const warning of audioRequest.warnings) message.warning(warning, 8);
                    if (audioRequest.blocked) throw new Error(audioRequest.blocked);
                    const audioResult = await requestAudioGeneration(generationConfig, audioRequest.prompt, { audios: audioRequest.audios as NonNullable<typeof context>["referenceAudios"], images: audioRequest.images as typeof retryImages });
                    const audio = await storeGeneratedAudio(audioResult.blob, generationConfig.audioFormat);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...(audioResult.traceId ? { traceId: audioResult.traceId } : {}), ...(audioResult.billedSeconds ? { audioBilledSeconds: audioResult.billedSeconds } : {}), ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    return;
                }

                // 有未完成的生图任务 ID：先领取原任务结果（服务端保留 48 小时，不重复扣费），失败/过期才重新创建
                let image: { id: string; dataUrl: string } | undefined;
                if (node.metadata?.imageJobId && !node.metadata?.content) {
                    try {
                        image = (await resumeImageGenerationJob(node.metadata.imageJobId, generationConfig))[0];
                    } catch (resumeError) {
                        // 「服务端连续查不通」不等于「原任务没了」：多半只是赶上了部署重启。
                        // 此时若照下面清掉 imageJobId 再重建任务，等于再扣一次费，而原任务后来出的那张图
                        // 没有任何节点持有它的 id，就成了只能查库才捞得回的孤儿。故这类错误直接抛给外层——
                        // 外层只标红、不清 id，等服务恢复再点一次重试就能领回来。
                        if (isRetryableJobError(resumeError)) throw resumeError;
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, imageJobId: undefined } } : item)));
                        message.warning(`原任务无法恢复（${resumeError instanceof Error ? resumeError.message : "未知原因"}），将重新生成`);
                    }
                }
                if (!image) {
                    const onJobCreated = (jobId: string) => {
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, imageJobId: jobId } } : item)));
                    };
                    // 重试也应用风格（与首次生成一致）：优先取被重试节点 metadata 持久化的风格，再降级 generationConfig。
                    const styledRetryPrompt = composeImagePrompt(prompt, savedImageMetadata?.imageStyle || generationConfig.imageStyle, savedImageMetadata?.imageView || generationConfig.imageView);
                    image = useReferenceImages ? await requestEdit(generationConfig, styledRetryPrompt, retryImages, undefined, onJobCreated).then(firstGeneratedImage) : await requestGeneration(generationConfig, styledRetryPrompt, onJobCreated).then(firstGeneratedImage);
                }
                const uploadedImage = await uploadImage(image.dataUrl);
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const imageSize = standardMediaSize(uploadedImage.width, uploadedImage.height);
                // ⚠️ references 必须写「本次真正用了哪些参考图」，不能无脑沿用存档里的旧快照——
                // 否则快照过期时这次虽然用了新图，写回的仍是旧引用，下次重试/再生成又会读到旧图，问题一直传染。
                const generationMetadata =
                    useSavedMetadata && savedImageMetadata?.generationType
                        ? { generationType: savedImageMetadata.generationType, model: generationConfig.model, size: generationConfig.size, quality: generationConfig.quality, count: savedImageMetadata.count || 1, references: savedImageMetadata.references }
                        : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  type: CanvasNodeType.Image,
                                  width: imageSize.width,
                                  height: imageSize.height,
                                  metadata: { ...item.metadata, ...imageMetadata(uploadedImage), imageJobId: undefined, prompt, ...generationMetadata },
                              }
                            : item,
                    ),
                );
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                removeRunningNodeId(node.id);
            }
        },
        [addRunningNodeId, effectiveConfig, message, openConfigDialog, removeRunningNodeId],
    );

    // 节点是否「进行中」：状态 loading 或挂着未完成的异步任务 id
    const isNodeInProgress = useCallback((node: CanvasNodeData) => node.metadata?.status === NODE_STATUS_LOADING || Boolean(node.metadata?.imageJobId) || Boolean(node.metadata?.videoTaskId), []);

    // 组一键生成：按 kind 筛出组内「待生成」节点批量生成。生视频前检查直接上游图节点是否就绪，
    // 未就绪的视频节点跳过并弹窗列出（不静默）；生图节点无前置约束直接全跑。并发上限 3。
    const generateGroup = useCallback(
        async (groupId: string, kind: "image" | "video") => {
            const group = groupsRef.current.find((item) => item.id === groupId);
            if (!group) return;
            setContextMenu(null);
            const currentNodes = nodesRef.current;
            const currentConnections = connectionsRef.current;
            const nodeMap = new Map(currentNodes.map((node) => [node.id, node]));
            const targetType = kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video;

            // 待生成：类型匹配 + 无 content + 非进行中
            const pending = group.memberNodeIds
                .map((id) => nodeMap.get(id))
                .filter((node): node is CanvasNodeData => Boolean(node && node.type === targetType && !node.metadata?.content && !isNodeInProgress(node)));

            if (pending.length === 0) {
                message.info(kind === "image" ? "组内没有待生成的图片节点" : "组内没有待生成的视频节点");
                return;
            }

            const runnable: CanvasNodeData[] = [];
            const skipped: { title: string }[] = [];

            if (kind === "video") {
                // 生视频前：直接上游图节点未生成完（无 content 或进行中）→ 前置未完成，跳过
                for (const node of pending) {
                    const upstreamImages = currentConnections
                        .filter((connection) => connection.toNodeId === node.id)
                        .map((connection) => nodeMap.get(connection.fromNodeId))
                        .filter((upstream): upstream is CanvasNodeData => Boolean(upstream && upstream.type === CanvasNodeType.Image));
                    const blocking = upstreamImages.filter((upstream) => !upstream.metadata?.content || isNodeInProgress(upstream));
                    if (blocking.length > 0) skipped.push({ title: node.title || node.id });
                    else runnable.push(node);
                }
            } else {
                runnable.push(...pending);
            }

            if (skipped.length > 0) {
                modal.warning({
                    title: "部分视频节点已跳过",
                    width: 480,
                    content: (
                        <div>
                            <div style={{ marginBottom: 8 }}>以下视频节点的上游图片尚未生成完成，本次已跳过，仅生成就绪的节点：</div>
                            <ul style={{ paddingLeft: 20, margin: 0 }}>
                                {skipped.map((item, index) => (
                                    <li key={index}>{item.title}</li>
                                ))}
                            </ul>
                        </div>
                    ),
                });
            }

            if (runnable.length === 0) return;

            // 未使用参考提醒（批量汇总一次）：列出「接入了参考但没 @ 用到」的节点，统一确认。
            if (useConfigStore.getState().config.warnUnusedReferences !== false) {
                const nodesMissingRefs = runnable.filter((node) => findUnusedReferenceInputs(node.id, nodesRef.current, connectionsRef.current, node.metadata?.composerContent ?? node.metadata?.promptDraft ?? node.metadata?.prompt ?? "").length > 0);
                if (nodesMissingRefs.length) {
                    const missingList = nodesMissingRefs.map((node) => getNodeDisplayName(node)).join("、");
                    const proceedMissing = await new Promise<boolean>((resolve) => {
                        modal.confirm({
                            title: "有节点的参考素材没用到",
                            content: `以下节点接入了参考但提示词里没提到：${missingList}。确定仍要一键生成吗？`,
                            okText: "仍然生成",
                            cancelText: "返回检查",
                            onOk: () => resolve(true),
                            onCancel: () => resolve(false),
                        });
                    });
                    if (!proceedMissing) return;
                }
            }

            // 生成二级确认：批量入口统一确认一次（开启时），确认后置 bypass，内层 handleGenerateNode 不再逐个弹窗。
            if (useConfigStore.getState().config.confirmBeforeGenerate) {
                const confirmed = await new Promise<boolean>((resolve) => {
                    modal.confirm({
                        title: "确认生成？",
                        content: `已开启生成二级确认，确定要一键生成 ${runnable.length} 个节点吗？`,
                        okText: "生成",
                        cancelText: "取消",
                        onOk: () => resolve(true),
                        onCancel: () => resolve(false),
                    });
                });
                if (!confirmed) return;
            }

            const hide = message.loading(`正在生成 ${runnable.length} 个节点…`, 0);
            let success = 0;
            let failure = 0;
            bypassGenerateConfirmRef.current = true;
            try {
                await runGroupConcurrency(runnable, 3, async (node) => {
                    // 取值优先原始草稿(含 @[node:] token)→ 让 buildNodeGenerationContext 按当前连线重解析标签，
                    // 与参考图数组同一遍产生、编号=位置一致；prompt(已解析烘焙版)只作最后兜底。与 :4286/:4112 同源。
                    const prompt = (node.metadata?.composerContent ?? node.metadata?.promptDraft ?? node.metadata?.prompt ?? "").trim();
                    try {
                        await handleGenerateNode(node.id, kind, prompt);
                        // handleGenerateNode 内部对单节点失败已 message.error；这里凭最终状态判定成败
                        const finalNode = nodesRef.current.find((item) => item.id === node.id);
                        if (finalNode?.metadata?.status === NODE_STATUS_ERROR) failure += 1;
                        else success += 1;
                    } catch {
                        failure += 1;
                    }
                });
            } finally {
                bypassGenerateConfirmRef.current = false;
            }
            hide();
            message.success(`一键生成完成：成功 ${success}，失败 ${failure}，跳过 ${skipped.length}`);
        },
        [handleGenerateNode, isNodeInProgress, message, modal],
    );

    // 批量连线（功能二）：多选状态下右键某个节点，把其余选中节点一次性与它连上。
    // 方向两种都做 —— "in" = 其余选中 -> 此节点；"out" = 此节点 -> 其余选中。
    // 右键的那个节点自己不参与（不会连出自环）；已存在的连线跳过；
    // 配置节点之间不能连（normalizeConnection 返回 null）也跳过。方向归一化整个交给 normalizeConnection，
    // 与手动拉线同源，不另写一套判据。
    const connectSelectionTo = useCallback(
        (targetId: string, selectedIds: string[], direction: "in" | "out") => {
            const currentNodes = nodesRef.current;
            const target = currentNodes.find((node) => node.id === targetId);
            setContextMenu(null);
            if (!target) return;

            const seen = new Set<string>();
            for (const conn of connectionsRef.current) {
                seen.add(conn.fromNodeId + "|" + conn.toNodeId);
            }
            const added: CanvasConnection[] = [];
            let skipped = 0;
            for (const id of selectedIds) {
                if (id === targetId) continue;
                const node = currentNodes.find((item) => item.id === id);
                if (!node) continue;
                if (isHiddenBatchChild(node, currentNodes)) continue;
                let pair: { fromNodeId: string; toNodeId: string } | null = null;
                if (direction === "in") pair = normalizeConnection(id, targetId, currentNodes, "source");
                else pair = normalizeConnection(targetId, id, currentNodes, "source");
                if (!pair) {
                    skipped += 1;
                    continue;
                }
                const key = pair.fromNodeId + "|" + pair.toNodeId;
                if (seen.has(key)) {
                    skipped += 1;
                    continue;
                }
                seen.add(key);
                added.push({ id: nanoid(), fromNodeId: pair.fromNodeId, toNodeId: pair.toNodeId });
            }

            if (!added.length) {
                message.info("没有新增连线（选中的节点要么已经连上了，要么不支持连接）");
                return;
            }
            setConnections((prev) => [...prev, ...added]);
            if (skipped > 0) message.success("已连接 " + added.length + " 条，跳过 " + skipped + " 条（已存在或不支持连接）");
            else message.success("已连接 " + added.length + " 条");
        },
        [message],
    );

    // ──────────────────────────────────────────────────────────────────────
    // 选中集批量生成（功能一）。与既有 generateGroup 的三点区别：
    //   ① 作用域是【当前选中集】，不是整组成员 —— 选中 2 个就只跑这 2 个
    //   ② 对【已生成】的节点也生效（重出），并且落法由用户在下拉里选：新建 / 覆盖原节点
    //   ③ 不管用户有没有开「生成二次确认」，一律强制确认一次
    //      （一次点击可能同时发起几十次生成，比单节点点一次的代价高一个量级）
    // 落点由 canvas-free-space 统一排好再传进 handleGenerateNode，保证这一批彼此不叠、也不压既有节点。
    const batchGenerateRunningRef = useRef(false);

    const batchGenerateSelection = useCallback(
        async (kind: "regen-new" | "regen-overwrite" | "empty", ids: string[]) => {
            if (batchGenerateRunningRef.current) {
                message.info("上一批还在生成中，等它跑完再点");
                return;
            }
            if (!ids.length) return;
            setContextMenu(null);

            const currentNodes = nodesRef.current;
            const currentConnections = connectionsRef.current;
            const nodeMap = new Map(currentNodes.map((node) => [node.id, node]));
            const isRegen = kind !== "empty";

            const modeOf = (node: CanvasNodeData): CanvasNodeGenerationMode => {
                if (node.type === CanvasNodeType.Video) return "video";
                if (node.type === CanvasNodeType.Audio) return "audio";
                return "image";
            };

            // 冷却自己先判：handleGenerateNode 内层撞上 5 秒防连点会直接 return，
            // 那种「静默没跑」在批量里会被当成失败，报给用户的数字就是错的。
            const GEN_COOLDOWN_MS = 5000;
            const startedAt = Date.now();

            const runnable: CanvasNodeData[] = [];
            let skippedCount = 0;
            for (const id of ids) {
                const node = nodeMap.get(id);
                if (!node) continue;
                if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) {
                    skippedCount += 1;
                    continue;
                }
                if (isNodeInProgress(node)) {
                    skippedCount += 1;
                    continue;
                }
                // 「重出」只收有内容的，「生成空节点」只收没内容的；混选时另一半在这里被滤掉并计入跳过数。
                if (isRegen !== Boolean(node.metadata?.content)) {
                    skippedCount += 1;
                    continue;
                }
                if (!isRegen && node.type === CanvasNodeType.Audio) {
                    skippedCount += 1;
                    continue;
                }
                if (startedAt - (generateCooldownRef.current.get(id) ?? 0) < GEN_COOLDOWN_MS) {
                    skippedCount += 1;
                    continue;
                }
                runnable.push(node);
            }

            // 生成空视频节点：直接上游图还没出完就跑，出来的必然是废片 —— 与 generateGroup 同一道前置检查。
            if (!isRegen) {
                const ready: CanvasNodeData[] = [];
                for (const node of runnable) {
                    if (node.type !== CanvasNodeType.Video) {
                        ready.push(node);
                        continue;
                    }
                    const blocking = currentConnections
                        .filter((connection) => connection.toNodeId === node.id)
                        .map((connection) => nodeMap.get(connection.fromNodeId))
                        .filter((upstream): upstream is CanvasNodeData => Boolean(upstream && upstream.type === CanvasNodeType.Image))
                        .filter((upstream) => !upstream.metadata?.content || isNodeInProgress(upstream));
                    if (blocking.length > 0) skippedCount += 1;
                    else ready.push(node);
                }
                runnable.length = 0;
                runnable.push(...ready);
            }

            if (runnable.length === 0) {
                message.info("选中的节点里没有可以执行本次操作的，已全部跳过");
                return;
            }

            // 模型/密钥没配好就别开跑：逐个进去只会弹一堆配置框。
            for (const node of runnable) {
                const probeConfig = buildGenerationConfig(effectiveConfig, node, modeOf(node));
                if (!isAiConfigReady(probeConfig, probeConfig.model)) {
                    openConfigDialog(true);
                    return;
                }
            }

            // 未使用参考提醒（批量汇总一次，与 generateGroup 同口径）
            if (useConfigStore.getState().config.warnUnusedReferences !== false) {
                const nodesMissingRefs = runnable.filter(
                    (node) => findUnusedReferenceInputs(node.id, currentNodes, currentConnections, node.metadata?.composerContent ?? node.metadata?.promptDraft ?? node.metadata?.prompt ?? "").length > 0,
                );
                if (nodesMissingRefs.length) {
                    const missingList = nodesMissingRefs.map((node) => getNodeDisplayName(node)).join("、");
                    const proceedMissing = await new Promise<boolean>((resolve) => {
                        modal.confirm({
                            title: "有节点的参考素材没用到",
                            content: `以下节点接入了参考但提示词里没提到：${missingList}。确定仍要批量生成吗？`,
                            okText: "仍然生成",
                            cancelText: "返回检查",
                            onOk: () => resolve(true),
                            onCancel: () => resolve(false),
                        });
                    });
                    if (!proceedMissing) return;
                }
            }

            // 强制二次确认：这里【不读】config.confirmBeforeGenerate，用户关了也照弹。
            const kindLabel = isRegen ? "重出" : "生成";
            let placeLabel = "在原节点上就地生成";
            if (kind === "regen-new") placeLabel = "结果落到空白处的新节点，继承原节点接入的参考连线；原节点保持不变";
            if (kind === "regen-overwrite") placeLabel = "先生成到空白处的临时节点，成功后写回原节点并删掉临时节点；失败则原节点一个字节都不动";
            const confirmLines: string[] = [`将对选中的 ${runnable.length} 个节点${kindLabel}。`, placeLabel + "。"];
            if (isRegen) confirmLines.push("每个节点各出 1 个结果（不受「一次生成数量」设置影响）。");
            if (skippedCount > 0) confirmLines.push(`另有 ${skippedCount} 个节点已跳过（类型不支持 / 正在生成中 / 刚生成过 / 上游还没就绪）。`);
            const confirmed = await new Promise<boolean>((resolve) => {
                modal.confirm({
                    title: `确认批量${kindLabel}？`,
                    width: 460,
                    content: (
                        <div>
                            {confirmLines.map((line, index) => (
                                <div key={index} style={{ marginBottom: 4 }}>
                                    {line}
                                </div>
                            ))}
                        </div>
                    ),
                    okText: "开始生成",
                    cancelText: "取消",
                    onOk: () => resolve(true),
                    onCancel: () => resolve(false),
                });
            });
            if (!confirmed) return;

            // 落点：重出会另起节点，先把这一批的位置一次排好（彼此不叠、也不压既有节点和组框）。
            // 空节点是就地生成、位置是用户自己摆的，不动。
            const positionById = new Map<string, Position>();
            if (isRegen) {
                const obstacles = buildObstacles(currentNodes, groupsRef.current, {
                    isHidden: (node) => isHiddenBatchChild(node, currentNodes),
                });
                const spawnSizeOf = (node: CanvasNodeData) => {
                    if (node.type === CanvasNodeType.Video) {
                        const videoSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                        const videoConfig = buildGenerationConfig(effectiveConfig, node, "video");
                        return expectedMediaSizeFromRatio(videoConfig.size) || videoSpec;
                    }
                    if (node.type === CanvasNodeType.Audio) return NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    return expectedImageNodeSize(buildGenerationConfig(effectiveConfig, node, "image"));
                };
                const placements = placeBatch(
                    runnable.map((node) => ({
                        id: node.id,
                        preferred: { x: node.position.x + node.width + FREE_GAP_X, y: node.position.y },
                        size: spawnSizeOf(node),
                    })),
                    obstacles,
                    FREE_GAP_Y,
                );
                placements.forEach((placement) => positionById.set(placement.id, placement.position));
            }

            // 等 React 把最后一次 setNodes 提交到 nodesRef 再判成败：await 返回的那一刻同步读会读到旧值。
            const waitUntil = async (predicate: () => boolean) => {
                for (let i = 0; i < 40; i += 1) {
                    if (predicate()) return true;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                return false;
            };

            // 覆盖回填：只接管「这次生成产出的那一部分」。
            // 名字/草稿留原节点自己的（名字是 @引用标签的依据，换掉会让别人的提示词指错节点）；
            // 批次归属也留原节点自己的（动了会让它的子节点永远隐藏）。
            const applyOverwrite = (sourceId: string, temp: CanvasNodeData) => {
                setNodes((prev) =>
                    prev
                        .filter((item) => item.id !== temp.id)
                        .map((item) => {
                            if (item.id !== sourceId) return item;
                            const merged: CanvasNodeMetadata = {
                                ...(temp.metadata || {}),
                                composerContent: item.metadata?.composerContent,
                                promptDraft: item.metadata?.promptDraft,
                                isBatchRoot: item.metadata?.isBatchRoot,
                                batchChildIds: item.metadata?.batchChildIds,
                                imageBatchExpanded: item.metadata?.imageBatchExpanded,
                                batchRootId: item.metadata?.batchRootId,
                                primaryImageId: item.metadata?.primaryImageId,
                                // 肖像授权是跟「那一张图」绑的。图换了，旧的 asset:// 必须作废——
                                // 否则之后每次拿它当参考，发给上游的都是一个对不上的 asset。
                                portraitAsset: undefined,
                                portraitAssetId: undefined,
                                portraitAssetUri: undefined,
                                portraitAssetStatus: undefined,
                                portraitAssetError: undefined,
                                status: NODE_STATUS_SUCCESS,
                                errorDetails: undefined,
                            };
                            return { ...item, width: temp.width, height: temp.height, metadata: merged };
                        }),
                );
                setConnections((prev) => prev.filter((connection) => connection.fromNodeId !== temp.id && connection.toNodeId !== temp.id));
            };

            const hide = message.loading(`正在${kindLabel} ${runnable.length} 个节点…`, 0);
            batchGenerateRunningRef.current = true;
            bypassGenerateConfirmRef.current = true;
            let success = 0;
            let failure = 0;
            try {
                await runGroupConcurrency(runnable, 3, async (node) => {
                    // 取值优先原始草稿(含 @[node:] token) → 让 buildNodeGenerationContext 按当前连线重解析标签。
                    // 与 generateGroup / :4286 / :4112 同源。
                    const prompt = (node.metadata?.composerContent ?? node.metadata?.promptDraft ?? node.metadata?.prompt ?? "").trim();
                    let spawnedIds: string[] = [];
                    try {
                        await handleGenerateNode(node.id, modeOf(node), prompt, {
                            spawnPosition: positionById.get(node.id),
                            forceCount: isRegen ? 1 : undefined,
                            onSpawn: (created) => {
                                spawnedIds = created;
                            },
                            silentSelection: true,
                        });
                    } catch {
                        failure += 1;
                        return;
                    }

                    if (!isRegen) {
                        await waitUntil(() => nodesRef.current.find((item) => item.id === node.id)?.metadata?.status !== NODE_STATUS_LOADING);
                        const finalNode = nodesRef.current.find((item) => item.id === node.id);
                        if (finalNode?.metadata?.status === NODE_STATUS_ERROR) failure += 1;
                        else success += 1;
                        return;
                    }

                    // 重出走的是 spawn 分支：源节点在建新节点那一刻就被写成 SUCCESS，
                    // 所以成败只能看新节点。（generateGroup:5717 读源节点状态那套判据，在重出场景下会把失败全算成成功。）
                    const primaryId = spawnedIds[0];
                    if (!primaryId) {
                        failure += 1;
                        return;
                    }
                    await waitUntil(() => {
                        const item = nodesRef.current.find((entry) => entry.id === primaryId);
                        return Boolean(item) && item?.metadata?.status !== NODE_STATUS_LOADING;
                    });
                    const fresh = nodesRef.current.find((item) => item.id === primaryId);
                    const ok = Boolean(fresh && fresh.metadata?.status !== NODE_STATUS_ERROR && fresh.metadata?.content);
                    if (!ok) {
                        failure += 1;
                        return;
                    }
                    success += 1;
                    if (kind === "regen-overwrite" && fresh) applyOverwrite(node.id, fresh);
                });
            } finally {
                bypassGenerateConfirmRef.current = false;
                batchGenerateRunningRef.current = false;
                hide();
            }

            const summary: string[] = [`成功 ${success}`, `失败 ${failure}`];
            if (skippedCount > 0) summary.push(`跳过 ${skippedCount}`);
            // 模板串里【不要】调函数：bun 1.3.13 在这种写法上有构建期 SIGILL 前科，先算出来再拼。
            const summaryText = summary.join("，");
            message.success("批量" + kindLabel + "完成：" + summaryText);
            if (kind === "regen-overwrite" && failure > 0) {
                message.warning(`其中 ${failure} 个失败：临时节点已留在空白处便于查看原因和重试，原节点未被改动`);
            }
        },
        [effectiveConfig, handleGenerateNode, isAiConfigReady, isNodeInProgress, message, modal, openConfigDialog],
    );

    // authGroupPortraits 整组一键肖像授权：对组内「已出图、且未认证/非认证中」的图片节点批量提交火山肖像授权。
    // 复用单图 enrollPortraitAsset（幂等、含压缩/上传/入库/轮询），并发上限 3 与一键生图一致，避免压垮上游/触发火山限流。
    // 注意：认证是异步的，提交成功≠审核通过；汇总文案只讲「已提交」，各节点最终 active/failed 由静默轮询回写状态标签。
    const authGroupPortraits = useCallback(
        async (groupId: string) => {
            const group = groupsRef.current.find((item) => item.id === groupId);
            if (!group) return;
            setContextMenu(null);
            const nodeMap = new Map(nodesRef.current.map((node) => [node.id, node]));
            const runnable = group.memberNodeIds
                .map((id) => nodeMap.get(id))
                .filter((node): node is CanvasNodeData => Boolean(node && node.type === CanvasNodeType.Image && node.metadata?.content && node.metadata?.portraitAssetStatus !== "active" && node.metadata?.portraitAssetStatus !== "processing"));
            if (runnable.length === 0) {
                message.info("组内没有可认证的人像图片（需已出图，且未认证 / 非认证中）");
                return;
            }
            const hide = message.loading(`正在提交 ${runnable.length} 张肖像授权…`, 0);
            let ok = 0;
            let fail = 0;
            try {
                await runGroupConcurrency(runnable, 3, async (node) => {
                    const result = await enrollPortraitAsset(node, true);
                    if (result === "failed") fail += 1;
                    else ok += 1;
                });
            } finally {
                hide();
            }
            message.success(`已提交 ${ok} 张肖像授权${fail > 0 ? `，${fail} 张提交失败` : ""}；审核中的会自动更新状态`);
        },
        [enrollPortraitAsset, message],
    );

    // 检出「认证不属于当前账号」的节点。
    // ⭐ 判据用【归属】而不是去 ping 火山：assetId 不在自己名下就一定用不了，比探测连通性又快又准，
    //   而且不额外消耗上游配额。listPortraitAssets 服务端已按 user_id 过滤，拿来做差集即可 —— 零后端改动。
    // 每个画布只查一次（foreignPortraitCheckedRef 记画布 id），避免每次节点变动都打一次接口。
    useEffect(() => {
        if (!portraitAssetEnabled || !hydrated || !projectId) return;
        if (foreignPortraitCheckedRef.current === projectId) return;
        const candidates = nodes.filter(
            (node) =>
                (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) &&
                node.metadata?.portraitAssetId &&
                node.metadata?.portraitAssetStatus === "active",
        );
        if (candidates.length === 0) return;
        foreignPortraitCheckedRef.current = projectId;
        let cancelled = false;
        void (async () => {
            try {
                const mine = await listPortraitAssets();
                if (cancelled) return;
                const owned = new Set(mine.map((item) => item.assetId).filter(Boolean));
                const foreign = candidates.filter((node) => !owned.has(node.metadata!.portraitAssetId!)).map((node) => node.id);
                setForeignPortraitNodes(foreign);
            } catch {
                // 查不到就当没这回事：这条只是「帮你发现」，不该因为一次接口失败打扰用户。
                foreignPortraitCheckedRef.current = "";
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [portraitAssetEnabled, hydrated, projectId, nodes]);

    // 一键重认：复用单节点 enrollPortraitAsset（它自带「本地读不到像素就交服务端重抓转存」的兜底，
    // 而分享过来的图恰恰就是这种：图还在对方桶、浏览器跨域取不到像素）。并发 3，与整组认证一致。
    const reauthForeignPortraits = useCallback(async () => {
        const nodeMap = new Map(nodesRef.current.map((node) => [node.id, node]));
        const runnable = foreignPortraitNodes.map((id) => nodeMap.get(id)).filter((node): node is CanvasNodeData => Boolean(node));
        if (runnable.length === 0) {
            setForeignPortraitNodes([]);
            return;
        }
        setReauthRunning(true);
        const hide = message.loading(`正在重新认证 ${runnable.length} 项素材…`, 0);
        let ok = 0;
        let fail = 0;
        try {
            await runGroupConcurrency(runnable, 3, async (node) => {
                const result = await enrollPortraitAsset(node, true);
                if (result === "failed") fail += 1;
                else ok += 1;
            });
        } finally {
            hide();
            setReauthRunning(false);
        }
        setForeignPortraitNodes([]);
        message.success(`已提交 ${ok} 项重新认证${fail > 0 ? `，${fail} 项失败` : ""}；审核中的会自动更新状态`);
    }, [foreignPortraitNodes, enrollPortraitAsset, message]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning("文本节点为空，无法生图");
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = standardMediaSize(meta.width, meta.height);
            const center = findFreeCenter(screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2), nodesRef.current);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            // 「我的素材」取用还原：仅当分享时已认证(active)才回填,并由 active 反推 portraitAsset 布尔
            const portraitPatch: Partial<CanvasNodeMetadata> =
                image.portraitAssetStatus === "active" && image.portraitAssetId
                    ? { portraitAsset: true, portraitAssetId: image.portraitAssetId, portraitAssetStatus: "active", portraitAssetUri: image.portraitAssetUri || `asset://${image.portraitAssetId}` }
                    : {};
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt, ...portraitPatch },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string) => {
            const center = findFreeCenter(screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2), nodesRef.current);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    // 画布助手（第一阶段：只排版、不生成、不删除）用的画布 API。
    // 建节点转调 createCanvasNode，保证新节点带上 nameSeq —— 否则「@图片3」这类引用编号会整体错乱。
    const makeAgentTextNode = useCallback(
        (text: string, position: { x: number; y: number }, title?: string) => ({
            ...createCanvasNode(CanvasNodeType.Text, position, { content: text, status: NODE_STATUS_SUCCESS }),
            title: title || text.slice(0, 32) || "助手文本",
        }),
        [],
    );
    // 助手建「待生成」节点：同样转调 createCanvasNode，拿到 nameSeq 等约定字段。
    const makeAgentGenerationNode = useCallback(
        (type: "image" | "video", prompt: string, position: { x: number; y: number }, config?: { size?: string; quality?: string }) => {
            const nodeType = type === "video" ? CanvasNodeType.Video : CanvasNodeType.Image;
            // 助手指定了比例/分辨率就用它的，没指定才回落到用户的默认设置
            const meta = { ...(defaultAspectMeta(nodeType) || {}) } as Record<string, string>;
            if (config?.size) meta.size = config.size;
            if (config?.quality) {
                // 图片存 quality(1k/2k/4k)，视频存 vquality(480/720/1080/2160，不带 p)
                if (nodeType === CanvasNodeType.Video) meta.vquality = config.quality.replace(/p$/i, "");
                else meta.quality = config.quality;
            }
            return {
                ...createCanvasNode(nodeType, position, { ...meta, prompt, promptDraft: prompt }),
                title: prompt.slice(0, 32) || (type === "video" ? "待生成视频" : "待生成图片"),
            };
        },
        [],
    );

    // 助手跑生成：转调 handleGenerateNode —— 和用户手动点生成完全同一条路径，
    // 冷却 / 扣费 / 退款 / 参考图解析 / 任务号回写全都白拿，不另开快路。
    const runAgentGenerate = useCallback(
        async (nodeId: string, prompt?: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return { ok: false, message: "节点不在了" };
            const mode: CanvasNodeGenerationMode = node.type === CanvasNodeType.Video ? "video" : "image";
            const text = (prompt ?? node.metadata?.composerContent ?? node.metadata?.promptDraft ?? node.metadata?.prompt ?? "").trim();
            const hadContent = Boolean(node.metadata?.content);
            let spawned: string[] = [];
            try {
                await handleGenerateNode(nodeId, mode, text, {
                    forceCount: 1,
                    silentSelection: true,
                    onSpawn: (ids) => {
                        spawned = ids;
                    },
                });
            } catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : "生成失败" };
            }
            // 等 React 把最后一次 setNodes 提交进 nodesRef 再判成败（同步读会读到旧值）
            const watchId = hadContent && spawned.length ? spawned[0] : nodeId;
            for (let i = 0; i < 40; i += 1) {
                const cur = nodesRef.current.find((item) => item.id === watchId);
                if (cur && cur.metadata?.status !== NODE_STATUS_LOADING) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            const fresh = nodesRef.current.find((item) => item.id === watchId);
            if (!fresh) return { ok: false, message: "生成后找不到节点" };
            if (fresh.metadata?.status === NODE_STATUS_ERROR) {
                return { ok: false, message: String(fresh.metadata?.errorDetails || "生成失败") };
            }
            if (!fresh.metadata?.content) return { ok: false, message: "生成没有产出内容" };
            if (hadContent && spawned.length) return { ok: true, message: "已重出，新节点 " + watchId };
            return { ok: true, message: "已生成" };
        },
        [handleGenerateNode],
    );

    const agentCanvasApi = useAgentCanvasApi({
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        sizeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setViewport,
        makeTextNode: makeAgentTextNode,
        makeGenerationNode: makeAgentGenerationNode,
        runGenerate: runAgentGenerate,
    });

    // 把一条收藏填回画布：新建一个对应类型的节点，带上提示词、生成配置和风格。
    //
    // 只回填「输入」，不重建参考素材节点和连线。参考素材已经作为副本保存在收藏里、可以在详情里
    // 查看，而把它们连带连线一起搬回画布是另一档事——那要走服务端改画布结构那套（推 rev、
    // 查墓碑、CAS），风险高得多，不塞进这一版。用户的核心诉求是「这次提示词效果好，下次还想用」。
    const applyPromptFavorite = useCallback(
        (item: PromptFavorite) => {
            const isVideo = item.kind === "video";
            const type = isVideo ? CanvasNodeType.Video : CanvasNodeType.Image;
            const spec = NODE_DEFAULT_SIZE[type];
            const rect = containerRef.current?.getBoundingClientRect();
            const center = findFreeCenter(screenToCanvas((rect?.left || 0) + size.width / 2, (rect?.top || 0) + size.height / 2), nodesRef.current);
            const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const config = parsePromptFavoriteJSON<Record<string, unknown>>(item.config) || {};
            // 用烘焙版提示词（@引用已被替换成「图片1/视频2」这类文字编号）。
            // 不用 promptDraft：它保留着 @[node:xxx] token，那些 id 指向的是原画布的节点，
            // 在这里全是死引用、会渲染成一串点不开的 chip。烘焙版保留了「当时提到了图片1」
            // 这个可读信息，用户自己接上参考图就行。兜底再清一遍残留 token。
            const promptText = (item.prompt || item.promptDraft || "").replace(/@\[node:[^\]]+\]/g, "").trim();
            setNodes((prev) => [
                ...prev,
                {
                    id,
                    type,
                    title: item.title || "收藏提示词",
                    position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
                    width: spec.width,
                    height: spec.height,
                    metadata: { prompt: promptText, promptDraft: promptText, ...pickFavoriteConfigMetadata(config, isVideo) },
                },
            ]);
            setSelectedNodeIds(new Set([id]));
            setAssetSidebarOpen(false);
            // 当时用的自定义风格可能已经被用户删掉了。明确说出来——
            // composeImagePrompt 对找不到的风格是静默降级的，不说他会以为效果能一模一样复现。
            const missingStyle = detectMissingFavoriteStyle(item, isVideo);
            if (missingStyle) {
                message.warning(`已填入画布，但当时用的风格「${missingStyle}」已不在你的风格库里，效果会有差异`);
                return;
            }
            message.success("已填入画布，可直接生成");
        },
        [message, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            if (payload.kind === "text") {
                insertAssistantText(payload.content);
            } else if (payload.kind === "video") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = findFreeCenter(screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2), nodesRef.current);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = standardMediaSize(payload.width || spec.width, payload.height || spec.height);
                setNodes((prev) => [...prev, { id, type: CanvasNodeType.Video, title: payload.title, position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 }, width: nextSize.width, height: nextSize.height, metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height } }]);
                setSelectedNodeIds(new Set([id]));
            } else if (payload.kind === "audio") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                const center = findFreeCenter(screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2), nodesRef.current);
                const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                setNodes((prev) => [...prev, { id, type: CanvasNodeType.Audio, title: payload.title, position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 }, width: spec.width, height: spec.height, metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, durationMs: payload.durationMs, mimeType: payload.mimeType, bytes: payload.bytes } }]);
                setSelectedNodeIds(new Set([id]));
            } else if (payload.kind === "group") {
                // 整组调回：复用 pasteCopiedNodes 那套「重分配 id + 重映射连线 + remap @[node:] mention」+ 重建 CanvasGroup。
                // 媒体不在此解析：节点 content 可能是失效的会话 blob，但 storageKey 仍在 → 渲染时 canvas-node 的 onError 自愈拉回（与跨会话图片一致）。
                const srcNodes = (payload.nodes as CanvasNodeData[]) || [];
                const srcConns = (payload.connections as CanvasConnection[]) || [];
                if (srcNodes.length) {
                    const target = findFreeCenter(screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2), nodesRef.current);
                    const bb = srcNodes.reduce((acc, n) => ({ left: Math.min(acc.left, n.position.x), top: Math.min(acc.top, n.position.y), right: Math.max(acc.right, n.position.x + n.width), bottom: Math.max(acc.bottom, n.position.y + n.height) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
                    const gdx = target.x - (bb.left + bb.right) / 2;
                    const gdy = target.y - (bb.top + bb.bottom) / 2;
                    const idMap = new Map<string, string>();
                    const usedNames = collectDisplayNames(nodesRef.current);
                    const rebuilt = srcNodes.map((node, index) => {
                        const nid = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
                        idMap.set(node.id, nid);
                        const nm = deriveCopyName(getNodeDisplayName(node), usedNames);
                        usedNames.add(nm);
                        return { ...node, id: nid, name: nm, nameIsCustom: true, nameSeq: undefined, position: { x: node.position.x + gdx, y: node.position.y + gdy }, metadata: node.metadata ? { ...node.metadata } : undefined };
                    });
                    const rebuiltConns = srcConns.flatMap((c, index) => {
                        const from = idMap.get(c.fromNodeId);
                        const to = idMap.get(c.toNodeId);
                        if (!from || !to) return [];
                        return [{ ...c, id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`, fromNodeId: from, toNodeId: to }];
                    });
                    const remapNodeId = (id?: string) => (id ? idMap.get(id) || id : id);
                    const finalNodes = rebuilt.map((item) => {
                        if (!item.metadata) return item;
                        const md = remapMetadataMentionIds(item.metadata, idMap);
                        // 批次关联 id（batch root↔child 互指的旧 id）也要过 idMap，否则含图片批次的组调回后会翻倍显示 / 折叠联动失灵
                        if (md.batchRootId) md.batchRootId = remapNodeId(md.batchRootId);
                        if (md.primaryImageId) md.primaryImageId = remapNodeId(md.primaryImageId);
                        if (Array.isArray(md.batchChildIds)) md.batchChildIds = md.batchChildIds.map((c) => idMap.get(c)).filter(Boolean) as string[];
                        return { ...item, metadata: md };
                    });
                    const newGroupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                    setNodes((prev) => [...prev, ...finalNodes]);
                    if (rebuiltConns.length) setConnections((prev) => [...prev, ...rebuiltConns]);
                    setGroups((prev) => [...prev, { id: newGroupId, title: payload.title || "", memberNodeIds: finalNodes.map((n) => n.id), createdAt: new Date().toISOString() }]);
                    setSelectedNodeIds(new Set(finalNodes.map((n) => n.id)));
                    // 音频节点无 onError 自愈（不同于图片/视频），跨会话调回后 content 是失效 blob → 主动按 storageKey 解析回填
                    finalNodes.forEach((n) => {
                        const key = n.metadata?.storageKey;
                        if (n.type === CanvasNodeType.Audio && key) {
                            resolveMediaUrl(key, n.metadata?.content || "")
                                .then((url) => {
                                    if (url && url !== n.metadata?.content) setNodes((prev) => prev.map((p) => (p.id === n.id ? { ...p, metadata: { ...p.metadata, content: url } } : p)));
                                })
                                .catch(() => {});
                        }
                    });
                }
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey, portraitAssetId: payload.portraitAssetId, portraitAssetStatus: payload.portraitAssetStatus, portraitAssetUri: payload.portraitAssetUri });
            }
            setAssetPickerOpen(false);
        },
        [insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    // ── P0 性能：稳定化传给 CanvasNode 的引用型 props，让 React.memo 真正生效 ──
    // 此前每个节点都收到一堆行内箭头/新数组 → memo 每次浅比较判定“变了” → 任一状态变化(悬浮/选中/平移/生成轮询)都重渲全部可见节点。
    // renderPanel/renderNodeContent 走「最新闭包 ref + 稳定包装」：包装引用恒定不破 memo；每次调用取最新闭包保证内容不陈旧。
    // 面板只对当前打开的节点渲染、content 只对 Config/Storyboard/SceneCamera 调用，图片/视频/音频/文本节点不受其影响。
    const renderPanelImpl = (panelNode: CanvasNodeData) =>
        panelNode.type === CanvasNodeType.Config ? (
            <CanvasConfigComposer
                value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                inputs={configInputsById.get(panelNode.id) || []}
                onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                onClose={() => setDialogNodeId(null)}
            />
        ) : panelNode.type === CanvasNodeType.Storyboard ? (
            <CanvasStoryboardComposer
                state={panelNode.metadata?.storyboard ?? { mode: "auto" }}
                parsing={parsingStoryboardIds.has(panelNode.id)}
                textModelConfig={buildPickerConfig(effectiveConfig, publicSettings?.modelChannel?.availableModels ?? [])}
                onChange={(patch) => handleConfigNodeChange(panelNode.id, { storyboard: { ...(panelNode.metadata?.storyboard ?? { mode: "auto" }), ...patch } })}
                onParse={() => void parseStoryboardNode(panelNode)}
                onExpand={() => void expandStoryboardNode(panelNode)}
                onClose={() => setDialogNodeId(null)}
            />
        ) : panelNode.type === CanvasNodeType.SceneCamera ? null : panelNode.type === CanvasNodeType.Stage ? null : (
            <CanvasNodePromptPanel
                node={panelNode}
                isRunning={runningNodeIds.has(panelNode.id)}
                mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_MENTION_REFS}
                onConfigChange={handleConfigNodeChange}
                onGenerate={handleGenerateNode}
                onRemoveReference={(sourceNodeId) => removeNodeReference(panelNode.id, sourceNodeId)}
                onImageSettingsOpenChange={(open) => {
                    setNodeImageSettingsOpen(open);
                    if (open) setToolbarNodeId(null);
                }}
            />
        );
    const renderPanelRef = useRef(renderPanelImpl);
    renderPanelRef.current = renderPanelImpl;
    const renderNodePanel = useCallback((panelNode: CanvasNodeData) => renderPanelRef.current(panelNode), []);

    const renderNodeContentImpl = (contentNode: CanvasNodeData) =>
        contentNode.type === CanvasNodeType.Stage ? (
            <CanvasStageNodePanel node={contentNode} onOpen={(nodeId) => setStageDialogNodeId(nodeId)} />
        ) : contentNode.type === CanvasNodeType.SceneCamera ? (
            <CanvasSceneCameraNodePanel node={contentNode} generating={roomPlanBusyIds.has(contentNode.id) || roomAngleBusyIds.has(contentNode.id)} onOpen={(nodeId) => setSceneDialogNodeId(nodeId)} />
        ) : contentNode.type === CanvasNodeType.Storyboard ? (
            <CanvasStoryboardNodePanel
                node={contentNode}
                parsing={parsingStoryboardIds.has(contentNode.id)}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onExpand={() => void expandStoryboardNode(contentNode)}
            />
        ) : (
            <CanvasConfigNodePanel
                node={contentNode}
                isRunning={runningNodeIds.has(contentNode.id)}
                inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                onConfigChange={handleConfigNodeChange}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onGenerate={(nodeId) => {
                    const target = nodesRef.current.find((item) => item.id === nodeId);
                    void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                }}
            />
        );
    const renderNodeContentRef = useRef(renderNodeContentImpl);
    renderNodeContentRef.current = renderNodeContentImpl;
    const renderNodeContent = useCallback((contentNode: CanvasNodeData) => renderNodeContentRef.current(contentNode), []);

    const handleNodeHoverStart = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current) return;
            setHoveredNodeId(nodeId);
            keepNodeToolbar(nodeId);
        },
        [keepNodeToolbar],
    );
    const handleNodeHoverEnd = useCallback(
        (nodeId: string) => {
            setHoveredNodeId((current) => (current === nodeId ? null : current));
            hideNodeToolbar();
        },
        [hideNodeToolbar],
    );
    const handleNodeRetry = useCallback((node: CanvasNodeData) => void handleRetryNode(node), [handleRetryNode]);
    const handleNodeViewImage = useCallback((node: CanvasNodeData) => {
        document.querySelectorAll("video").forEach((v) => v.pause());
        setPreviewNodeId(node.id);
    }, []);
    const handleNodeAudioTrimConfirm = useCallback((trimNode: CanvasNodeData, blob: Blob, durationMs: number) => void trimAudioNode(trimNode, blob, durationMs), [trimAudioNode]);
    const handleNodeAudioTrimCancel = useCallback(() => setAudioTrimNodeId(null), []);
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, id: string) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
    }, []);

    // 右键菜单「批量连线」显示几个节点：
    //   · 右键的是【没被选中】的节点 → 选中的全部当源，连到它（最常见用法）
    //   · 右键的是【选中集里的】节点 → 它当目标，其余当源，排掉自己
    // 判据摊平写在 JSX 外面：JSX 属性里写嵌套三元在 bun 1.3.13 上撞过构建期 SIGILL。
    let connectSelectionCount = 0;
    if (contextMenu && contextMenu.type === "node" && selectedNodeIds.size > 0) {
        if (selectedNodeIds.has(contextMenu.nodeId)) connectSelectionCount = selectedNodeIds.size - 1;
        else connectSelectionCount = selectedNodeIds.size;
    }

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || "未命名画布"}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={() => guardedNavigate(() => router.push("/"))}
                    onProjects={() => guardedNavigate(() => router.push("/canvas"))}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    creditSourceLabel={creditSourceLabel}
                    projectCredits={currentSourceProject ? { name: currentSourceProject.name, credits: currentSourceProject.credits } : null}
                    onImportImage={() => handleUploadRequest()}
                    onShareProject={() => void shareCurrentProject()}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                    onClear={() => setClearConfirmOpen(true)}
                    assistantCollapsed={assistantCollapsed}
                    onExpandAssistant={() => {
                        setAssistantMounted(true);
                        setAssistantCollapsed(false);
                    }}
                />

                <CanvasCreditSourceDialog open={creditSourceOpen} onCancel={() => setCreditSourceOpen(false)} onConfirm={confirmCreateProject} />

                <CanvasSurface
                    containerRef={containerRef}
                    viewport={viewport}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDoubleClick={handleCanvasDoubleClick}
                    onCanvasDeselect={deselectCanvas}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {visibleConnections.map((connection) => {
                            const from = nodeById.get(connection.fromNodeId);
                            const to = nodeById.get(connection.toNodeId);
                            if (!from || !to) return null;

                            return (
                                <ConnectionPath
                                    key={connection.id}
                                    connection={connection}
                                    from={from}
                                    to={to}
                                    active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                    onDelete={deleteConnection}
                                    onSelect={handleConnectionSelect}
                                    onContextMenu={handleConnectionContextMenu}
                                />
                            );
                        })}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
                        {alignmentGuides.map((guide, index) => {
                            const pad = 16 / viewport.k;
                            const dash = `${5 / viewport.k} ${4 / viewport.k}`;
                            return guide.orientation === "vertical" ? (
                                <line key={`align-guide-${index}`} x1={guide.position} y1={guide.start - pad} x2={guide.position} y2={guide.end + pad} stroke={theme.canvas.selectionStroke} strokeWidth={1.2 / viewport.k} strokeDasharray={dash} />
                            ) : (
                                <line key={`align-guide-${index}`} x1={guide.start - pad} y1={guide.position} x2={guide.end + pad} y2={guide.position} stroke={theme.canvas.selectionStroke} strokeWidth={1.2 / viewport.k} strokeDasharray={dash} />
                            );
                        })}
                    </svg>

                    {groups.map((group) => {
                        const bounds = computeGroupBounds(group.memberNodeIds, nodeById);
                        if (!bounds) return null;
                        return (
                            <CanvasGroupBox
                                key={group.id}
                                group={group}
                                bounds={bounds}
                                scale={viewport.k}
                                onMouseDown={handleGroupMouseDown}
                                onRename={renameGroup}
                                onContextMenu={(event, groupId) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setContextMenu({ type: "group", x: event.clientX, y: event.clientY, groupId });
                                }}
                            />
                        );
                    })}

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            displayName={getNodeDisplayName(node)}
                            onRename={renameNode}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            editRequestNonce={editingNodeId === node.id ? editRequestNonce : 0}
                            showPanel={dialogNodeId === node.id && !selectionBox}
                            nodeBusy={runningNodeIds.has(node.id) || parsingStoryboardIds.has(node.id) || roomPlanBusyIds.has(node.id) || roomAngleBusyIds.has(node.id)}
                            batchCount={batchChildCountById.get(node.id) || 0}
                            batchExpanded={Boolean(node.metadata?.imageBatchExpanded)}
                            batchClosing={Boolean(node.metadata?.batchRootId && collapsingBatchIds.has(node.metadata.batchRootId))}
                            batchOpening={openingBatchIds.has(node.id)}
                            batchRecovering={collapsingBatchIds.has(node.id)}
                            batchMotion={batchMotionById.get(node.id)}
                            showImageInfo={showImageInfo}
                            resourceLabel={resourceReferenceByNodeId.get(node.id)}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) ?? EMPTY_MENTION_REFS}
                            renderPanel={renderNodePanel}
                            renderNodeContent={renderNodeContent}
                            onMouseDown={handleNodeMouseDown}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResize={handleNodeResize}
                            onContentChange={handleNodeContentChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onRetry={handleNodeRetry}
                            onGenerateImage={generateImageFromTextNode}
                            onViewImage={handleNodeViewImage}
                            onOpenStage={(stageTarget) => setStageDialogNodeId(stageTarget.id)}
                            audioTrimming={audioTrimNodeId === node.id}
                            onAudioTrimConfirm={handleNodeAudioTrimConfirm}
                            onAudioTrimCancel={handleNodeAudioTrimCancel}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <div
                            className="pointer-events-none absolute z-[100] border"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                                borderColor: theme.canvas.selectionStroke,
                                background: theme.canvas.selectionFill,
                            }}
                        />
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu position={pendingConnectionCreate.position} title={pendingConnectionCreate.connection.handleType === "target" ? "添加上一步节点" : "添加下一步节点"} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {canvasCreateMenu ? (
                        <ConnectionCreateMenu
                            position={canvasCreateMenu}
                            title="在此添加节点"
                            onCreate={(type) => createNodeAtMenu(type)}
                            onClose={() => setCanvasCreateMenu(null)}
                            onUpload={() => {
                                handleUploadRequest(undefined, canvasCreateMenuRef.current ?? undefined);
                                setCanvasCreateMenu(null);
                            }}
                            onOpenStage={() => {
                                createStageNode(canvasCreateMenuRef.current ?? undefined);
                                setCanvasCreateMenu(null);
                            }}
                            onOpenStoryboard={() => {
                                createNode(CanvasNodeType.Storyboard, canvasCreateMenuRef.current ?? undefined);
                                setCanvasCreateMenu(null);
                            }}
                            onOpenSceneCamera={() => {
                                createSceneCameraNode(canvasCreateMenuRef.current ?? undefined);
                                setCanvasCreateMenu(null);
                            }}
                        />
                    ) : null}
                </CanvasSurface>


                <CanvasSelectionToolbar
                    bounds={selectionToolbar.bounds}
                    viewport={viewport}
                    viewportSize={size}
                    mode={selectionToolbar.mode}
                    onGroup={createGroupFromSelection}
                    onUngroup={() => {
                        if (selectionToolbar.groupId) ungroupNodes(selectionToolbar.groupId);
                    }}
                    onSortMode={(mode) => {
                        if (selectionToolbar.groupId) arrangeGroup(selectionToolbar.groupId, mode);
                    }}
                    canGenerateImage={selectionToolbar.canGenerateImage}
                    canGenerateVideo={selectionToolbar.canGenerateVideo}
                    canCombineGrid={selectionToolbar.canCombineGrid}
                    onCombineGrid={() => void combineSelectedImagesToGrid()}
                    onAutoGenerateImage={() => {
                        if (selectionToolbar.groupId) void generateGroup(selectionToolbar.groupId, "image");
                    }}
                    onAutoGenerateVideo={() => {
                        if (selectionToolbar.groupId) void generateGroup(selectionToolbar.groupId, "video");
                    }}
                    canFaceAuth={portraitAssetEnabled && selectionToolbar.canFaceAuth}
                    onAuthGroupPortrait={() => {
                        if (selectionToolbar.groupId) void authGroupPortraits(selectionToolbar.groupId);
                    }}
                    regenCount={selectionToolbar.regenIds.length}
                    emptyGenCount={selectionToolbar.emptyGenIds.length}
                    onBatchGenerate={(batchMode) => {
                        // id 直接取自选区 memo，不在这里重算判据（同源，避免「亮起的数」和「真正跑的数」对不上）
                        const targetIds = batchMode === "empty" ? selectionToolbar.emptyGenIds : selectionToolbar.regenIds;
                        void batchGenerateSelection(batchMode, targetIds);
                    }}
                />

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || nodeImageSettingsOpen ? null : toolbarNode}
                    viewport={viewport}
                    viewportSize={size}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onEditText={openTextEditor}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onCaptureFrame={(node, target) => void captureVideoFrameNode(node, target)}
                    onExtractAudio={(node) => void extractVideoAudioNode(node)}
                    onTrimAudio={(node) => setAudioTrimNodeId(node.id)}
                    onAddToGroup={(node) => setGroupAssetSourceNodeId(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onAnnotate={(node) => setAnnotateNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onNineGrid={(node) => void generateNineGridNode(node)}
                    onMenuOpenChange={(open) => { toolbarMenuOpenRef.current = open; }}
                    onDenoiseRepaint={(node, variant) => void denoiseRepaintNode(node, variant)}
                    onViewImage={(node) => { document.querySelectorAll("video").forEach((v) => v.pause()); setPreviewNodeId(node.id); }}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onPortraitAsset={(node) => void enrollPortraitAsset(node)}
                    onToggleFavorite={(node) => void toggleNodeFavorite(node)}
                    favoritePendingNodeId={favoritePendingNodeId}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                />

                <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    onAlign={alignSelectedNodes}
                    onSort={sortNodes}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    scale={viewport.k}
                    onScaleChange={setZoomScale}
                    onReset={resetViewport}
                    isMiniMapOpen={isMiniMapOpen}
                    onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)}
                />

                {portraitAssetEnabled && foreignPortraitNodes.length > 0 && !foreignPortraitDismissed ? (
                    <div className="anim-rise pointer-events-auto absolute bottom-[calc(6rem+var(--app-banner-h,0px))] left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-2xl border border-border bg-popover px-4 py-2.5 text-sm text-popover-foreground shadow-[0_12px_30px_rgba(15,23,42,.16)] dark:shadow-[0_14px_32px_rgba(0,0,0,.5)]">
                        <span className="min-w-0">
                            本画布有 <b>{foreignPortraitNodes.length}</b> 项素材的肖像授权属于原作者，当前账号用不了 —— 直接生成会被上游拒绝。重新认证后即可正常使用。
                        </span>
                        <button
                            type="button"
                            disabled={reauthRunning}
                            onClick={() => void reauthForeignPortraits()}
                            className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                        >
                            {reauthRunning ? "重新认证中…" : "一键重新认证"}
                        </button>
                        <button
                            type="button"
                            onClick={() => setForeignPortraitDismissed(true)}
                            className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent"
                        >
                            忽略
                        </button>
                    </div>
                ) : null}

                {sortToast ? (
                    <div className="anim-rise pointer-events-auto absolute bottom-[calc(6rem+var(--app-banner-h,0px))] left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-[0_12px_30px_rgba(15,23,42,.16)] dark:shadow-[0_14px_32px_rgba(0,0,0,.5)]">
                        <span>已按「{SORT_MODE_LABELS[sortToast.mode]}」排布</span>
                        <button type="button" onClick={undoSortNodes} className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium transition-colors hover:bg-accent">撤回</button>
                    </div>
                ) : null}

                <CanvasAssetSidebar
                    open={assetSidebarOpen}
                    activeTab={assetSidebarTab}
                    onTabChange={setAssetSidebarTab}
                    onToggle={setAssetSidebarOpen}
                    onInsert={handleAssetInsert}
                    onInsertGroupAsset={insertGroupAssetToCanvas}
                    onApplyFavorite={applyPromptFavorite}
                    currentCanvasName={currentProject?.title}
                    currentProjectId={currentProject?.projectId}
                />

                <CanvasSubCanvasSwitcher currentId={projectId} onOpenCopyDialog={() => setCopyFromSiblingOpen(true)} />
                <CanvasCopyFromSiblingDialog open={copyFromSiblingOpen} onClose={() => setCopyFromSiblingOpen(false)} currentId={projectId} onCopy={copyNodesFromSibling} />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        onClose={() => setContextMenu(null)}
                        canGroup={contextMenu.type === "node" && selectedNodeIds.size > 1 && selectedNodeIds.has(contextMenu.nodeId)}
                        connectSelectionCount={connectSelectionCount}
                        onConnectSelectionIn={() => {
                            if (contextMenu.type !== "node") return;
                            connectSelectionTo(contextMenu.nodeId, Array.from(selectedNodeIds), "in");
                        }}
                        onConnectSelectionOut={() => {
                            if (contextMenu.type !== "node") return;
                            connectSelectionTo(contextMenu.nodeId, Array.from(selectedNodeIds), "out");
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDuplicateNoConnections={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNodeNoConnections(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onGroup={() => {
                            createGroupFromSelection();
                            setContextMenu(null);
                        }}
                        onUngroup={() => {
                            if (contextMenu.type === "group") ungroupNodes(contextMenu.groupId);
                            setContextMenu(null);
                        }}
                        onSortMode={(mode) => {
                            if (contextMenu.type === "group") arrangeGroup(contextMenu.groupId, mode);
                            setContextMenu(null);
                        }}
                        onSaveGroup={() => {
                            if (contextMenu.type === "group") serializeGroupToAsset(contextMenu.groupId);
                        }}
                        canFaceAuth={portraitAssetEnabled}
                        onAuthGroup={() => {
                            if (contextMenu.type === "group") void authGroupPortraits(contextMenu.groupId);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else if (contextMenu.type === "connection") {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {annotateNode?.metadata?.content ? <CanvasNodeAnnotateDialog dataUrl={annotateNode.metadata.content} open={Boolean(annotateNode)} onClose={() => setAnnotateNodeId(null)} onConfirm={(payload) => void annotateImageNode(annotateNode!, payload)} /> : null}
                <CanvasGroupAssetNameDialog open={Boolean(groupAssetSourceNode)} defaultName={groupAssetSourceNode?.title || ""} busy={groupAssetBusy} onClose={() => setGroupAssetSourceNodeId(null)} onConfirm={(name) => void addNodeToGroup(groupAssetSourceNode!, name)} />

                {maskEditNode?.metadata?.content ? <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} /> : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} /> : null}

                <Modal title="AI 超分" open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">暂未实现</div>
                </Modal>

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                {sceneNode ? (
                    <CanvasRoomSceneDialog
                        open={Boolean(sceneNode)}
                        scene={normalizeRoomScene(sceneNode.metadata?.roomScene)}
                        config={effectiveConfig}
                        generatingPlan={roomPlanBusyIds.has(sceneNode.id)}
                        generatingAngle={roomAngleBusyIds.has(sceneNode.id)}
                        onChange={(scene) => handleConfigNodeChange(sceneNode.id, { roomScene: scene })}
                        onUploadRoomImage={async (file) => {
                            try {
                                const img = await uploadImage(file);
                                return { url: img.url, storageKey: img.storageKey };
                            } catch (error) {
                                message.error(error instanceof Error ? error.message : "房间照片上传失败");
                                return null;
                            }
                        }}
                        onMissingConfig={() => openConfigDialog(true)}
                        onGeneratePlan={(prompt) => void generateRoomPlan(sceneNode.id, prompt)}
                        onGenerateAngle={(scene, snapshot) => {
                            const node = nodesRef.current.find((item) => item.id === sceneNode.id);
                            if (node) void generateRoomSceneAngle(node, scene, snapshot);
                        }}
                        onClose={() => setSceneDialogNodeId(null)}
                    />
                ) : null}
                {/* 新功能引导默认关闭。组件与状态逻辑原样保留，
                    需要开启时，把下面这行的注释去掉即可。 */}
                {/* <CanvasFeatureGuide onTryFavorite={revealFavoriteEntry} onTryStage={() => createStageNode()} /> */}
                {stageNode ? (
                    <CanvasStageDialog
                        open
                        instanceId={stageNode.metadata?.stage?.instanceId || stageNode.id}
                        nodeTitle={getNodeDisplayName(stageNode)}
                        onClose={() => setStageDialogNodeId(null)}
                        onCaptures={(captures) => void handleStageCaptures(stageNode.id, captures)}
                        onVideo={(result) => handleStageVideo(stageNode.id, result)}
                    />
                ) : null}
                <Modal
                    title={previewNode?.type === CanvasNodeType.Video ? "视频详情" : "图片详情"}
                    open={Boolean(previewNode?.metadata?.content)}
                    centered
                    // destroyOnHidden：关闭即卸载弹窗内容，否则 rc-dialog 会记忆并保留 <video>，关掉后仍在后台播放；
                    // onCancel 里先 pause 让声音立刻停（destroyOnHidden 卸载发生在关闭动画之后，避免那段余音）。
                    destroyOnHidden
                    onCancel={() => {
                        previewVideoRef.current?.pause();
                        setPreviewNodeId(null);
                    }}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewNode?.metadata?.content ? (
                        previewNode.type === CanvasNodeType.Video ? (
                            <video
                                ref={previewVideoRef}
                                src={previewNode.metadata.content}
                                controls
                                style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain", background: "#000" }}
                            />
                        ) : (
                            <img
                                src={previewNode.metadata.content}
                                alt={previewNode.title || "图片"}
                                style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }}
                            />
                        )
                    ) : null}
                </Modal>

                <Modal
                    title="清空画布？"
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>取消</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                清空
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">这会删除当前画布上的所有节点和连线。</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} defaultTab={assetPickerTab} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
            {assistantMounted ? (
                <CanvasAssistantPanel
                    nodes={nodes}
                    selectedNodeIds={selectedNodeIds}
                    sessions={chatSessions}
                    activeSessionId={activeChatId}
                    onSelectNodeIds={setSelectedNodeIds}
                    onSessionsChange={handleAssistantSessionsChange}
                    onInsertImage={insertAssistantImage}
                    onInsertText={insertAssistantText}
                    onPasteImage={pasteAssistantImage}
                    onCollapseStart={() => setAssistantCollapsed(true)}
                    onCollapse={() => setAssistantMounted(false)}
                    agentApi={agentCanvasApi}
                />
            ) : null}
        </main>
    );
}

function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onHome,
    onProjects,
    onCreateProject,
    onDeleteProject,
    creditSourceLabel,
    projectCredits,
    onImportImage,
    onShareProject,
    onUndo,
    onRedo,
    backgroundMode,
    showImageInfo,
    onBackgroundModeChange,
    onShowImageInfoChange,
    onClear,
    assistantCollapsed,
    onExpandAssistant,
}: {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onHome: () => void;
    onProjects: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    creditSourceLabel: string;
    projectCredits: { name: string; credits: number } | null;
    onImportImage: () => void;
    onShareProject: () => void;
    onUndo: () => void;
    onRedo: () => void;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
    onClear: () => void;
    assistantCollapsed: boolean;
    onExpandAssistant: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const accountRef = useRef<HTMLDivElement>(null);
    const appearanceRef = useRef<HTMLDivElement>(null);
    const headerMenuRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [accountOpen, setAccountOpen] = useState(false);
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    useEffect(() => {
        if (!accountOpen) return;
        const close = (event: PointerEvent) => {
            if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [accountOpen]);

    useEffect(() => {
        if (!appearanceOpen) return;
        const close = (event: PointerEvent) => {
            if (!appearanceRef.current?.contains(event.target as Node)) setAppearanceOpen(false);
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [appearanceOpen]);

    // 三横线画布菜单:antd 的「点外部关闭」被画布 pointerdown 的 preventDefault 挡住 → 用 capture 阶段 pointerdown 补齐(点画布/别处即关;点按钮本身或菜单项交给 antd)。
    useEffect(() => {
        if (!headerMenuOpen) return;
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (headerMenuRef.current?.contains(target as Node)) return;
            if (target instanceof Element && target.closest(".ant-dropdown")) return;
            setHeaderMenuOpen(false);
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [headerMenuOpen]);

    return (
        <>
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-16 items-center justify-between px-4">
                <div
                    className="anim-fade pointer-events-auto flex min-w-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3.5 backdrop-blur-md"
                    style={{
                        background: theme.toolbar.panel,
                        borderColor: theme.toolbar.border,
                        boxShadow: colorTheme === "dark" ? "0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.35)" : "0 1px 2px rgba(15,23,42,.06), 0 10px 30px rgba(15,23,42,.12)",
                    }}
                >
                    <div ref={headerMenuRef}>
                    <Dropdown
                        open={headerMenuOpen}
                        onOpenChange={setHeaderMenuOpen}
                        trigger={["click"]}
                        menu={{
                            items: [
                                { key: "home", icon: <Home className="size-4" />, label: "主页", onClick: onHome },
                                { key: "projects", icon: <Images className="size-4" />, label: "我的画布", onClick: onProjects },
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-4" />, label: "新建画布", onClick: onCreateProject },
                                { key: "credit-source", icon: <FolderKanban className="size-4" />, label: <span className="text-xs opacity-70">{creditSourceLabel}</span>, disabled: true },
                                { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: "删除当前画布", onClick: onDeleteProject },
                                { type: "divider" },
                                { key: "import", icon: <Upload className="size-4" />, label: "导入素材", onClick: onImportImage },
                                { key: "share", icon: <Share2 className="size-4" />, label: "分享画布", onClick: onShareProject },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text="撤销" shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text="重做" shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                            ],
                        }}
                    >
                        <button type="button" className="grid size-9 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label="打开画布菜单">
                            <Menu className="size-5" />
                        </button>
                    </Dropdown>
                    </div>

                    <div ref={titleRef} className="flex min-w-0 items-center gap-2">
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="max-w-[280px] bg-transparent p-0 text-left font-heading text-lg font-medium tracking-wide outline-none"
                                style={{ color: theme.node.text }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="max-w-[280px] truncate border-b border-dashed border-transparent text-left font-heading text-lg font-medium tracking-wide transition hover:border-current"
                                style={{ color: theme.node.text }}
                                onDoubleClick={onStartTitleEditing}
                                title="双击修改画布名称"
                            >
                                {title}
                            </button>
                        )}
                    </div>
                </div>

                <div
                    className="anim-fade pointer-events-auto flex items-center gap-1.5 rounded-full border px-1.5 py-1 backdrop-blur-md"
                    style={{
                        background: theme.toolbar.panel,
                        borderColor: theme.toolbar.border,
                        boxShadow: colorTheme === "dark" ? "0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.35)" : "0 1px 2px rgba(15,23,42,.06), 0 10px 30px rgba(15,23,42,.12)",
                    }}
                >                    <div ref={appearanceRef} className="relative">
                        <Button
                            type="text"
                            title="画布外观"
                            aria-label="画布外观"
                            className="!h-9 !w-9 !min-w-9 !rounded-full !p-0"
                            style={appearanceOpen ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : { color: theme.node.text }}
                            icon={<Palette className="size-4" />}
                            onClick={() => setAppearanceOpen((value) => !value)}
                        />
                        {appearanceOpen ? (
                            <div
                                className="paper-card anim-pop absolute right-0 top-[calc(100%+10px)] z-30 w-[248px] p-2.5"
                                style={{ color: theme.toolbar.item }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                            >
                                <div className="px-1 pb-2 text-sm font-medium opacity-65">画布外观</div>
                                <div className="px-1 pb-1.5 text-[11px] font-medium opacity-50">网格样式</div>
                                <Segmented
                                    className="w-full !p-1 [&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-h-8 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!min-h-8 [&_.ant-segmented-item-label]:!leading-8"
                                    value={backgroundMode}
                                    onChange={(value) => onBackgroundModeChange(value as CanvasBackgroundMode)}
                                    options={[
                                        {
                                            value: "dots",
                                            label: (
                                                <span className="inline-flex items-center gap-1.5">
                                                    <CircleDot className="size-4" />点
                                                </span>
                                            ),
                                        },
                                        {
                                            value: "lines",
                                            label: (
                                                <span className="inline-flex items-center gap-1.5">
                                                    <Grid2x2 className="size-4" />线
                                                </span>
                                            ),
                                        },
                                        {
                                            value: "blank",
                                            label: (
                                                <span className="inline-flex items-center gap-1.5">
                                                    <Square className="size-4" />
                                                    空白
                                                </span>
                                            ),
                                        },
                                    ]}
                                />
                                <div className="mt-3 flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
                                    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium opacity-65">
                                        <Info className="size-3.5" />
                                        图片信息
                                    </span>
                                    <Switch size="small" checked={showImageInfo} onChange={onShowImageInfoChange} />
                                </div>
                            </div>
                        ) : null}
                    </div>
                    <Button
                        type="text"
                        title="清空画布"
                        aria-label="清空画布"
                        className="!h-9 !w-9 !min-w-9 !rounded-full !p-0"
                        style={{ color: colorTheme === "dark" ? "#EF4444" : "#DC2626" }}
                        icon={<Eraser className="size-4" />}
                        onClick={onClear}
                    />
                    <UserStatusActions
                        variant="canvas"
                        projectCredits={projectCredits}
                        accountOpen={accountOpen}
                        onAccountOpenChange={setAccountOpen}
                        accountRef={accountRef}
                        getPopupContainer={(node) => node.parentElement || document.body}
                        onOpenShortcuts={() => {
                            setShortcutsOpen(true);
                            setAccountOpen(false);
                        }}
                    />
                    {assistantCollapsed ? (
                        <>
                            <span className="h-6 w-px" style={{ background: theme.toolbar.border }} />
                            <Button type="text" className="!h-9 !rounded-full !px-3 !font-medium" style={{ color: theme.node.text }} icon={<MessageSquare className="size-4" />} onClick={onExpandAssistant}>
                                助手
                            </Button>
                        </>
                    ) : null}
                </div>            </div>
            {/* 快捷键面板现在是可编辑的，且和实际生效的键位同源（见 constant/shortcuts）。
                原先这里是一份手写清单，改了实现不会跟着变，已经积累了「Ctrl+拖动=框选」这类错误描述。 */}
            <ShortcutSettingsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        </>
    );
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function imageExtension(dataUrl: string, mimeType?: string) {
    // 优先按真实 mimeType 定扩展名(压缩后 content 是 blob: URL、从中认不出格式,原来一律默认 png 造成误标)
    let fromMime = "";
    if (mimeType) fromMime = mimeType.match(/image[/]([^;]+)/)?.[1] || "";
    if (fromMime === "jpeg") return "jpg";
    if (fromMime) return fromMime;
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: image.url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}

// 复制图片/视频生成节点时：若副本有上游参考输入（可重新生成），清掉已生成的输出，
// 让副本变成「空生成槽」，点生成在原地用同样的参考重出，而不是再接一个下游节点。
// 无上游输入的独立图片（纯参考/上传图）保留内容不动。
function resetCopiedGenerationOutput(node: CanvasNodeData, hasUpstreamInput: boolean): CanvasNodeData {
    if (!hasUpstreamInput) return node;
    if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) return node;
    if (!node.metadata?.content) return node;
    const metadata = { ...node.metadata };
    // 清空生成输出与在途任务标记，保留提示词/模型/尺寸等生成配置
    delete metadata.content;
    delete metadata.storageKey;
    delete metadata.naturalWidth;
    delete metadata.naturalHeight;
    delete metadata.bytes;
    delete metadata.mimeType;
    delete metadata.durationMs;
    delete metadata.status;
    delete metadata.errorDetails;
    delete metadata.imageJobId;
    delete metadata.videoTaskId;
    delete metadata.videoTaskProvider;
    delete metadata.primaryImageId;
    delete metadata.isBatchRoot;
    delete metadata.batchChildIds;
    delete metadata.generationStartedAt;
    delete metadata.generationMs;
    return { ...node, metadata };
}

function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: video.url, storageKey: video.storageKey, status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4", durationMs: video.durationMs, browserPlayable: video.browserPlayable };
}

function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: audio.url, storageKey: audio.storageKey, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs };
}

function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
        // 把所选风格/视图随生成结果节点持久化：重开面板能回显高亮、重试/再生成能延续。
        imageStyle: config.imageStyle || "",
        imageView: config.imageView || "",
    };
}

function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
        // 采样率/音量/音调只对音频生成(seed-audio)有意义，但一律记下来：
        // 节点上留着这次用的参数，重试才能复现同一次生成。
        audioSampleRate: config.audioSampleRate,
        audioLoudness: config.audioLoudness,
        audioPitch: config.audioPitch,
    };
}

// —— 收藏提示词：收集「这一次生成」的完整输入 ——

// 只有 http(s) 地址服务端才取得到，其余一律不传。
// blob: 是会话级地址（跨会话即失效，本项目历史上大量误写进持久字段）、data: 是内联数据、
// asset:// 是火山素材库地址（浏览器和服务端都取不到像素）。传上去只会让服务端白试一次，
// 不传则让它走 storageKey 那条路去 sync_files 里找源文件。
function serverFetchableUrl(value?: string) {
    if (!value) return undefined;
    if (value.startsWith("http://")) return value;
    if (value.startsWith("https://")) return value;
    return undefined;
}

// buildFavoriteAssetInput 描述一份要转存的素材。字节由服务端自己复制，这里只给「去哪儿找」。
function buildFavoriteAssetInput(nodes: CanvasNodeData[], kind: string, label: string, sourceNodeId: string, fallbackMime?: string): PromptFavoriteAssetInput {
    const source = nodes.find((item) => item.id === sourceNodeId);
    const meta = source?.metadata;
    return {
        kind,
        label,
        storageKey: meta?.storageKey,
        url: serverFetchableUrl(meta?.content),
        mimeType: meta?.mimeType || fallbackMime,
        durationMs: meta?.durationMs,
        sourceNodeId,
    };
}

// collectFavoriteReferences 收集这次生成用到的全部参考素材，**带上发给模型时的编号**。
//
// 编号（图片1 / 视频2 / 音频1 / 文本1）必须一起存：提示词正文里引用的就是这些编号，
// 丢了编号，「请参考图片2的构图」这句话日后就再也对不上是哪张图了。
// 这里直接复用 buildNodeGenerationContext 的推导结果，不自己算——编号有两套规则
// （按连线顺序 vs 按 @token 在正文中出现的顺序），重写一遍必然和真实发送口径跑偏。
function collectFavoriteReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], nodeId: string, promptSource: string): PromptFavoriteAssetInput[] {
    const context = buildNodeGenerationContext(nodeId, nodes, connections, promptSource);
    const refs: PromptFavoriteAssetInput[] = [];
    for (const image of context.referenceImages) {
        refs.push(buildFavoriteAssetInput(nodes, "image", image.label || "", image.id, image.type));
    }
    for (const video of context.referenceVideos) {
        refs.push(buildFavoriteAssetInput(nodes, "video", video.label || "", video.id, video.type));
    }
    for (const audio of context.referenceAudios) {
        refs.push(buildFavoriteAssetInput(nodes, "audio", audio.label || "", audio.id, audio.type));
    }
    // 文本参考的正文已经被烘焙进 prompt 了，但仍单独存一份：
    // 日后回填时才分得清哪段是用户自己写的、哪段是上游文本节点带进来的。
    let textIndex = 0;
    for (const input of buildNodeGenerationInputs(nodeId, nodes, connections)) {
        if (input.type !== "text") continue;
        if (!input.text) continue;
        textIndex += 1;
        refs.push({ kind: "text", label: `文本${textIndex}`, text: input.text, sourceNodeId: input.nodeId });
    }
    return refs;
}

// buildFavoriteConfig 生成配置快照。
// 配置项散在六处、而且还在增加，所以这里宁可多存几个字段也不要漏——
// 收藏的全部价值就在于日后能照原样再来一次。
function buildFavoriteConfig(node: CanvasNodeData) {
    const meta = node.metadata || {};
    return {
        model: meta.model,
        size: meta.size,
        quality: meta.quality,
        count: meta.count,
        generationType: meta.generationType,
        generationMode: meta.generationMode,
        imageStyle: meta.imageStyle,
        imageView: meta.imageView,
        videoStyle: meta.videoStyle,
        seconds: meta.seconds,
        vquality: meta.vquality,
        generateAudio: meta.generateAudio,
        watermark: meta.watermark,
        videoOutputFormat: meta.videoOutputFormat,
        // 模式必须一起存：不存的话，收藏了「首尾帧」的那条提示词，恢复回来会静默落到别的模式上——
        // 而那正是本轮要根治的「实际发出去的任务类型与界面显示的不是一回事」。
        videoMode: meta.videoMode,
        // ⚠️ videoFrameRoles 【故意不存】，不是漏的：它的值是【参考图节点的 id】，只在原来那条画布里有意义。
        //    收藏的提示词会被套用到别的节点、别的画布上，那边的参考图是另一批节点、id 完全对不上，
        //    存过去只会让 resolveFrameRoles / 请求层 frameRoleMatches 一路失配，然后静默落回接入顺序 ——
        //    与不存的结果一模一样，却多留了一份看着像生效、实际永远不生效的脏数据。
    };
}

// buildFavoriteStyleSnapshot 风格快照：存**整份预设**，不是只存 id。
//
// 自定义风格属于用户自己、随时可删。只留 id 的话用户一删，这条收藏就再也还原不出当时的效果——
// getImageStylePreset 会返回 undefined，composeImagePrompt 静默降级成无风格，
// 而用户完全不知道自己丢了什么。
function buildFavoriteStyleSnapshot(node: CanvasNodeData) {
    const meta = node.metadata || {};
    const snapshot: Record<string, unknown> = {};
    const imageStyle = getImageStylePreset(meta.imageStyle);
    if (imageStyle) snapshot.imageStyle = imageStyle;
    const imageView = getImageViewPreset(meta.imageView);
    if (imageView) snapshot.imageView = imageView;
    const videoStyle = getVideoStylePreset(meta.videoStyle);
    if (videoStyle) snapshot.videoStyle = videoStyle;
    return snapshot;
}

// pickFavoriteConfigMetadata 从收藏的配置快照里挑出能写进节点 metadata 的字段。
//
// 键名与 metadata 一致（收藏时就是照 metadata 存的），所以这里只做两件事：
// 去掉空值、按节点类型分流（把视频的时长塞进图片节点没意义，反而会让节点信息面板显示脏数据）。
function pickFavoriteConfigMetadata(config: Record<string, unknown>, isVideo: boolean): Partial<CanvasNodeMetadata> {
    const commonKeys = ["model", "size", "quality"];
    const imageKeys = ["count", "imageStyle", "imageView", "generationType"];
    const videoKeys = ["seconds", "vquality", "generateAudio", "watermark", "videoOutputFormat", "videoStyle", "videoMode"];
    const keys = isVideo ? [...commonKeys, ...videoKeys] : [...commonKeys, ...imageKeys];
    const picked: Record<string, unknown> = {};
    for (const key of keys) {
        const value = config[key];
        if (value === undefined) continue;
        if (value === null) continue;
        if (value === "") continue;
        picked[key] = value;
    }
    return picked as Partial<CanvasNodeMetadata>;
}

// detectMissingFavoriteStyle 判断收藏当时用的风格现在还在不在，返回已失效的风格名。
//
// 自定义风格是用户自己的、随时可删。收藏里存了整份快照（所以还知道它叫什么名字），
// 但回填进画布的只能是 id——风格库里没有这个 id 的话，生成时会静默按「无风格」处理。
// 这个函数就是为了把这件事说出来，而不是让用户对着不一样的结果纳闷。
function detectMissingFavoriteStyle(item: PromptFavorite, isVideo: boolean) {
    const snapshot = parsePromptFavoriteJSON<Record<string, { id?: string; nameZh?: string }>>(item.styleSnapshot);
    if (!snapshot) return "";
    if (isVideo) {
        const saved = snapshot.videoStyle;
        if (saved?.id && !getVideoStylePreset(saved.id)) return saved.nameZh || saved.id;
        return "";
    }
    const savedStyle = snapshot.imageStyle;
    if (savedStyle?.id && !getImageStylePreset(savedStyle.id)) return savedStyle.nameZh || savedStyle.id;
    const savedView = snapshot.imageView;
    if (savedView?.id && !getImageViewPreset(savedView.id)) return savedView.nameZh || savedView.id;
    return "";
}

// persistableReferenceUrl 只放行「写进画布存档后还能活下来」的地址。
// data: 太大（几 MB 的 base64 进画布文档会把同步载荷撑爆）；
// blob: 换一个会话就失效，存下来等于存了一条必然取不到的死链——
// 而快照里只要有一条取不到，resolveMetadataReferences 就整体返回 null，节点从此不能重试。
function persistableReferenceUrl(value?: string) {
    const url = (value || "").trim();
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    return undefined;
}

function referenceUrl(image: ReferenceImage) {
    // sourceUrl 排在 dataUrl 前面：水合之后 dataUrl 已经是 base64，只有 sourceUrl 还记得它原本在哪。
    return image.storageKey || image.url || persistableReferenceUrl(image.sourceUrl) || persistableReferenceUrl(image.dataUrl);
}

function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

// referenceSnapshotStale 判断节点自存的参考快照(metadata.references)是否已经过期。
//
// 背景：已生成的图片节点上会缓存一份「当初用了哪些参考图」的快照，点「生成」时优先复刻它
// （避免把节点自己的输出图当成新参考）。但这份快照【不会】随连线变化更新——用户把上游图换掉、
// 或重新连线之后，快照仍是旧的，于是发给模型的还是旧图（复制节点后换图尤其容易踩到）。
//
// 判据：节点【当前确实有上游参考】且与快照不一致 → 说明用户改过上游，快照作废、以当前连线为准。
// 用有序比较：参考图的顺序决定提示词里的编号(图片1/图片2)，顺序变了也必须重解析，否则号与图错位。
// 当前没有任何上游参考时不判过期——那是「复制走了连线」或「上游被删」，此时快照是唯一线索，保持原行为。
function referenceSnapshotStale(snapshot: string[] | undefined, currentRefs: string[]) {
    // 当前没有任何上游参考时不判过期——那是「复制走了连线」或「上游被删」，此时快照是唯一线索。
    if (!currentRefs.length) return false;
    // ⚠️ 空快照 + 当前确实有参考 = 判过期。
    // 原来这里返回 false，把「压根没记下来」当成了「记下来了且没变」，于是 useSavedMetadata 保持 true、
    // resolveMetadataReferences 见 references 为空直接 return null，最终报「参考图片已丢失，无法继续重试」——
    // 而整条路径从头到尾不看当前连线，用户重新上传图、重新连线都无济于事，该节点永久报废。
    // 空快照本就没有「存档行为」可保，以当前连线为准是唯一出路。
    if (!snapshot.length) return true;
    if (snapshot.length !== currentRefs.length) return true;
    return snapshot.some((ref, index) => ref !== currentRefs[index]);
}

async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

// 取节点媒体当前真正可用的地址：先按 storageKey 解析（本地没字节时 resolveImageUrl/resolveMediaUrl
// 会带 token 从服务端自愈拉回，并写进本地缓存），解析不出来才退回 metadata.content。
//
// ⚠️ 顺序绝不能反。content 里常年存着上个会话的 blob: URL——**非空但已经失效**。
// 让它优先，自愈结果就会被 `||` 短路丢掉，随后对死链的操作要么把裸的「Failed to fetch」
// 甩给用户，要么被误判成跨域问题、把排查带去查对象存储桶的 CORS 配置（其实与 CORS 毫无关系，纯属白查）。
async function resolveNodeMediaSrc(node: CanvasNodeData) {
    const content = node.metadata?.content || "";
    const key = node.metadata?.storageKey;
    if (!key) return content;
    let healed = "";
    if (node.type === CanvasNodeType.Image) healed = await resolveImageUrl(key, "");
    else healed = await resolveMediaUrl(key, "");
    return healed || content;
}

async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(
        nodes.map(async (node) => {
            const content = node.metadata?.content;
            if (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
                if (!node.metadata?.storageKey) return node;
                // content 已经是可用公网地址时【不要】再按 storageKey 解析。
                //
                // resolveMediaUrl 本地没字节就会把整段视频下载进 IndexedDB 并把 content 换成会话级 blob:，
                // 而这里是进画布时对全部节点铺开的 Promise.all（没有并发闸）：一个 286 个视频的画布
                // = 286 个并发整片下载、几 GB 写入，撞上 IndexedDB 配额还会把整张画布的水合一起废掉。
                // 换成 blob: 之后还会连带：首帧封面没有可加 x-tos-process 的地址；参考视频 / 素材授权 /
                // 服务端视频处理从「把现成公网地址交给上游」退化成「取本地字节再传一遍」；用户随手一编辑就把
                // 会话级 blob: 持久化进画布——正是本项目反复出事的死 blob 故障类。
                // 公网地址真坏了会走节点 onError 的自愈链，按需、且只影响那一个节点。
                if (/^https?:\/\//i.test(content || "")) return node;
                return { ...node, metadata: { ...node.metadata, content: await resolveMediaUrl(node.metadata.storageKey, content) } };
            }
            if (node.type !== CanvasNodeType.Image) return node;
            // 只要有 storageKey 就按它解析（content 可能是其他设备的失效 blob: URL，甚至为空）
            if (node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveImageUrl(node.metadata.storageKey, content || "") } };
            if (!content || !content.startsWith("data:image/")) return node;
            return { ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadImage(content)) } };
        }),
    );
}

async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                    images: await Promise.all((message.images || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

// 按生成配置的比例预判图片节点最终标准尺寸（固定高 360、宽按比例、封顶 720，同 standardMediaSize）。
// config.size 对画布图片是比例串（如 "16:9"/"9:16"/"1:1"），也兼容像素串（如 "1024x1024"）；都按宽高比折算。
// 用于多图占位尺寸与网格间距，使占位即终态、间距足够，根治批量节点重叠/resize 跳动。无法解析时回退方形 360×360。
// handleGenerateNode 的可选行为开关，只有批量生成入口会传。
export type GenerateNodeOptions = {
    // 指定新节点落点（只对「另起新节点」生效；空节点就地生成不受影响）
    spawnPosition?: Position;
    // 强制本次出几张，绕过全局「一次生成数量」设置
    forceCount?: number;
    // 新节点建好后立刻回调其 id。批量靠它判成败——源节点在 spawn 分支会被立即写成 SUCCESS，
    // 读源节点状态（generateGroup 那套）在重出场景下必然把失败算成成功。
    onSpawn?: (ids: string[]) => void;
    // 不抢选中态、不弹提示词面板
    silentSelection?: boolean;
};

function expectedImageNodeSize(config: { size?: string }): { width: number; height: number } {
    // 与新建空节点、视频占位共用同一个算法，保证「占位 = 终态」。
    const sized = expectedMediaSizeFromRatio(config?.size);
    if (sized) return sized;
    return { width: STANDARD_NODE_HEIGHT, height: STANDARD_NODE_HEIGHT };
}

// 组一键生成的并发节流：固定 limit 个 worker 轮流取任务，避免一次性发几十个请求。
async function runGroupConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                await worker(items[index]);
            }
        }),
    );
}

function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    // 空节点改比例时也按**终态**尺寸重算，别用默认盒子——否则改完比例又跟出图后的尺寸对不上。
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? expectedMediaSizeFromRatio(safePatch.size) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size } : next;
}

function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    // 左侧接点（target）拉线：对方是上一步（对方 → 当前）；右侧（source）：对方是下一步（当前 → 对方）
    if (firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}

function getInputSummary(inputs: NodeGenerationInput[]) {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
        videoCount: inputs.filter((input) => input.type === "video").length,
        audioCount: inputs.filter((input) => input.type === "audio").length,
    };
}

// 找出参考图里像素超上限的(供生成前弹窗压缩)。尺寸优先取源节点 metadata.naturalWidth/Height,缺失时加载测量。
async function findOversizedReferenceImages(images: ReferenceImage[], nodes: CanvasNodeData[]) {
    const result: Array<{ image: ReferenceImage; width: number; height: number }> = [];
    for (const image of images) {
        if ((image.url || "").startsWith("asset://")) continue; // 肖像授权 asset:// 引用不上传像素、不适用上限,跳过
        const src = nodes.find((n) => n.id === image.id);
        let width = src?.metadata?.naturalWidth || 0;
        let height = src?.metadata?.naturalHeight || 0;
        if (!width || !height) {
            const meta = await readImageMeta(await imageToDataUrl(image));
            width = meta.width;
            height = meta.height;
        }
        if (width > 0 && height > 0 && width * height > REFERENCE_IMAGE_MAX_PIXELS) result.push({ image, width, height });
    }
    return result;
}

function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : mode === "audio" ? config.audioModel : config.textModel;
    return {
        ...config,
        model: node?.metadata?.model || defaultModel || (mode === "audio" ? defaultConfig.audioModel : config.model || defaultConfig.model),
        quality: node?.metadata?.quality || (mode === "image" ? config.canvasImageQuality : "") || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || (mode === "image" ? config.canvasImageAspect : mode === "video" ? config.canvasVideoRatio : "") || config.size || defaultConfig.size,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || (mode === "video" ? config.canvasVideoResolution : "") || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        videoOutputFormat: node?.metadata?.videoOutputFormat || config.videoOutputFormat || defaultConfig.videoOutputFormat,
        // 视频生成模式：节点上显式选的优先，没选就用全局默认（默认「文生视频」）。
        // 这是真正发出去的那一份 —— 请求层据此显式声明上游任务类型，不再按「参考素材有几个」去推断。
        videoMode: node?.metadata?.videoMode || config.videoMode || defaultConfig.videoMode,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        // 采样率/音量/音调：新配置字段必须在这里映射回 config，否则设置面板「点了没反应」
        // （面板读 config，而 onConfigChange 写的是 node.metadata，中间靠这一层接通）。
        audioSampleRate: node?.metadata?.audioSampleRate || config.audioSampleRate || defaultConfig.audioSampleRate,
        audioLoudness: node?.metadata?.audioLoudness || config.audioLoudness || defaultConfig.audioLoudness,
        audioPitch: node?.metadata?.audioPitch || config.audioPitch || defaultConfig.audioPitch,
        count: String(node?.metadata?.count || (mode === "image" ? config.canvasImageCount || config.count : config.count) || defaultConfig.count),
        // 图片风格/视图预设 id：仅图片模式取节点 metadata，生成时 composeImagePrompt 把两者助提示词追加到用户描述后。
        imageStyle: mode === "image" ? node?.metadata?.imageStyle || "" : undefined,
        imageView: mode === "image" ? node?.metadata?.imageView || "" : undefined,
        // 视频风格预设 id：仅视频模式取节点 metadata，生成时 composeVideoPrompt 把助提示词追加到用户描述后。
        videoStyle: mode === "video" ? node?.metadata?.videoStyle || "" : undefined,
        // 首尾帧角色（哪张参考图是首帧/尾帧）：仅视频模式带上，请求层据此给两张参考图分别标上
        // content[].role = first_frame / last_frame。没指定时请求层按接入顺序处理。
        videoFrameRoles: mode === "video" ? node?.metadata?.videoFrameRoles : undefined,
    };
}

// 历史数据可能把批量根/子节点以 1×1 几何持久化（收起动画中断等），此时节点本体不可见、
// 只剩角标以竖排碎片"乱飘"。载入时自愈：恢复默认尺寸；塌缩的批量根改回收起态；子节点按创建布局扇形归位。
// 读远端视频的固有宽高（取用团队素材时旧数据没存宽高的兜底；不需 CORS 即可拿 videoWidth）。
function readVideoMetaDims(url: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.onloadedmetadata = () => resolve(video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : null);
        video.onerror = () => resolve(null);
        video.src = url;
    });
}

function healDegenerateNodes(nodes: CanvasNodeData[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const fallback = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    return nodes.map((node) => {
        if ((node.width ?? 0) > 2 && (node.height ?? 0) > 2) return node;
        // 恢复为该节点的标准显示尺寸（有内容按真实宽高→固定高 360；空节点用默认），与 normalizeMediaNodeSizes 一致，
        // 否则恢复成默认 340×240 后又被 normalize 改成 360 高却保持旧间距 → 批量子图重叠。
        const size = node.metadata?.content ? standardMediaSize(node.metadata.naturalWidth || fallback.width, node.metadata.naturalHeight || fallback.height, STANDARD_NODE_HEIGHT) : fallback;
        let position = node.position;
        const rootId = node.metadata?.batchRootId;
        if (rootId) {
            const root = byId.get(rootId);
            if (root) {
                const index = Math.max(0, (root.metadata?.batchChildIds || []).indexOf(node.id));
                const rootWidth = (root.width ?? 0) > 2 ? root.width : size.width;
                position = {
                    // 行距用标准高 360（而非默认 240），列距用本节点标准宽，保证 normalize 后不重叠。
                    x: root.position.x + rootWidth + 120 + (index % 2) * (size.width + 36),
                    y: root.position.y + Math.floor(index / 2) * (STANDARD_NODE_HEIGHT + 40),
                };
            }
        }
        const metadata = node.metadata?.isBatchRoot && node.metadata.imageBatchExpanded ? { ...node.metadata, imageBatchExpanded: undefined } : node.metadata;
        return { ...node, width: size.width, height: size.height, position, metadata };
    });
}

// 统一尺寸规范：所有带内容的图片/视频节点固定高 360、宽按比例；音频节点固定高 240。
// 保持节点中心不变；手动拉伸过（metadata.manualSize）的节点跳过，不覆盖用户意图。
function normalizeMediaNodeSizes(nodes: CanvasNodeData[]) {
    return nodes.map((node) => {
        if (node.metadata?.manualSize) return node;
        let size: { width: number; height: number } | null = null;
        if (node.type === CanvasNodeType.Image) {
            if (!node.metadata?.content) {
                // 未生成图片：有存的比例(metadata.size)按**终态**尺寸占位，让设置/默认比例刷新后不丢；无比例保持原小尺寸不撑大。
                // ⚠️ 这里必须和出图后的 standardMediaSize 同源，否则刷新一次就把新建时算对的尺寸改回旧值。
                const ratioSize = expectedMediaSizeFromRatio(node.metadata?.size);
                if (!ratioSize) return node;
                size = ratioSize;
            } else {
                size = standardMediaSize(node.metadata.naturalWidth || node.width, node.metadata.naturalHeight || node.height, STANDARD_NODE_HEIGHT);
            }
        } else if (node.type === CanvasNodeType.Video) {
            if (node.metadata?.content) {
                size = standardMediaSize(node.metadata.naturalWidth || node.width, node.metadata.naturalHeight || node.height, STANDARD_NODE_HEIGHT);
            } else {
                // 未生成视频：同理按终态尺寸占位。
                size = expectedMediaSizeFromRatio(node.metadata?.size) || { width: NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, height: NODE_DEFAULT_SIZE[CanvasNodeType.Video].height };
            }
        } else if (node.type === CanvasNodeType.Audio) {
            size = { width: node.width, height: AUDIO_NODE_HEIGHT };
        }
        if (!size || (Math.abs(size.width - node.width) < 1 && Math.abs(size.height - node.height) < 1)) return node;
        return {
            ...node,
            width: size.width,
            height: size.height,
            position: { x: node.position.x + (node.width - size.width) / 2, y: node.position.y + (node.height - size.height) / 2 },
        };
    });
}

function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    // 带服务端任务 ID（生图任务/视频任务）的节点保持 loading，由画布载入后的自动续查领回结果；
    // 只有无任务可续的（local 渠道直连/LLM 流式）才标记中断。
    return nodes.map((node) =>
        node.metadata?.status === "loading" && !node.metadata.imageJobId && !node.metadata.videoTaskId
            ? { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "页面刷新后生成已中断，请重新生成。" } }
            : node,
    );
}

// 把正文里的 @[node:旧id] 批量重映射到 idMap 的新 id；不在 idMap 的引用原样保留（生成时命中不到会被一致丢弃，不会错配）。
// 单遍全局替换、幂等（新 id 不含旧 pattern）、[^\]]+ 只吃 token 本身不跨 ]，与生成端 canvas-node-generation.ts 的 token 正则同源。
function remapMentionIds(text: string, idMap: Map<string, string>): string {
    return text.replace(/@\[node:([^\]]+)\]/g, (match, oldId) => {
        const next = idMap.get(oldId);
        return next ? `@[node:${next}]` : match;
    });
}

// 复制副本时，只重写承载 @ 引用的三个字段（promptDraft/composerContent/prompt），其余 metadata 原样带走。
function remapMetadataMentionIds(metadata: NonNullable<CanvasNodeData["metadata"]>, idMap: Map<string, string>): NonNullable<CanvasNodeData["metadata"]> {
    const patch: Partial<NonNullable<CanvasNodeData["metadata"]>> = {};
    if (typeof metadata.promptDraft === "string" && metadata.promptDraft.includes("@[node:")) patch.promptDraft = remapMentionIds(metadata.promptDraft, idMap);
    if (typeof metadata.composerContent === "string" && metadata.composerContent.includes("@[node:")) patch.composerContent = remapMentionIds(metadata.composerContent, idMap);
    if (typeof metadata.prompt === "string" && metadata.prompt.includes("@[node:")) patch.prompt = remapMentionIds(metadata.prompt, idMap);
    return { ...metadata, ...patch };
}

function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}

function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

function isHiddenBatchChild(node: CanvasNodeData, nodes: CanvasNodeData[], collapsingBatchIds?: Set<string>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

function isHiddenBatchConnectionEndpoint(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
    const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
    return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${params.wideAngle ? "广角" : "标准"}镜头`;
}

function buildAnglePrompt(params: CanvasImageAngleParams) {
    return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${buildAngleLabel(params)}。`;
}

// 九宫格机位：让模型把参考图中的同一主体，从 9 个明显不同的相机机位(环绕方位角×俯仰高度)合成到一张 3×3 网格图里（libtv「多机位九宫格」同款玩法）。
// 控制轴=方位角×俯仰，不是景别远近(否则房间这类无正背面的场景会塌成"同一正面视角放大缩小")；对房间/人物/产品三类主体都稳健。
// ── 去噪重绘：两段提示词 ──────────────────────────────────────────────
//
// 思路：image2 的颗粒是它自己的出图特征，改提示词压不掉。与其去噪，不如换个模型【重画一遍】——
// 重画不会逐像素搬运原图，颗粒自然带不过来。白模那一步的作用不是「变干净」，
// 而是把几何显式外化成一张图，让重画时结构不至于跟着一起漂。
//
// ⚠️ 这两段是照着「已知会出错的写法」反过来写的，改动前请先读这几条：
//   · 不要写「纯净的中性灰无缝背景」——那会让模型把环境整个抹成空白，纵深和场景全没了。
//     要的是「连环境一起转成灰」，不是「把环境换成灰底」。
//   · 不要写「柔和的工作室布光」——它和「保留原图光影」直接打架。夜戏、强反差的图会被打平。
//   · 第二段开头必须先声明「图片1 的灰色是刻意的、不是要的效果」，否则模型会把灰色当成目标外观，
//     输出一张灰扑扑的图。
// 灰模的通用条款：两种变体共用的部分。
//
// ⚠️ 为什么是「中性灰」而不是纯白：纯白会让受光面直接过曝、糊成一片，形体就读不出来了。
// 行业里叫「白模」，实际渲的都是约 50% 中性灰，就是为了把明暗层次留住——
// 而灰模的全部价值就在于结构可读。
const CLAY_COMMON = `【必须去掉】
- 全部颜色：整个画面（含主体、服装、道具、环境、背景）统一成同一种中性灰
- 全部材质与纹理：布料织纹、皮肤毛孔、木纹、金属反射、印花图案，一律抹平成均匀哑光灰
- 画面上的一切文字、标识与水印
- 原图的颗粒、噪点与压缩痕迹

输出一张干净的中性灰素模渲染图（clay render），像未贴图的三维模型截图。
不要添加原图里没有的任何物体、装饰或背景元素，也不要把背景抹成空白或纯色底。`;

// 重绘的通用条款。
//
// ⚠️ 不要去复用 image-style-presets.ts 里的 REALISM_SKIN：它结尾写着 "subtle fine film grain"，
// 而这条链路的全部目的就是去掉颗粒——复用等于自己把要去的东西又加回来。
const REPAINT_COMMON = `任务：生成一张洁净的商业成图，不是生活化、做旧或颗粒感的效果。

【图片2｜原图】是唯一事实基准。
对象数量、人物身份、文字、Logo、产品几何、构图、真实内容、配色与材质类别，全部以图片2 为准。

【图片1｜生成式灰模】只在与图片2 一致时，辅助参考大尺度轮廓、遮挡关系与粗粒度布局。
它不是几何真值。不得继承其中的灰色、压缩块、振铃、伪边、伪文字、缺失物体或细节偏移。

【冲突规则】两图不一致时，始终以图片2 为准；
不得根据图片1 新增、删除、替换或移动任何对象。

【清洁目标】移除与物体结构、材质方向和光照无关的随机颗粒、彩噪、重复网纹、虫纹、
块效应、色带、边缘振铃、棋盘格、锐化伪影、局部明暗斑点与表面污点。
轮廓清楚但不过锐；不要光晕、彩边与伪文字。

【纹理边界】只保留图片2 中有明确依据、尺度合理、低对比、非周期且与表面几何一致的真实微结构。
不得为了增强真实感而新增统一颗粒、重复毛孔、污点、磨损或表面纹理。`;

// 两种变体：人物 与 场景/道具。
//
// 拆开的理由：决定「真实感」的东西完全不同。人物靠皮肤次表面散射、毛孔细纹、眼睛高光、发丝；
// 场景道具靠材质粗糙度差异、表面微观结构、磨损与接触阴影。共用一套必然两头不讨好。
const DENOISE_VARIANTS = {
    character: {
        label: "人物",
        white: `把这张图整幅转换成一张中性灰素模（clay render）——只保留几何与光影结构，去掉一切颜色与材质。

【必须原样保留】
- 构图、取景、透视，以及所有主体的位置与比例，一寸都不要移动
- 人物的姿态、朝向、重心、肢体角度与手指分节
- 五官的位置、比例与朝向；头部的转向与倾角
- 发型的体块与走向（发丝纹理可以抹平，但发型的轮廓和蓬松度要保留）
- 服装的层次、剪裁结构与主要褶皱走向；配饰、鞋履的位置与体块
- 环境与背景的几何结构与纵深关系
- 原图的照明方向、明暗分布与阴影位置。原图是低照度或强反差的，就保持低照度、强反差

${CLAY_COMMON}`,
        repaint: `${REPAINT_COMMON}

【人物真实感——这是本次成败的关键，请逐条落实】
- 皮肤：自然哑光质地，肤色过渡连续；保留低对比、非周期的毛孔与细小绒毛，
  其可见度随面部曲率、观看距离与光照自然变化，不要整脸均匀铺满毛孔
- 只保留【图片2】中确实存在的痣、雀斑、疤痕与细纹，不得新增、复制、规则化或夸大
- T 区只有局部轻微油光，绝不是整张脸均匀的油亮或湿滑反光
- 次表面散射：耳廓、鼻翼、指缝等薄处透出自然的光感
- 眼睛：清晰的高光点、湿润的眼白与虹膜纹理，双眼视线方向一致
- 毛发：成缕而非成块，发际线与轮廓处有自然碎发
- 明确不要：磨皮、美颜滤镜、过度平滑、蜡质感、塑料感、娃娃脸、失焦的糊脸；
  也不要整脸颗粒、重复毛孔纹、网纹或虫纹

【身份一致】五官比例、脸型、发型与肤色必须与【图片2】是同一个人，不得美化或改动。`,
    },
    scene: {
        label: "场景道具",
        white: `把这张图整幅转换成一张中性灰素模（clay render）——只保留几何与光影结构，去掉一切颜色与材质。

【必须原样保留】
- 构图、取景、透视、地平线与灭点，一寸都不要移动
- 建筑与场景的结构、体块关系、开窗与分隔
- 所有物件、道具、家具、装饰的数量、位置、朝向与尺寸比例，一个都不能少、也不能多
- 空间的纵深与前中后景的层次关系
- 原图的照明方向、明暗分布与阴影位置。原图是低照度或强反差的，就保持低照度、强反差

${CLAY_COMMON}`,
        repaint: `${REPAINT_COMMON}

【材质真实感——这是本次成败的关键，请逐条落实】
- 材质区分：金属、木料、布料、皮革、塑料、玻璃、石材各自的反射率与粗糙度必须明显不同，
  不能所有表面都是同一种质感
- 表面微观结构：木纹、织纹、拉丝、编织纹理，按各自材质如实呈现；
  尺度合理、方向与表面几何和透视一致，低幅、非平铺、不重复
- 只保留【图片2】中确实存在的使用痕迹；不要新增灰尘、磨损、划痕、水渍、油渍或做旧效果
- 光学细节：接触阴影与环境光遮蔽（物体与地面/墙面相接处的暗部）、
  金属与玻璃的环境反射、透明材质的折射与厚度感
- 边缘：真实的倒角，不是刀切般的锐利硬边
- 明确不要：塑料感、廉价 CG 感、所有材质长得一样；
  也不要把噪点或生成伪影重新解释成布纹、颗粒面或表面质感

【内容一致】物件的种类、数量与摆放必须与【图片2】完全相同，不得增删或替换。`,
    },
} as const;

type DenoiseVariant = keyof typeof DENOISE_VARIANTS;

const NINE_GRID_PROMPT = `把这张参考图里的【同一个主体/同一个场景】当作唯一对象，生成一张 1:1 正方形、3 行 3 列共 9 格、平均分布且严格对齐的九宫格图。

【核心目标：9 个明显不同的相机机位，不是同一视角的放大缩小】
想象主体固定不动，我手里拿着一台摄像机绕着它走一整圈，并不断改变高度和远近去拍。9 格 = 这台相机停在 9 个【明显不同的位置/朝向/高度】拍下的 9 张照片。判定标准：把任意两格并排看，必须一眼就能看出"相机站在了不同的位置、朝主体的不同方向、在不同的高度"——而不是"同一个画面被推近、拉远或裁掉一块"。每一格之间至少在 方位角(绕到主体的哪一侧)或 俯仰高度(平视/俯拍/仰拍/顶视)上有清楚可见的差别。

【主体类型自适应——用相对环绕描述，不要假设主体一定有正脸】
- 若主体是【室内房间/场景】(如卧室，没有明确的正面/背面/左右)：就理解为相机站在房间不同的墙角、朝不同的门窗/家具方向、在不同高度拍同一个空间——从一个角落广角拍全貌、从对角墙角斜拍、贴近某件家具拍局部、升到接近天花板俯拍整屋布局、蹲到贴近地面仰拍，让每格看到的墙面组合、家具朝向和纵深方向都不一样，而不是同一面墙的远近。
- 若主体是【人物/角色】：就理解为相机绕人物水平转一圈，依次拍到正脸、四分之三侧、纯侧脸、背侧、背面，叠加平视/俯拍/仰拍/顶视。
- 若主体是【产品/物体】：就把它放在转台中央，相机绕它一圈并升降，拍到正面、侧面、四分之三角、背面、顶视俯拍、贴台面仰视等不同的面与棱角。

【逐格机位安排(按行从左到右、从上到下)】
第1格(左上)：正面平视、中等距离的基准机位——相机在主体正前方、与主体大致同高。
第2格(中上)：相机沿环绕方向转约 40°，到主体右前方，四分之三角度、平视偏微俯，中景。
第3格(右上)：相机继续转到主体右侧约 90°，纯侧向视角，平视，中近距离。
第4格(左中)：相机转到主体右后方约 135°，从斜后方观察，平视到微俯，中景。
第5格(正中)：相机升到主体上方做高位大俯拍(俯角较大)、略拉远，带出主体周围的整体布局与环境关系。
第6格(右中)：相机绕到主体正后/后侧约 180°，从背面方向平视或略仰，中景(房间=从最里侧朝门口方向回看)。
第7格(左下)：相机压到接近地面做贴地大仰角仰拍，靠近主体，强调高耸感与前景纵深，近-中景。
第8格(中下)：相机转到主体左前方约 320°，四分之三角度、平视，贴近做特写/局部，突出关键细节与材质(仍是新机位方向，不是把别格裁出来)。
第9格(右下)：相机升到主体正上方做顶视/俯瞰(近乎垂直向下)，展示主体的俯视轮廓或房间的平面布局，作为收尾。
(以上"左/右/前/后"以主体固有朝向为准；若是无明确朝向的房间，则按相机绕空间均匀转一圈来分配这些方位，确保任意两格的墙面组合与纵深方向都不同。)

【绝对禁止】
- 禁止多个格子使用相近或几乎相同的视角。
- 禁止把同一个视角只做放大、缩小或重新裁切来凑数。
- 禁止只改变景别/远近，而相机的实际位置、朝向和高度不变。
- 不要出现"其实都是正面、只是远近不同"或"两三格是同一张照片裁出来的"这种情况。除点名的顶视/仰拍外，其余各格也必须各不相同。

【一致性约束(必须严格保持)】
- 9 格自始至终是【同一个主体、同一个场景】：同一套陈设与道具、同一种材质与配色、同一组家具/物件，只是相机机位不同。
- 若是室内场景，必须始终是【同一个房间、同样的家具布置和装饰】，绝对不能换成不同的房间或不同的装修；若是人物，五官、发型、服装、配饰在 9 格里完全一致；若是产品，造型、比例、纹理、颜色完全一致。
- 【室内空间结构必须前后一致且合理】：把参考图的房间当成一个真实存在、固定不变的三维空间——床/沙发/柜子/窗/门/挂画/吊灯等每一件物体都始终在同一个位置、靠同一面墙，只是从不同机位去观察；不要把家具搬到别处、不要凭空增删墙体/门窗、不要改变房间的形状或比例、不要出现透视错乱/墙体穿插/地面倾斜/物体悬空等不合理的空间结构。9 格合在一起必须能拼成同一个连贯合理的房间，每一格都是这个房间里一个真实站得住的视角。
- 全局光线方向、色温、明暗氛围、时间感与整体风格在 9 格中保持统一，只有相机在动。

【画幅与排版】
- 整张图为 1:1 正方形、高分辨率、清晰锐利。
- 严格的 3×3 等分九宫格，9 格大小一致、横平竖直、间距均匀、对齐工整、平均分布。
- 格与格之间不要黑边、白边、分隔线、格线、序号、编号、文字、字母、数字、标注或水印；每格画面干净、构图完整。`;
