"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Image as ImageIcon, Loader2, Maximize2, Minimize2, Music2, RefreshCw, Star, Video } from "@/components/icons";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { deleteStoredImages, resolveImageUrl } from "@/services/image-storage";
import { deleteStoredMedia, resolveMediaUrl } from "@/services/file-storage";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasAudioNodeContent } from "./canvas-audio-node-content";
import { ensureMediaPathIndex, getPublicMediaPath } from "@/services/media-path-index";
import { retryMediaUpload } from "@/services/media-uplink";
import { posterHostSupported, tosVideoPosterUrl } from "../utils/canvas-video-poster";
import { useMediaTranscode } from "@/hooks/use-media-transcode";
import { useMediaUplink } from "@/hooks/use-media-uplink";
import { CanvasNodeType, type CanvasNodeData, type Position } from "../types";
import { displayLongEdgePx, LOD_FULL_QUALITY_ZOOM, NODE_FAR_VIEW_ZOOM, tosDisplayThumbUrl, zoomBucketOf } from "../utils/canvas-image-lod";
import { canvasPerfFlag } from "../utils/canvas-perf-flags";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
// 选中态主色辉光（亮/暗双份，随主题取值）
const selectionGlow = {
    light: "0 0 0 1px rgba(37,99,235,.22), 0 12px 32px rgba(37,99,235,.12)",
    dark: "0 0 0 1px rgba(59,130,246,.28), 0 12px 32px rgba(59,130,246,.14)",
} as const;
// 入场弹现只在节点本会话首次挂载时播一次：视口裁剪（visibleNodes）会让节点平移回视野时重新 mount，
// 不记忆的话节点会在画布边缘反复弹跳。纯展示状态，不进 store。
const poppedNodeIds = new Set<string>();

type CanvasNodeProps = {
    data: CanvasNodeData;
    scale: number;
    isSelected: boolean;
    // 节点名字（自定义名或默认名，由父组件解析）+ 改名回调。名字标签渲染在节点内部、随节点 z 层级堆叠，
    // 被前面的节点自然遮住（取代旧的全局 NodeNameLabelLayer 覆盖层）。
    displayName: string;
    onRename: (id: string, value: string) => void;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    editRequestNonce?: number;
    showPanel: boolean;
    // 仅用于触发 React.memo 重渲以刷新面板“忙碌态”(解析中/生成中等来自外部 Set 的状态，不随节点 data 变化)；
    // 布尔值按值比较、不破 memo。组件内不直接读它，靠它变化把当前节点重渲一次即可。
    nodeBusy?: boolean;
    showImageInfo: boolean;
    resourceLabel?: CanvasResourceReference;
    mentionReferences?: CanvasResourceReference[];
    renderPanel?: (node: CanvasNodeData) => ReactNode;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    batchCount?: number;
    batchExpanded?: boolean;
    batchClosing?: boolean;
    batchOpening?: boolean;
    batchRecovering?: boolean;
    batchMotion?: { x: number; y: number; index: number };
    onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (node: CanvasNodeData) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onViewImage?: (node: CanvasNodeData) => void;
    // 双击 3D 场景台节点时打开 iframe 弹窗。
    onOpenStage?: (node: CanvasNodeData) => void;
    audioTrimming?: boolean;
    onAudioTrimConfirm?: (node: CanvasNodeData, blob: Blob, durationMs: number) => void;
    onAudioTrimCancel?: () => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

type NodeContentRendererProps = {
    node: CanvasNodeData;
    // scale 画布当前缩放。图片节点据此按显示尺寸取小图（见 canvas-image-lod）。
    scale?: number;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isEditingContent: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    onContentChange: (nodeId: string, content: string) => void;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: () => void;
    audioTrimming?: boolean;
    onAudioTrimConfirm?: (blob: Blob, durationMs: number) => void;
    onAudioTrimCancel?: () => void;
};

export const CanvasNode = React.memo(function CanvasNode({
    data,
    scale,
    isSelected,
    displayName,
    onRename,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnecting,
    editRequestNonce = 0,
    showPanel,
    showImageInfo,
    resourceLabel,
    mentionReferences = [],
    renderPanel,
    renderNodeContent,
    batchCount = 0,
    batchExpanded = false,
    batchClosing = false,
    batchOpening = false,
    batchRecovering = false,
    batchMotion,
    onMouseDown,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResize,
    onContentChange,
    onToggleBatch,
    onSetBatchPrimary,
    onRetry,
    onGenerateImage,
    onViewImage,
    onOpenStage,
    audioTrimming = false,
    onAudioTrimConfirm,
    onAudioTrimCancel,
    onContextMenu,
}: CanvasNodeProps) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const [hovered, setHovered] = useState(false);
    const [isEditingContent, setIsEditingContent] = useState(false);
    // mount 一次性入场动画：批量子卡走自己的 canvas-batch-child-in/out keyframes，不叠加
    const [shouldPopIn] = useState(() => !data.metadata?.batchRootId && !poppedNodeIds.has(data.id));
    useEffect(() => {
        poppedNodeIds.add(data.id);
    }, [data.id]);
    const hasImageContent = data.type === CanvasNodeType.Image && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    // 远景视图：缩得很小时省掉装饰性元素。
    //
    // 实测每个节点无条件产出约 16 个 DOM 元素，其中 10 个是纯装饰：4 个缩放手柄、
    // 2 个连线圆点（各 2 个 div，且 visible=false 时也照样渲染、只是 opacity-0）、2 个名字标签、
    // 信息条。885 个节点就是约 14000 个元素、其中近 1800 个还挂着 CSS transition。
    // 缩到 0.25 倍时这些东西在屏幕上只有几个像素、肉眼完全不可辨，却全额付渲染与合成的钱。
    //
    // 用量化后的缩放做判据（不是原始 scale），避免在阈值附近来回抖动导致反复增删元素。
    // 交互不受影响：选中、拖动、右键菜单都挂在根 div 上，这里只删装饰。
    const farView = zoomBucketOf(scale) < NODE_FAR_VIEW_ZOOM;
    // 提到 JSX 外面算好——bun 1.3.13 对 JSX 属性里的复合三元/常量折叠会编译期 SIGILL（见 lib/ 里同类写法的注释）。
    const showLeftHandle = hovered || isSelected || isConnecting;
    const showRightHandle = data.type !== CanvasNodeType.Config && showLeftHandle;
    // ⚠️ 远景下不能把连线圆点/缩放手柄「一刀切删掉」——圆点就是拖出连线的把手，删了就【连不了线】。
    // 正确做法是「用得到才渲染」：没被 hover/选中的节点照样省掉这些元素（性能收益仍在，
    // 因为同屏几百个节点里最多一个被 hover），一旦鼠标移上去或正在连线，把手立刻出现。
    const hideLeftHandle = farView && !showLeftHandle;
    const hideRightHandle = farView && !showRightHandle;
    const hideResizeHandles = farView && !hovered && !isSelected;
    const isBatchRoot = data.type === CanvasNodeType.Image && Boolean(data.metadata?.isBatchRoot) && batchCount > 1;
    const isBatchChild = data.type === CanvasNodeType.Image && Boolean(data.metadata?.batchRootId);
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const imageBorderColor = isActive ? theme.node.activeStroke : isRelated && !isBatchChild ? theme.node.muted : "transparent";
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
    });

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!editRequestNonce || data.type !== CanvasNodeType.Text) return;
        setIsEditingContent(true);
    }, [data.type, editRequestNonce]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            const minWidth = 220;
            const minHeight = 160;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            onResize(data.id, width, height, {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            });
        },
        [data.id, onResize, scale],
    );

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
    }, [handleResizeMove]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: (data.type === CanvasNodeType.Image && !data.metadata?.freeResize) || data.type === CanvasNodeType.Video,
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    return (
        <div
            data-node-id={data.id}
            className={`node-element absolute flex select-none flex-col transition-shadow duration-200 ${isSelected ? "z-50" : "z-10"}`}
            style={{
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                transition: "box-shadow 200ms ease",
                // ⚠️ 不要在这里加 contain:paint。节点故意有多处溢出自身边界的子元素——
                // 名字标签(NodeNameTag，节点上方)、四角缩放手柄(-14px)、两侧连线圆点(-24px)、
                // 批次根节点的堆叠卡片(overflow-visible)。加 paint 会把它们全裁掉。
                contain: "layout style",
            }}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            <div
                className={`relative h-full w-full overflow-visible rounded-3xl border-2 transition-[border-color,box-shadow] duration-200 ${shouldPopIn ? "anim-pop" : ""}`}
                style={{
                    background: hasImageContent || hasVideoContent ? "transparent" : theme.node.fill,
                    borderColor: hasImageContent ? imageBorderColor : isActive ? theme.node.activeStroke : isRelated ? theme.node.muted : theme.node.stroke,
                    boxShadow: isActive ? selectionGlow[colorTheme] : isRelated && !isBatchChild ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(15,23,42,.14)` : undefined,
                }}
                onMouseDown={(event) => onMouseDown(event, data.id)}
                onDoubleClick={(event) => {
                    if (isBatchRoot) {
                        event.stopPropagation();
                        onToggleBatch?.(data.id);
                        return;
                    }
                    if (data.type === CanvasNodeType.Image && hasImageContent) {
                        event.stopPropagation();
                        onViewImage?.(data);
                        return;
                    }
                    if (data.type === CanvasNodeType.Video && hasVideoContent) {
                        event.stopPropagation();
                        onViewImage?.(data);
                        return;
                    }
                    // 3D 场景台：双击直接开工具，和图片/视频双击预览是同一类心智。
                    if (data.type === CanvasNodeType.Stage) {
                        event.stopPropagation();
                        onOpenStage?.(data);
                        return;
                    }
                    if (data.type !== CanvasNodeType.Text) return;
                    event.stopPropagation();
                    setIsEditingContent(true);
                }}
            >
                <div
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${isBatchRoot ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: hasImageContent || hasVideoContent ? "transparent" : theme.node.fill,
                            "--batch-from-x": `${batchMotion?.x || 0}px`,
                            "--batch-from-y": `${batchMotion?.y || 0}px`,
                            "--batch-from-rotate": `${6 + (batchMotion?.index || 0) * 4}deg`,
                            animation: data.metadata?.batchRootId ? (batchClosing ? "canvas-batch-child-out 260ms cubic-bezier(.4,0,.2,1) both" : "canvas-batch-child-in 340ms cubic-bezier(.2,.85,.18,1) both") : undefined,
                            animationDelay: data.metadata?.batchRootId ? `${batchClosing ? 0 : 45 + (batchMotion?.index || 0) * 24}ms` : undefined,
                        } as React.CSSProperties
                    }
                >
                    <NodeContent
                        node={data}
                        scale={scale}
                        theme={theme}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        isBatchRoot={isBatchRoot}
                        batchCount={batchCount}
                        batchExpanded={batchExpanded}
                        batchOpening={batchOpening}
                        batchRecovering={batchRecovering}
                        renderNodeContent={renderNodeContent}
                        mentionReferences={mentionReferences}
                        onContentChange={onContentChange}
                        onStopEditing={() => setIsEditingContent(false)}
                        onRetry={onRetry}
                        onGenerateImage={onGenerateImage}
                        onToggleBatch={() => onToggleBatch?.(data.id)}
                        onSetBatchPrimary={() => onSetBatchPrimary?.(data)}
                        audioTrimming={audioTrimming}
                        onAudioTrimConfirm={(blob, durationMs) => onAudioTrimConfirm?.(data, blob, durationMs)}
                        onAudioTrimCancel={onAudioTrimCancel}
                    />
                </div>

                {showImageInfo && hasImageContent && !farView ? <ImageInfoBar node={data} /> : null}
                {/* 节点内的「图片N」引用徽标已移除：改用节点外部左上角的自定义名标签(NodeNameLabelLayer)统一显示，避免内外重复且数字口径不一。 */}

                {!hasImageContent && !hasVideoContent && !hasAudioContent ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} /> : null}

                {hideResizeHandles ? null : <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} />}
                {hideResizeHandles ? null : <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} />}
                {hideResizeHandles ? null : <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} />}
                {hideResizeHandles ? null : <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} />}
            </div>

            {farView ? null : <NodeNameTag id={data.id} displayName={displayName} isSelected={isSelected} onRename={onRename} />}

            {hideLeftHandle ? null : <ConnectionHandleDot side="left" visible={showLeftHandle} onMouseDown={(event) => onConnectStart(event, data.id, "target")} />}
            {hideRightHandle ? null : <ConnectionHandleDot side="right" visible={showRightHandle} onMouseDown={(event) => onConnectStart(event, data.id, "source")} />}

            {/* 面板宽度走 CSS 变量，默认 620（原先写死 500，模型名长时控件行超出、被左侧组的
                    overflow-hidden 裁掉，右边显示不全；不靠压缩模型名解决，那样看不出是哪个模型）。
                    ⚠️ 用 CSS 变量而不是在这里读 store：这个组件【每个节点都渲染一遍】，
                       挂一个 store 订阅会破坏 memo。变量由画布页设一次在 :root 上。 */}
            {showPanel && renderPanel ? <div className="absolute left-1/2 top-full z-[70] max-w-[92vw] -translate-x-1/2 pt-4" style={{ width: "var(--canvas-panel-w, 620px)" }}>{renderPanel(data)}</div> : null}
        </div>
    );
});

// 节点名字标签：渲染在节点内部、贴节点上边缘之上，随节点一起缩放、随节点 z 层级堆叠（被前面的节点自然遮住）。
// 双击进入改名；Enter/失焦提交、Esc 取消；空串由父级恢复默认名。取代旧的全局 NodeNameLabelLayer 覆盖层。

function NodeNameTag({ id, displayName, isSelected, onRename }: { id: string; displayName: string; isSelected: boolean; onRename: (id: string, value: string) => void }) {
    const [editing, setEditing] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        if (!editing) return;
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.select();
    }, [editing]);
    const commit = () => {
        const value = inputRef.current ? inputRef.current.value.trim() : "";
        onRename(id, value);
        setEditing(false);
    };
    return (
        <div className="absolute left-0 z-[1]" style={{ top: -6, transform: "translateY(-100%)" }}>
            {editing ? (
                <input
                    ref={inputRef}
                    type="text"
                    defaultValue={displayName}
                    className="pointer-events-auto block max-w-[200px] rounded-md bg-black/70 px-2 py-1 text-[11px] leading-none text-white outline-none ring-1 ring-white/40"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                            event.preventDefault();
                            commit();
                        } else if (event.key === "Escape") {
                            event.preventDefault();
                            setEditing(false);
                        }
                    }}
                    onBlur={commit}
                />
            ) : (
                <button
                    type="button"
                    title={displayName}
                    className={`pointer-events-auto block max-w-[200px] cursor-text truncate whitespace-nowrap rounded-md px-2 py-1 text-left text-[11px] leading-none backdrop-blur-sm transition-colors ${
                        isSelected ? "bg-black/60 text-white ring-1 ring-white/40" : "bg-black/45 text-white/90 hover:bg-black/60"
                    }`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => {
                        event.stopPropagation();
                        setEditing(true);
                    }}
                >
                    {displayName}
                </button>
            )}
        </div>
    );
}

function NodeContent(props: NodeContentRendererProps) {
    if ((props.node.type === CanvasNodeType.Config || props.node.type === CanvasNodeType.Storyboard || props.node.type === CanvasNodeType.SceneCamera || props.node.type === CanvasNodeType.Stage) && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (props.isBatchRoot) return <ImageNodeContent {...props} />;
    if (props.node.metadata?.status === "loading") return <LoadingContent theme={props.theme} node={props.node} />;
    if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;

    const Renderer = nodeContentRenderers[props.node.type];
    return Renderer ? <Renderer {...props} /> : <UnknownNodeContent theme={props.theme} />;
}

const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Storyboard]: EmptyImageContent,
    [CanvasNodeType.SceneCamera]: EmptyImageContent,
    // 实际内容由上面的 renderNodeContent 委托渲染，这里只是为了满足 satisfies Record 的完整性。
    [CanvasNodeType.Stage]: EmptyImageContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

// 生成耗时格式化：<60s 显示秒(decimal=true 带一位小数)，否则 M:SS。零三元。
function formatGenSeconds(ms: number, decimal: boolean): string {
    if (ms < 60000) {
        if (decimal) return (ms / 1000).toFixed(1) + "s";
        return Math.floor(ms / 1000) + "s";
    }
    const totalSec = Math.round(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min + ":" + String(sec).padStart(2, "0");
}

// 生成中实时计时：每 250ms 刷新，从 generationStartedAt 起算。
function useGenerationElapsed(startedAt?: string): string {
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!startedAt) return;
        const timer = setInterval(() => setTick((value) => value + 1), 250);
        return () => clearInterval(timer);
    }, [startedAt]);
    if (!startedAt) return "";
    const start = Date.parse(startedAt);
    if (!start) return "";
    return formatGenSeconds(Math.max(0, Date.now() - start), false);
}

// 等待久了之后给的安心提示：任务在云端跑，离开/关页也不会丢，不必重新生成。
//
// 为什么需要：视频动辄 3~8 分钟，用户盯着一个只写「生成中」的转圈很容易判断为「卡死了」，
// 于是再点一次生成——每多点一次就多扣一份钱、还把原任务变成没人认领的孤儿
// （只能靠服务端兜底扫描捡回「我的素材」，而那还有 15 分钟宽限期，用户更以为丢了）。
// 与其在出问题后补救，不如在这里先把「重新生成」的念头掐掉。
//
// 阈值为什么是 180s：90s 这个量级太低了。gpt-image-2-4k 这类重模型单次上游耗时中位就在 100s 上下、
// P90 逼近 190s，也就是说九成以上的**正常**生成都会越过 90s，提示每次都弹、退化成背景板，
// 真正该被警觉的慢尾巴反而淹没在噪音里。取 P90 作阈值，让它只在确实偏慢时出现。
const LOADING_REASSURE_MS = 180_000;

function LoadingContent({ theme, node }: Pick<NodeContentRendererProps, "theme" | "node">) {
    const startedAt = node?.metadata?.generationStartedAt;
    const elapsed = useGenerationElapsed(startedAt);
    let label = "生成中";
    if (elapsed) label = "生成中 · " + elapsed;
    // 有服务端任务号才提示——本地直连/流式那类没有可续查的任务，关页确实就断了，不能给错误的安心感。
    const hasServerTask = Boolean(node?.metadata?.videoTaskId || node?.metadata?.imageJobId);
    const startedMs = startedAt ? Date.parse(startedAt) : 0;
    const waitedLong = Boolean(startedMs) && Date.now() - startedMs >= LOADING_REASSURE_MS;
    const showReassure = hasServerTask && waitedLong;
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
            <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            <span className="text-[10px] tracking-[0.2em]" style={{ color: theme.node.muted }}>
                {label}
            </span>
            {showReassure ? (
                <span className="max-w-[240px] text-[10px] leading-relaxed" style={{ color: theme.node.muted }}>
                    仍在云端生成中，可以先去做别的
                    <br />
                    离开画布也不会丢，回来会自动接上
                    <br />
                    <span style={{ color: theme.node.activeStroke }}>不必重新生成（会重复扣费）</span>
                </span>
            ) : null}
        </div>
    );
}

function ErrorContent({ node, theme, onRetry }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry">) {
    return (
        <div className="flex max-w-[260px] flex-col items-center gap-3 px-5 text-center">
            <div className="text-xs leading-5 text-destructive">{node.metadata?.errorDetails || "生成失败"}</div>
            <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition duration-200 hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: "0 4px 14px rgba(15,23,42,.10)" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                重试
            </button>
        </div>
    );
}

function UnknownNodeContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    return (
        <div className="flex h-full w-full items-center justify-center text-sm" style={{ color: theme.node.placeholder }}>
            未知节点
        </div>
    );
}

function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, onContentChange, onStopEditing, onGenerateImage }: NodeContentRendererProps) {
    const [expanded, setExpanded] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;

    // 画布容器在原生阶段 preventDefault 了 wheel，React 层 stopPropagation 来不及生效；
    // 内容溢出时在原生阶段拦截，让浏览器执行默认滚动。
    useEffect(() => {
        const element = contentRef.current;
        if (!element) return;
        const handleWheel = (event: WheelEvent) => {
            if (element.scrollHeight > element.clientHeight) event.stopPropagation();
        };
        element.addEventListener("wheel", handleWheel, { passive: true });
        return () => element.removeEventListener("wheel", handleWheel);
    }, [isEditingContent]);

    const closeExpanded = () => {
        setExpanded(false);
        onStopEditing();
    };

    return (
        <div className="flex h-full w-full flex-col overflow-hidden pt-8">
            <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5">
                <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium opacity-85 backdrop-blur-md transition duration-200 hover:scale-[1.02] hover:opacity-100"
                    style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text, boxShadow: "0 6px 18px rgba(15,23,42,.10)" }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onGenerateImage?.(node);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title="用文本生图"
                    aria-label="用文本生图"
                >
                    <ImageIcon className="size-3.5" />
                    生图
                </button>
            </div>
            {/* 放大编辑：右下角独立悬浮按钮，避开顶部悬浮工具栏遮挡，显示态/编辑态都可点 */}
            <button
                type="button"
                className="absolute bottom-3 right-3 z-30 inline-flex h-9 items-center gap-1 rounded-full border px-3 text-xs font-medium opacity-90 backdrop-blur-md transition duration-200 hover:scale-[1.03] hover:opacity-100"
                style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text, boxShadow: "0 8px 24px rgba(15,23,42,.14)" }}
                onClick={(event) => {
                    event.stopPropagation();
                    setExpanded(true);
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title="放大编辑"
                aria-label="展开编辑"
            >
                <Maximize2 className="size-3.5" />
                放大
            </button>
            {expanded
                ? createPortal(
                      <div className="anim-fade fixed inset-0 z-[200] flex items-center justify-center bg-[#0e1628]/55 p-6 backdrop-blur-[2px]" onMouseDown={closeExpanded} onPointerDown={(event) => event.stopPropagation()}>
                          <div
                              className="anim-pop flex h-[80vh] w-[880px] max-w-[92vw] flex-col rounded-2xl border p-3"
                              style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: "0 2px 8px rgba(2,6,23,.14), 0 32px 80px rgba(2,6,23,.32)" }}
                              onMouseDown={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                              onWheel={(event) => event.stopPropagation()}
                          >
                              <div className="mb-2 flex items-center justify-between px-1">
                                  <span className="text-sm font-medium opacity-80">编辑文字</span>
                                  <button
                                      type="button"
                                      onClick={closeExpanded}
                                      className="inline-flex size-7 items-center justify-center rounded-md opacity-70 transition hover:bg-black/10 hover:opacity-100"
                                      style={{ color: theme.node.text }}
                                      aria-label="收起"
                                      title="收起"
                                  >
                                      <Minimize2 className="size-4" />
                                  </button>
                              </div>
                              <div className="min-h-0 flex-1">
                                  <CanvasResourceMentionTextarea
                                      autoFocus
                                      value={node.metadata?.content || ""}
                                      references={mentionReferences}
                                      highlightLabels={false}
                                      onChange={(value) => onContentChange(node.id, value)}
                                      onKeyDown={(event) => {
                                          if (event.key === "Escape") closeExpanded();
                                      }}
                                      className="thin-scrollbar h-full w-full resize-none rounded-xl border px-3 py-2 font-mono outline-none"
                                      style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text, fontSize: "14px", lineHeight: "23px" }}
                                      placeholder="输入文字内容"
                                  />
                              </div>
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
            {isEditingContent ? (
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    className="thin-scrollbar block h-full w-full resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent pl-4 pr-14 pt-0 pb-14 m-0 font-mono outline-none select-text appearance-none"
                    style={textStyle}
                    value={node.metadata?.content || ""}
                    references={mentionReferences}
                    highlightLabels={false}
                    onChange={(value) => onContentChange(node.id, value)}
                    onBlur={onStopEditing}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onStopEditing();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                />
            ) : (
                <div
                    ref={contentRef}
                    className="thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent pl-4 pr-14 pt-0 pb-14 font-mono"
                    style={textStyle}
                    onWheel={(event) => event.stopPropagation()}
                >
                    {node.metadata?.content || <span style={{ color: theme.node.placeholder }}>双击编辑文字</span>}
                </div>
            )}
        </div>
    );
}

function ResourceLabelBadge({ reference, side = "right" }: { reference: CanvasResourceReference; side?: "left" | "right" }) {
    return (
        <span className={`pointer-events-none absolute top-2 z-30 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${side === "left" ? "left-2" : "right-2"} ${reference.active ? "bg-[#2563EB] text-white shadow-sm dark:bg-[#3B82F6]" : "bg-black/35 text-white/75"}`}>
            {reference.label}
        </span>
    );
}

function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content && props.isBatchRoot) {
        const content =
            props.node.metadata?.status === "loading" ? (
                <LoadingContent theme={props.theme} />
            ) : props.node.metadata?.status === "error" ? (
                <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />
            ) : (
                <EmptyImageContent {...props} isBatchRoot={false} />
            );
        return (
            <BatchFrame batchCount={props.batchCount} batchExpanded={props.batchExpanded} batchOpening={props.batchOpening} batchRecovering={props.batchRecovering} onToggleBatch={props.onToggleBatch}>
                {content}
            </BatchFrame>
        );
    }
    if (!props.node.metadata?.content) return <EmptyImageContent {...props} />;

    return (
        <ImageContent
            node={props.node}
            scale={props.scale}
            isBatchRoot={props.isBatchRoot}
            batchCount={props.batchCount}
            batchExpanded={props.batchExpanded}
            batchOpening={props.batchOpening}
            batchRecovering={props.batchRecovering}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
        />
    );
}

function EmptyImageContent({ theme, isBatchRoot, batchCount, batchExpanded, batchOpening, batchRecovering, onToggleBatch }: NodeContentRendererProps) {
    const content = (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">空图片节点</span>
        </div>
    );
    if (isBatchRoot)
        return (
            <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} onToggleBatch={onToggleBatch}>
                {content}
            </BatchFrame>
        );
    return content;
}

// 给 http(s) 地址挂一个一次性的重试参数。
//
// 为什么不是直接 img.src = src / video.load()：重试要对付的正是「上一次那条失败或半截的响应被缓存住了」，
// 同一个 URL 再来一次很可能原样命中缓存、错误照旧。换掉 URL 才能保证真的重新发一次请求。
// blob:/data: 一律不动——给它们加 query 会直接失效。
// 只有出错后才会带上这个参数，正常路径的 URL 不变，不影响对象存储那条 immutable 缓存策略。
function withRetryTick(url: string, tick: number) {
    if (!url || tick <= 0) return url;
    if (!/^https?:/i.test(url)) return url;
    return url + (url.includes("?") ? "&" : "?") + "_retry=" + tick;
}

function VideoNodeContent({ node, scale, theme }: NodeContentRendererProps) {
    // 画布里播放优先用预览版：源片可能是浏览器解不了的编码（H.265 这类），也可能大到几百 MB，
    // 而节点显示区不过两三百像素——没有任何理由在这里拉原片。
    // ⚠️ 只有这里换：当参考 / 下载 / 后续处理读的都是 metadata.content，那条路必须还是原片，
    //    否则用户会拿 720p 的预览版去做后续处理，画质白白掉一档。
    const content = node.metadata?.previewContent || node.metadata?.content;
    const storageKey = node.metadata?.storageKey;
    // 上云状态：拖进画布的视频要先推到服务端才能做服务端侧的处理操作，
    // 以前这一步全程静默，用户只能靠手感猜什么时候能点（点早了就报「还没有同步到云端」）。
    const uplink = useMediaUplink(storageKey);
    // 上云走完之后可能还在转「可播放的预览版」（源片是浏览器解不了的编码时）。
    // 那一步同样要让用户看见，否则就是盯着一个不动的节点干等一两分钟。
    const transcode = useMediaTranscode(storageKey);
    const videoRef = useRef<HTMLVideoElement>(null);
    const [loadedSrc, setLoadedSrc] = useState("");
    // 与图片对称的自愈：跨会话后 content 是死 blob:，onError 时先查本地缓存(内存/IndexedDB media_files)、
    // 命中直接用本地 ObjectURL 秒显不联网，本地没有才由 resolveMediaUrl 内部带 token 从服务器拉回一次。
    const [healedSrc, setHealedSrc] = useState("");
    const [healFailed, setHealFailed] = useState(false);
    const healingRef = useRef(false); // 防重入/防死循环：一个 content 只自愈一次
    // 二级兜底标记：本地缓存命中的 blob 本身是坏的(写入中断/驱逐残留)时,一级自愈拿到的是"能生成 URL 但放不出来"的假活链;
    // 此时删本地坏缓存、强制从服务器重拉一次(只一次),仍失败才判死——修「重新进入后资源丢失且重试无效」。
    const serverHealTriedRef = useRef(false);
    // 无 storageKey 的节点（服务端生成后直接把公网地址写进 content 的成片，绝大多数视频都是这种）
    // 走不了上面那条自愈链——它整条都是按 storageKey 找本地/服务端副本的。
    // 这类节点原来的行为是：<video> 一报错就直接判死，连原地址都没重试过一次；而「点击重试」调的又是
    // 同一个判死分支，src 从头到尾没变、浏览器根本不会重新加载 —— 按钮点几次都一样。
    // 于是任何一次瞬时失败（网络抖动、对象存储偶发、并发播放器超上限）都会被固化成永久「加载失败」。
    // 现在给它一条自己的路：换个 URL 真的重来一次。
    const [retryTick, setRetryTick] = useState(0);
    const autoRetriedRef = useRef(false); // 自动重试只给一次，避免真死链时无限重拉
    const src = healedSrc || withRetryTick(content || "", retryTick) || "";
    // ── 首帧封面 + 不默认挂播放器 ──────────────────────────────────────────
    // 现状：<video> 没写 preload，浏览器一挂载就建播放器、取数据、解首帧。实测同时挂 100 个还扛得住，
    // 300 个直接把渲染进程卡死（标签页失去响应）。视频节点上百的画布缩小看全局时正落在这个区间。
    // 改法：拿得到 TOS 截帧封面就 preload="none"（一个播放器都不建，只下一张几 KB 的 JPEG），
    //       拿不到就退回今天的默认行为。这样每种情况都不会比改之前更差。
    const [activated, setActivated] = useState(false);
    const [posterSrc, setPosterSrc] = useState("");
    const [posterFailed, setPosterFailed] = useState(false);
    const zoomBucket = zoomBucketOf(scale ?? 1);
    // ⚠️ 封面只从【原始 content】拼，不从 src 拼：src 可能带 ?_retry=N，而 TOS 处理参数的第一条铁律
    //    就是「已带查询串的地址不碰」——从 src 拼会让重试过一次的视频永久没有封面。
    // ⚠️ 传缩放档而不是显示像素：封面只有远近两个固定档，一条视频最多两个 URL、各转码一次、缓存一年。
    //    跟着显示尺寸走会让每个缩放档都产生一个新 URL = 一次新的服务端转码（用户问的就是这个）。
    const posterCandidate = tosVideoPosterUrl(content, zoomBucket, node.metadata?.naturalWidth, node.metadata?.naturalHeight);
    // !healFailed 门控：自愈失败时立即收起 loading 圈并显示失败/重试，避免死链拉不回时无限转圈（与图片对齐）。
    // preload="none" 期间不转圈：那时本来就没在加载，转圈会让人以为卡住了。
    let showLoading = !healFailed && Boolean(src) && loadedSrc !== src;
    // 等封面期间本来就没在加载，不该转圈；用户点播放之后也不该转——原生播放器自己有缓冲圈，
    // 再盖一个就是两个圈一起转。加载完成与否交给原生控件表达。
    if (posterCandidate && !posterFailed) showLoading = false;
    // 换视频/重生成 → 重置自愈态。
    //
    // 判据用 storageKey 而不是 content：content 会在【每次画布重载】时抖动两次——
    // restore 先拿持久化里的值建节点（跨会话后常是死 blob:），随后 hydrateCanvasImages
    // 异步把它补成可用地址（见 canvas-client-page 的媒体后台水合）。
    // 若按 content 重置，已经自愈好的视频会被打回未加载态、重新转圈；而画布重载又会被
    // 「切走窗口→flushCloudSync 推送→updatedAt 变新→回来同步完成→restoreEpoch++」触发，
    // 用户表现就是「移开窗口再回来视频又开始转圈」。
    // 自愈结果本来就是按 storageKey 取的，storageKey 没变就还是同一个视频，没有理由丢弃。
    // 无 storageKey 的节点（纯 content、无服务端副本）退回按 content 判定，行为不变。
    const healKey = storageKey || content;
    useEffect(() => {
        setHealedSrc("");
        setHealFailed(false);
        healingRef.current = false;
        serverHealTriedRef.current = false;
        setRetryTick(0);
        autoRetriedRef.current = false;
        setActivated(false);
        setPosterSrc("");
        setPosterFailed(false);
    }, [healKey]);
    // 缓存视频可能在 onLoadedData 绑定前已就绪 → 用 readyState 兜底，避免 loading 永久卡住。
    useEffect(() => {
        const v = videoRef.current;
        if (src && v && v.readyState >= 2) setLoadedSrc(src);
    }, [src]);
    // 封面必须先探一次再挂：<video poster> 加载失败【没有任何事件可听】，桶没开媒体处理、对象已删、
    // 视频短于截帧点，都会静默退回黑框——那正是这次要消灭的东西。探通了才挂 poster、才敢 preload="none"；
    // 探不通就立 posterFailed，preload 退回 "metadata"，行为与改动前一字不差。
    // 同一个 URL 浏览器只真下一次（挂到 poster 上时走 HTTP 缓存）。
    // 探不通【不自动重试】：几百个节点各自重试是一场雷群，而封面挂了只是观感问题、不影响播放。
    // 不在开头清 posterSrc：换档位时旧封面继续显示到新档探通，避免缩放时整屏封面闪空白（与图片 LOD 同款）。
    useEffect(() => {
        if (!posterCandidate) return;
        let cancelled = false;
        // 只问一句「这个桶支不支持截帧」——桶级结论，全局探一次、跨会话记在 localStorage。
        // 支持就直接把封面挂上去，让浏览器自己并发去取；不再给每个节点单独排队探测
        //（那一版在 261 个视频的画布上光排队就十几秒，反而更慢）。
        void posterHostSupported(posterCandidate).then((ok) => {
            if (cancelled) return;
            if (ok) setPosterSrc(posterCandidate);
            else setPosterFailed(true);
        });
        return () => {
            cancelled = true;
        };
    }, [posterCandidate]);
    async function healVideo() {
        if (!storageKey) {
            setHealFailed(true);
            return;
        }
        healingRef.current = true;
        setHealFailed(false);
        const url = await resolveMediaUrl(storageKey, "");
        if (url) {
            setHealedSrc(url);
            // 广播活链：ccp 监听后把仍是死 blob: 的同 storageKey 节点 content 回写，让参考缩略图/详情随之恢复
            //（缓存命中时 resolveMediaUrl 自身不广播）。
            if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("image-blob-healed", { detail: { storageKey, url } }));
        } else {
            setHealFailed(true);
        }
    }
    // 二级兜底：一级自愈拿到的本地 URL 仍放不出来 = 本地缓存条目已损坏 → 删本地坏缓存、强制服务器重拉一次。
    async function healVideoFromServer() {
        if (!storageKey) {
            setHealFailed(true);
            return;
        }
        serverHealTriedRef.current = true;
        setHealFailed(false);
        await deleteStoredMedia([storageKey]);
        const url = await resolveMediaUrl(storageKey, "");
        if (url) {
            setHealedSrc(url);
            if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("image-blob-healed", { detail: { storageKey, url } }));
        } else {
            setHealFailed(true);
        }
    }
    // content 是公网地址：原地换个 URL 重来一次。返回 true 表示已经安排了重试。
    //
    // 判据从「没有 storageKey」改成「content 是公网地址」：服务端交付的成片以后两样都有
    //（见 handler/media_persist.go 的 sync_files 登记），而换个 URL 重来一次仍然是最便宜的第一步
    //（不下载整片、不写 IndexedDB）。这一步之后 handleVideoError 才退到按 storageKey 的自愈链。
    function retryRemoteVideo(manual: boolean) {
        if (!/^https?:/i.test(content || "")) return false;
        if (!manual && autoRetriedRef.current) return false;
        if (!manual) autoRetriedRef.current = true;
        setHealFailed(false);
        setLoadedSrc("");
        setRetryTick((tick) => tick + 1);
        return true;
    }
    function handleVideoError() {
        // 死链（多为跨会话 blob:）→ 先走本地缓存/IndexedDB 自愈一次；
        // 本地拉回的仍放不出来（本地缓存损坏）→ 删本地坏缓存、强制服务器重拉一次；再失败才判死。
        if (healedSrc || healingRef.current) {
            if (!serverHealTriedRef.current) {
                void healVideoFromServer();
                return;
            }
            setHealFailed(true);
            return;
        }
        // 服务端交付的成片没有 storageKey，自愈链路对它无效——先老老实实把原地址重试一次再说。
        if (retryRemoteVideo(false)) return;
        void healVideo();
    }
    function handleVideoRetry() {
        setHealedSrc("");
        setHealFailed(false);
        healingRef.current = false;
        serverHealTriedRef.current = false;
        // 手动重试永远算数：不受"自动只给一次"的限制，用户点一次就真的重新拉一次。
        if (retryRemoteVideo(true)) return;
        void healVideo();
    }
    // 角标文案在 return 之前用纯 if 算好，JSX 属性里不写三元——这个项目的画布组件踩过 bun SSG 的 SIGILL。
    let uplinkLabel = "";
    let uplinkFailed = false;
    if (uplink && uplink.status === "uploading") {
        const total = uplink.total || 0;
        if (total > 0 && uplink.loaded >= total) {
            // 进度条只覆盖「浏览器 → 服务端」，走完还要由服务端推对象存储，这段没有进度可报。
            uplinkLabel = "上云中 · 服务端处理…";
        } else {
            let pct = 0;
            if (total > 0) pct = Math.min(99, Math.floor((uplink.loaded / total) * 100));
            uplinkLabel = `上云中 ${pct}%`;
        }
    }
    if (uplink && uplink.status === "failed") uplinkFailed = true;
    // 转码进度复用同一个徽标：上云与转码是先后两段，同一时刻只会有一个在跑。
    if (!uplinkLabel && transcode && transcode.status === "running") {
        if (transcode.progress > 0) uplinkLabel = `转换可播放版本 ${transcode.progress}%`;
        else uplinkLabel = "转换可播放版本…";
    }
    if (!uplinkLabel && transcode && transcode.status === "failed") uplinkLabel = "转换失败，原片仍可下载";
    // 同上：JSX 属性里不写三元，先在这里算好。poster 用 undefined 而不是空串，让 React 直接省掉这个属性。
    let posterAttr: string | undefined = undefined;
    if (posterSrc) posterAttr = posterSrc;
    // preload：只有「确实拿到了封面、且用户还没点开」时才 none，其余一切情况都是改动前的行为。
    // ⚠️ 方向是单向的：初始必须 none，之后只能 none→metadata。Chromium 在 preload 离开 none 时会
    //    启动那次被推迟的加载，所以「用户点播放 / 封面探测失败」翻成 metadata 就会自己开始加载，
    //    不需要手动调 play()（也就不会撞自动播放策略）。反过来先 metadata 再翻 none 是没用的。
    // ⚠️ 绝不能用 onLoadStart 来置 activated：按规范 loadstart 在延迟加载【之前】就会触发，
    //    那会在挂载瞬间把 activated 立起来，整个改动当场作废。只能听 onPlay。
    // ⚠️ 判据必须用【同步就知道的】posterCandidate，不能用探测回来才有的 posterSrc。
    //    用后者 = 首次渲染时 preload 还是 metadata，浏览器当场就给几百个节点建播放器开始加载，
    //    等封面探完早就晚了——那次改动等于没做，还额外并发了几百个截帧请求，比不改更重。
    //    （写错的话表现极具迷惑性：画布打开后节点照样全在转圈、页面直接卡死，看起来像是改动根本没生效。）
    //    探测失败会翻回 metadata，Chromium 那时才启动被推迟的加载，行为回到改动前。
    let preloadAttr: "none" | "metadata" = "metadata";
    if (posterCandidate && !posterFailed && !activated) preloadAttr = "none";

    if (!content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
                <Video className="size-7 opacity-35" />
                <span className="text-sm">空视频节点</span>
            </div>
        );
    return (
        <div className="relative h-full w-full">
            <video
                ref={videoRef}
                src={src}
                controls
                poster={posterAttr}
                preload={preloadAttr}
                onPlay={() => setActivated(true)}
                onLoadedData={() => setLoadedSrc(src)}
                onError={handleVideoError}
                className="h-full w-full rounded-[18px] bg-black object-contain"
                data-canvas-no-zoom
            />
            {showLoading ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[18px] bg-black/40">
                    <Loader2 className="size-7 animate-spin text-white/75" />
                </div>
            ) : null}
            {healFailed ? (
                <button type="button" onClick={handleVideoRetry} className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[18px] bg-black/55 text-white/80" data-canvas-no-zoom>
                    <RefreshCw className="size-6" />
                    <span className="text-xs">视频加载失败 · 点击重试</span>
                </button>
            ) : null}
            {uplinkLabel ? (
                <div className="pointer-events-none absolute right-2 top-2 z-40">
                    <span className="flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white/90 backdrop-blur-sm">
                        <Loader2 className="size-3 animate-spin" />
                        {uplinkLabel}
                    </span>
                </div>
            ) : null}
            {uplinkFailed && storageKey ? (
                <button
                    type="button"
                    className="absolute right-2 top-2 z-40 flex items-center gap-1 rounded-md bg-[#DC2626]/85 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white backdrop-blur-sm"
                    data-canvas-no-zoom
                    title="这个视频没能传到云端。云端没有它，换台设备就看不到，服务端也处理不了。"
                    onClick={(event) => {
                        event.stopPropagation();
                        retryMediaUpload(storageKey);
                    }}
                >
                    <RefreshCw className="size-3" />
                    上云失败 · 重试
                </button>
            ) : null}
        </div>
    );
}

function AudioNodeContent({ node, theme, audioTrimming, onAudioTrimConfirm, onAudioTrimCancel }: NodeContentRendererProps) {
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">空音频节点</span>
            </div>
        );
    return (
        <CanvasAudioNodeContent
            src={node.metadata.content}
            title={node.title}
            durationMs={node.metadata.durationMs}
            trimming={audioTrimming ?? false}
            colors={{
                fill: theme.node.fill,
                text: theme.node.text,
                muted: theme.node.muted,
                accent: theme.node.activeStroke,
                border: theme.toolbar.border,
                panel: theme.toolbar.panel,
            }}
            onTrimConfirm={(blob, durationMs) => onAudioTrimConfirm?.(blob, durationMs)}
            onTrimCancel={() => onAudioTrimCancel?.()}
        />
    );
}

function ImageContent({
    node,
    scale,
    isBatchRoot,
    batchCount,
    batchExpanded,
    batchOpening,
    batchRecovering,
    onToggleBatch,
    onSetBatchPrimary,
}: {
    node: CanvasNodeData;
    scale?: number;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const isBatchChild = Boolean(node.metadata?.batchRootId);
    // 认证成功（人像资产 active）时序号变绿，沿用工具栏「已认证」绿（亮 #059669 / 暗 #34D399）
    const isPortraitActive = node.metadata?.portraitAssetStatus === "active";
    const badgeNumberColor = isPortraitActive ? (colorTheme === "dark" ? "#34D399" : "#059669") : theme.node.activeStroke;
    // 加载态:从素材库/分享取用的图片是远端 URL，有传输过程；加载完成前盖一层 loading 而非空白，避免用户误判为失败。
    const content = node.metadata!.content!;
    const storageKey = node.metadata?.storageKey;
    const imgRef = useRef<HTMLImageElement>(null);
    const [loadedSrc, setLoadedSrc] = useState("");
    // 自愈：跨会话后 content 存的会话级 blob: 已死链，onError 时先查本地缓存(内存/IndexedDB)、命中秒显不联网，
    // 本地也没有才带 token 从后端拉回（resolveImageUrl 内部三级兜底）。
    // healedSrc = 解析回的本地新 URL（优先用它），healFailed = 连服务器都拉不到 → 显式重试态（不再静默空白）。
    const [healedSrc, setHealedSrc] = useState("");
    const [healFailed, setHealFailed] = useState(false);
    const healingRef = useRef(false); // 防重入/防死循环：一个 content 只自愈一次，拉回的新 URL 再失败不再拉
    // 二级兜底标记：本地缓存命中的 blob 本身是坏的(写入中断/驱逐残留)时,一级自愈拿到的是"能生成 URL 但放不出来"的假活链;
    // 此时删本地坏缓存、强制从服务器重拉一次(只一次),仍失败才判死——修「重新进入后资源丢失且重试无效」。
    const serverHealTriedRef = useRef(false);
    // 与视频节点同因同治：没有 storageKey 的图片（服务端转存后只写了公网地址）自愈链路使不上劲，
    // 原来一报错就判死、且「点击重试」不会真的重新加载。这里给它一条换 URL 重来的路。
    const [retryTick, setRetryTick] = useState(0);
    const autoRetriedRef = useRef(false);
    const src = healedSrc || withRetryTick(content, retryTick);
    // 按显示尺寸取小图（只影响显示；生成/下载/编辑/认证读的都是 metadata.content，不受影响）。
    // lodFailed：万一某个桶没开图片处理或返回异常，退回原图，且【不能】走自愈逻辑——
    // 那会把「缩略图取不到」误判成「原图死链」，进而标成需要重试的坏节点。
    const [lodFailed, setLodFailed] = useState(false);
    const [lodSrc, setLodSrc] = useState("");
    const naturalLongEdge = Math.max(node.metadata?.naturalWidth || 0, node.metadata?.naturalHeight || 0);
    // 量化后的缩放：一次手势里最多跨几档，同档内不重算。
    // 直接依赖原始 scale 会让几百个节点每帧都重跑副作用（清/设定时器、换 src），反成卡顿源。
    const zoomBucket = zoomBucketOf(scale ?? 1);
    useEffect(() => {
        if (lodFailed) return;
        // 放大到一定程度就直接用原图，不再走小图（用户要的「超过 50% 就切高清」）。
        // 清空 lodSrc 让 wantedSrc 回落到 src；预加载那层会先把原图在后台读好再换上去，中途不闪。
        if (zoomBucket >= LOD_FULL_QUALITY_ZOOM) {
            setLodSrc("");
            return;
        }
        let cancelled = false;
        const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
        const longEdge = displayLongEdgePx(node.width, node.height, zoomBucket, dpr);
        const apply = (base: string) => {
            if (cancelled) return;
            setLodSrc(tosDisplayThumbUrl(base, longEdge, naturalLongEdge || undefined));
        };
        // content 本身就是 TOS 地址（只有少数节点是这种）→ 直接用。
        const direct = tosDisplayThumbUrl(src, longEdge, naturalLongEdge || undefined);
        if (direct) {
            setLodSrc(direct);
            return;
        }
        // 其余约 96.5% 的节点 content 是会话级 blob:，拿不到可加参数的地址 → 用 storageKey 反查公网地址。
        if (!storageKey) {
            setLodSrc("");
            return;
        }
        const known = getPublicMediaPath(storageKey);
        if (known) {
            apply(known);
            return;
        }
        void ensureMediaPathIndex().then(() => {
            if (!cancelled) apply(getPublicMediaPath(storageKey));
        });
        return () => {
            cancelled = true;
        };
    }, [src, storageKey, node.width, node.height, zoomBucket, naturalLongEdge, lodFailed]);
    const wantedSrc = lodFailed ? src : lodSrc || src;
    // 换 LOD 档位时【不能】直接改 <img src>：改的瞬间旧图就没了，要等新图下载解码完才出现，
    // 中间那段空窗会盖出 loading 遮罩——用户看到的就是「缩放时图片反复重新加载、一直闪」。
    // 改成：新档位先在后台预加载，加载好了再换上去，屏幕上始终有图，全程无闪。
    const [displaySrc, setDisplaySrc] = useState("");
    useEffect(() => {
        if (!wantedSrc) return;
        // 还没有任何图可显示（首次进入）→ 直接挂上，让它走正常的 loading 态
        if (!displaySrc) {
            setDisplaySrc(wantedSrc);
            return;
        }
        if (wantedSrc === displaySrc) return;
        let cancelled = false;
        const preload = new Image();
        preload.decoding = "async";
        preload.onload = () => {
            if (!cancelled) setDisplaySrc(wantedSrc);
        };
        // 预加载失败就别换了，继续显示当前这张（比换成一张加载不出来的强）
        preload.src = wantedSrc;
        return () => {
            cancelled = true;
        };
    }, [wantedSrc, displaySrc]);
    const effectiveSrc = displaySrc || wantedSrc;
    // 只有「一张都还没显示出来」时才盖 loading；换档位属于静默替换，不该再闪一次遮罩。
    const showLoading = !healFailed && !loadedSrc;
    // 换图/重生成 → 重置自愈态与 LOD 态。
    // 这里必须连 displaySrc/loadedSrc 一起清：换的是【另一张图】，不能继续挂着上一张，
    // 也该重新走一次 loading（与「同一张图换 LOD 档位」的静默替换区分开）。
    //
    // 判据用 storageKey 而不是 content：content 会在【每次画布重载】时抖动两次——
    // restore 先拿持久化里的值建节点（跨会话后常是死 blob:），随后 hydrateCanvasImages
    // 异步把它补成可用地址。若按 content 重置，已经显示好的图会被清空、重新转圈；
    // 而画布重载又会被「切走窗口→推送→updatedAt 变新→回来同步完成→restoreEpoch++」触发，
    // 用户表现就是「移开窗口再回来，图和视频全部重新加载一遍」。
    // storageKey 没变就还是同一张图，没有理由丢弃已经拿到的可用地址。
    // 无 storageKey 的节点（data: 图等无服务端副本）退回按 content 判定，行为不变。
    const healKey = storageKey || content;
    useEffect(() => {
        setHealedSrc("");
        setHealFailed(false);
        healingRef.current = false;
        serverHealTriedRef.current = false;
        setLodFailed(false);
        setLodSrc("");
        setDisplaySrc("");
        setLoadedSrc("");
    }, [healKey]);
    // 缓存 / data: 图片可能在 onLoad 绑定前就已解码完成 → 用 complete 兜底，避免 loading 永久卡住。
    useEffect(() => {
        const img = imgRef.current;
        if (img && img.complete && img.naturalWidth > 0) setLoadedSrc(effectiveSrc);
    }, [effectiveSrc]);
    async function runHeal() {
        if (!storageKey) {
            setHealFailed(true);
            return;
        }
        healingRef.current = true;
        setHealFailed(false);
        // 先查本地缓存(内存 ObjectURL → IndexedDB image_files)，命中直接用本地链秒显、不联网；
        // 只有本地真没有(跨设备/清缓存/被驱逐)才由 resolveImageUrl 内部带 token 从服务器 heal 一次。
        const url = await resolveImageUrl(storageKey, "");
        if (url) {
            setHealedSrc(url);
            // 广播活链：ccp 监听后把仍是死 blob: 的同 storageKey 节点 content 回写，让参考缩略图/下载/详情随之恢复
            //（缓存命中时 resolveImageUrl 自身不广播；放这里只在真正 onError 自愈时触发一次，不拖累批量水合）。
            if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("image-blob-healed", { detail: { storageKey, url } }));
        } else {
            setHealFailed(true);
        }
    }
    // 二级兜底：一级自愈拿到的本地 URL 仍放不出来 = 本地缓存条目已损坏 → 删本地坏缓存、强制服务器重拉一次。
    async function runServerHeal() {
        if (!storageKey) {
            setHealFailed(true);
            return;
        }
        serverHealTriedRef.current = true;
        setHealFailed(false);
        await deleteStoredImages([storageKey]);
        const url = await resolveImageUrl(storageKey, "");
        if (url) {
            setHealedSrc(url);
            if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("image-blob-healed", { detail: { storageKey, url } }));
        } else {
            setHealFailed(true);
        }
    }
    function retryRemoteImage(manual: boolean) {
        if (storageKey) return false;
        if (!/^https?:/i.test(content || "")) return false;
        if (!manual && autoRetriedRef.current) return false;
        if (!manual) autoRetriedRef.current = true;
        setHealFailed(false);
        setLoadedSrc("");
        // displaySrc 也必须清掉。它是「换 LOD 档位时先后台预加载、成功了才换上去」的那层缓冲：
        // 不清的话，新地址只会在后台预加载，失败就默默保持旧的坏图——既不显示 loading，
        // <img> 的 src 也没变、onError 不会再触发，用户会看到一张既不加载也没有失败提示的图。
        setDisplaySrc("");
        setRetryTick((tick) => tick + 1);
        return true;
    }
    function handleImgError() {
        // 拉回的新 URL 又失败：先删本地坏缓存、强制服务器重拉一次（只一次）；再失败才判死（防死循环）。
        if (healedSrc || healingRef.current) {
            if (!serverHealTriedRef.current) {
                void runServerHeal();
                return;
            }
            setHealFailed(true);
            return;
        }
        if (retryRemoteImage(false)) return;
        void runHeal();
    }
    function handleImgRetry() {
        setHealedSrc("");
        setHealFailed(false);
        healingRef.current = false;
        serverHealTriedRef.current = false;
        if (retryRemoteImage(true)) return;
        void runHeal();
    }

    // 诊断开关 ?perf=noimg：只把 <img> 换成纯色块，节点数量/连线/布局一律不变。
    // 用来把「图片太重」和「DOM 元素太多」这两种卡顿分开——两者体感相同但解法完全不同。
    if (canvasPerfFlag("noimg")) {
        return (
            <BatchFrame batchCount={isBatchRoot ? batchCount : 0} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} onToggleBatch={onToggleBatch}>
                <div className="h-full w-full rounded-3xl" style={{ background: theme.node.fill }} />
            </BatchFrame>
        );
    }

    return (
        <BatchFrame batchCount={isBatchRoot ? batchCount : 0} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} onToggleBatch={onToggleBatch}>
            <div className="relative h-full w-full overflow-hidden rounded-3xl">
                <img
                    ref={imgRef}
                    src={effectiveSrc}
                    alt={node.title}
                    decoding="async"
                    draggable={false}
                    onDragStart={(event) => event.preventDefault()}
                    onLoad={() => setLoadedSrc(effectiveSrc)}
                    onError={() => {
                        // 当前显示的是 LOD 小图且它失败了 → 先退回原图重试一次，不要当成死链走自愈。
                        if (!lodFailed && lodSrc && effectiveSrc === lodSrc) {
                            setLodFailed(true);
                            return;
                        }
                        handleImgError();
                    }}
                    className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                />
                {showLoading ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ background: theme.node.fill, color: theme.node.placeholder }}>
                        <Loader2 className="size-7 animate-spin opacity-55" />
                        <span className="text-[10px] tracking-[0.18em] opacity-45">加载中</span>
                    </div>
                ) : null}
                {healFailed ? (
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            handleImgRetry();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        className="absolute inset-0 flex flex-col items-center justify-center gap-2"
                        style={{ background: theme.node.fill, color: theme.node.placeholder }}
                    >
                        <ImageIcon className="size-7 opacity-45" />
                        <span className="text-[11px] opacity-70">图片加载失败</span>
                        <span className="flex items-center gap-1 text-[10px] tracking-[0.18em] opacity-55">
                            <RefreshCw className="size-3" />
                            点击重试
                        </span>
                    </button>
                ) : null}
                {!showLoading && !healFailed && (node.metadata?.naturalWidth || node.width) ? (
                    <div className="pointer-events-none absolute left-2 top-2 z-40">
                        <span className="rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white/90 backdrop-blur-sm">
                            {Math.round(node.metadata?.naturalWidth || node.width)} × {Math.round(node.metadata?.naturalHeight || node.height)}
                        </span>
                    </div>
                ) : null}
            </div>
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1 rounded-full border px-2.5 text-xs font-semibold shadow-[0_6px_18px_rgba(15,23,42,.12)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: `${theme.toolbar.panel}d9`, borderColor: isPortraitActive ? `${badgeNumberColor}cc` : `${theme.toolbar.border}cc`, color: theme.node.text }}
                    aria-label={batchExpanded ? "图片组已展开" : "图片组已收起"}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none" style={{ color: badgeNumberColor }}>
                        {batchCount}
                    </span>
                    <ChevronRight className={`size-3.5 opacity-55 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
            {isBatchChild ? (
                <button
                    type="button"
                    className="absolute right-3 top-3 z-30 flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium opacity-0 shadow-[0_8px_20px_rgba(15,23,42,.13)] backdrop-blur-md transition group-hover/batch:opacity-100 hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onSetBatchPrimary?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <Star className="size-3.5" style={{ color: theme.node.activeStroke }} />
                    设为主图
                </button>
            ) : null}
        </BatchFrame>
    );
}

function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    const genMs = node.metadata?.generationMs;
    let elapsedText = "";
    if (genMs && genMs > 0) elapsedText = " · 耗时 " + formatGenSeconds(genMs, true);
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {width} x {height}
                {size ? ` · ${size}` : ""}
                {elapsedText}
            </span>
        </div>
    );
}

function BatchFrame({ batchCount, batchExpanded, batchOpening, batchRecovering, onToggleBatch, children }: { batchCount: number; batchExpanded: boolean; batchOpening: boolean; batchRecovering: boolean; onToggleBatch?: () => void; children: ReactNode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isBatchRoot = batchCount > 1;
    return (
        <div
            className="group/batch relative h-full w-full overflow-visible"
            onDoubleClick={
                isBatchRoot
                    ? (event) => {
                          event.stopPropagation();
                          onToggleBatch?.();
                      }
                    : undefined
            }
        >
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 5) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_14px_34px_rgba(15,23,42,.16)] transition-all duration-300 group-hover/batch:translate-x-2"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded && !batchOpening ? 0.34 : 1,
                                transform:
                                    batchOpening || batchRecovering ? `translate(${54 + index * 22}px, ${20 + index * 12}px) rotate(${8 + index * 5}deg) scale(.98)` : `translate(${34 + index * 18}px, ${14 + index * 10}px) rotate(${6 + index * 4}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div className={`absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

function ConnectionHandleDot({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: React.MouseEvent) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div
            className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                side === "left" ? "-left-6" : "-right-6"
            } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            onMouseDown={onMouseDown}
        >
            <div
                className="size-3 rounded-full border-2 transition-all hover:scale-125 hover:border-[var(--handle-active)]"
                style={{ background: theme.node.panel, borderColor: theme.node.muted, "--handle-active": theme.node.activeStroke } as React.CSSProperties}
            />
        </div>
    );
}
