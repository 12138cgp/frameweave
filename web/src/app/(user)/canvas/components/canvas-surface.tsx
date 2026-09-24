"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useShortcutStore } from "@/stores/use-shortcut-store";
import { PAN_CANVAS_COMMAND_ID, eventToChord, resolveShortcutChords, shouldSkipShortcut } from "@/constant/shortcuts";
import type { ViewportTransform } from "../types";

type CanvasSurfaceProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDoubleClick?: (clientX: number, clientY: number) => void;
    onCanvasDeselect?: () => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

// 滚轮落在可滚动元素(节点文本框/prompt 输入等)且它在该方向还能滚 → true：放行浏览器原生滚动、画布不缩放；
// 到达滚动边界则返回 false，交回画布缩放。零三元规避 bun SIGILL。
function wheelTargetScrollable(target: Element | null, deltaY: number): boolean {
    let el: Element | null = target;
    let depth = 0;
    while (el && depth < 12) {
        if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight) {
            const overflowY = getComputedStyle(el).overflowY;
            if (el.tagName === "TEXTAREA" || overflowY === "auto" || overflowY === "scroll") {
                const atTop = el.scrollTop <= 0;
                const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
                if (deltaY < 0 && !atTop) return true;
                if (deltaY > 0 && !atBottom) return true;
                return false;
            }
        }
        if (el.hasAttribute("data-node-id")) break;
        el = el.parentElement;
        depth += 1;
    }
    return false;
}

export function CanvasSurface({ containerRef, viewport, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDoubleClick, onCanvasDeselect, onContextMenu, onDrop, children }: CanvasSurfaceProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
    });
    const scaleRef = useRef(viewport.k);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    // 平移键（默认空格）从用户的快捷键配置里取，和主监听器读同一份数据。
    const shortcutBindings = useShortcutStore((state) => state.bindings);
    const panChords = useMemo(() => resolveShortcutChords(shortcutBindings)[PAN_CANVAS_COMMAND_ID] || [], [shortcutBindings]);

    // 世界容器 / 网格 的 DOM 引用：手势(平移/触控板拖动)进行中直接改它们的样式，绕过 React 状态。
    const worldRef = useRef<HTMLDivElement | null>(null);
    const gridRef = useRef<HTMLDivElement | null>(null);
    // 手势进行中标志：期间只用 ref 改 DOM transform，不 setViewport → ccp 不重渲；松手/滑动停才提交一次。
    const gestureActiveRef = useRef(false);
    const panCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 把某视口直接写进 DOM（世界容器 transform + 网格背景偏移），不经 React 状态。
    const applyTransform = (vp: ViewportTransform) => {
        if (worldRef.current) worldRef.current.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.k})`;
        const grid = gridRef.current;
        if (grid) {
            const gridSize = 48 * vp.k;
            grid.style.backgroundSize = `${gridSize}px ${gridSize}px`;
            grid.style.backgroundPosition = `${vp.x % gridSize}px ${vp.y % gridSize}px`;
        }
        // 手势进行中广播实时视口：小地图订阅它、用 ref 即时更新指示框（否则 imperative 平移期 viewport 状态冻结、
        // 小地图要松手提交才跳）。仅手势期发,平时(committed)小地图走 React prop 正常渲染。
        if (gestureActiveRef.current && typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("canvas-live-viewport", { detail: vp }));
        }
    };

    // 每次渲染后把正确 transform 写回 DOM：手势中用实时 ref 值（任何杂散重渲都不会把画布弹回旧位），否则用已提交 viewport。
    useLayoutEffect(() => {
        applyTransform(gestureActiveRef.current && nextViewportRef.current ? nextViewportRef.current : viewport);
    });

    // 提交手势结果到 React 状态（触发一次 ccp 重渲 + 视口裁剪刷新）。供触控板滑动停止的防抖定时器调用。
    const commitGesture = () => {
        if (panCommitTimerRef.current) {
            clearTimeout(panCommitTimerRef.current);
            panCommitTimerRef.current = null;
        }
        if (frameRef.current) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        const next = nextViewportRef.current;
        gestureActiveRef.current = false;
        nextViewportRef.current = null;
        if (next) onViewportChange(next);
    };

    useEffect(() => {
        scaleRef.current = viewport.k;
    }, [viewport.k]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (panCommitTimerRef.current) clearTimeout(panCommitTimerRef.current);
        },
        [],
    );

    // 「按住某键 + 拖动 = 平移画布」。默认是空格，用户可在快捷键设置里改。
    //
    // 这个键必须和主监听器一样读同一份配置，否则它就是唯一一个改不了的快捷键。
    // 两处的「焦点在输入框就不接管」也统一用 shouldSkipShortcut——原先这里是弱化版，
    // 只查 input/textarea，漏了 select 和 contenteditable。
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (shouldSkipShortcut(event)) return;
            if (!panChords.includes(eventToChord(event))) return;
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            // 抬起时不能再要求 shouldSkipShortcut 通过：按下后焦点若移进输入框，
            // 这里收不到 keyup 就会让画布永远停在「平移中」。松开即复位，宁可多复位一次。
            if (panChords.includes(eventToChord(event))) setIsSpacePressed(false);
        };

        // 切到别的标签页时按键抬起收不到，回来时状态会卡住，补一个失焦复位。
        const handleBlur = () => setIsSpacePressed(false);

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, [panChords]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
        if (wheelTargetScrollable(target, event.deltaY)) return;

        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        // 缩放:Cmd/Ctrl+滚轮(强制),或 macOS 触摸板捏合(浏览器发 wheel 且 ctrlKey===true)。
        const isZoomGesture = event.ctrlKey || event.metaKey;

        // 触摸板双指滑动启发式:像素级(deltaMode===0)且具备触摸板特征
        // (有横向分量 / 纵向非整数 / 纵向幅度很小)。否则视为鼠标滚轮 → 缩放。
        const isTrackpadPan =
            !isZoomGesture &&
            event.deltaMode === 0 &&
            (event.deltaX !== 0 || !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 50);

        if (isTrackpadPan) {
            // 平移:内容跟手指走(双指上滑 → 内容上移)。wheel 已 passive:false,可 preventDefault。
            event.preventDefault();
            const base = nextViewportRef.current ?? viewport;
            gestureActiveRef.current = true;
            nextViewportRef.current = {
                x: base.x - event.deltaX,
                y: base.y - event.deltaY,
                k: scaleRef.current,
            };
            // 触控板 wheel 无明确结束事件：滑动停 ~140ms 后提交一次到 React 状态（刷新视口裁剪）。
            if (panCommitTimerRef.current) clearTimeout(panCommitTimerRef.current);
            panCommitTimerRef.current = setTimeout(commitGesture, 140);
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                // 只改 DOM transform（不 setViewport）：平移全程 ccp 不重渲。
                if (nextViewportRef.current) applyTransform(nextViewportRef.current);
            });
            return;
        }

        // 缩放(鼠标滚轮 / Cmd / 捏合):以光标为锚点,走 imperative(与平移一致)——
        // 连续滚轮/捏合期间只改 DOM transform,停 ~140ms 才提交一次 setViewport(刷新视口裁剪)。
        // 取消可能挂起的平移 RAF,并用其累积的实时视口做锚点基准(避免用旧坐标算错)。
        if (frameRef.current) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
        const base = nextViewportRef.current ?? viewport;

        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const newScale = Math.min(Math.max(base.k * factor, 0.05), 5);

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - base.x) / base.k;
        const worldY = (mouseY - base.y) / base.k;

        gestureActiveRef.current = true;
        nextViewportRef.current = {
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        };
        scaleRef.current = newScale; // 立即同步,若缩放中途切平移分支用到正确的 k
        if (panCommitTimerRef.current) clearTimeout(panCommitTimerRef.current);
        panCommitTimerRef.current = setTimeout(commitGesture, 140);
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            if (nextViewportRef.current) applyTransform(nextViewportRef.current);
        });
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id],[data-group-id]");

        // 中键(button===1)或 空格+左键 = 平移画布(pan)
        // 中键在浏览器有 autoscroll / 新标签等默认行为,务必 preventDefault
        if (event.button === 1 || (event.button === 0 && isSpacePressed && isBackgroundClick)) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            if (panCommitTimerRef.current) {
                clearTimeout(panCommitTimerRef.current);
                panCommitTimerRef.current = null;
            }
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: viewport.x,
                initialY: viewport.y,
                hasMoved: false,
            };
            gestureActiveRef.current = true;
            nextViewportRef.current = { x: viewport.x, y: viewport.y, k: scaleRef.current };
            document.body.style.cursor = "grabbing";
            return;
        }

        // 左键(button===0)在空白处 = 框选节点(rubber-band)/ 单击取消选中
        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
            return;
        }
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            nextViewportRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: scaleRef.current,
            };
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                // 拖动过程只改 DOM transform（不 setViewport）→ 平移全程 ccp 零重渲。
                if (nextViewportRef.current) applyTransform(nextViewportRef.current);
            });
        };

        const handlePointerUp = () => {
            if (!panState.current.isPanning) return;
            panState.current.isPanning = false;
            document.body.style.cursor = "default";
            const moved = panState.current.hasMoved;
            if (frameRef.current) {
                cancelAnimationFrame(frameRef.current);
                frameRef.current = null;
            }
            const next = nextViewportRef.current;
            gestureActiveRef.current = false;
            nextViewportRef.current = null;
            // 松手才把最终视口提交到 React 状态（一次重渲刷新视口裁剪）；未移动则视为单击 → 取消选中。
            if (moved) {
                if (next) onViewportChange(next);
            } else {
                onCanvasDeselect?.();
            }
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
        };
    }, [onCanvasDeselect, onViewportChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (wheelTargetScrollable(target, event.deltaY)) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        // 全局拦截捏合手势（ctrlKey 的 wheel）：光标落在固定 UI（左下/右上工具栏、侧栏等）上做捏合时，
        // 事件不经画布容器，浏览器会缩放整个页面把 UI 顶跑——这里在 document 层兜底阻止页面缩放。
        const preventPageZoom = (event: WheelEvent) => {
            if (event.ctrlKey) event.preventDefault();
        };
        document.addEventListener("wheel", preventPageZoom, { passive: false });
        return () => {
            container.removeEventListener("wheel", preventWheelScroll);
            document.removeEventListener("wheel", preventPageZoom);
        };
    }, [containerRef]);

    return (
        <div
            ref={containerRef}
            className={`relative h-full w-full select-none overflow-hidden ${isSpacePressed ? "cursor-grab" : "cursor-default"}`}
            style={{ background: theme.canvas.background }}
            onPointerDown={handlePointerDown}
            onDoubleClick={(event) => {
                const target = event.target instanceof Element ? event.target : null;
                // 仅画布空白处双击触发（节点/连线/菜单内的双击有各自用途）
                if (target?.closest("[data-node-id],[data-connection-id],[data-group-id],[data-connection-create-menu]")) return;
                onCanvasDoubleClick?.(event.clientX, event.clientY);
            }}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewport} mode={backgroundMode} gridRef={gridRef} />
            {/* 世界容器:节点/组框随缩放平移。显式 zIndex:0 把整个缩放层固定在最低层级,
                保证外层固定 UI(右上 header z-50 / 左下悬浮框 z-40 / 选区·悬停工具栏)永远盖在画布内容之上,
                不会因缩放后节点变大或其内部高 z-index 元素而被遮挡。固定 UI 本就在本容器外(section 层),不随缩放。
                transform 由 useLayoutEffect 权威写入（手势中用实时 ref、否则用 viewport）；这里的 style 仅作首帧初值。 */}
            <div
                ref={worldRef}
                className="absolute origin-top-left"
                style={{
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
                    zIndex: 0,
                }}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ viewport, mode, gridRef }: { viewport: ViewportTransform; mode: CanvasBackgroundMode; gridRef: React.RefObject<HTMLDivElement | null> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            ref={gridRef}
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
