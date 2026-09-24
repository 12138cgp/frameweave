import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "antd";

import { ShortcutSettingsModal } from "@/components/shortcut-settings-modal";
import {
    AlignCenterHorizontal,
    AlignCenterVertical,
    AlignEndHorizontal,
    AlignEndVertical,
    AlignHorizontalDistributeCenter,
    AlignStartHorizontal,
    AlignStartVertical,
    AlignVerticalDistributeCenter,
    ArrowDownUp,
    ChevronUp,
    Compass,
    Focus,
    HelpCircle,
    LayoutGrid,
    Minus,
    Plus,
    Redo2,
    Undo2,
} from "@/components/icons";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import type { AlignActionMode } from "../utils/canvas-alignment";
import type { SortMode } from "../utils/canvas-sort-layout";
import { useThemeStore } from "@/stores/use-theme-store";

// 左下角合并悬浮框：左半为画布导航（指南针/重置/缩放滑块/百分比/快捷键），右半为次要功能（撤销/重做/对齐），中间竖分隔线。
// 画布外观、清空 → 右上角 header；添加节点、上传素材、分镜故事板 → 双击空白菜单；素材库、我的素材 → 右侧侧栏。
export function CanvasToolbar({
    selectedCount,
    onAlign,
    onSort,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    scale,
    onScaleChange,
    onReset,
    isMiniMapOpen,
    onToggleMiniMap,
}: {
    selectedCount: number;
    onAlign: (mode: AlignActionMode) => void;
    onSort: (mode: SortMode) => void;
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
    scale: number;
    onScaleChange: (scale: number) => void;
    onReset: () => void;
    isMiniMapOpen: boolean;
    onToggleMiniMap: () => void;
}) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const [hovered, setHovered] = useState<string | null>(null);
    const [tipX, setTipX] = useState(0);
    const [alignOpen, setAlignOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [alignPanelX, setAlignPanelX] = useState(0);
    const [zoomOpen, setZoomOpen] = useState(false);
    const [zoomPanelX, setZoomPanelX] = useState(0);
    const zoomMenuRef = useRef<HTMLDivElement>(null);
    const [sortOpen, setSortOpen] = useState(false);
    const [sortPanelX, setSortPanelX] = useState(0);
    const sortMenuRef = useRef<HTMLDivElement>(null);
    const canAlign = selectedCount >= 2;
    // 排序范围提示:选中 ≥2 个则只排选中,否则排整个画布(用 if/else 派生,不写语句级三元,规避 bun SSG SIGILL)
    let sortScopeHint = "整个画布";
    if (selectedCount >= 2) sortScopeHint = "仅排选中的 " + selectedCount + " 个";

    useEffect(() => {
        if (!canAlign) setAlignOpen(false);
    }, [canAlign]);

    useEffect(() => {
        if (!zoomOpen) return;
        const onDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (wrapRef.current?.contains(target) || zoomMenuRef.current?.contains(target)) return;
            setZoomOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [zoomOpen]);

    useEffect(() => {
        if (!sortOpen) return;
        const onDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (wrapRef.current?.contains(target) || sortMenuRef.current?.contains(target)) return;
            setSortOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [sortOpen]);

    const dockStyle = { background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item, boxShadow: colorTheme === "dark" ? "0 18px 45px rgba(0,0,0,.38)" : "0 16px 40px rgba(15,23,42,.12)" };
    const hoverStyle = { background: theme.toolbar.itemHover, color: theme.toolbar.activeText };
    const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };
    const tip = hovered ? toolLabel(hovered) : "";

    return (
        <div className="pointer-events-none absolute bottom-[calc(1.25rem+var(--app-banner-h,0px))] left-5 z-40 flex justify-start" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            {tip ? <DockTip label={tip} x={tipX} /> : null}
            <div ref={wrapRef} className="anim-rise pointer-events-auto flex h-12 items-center gap-1 rounded-full border px-2.5 backdrop-blur [&>*]:shrink-0" style={dockStyle}>
                <Tooltip title={isMiniMapOpen ? "关闭小地图" : "打开小地图"}>
                    <Button
                        type="text"
                        className="!h-8 !w-8 !min-w-8 !p-0"
                        style={isMiniMapOpen ? activeStyle : { color: theme.toolbar.item }}
                        icon={<Compass className="size-4.5" />}
                        onClick={onToggleMiniMap}
                        aria-label={isMiniMapOpen ? "关闭小地图" : "打开小地图"}
                    />
                </Tooltip>
                <Tooltip title="重置视图">
                    <Button type="text" className="!h-8 !w-8 !min-w-8 !p-0" style={{ color: theme.toolbar.item }} icon={<Focus className="size-4.5" />} onClick={onReset} aria-label="重置视图" />
                </Tooltip>
                <Tooltip title="缩小">
                    <Button
                        type="text"
                        className="!h-8 !w-8 !min-w-8 !p-0"
                        style={{ color: theme.toolbar.item }}
                        icon={<Minus className="size-4.5" />}
                        onClick={() => onScaleChange(Math.max(0.05, scale / 1.25))}
                        aria-label="缩小"
                    />
                </Tooltip>
                <Tooltip title="缩放">
                    <Button
                        type="text"
                        className="!h-8 !min-w-0 !px-2"
                        style={zoomOpen ? activeStyle : { color: theme.toolbar.item }}
                        onClick={(event) => {
                            setSortOpen(false);
                            setAlignOpen(false);
                            setZoomPanelX(getTipX(wrapRef.current, event.currentTarget));
                            setZoomOpen((value) => !value);
                        }}
                        aria-label="缩放"
                    >
                        <span className="flex items-center gap-0.5 text-xs tabular-nums">
                            {Math.round(scale * 100)}%
                            <ChevronUp className={`size-3.5 transition-transform ${zoomOpen ? "" : "rotate-180"}`} />
                        </span>
                    </Button>
                </Tooltip>
                <Tooltip title="放大">
                    <Button
                        type="text"
                        className="!h-8 !w-8 !min-w-8 !p-0"
                        style={{ color: theme.toolbar.item }}
                        icon={<Plus className="size-4.5" />}
                        onClick={() => onScaleChange(Math.min(5, scale * 1.25))}
                        aria-label="放大"
                    />
                </Tooltip>
                <Tooltip title="快捷键">
                    <Button type="text" className="!h-8 !w-8 !min-w-8 !p-0" style={shortcutsOpen ? activeStyle : { color: theme.toolbar.item }} icon={<HelpCircle className="size-4.5" />} onClick={() => setShortcutsOpen(true)} aria-label="快捷键" />
                </Tooltip>
                <Divider theme={theme} />
                <ToolbarButton id="tool-undo" label="撤销" disabled={!canUndo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onUndo}>
                    <Undo2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-redo" label="重做" disabled={!canRedo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onRedo}>
                    <Redo2 className="size-4.5" />
                </ToolbarButton>
                <Divider theme={theme} />
                <ToolbarButton
                    id="tool-align"
                    label="对齐"
                    disabled={!canAlign}
                    active={alignOpen}
                    hovered={hovered}
                    activeStyle={activeStyle}
                    hoverStyle={hoverStyle}
                    wrapRef={wrapRef}
                    onTipX={setTipX}
                    onHover={setHovered}
                    onClick={(event) => {
                        if (!canAlign) return;
                        setZoomOpen(false);
                        setSortOpen(false);
                        setAlignPanelX(getTipX(wrapRef.current, event.currentTarget));
                        setAlignOpen((value) => !value);
                    }}
                >
                    <LayoutGrid className="size-4.5" />
                </ToolbarButton>
                <Divider theme={theme} />
                <ToolbarButton
                    id="tool-sort"
                    label="排序"
                    active={sortOpen}
                    hovered={hovered}
                    activeStyle={activeStyle}
                    hoverStyle={hoverStyle}
                    wrapRef={wrapRef}
                    onTipX={setTipX}
                    onHover={setHovered}
                    onClick={(event) => {
                        setZoomOpen(false);
                        setAlignOpen(false);
                        setSortPanelX(getTipX(wrapRef.current, event.currentTarget));
                        setSortOpen((value) => !value);
                    }}
                >
                    <ArrowDownUp className="size-4.5" />
                </ToolbarButton>
            </div>

            {alignOpen && canAlign ? (
                <div
                    className="paper-card anim-pop pointer-events-auto absolute bottom-[64px] z-30 w-max -translate-x-1/2 p-2.5"
                    style={{ left: alignPanelX || "50%", color: theme.toolbar.item }}
                >
                    <div className="px-1 pb-2 text-sm font-medium opacity-65">对齐与分布</div>
                    <div className="grid grid-cols-6 gap-1">
                        <AlignButton theme={theme} hoverStyle={hoverStyle} label="左对齐" onClick={() => onAlign("left")}>
                            <AlignStartVertical className="size-4.5" />
                        </AlignButton>
                        <AlignButton theme={theme} hoverStyle={hoverStyle} label="水平居中" onClick={() => onAlign("center-x")}>
                            <AlignCenterVertical className="size-4.5" />
                        </AlignButton>
                        <AlignButton theme={theme} hoverStyle={hoverStyle} label="右对齐" onClick={() => onAlign("right")}>
                            <AlignEndVertical className="size-4.5" />
                        </AlignButton>
                        <AlignButton theme={theme} hoverStyle={hoverStyle} label="顶对齐" onClick={() => onAlign("top")}>
                            <AlignStartHorizontal className="size-4.5" />
                        </AlignButton>
                        <AlignButton theme={theme} hoverStyle={hoverStyle} label="垂直居中" onClick={() => onAlign("center-y")}>
                            <AlignCenterHorizontal className="size-4.5" />
                        </AlignButton>
                        <AlignButton theme={theme} hoverStyle={hoverStyle} label="底对齐" onClick={() => onAlign("bottom")}>
                            <AlignEndHorizontal className="size-4.5" />
                        </AlignButton>
                        {selectedCount >= 3 ? (
                            <>
                                <AlignButton theme={theme} hoverStyle={hoverStyle} label="水平等距" onClick={() => onAlign("distribute-x")}>
                                    <AlignHorizontalDistributeCenter className="size-4.5" />
                                </AlignButton>
                                <AlignButton theme={theme} hoverStyle={hoverStyle} label="垂直等距" onClick={() => onAlign("distribute-y")}>
                                    <AlignVerticalDistributeCenter className="size-4.5" />
                                </AlignButton>
                            </>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {zoomOpen ? (
                <div
                    ref={zoomMenuRef}
                    className="paper-card anim-pop pointer-events-auto absolute bottom-[64px] z-30 w-max -translate-x-1/2 p-1.5"
                    style={{ left: zoomPanelX || "50%", color: theme.toolbar.item }}
                >
                    {/* 这两条原来标着「⌘ +」「⌘ −」，但键盘里从来没有实现过缩放快捷键，是纯误导。
                        按产品决定：去掉提示，不实现该快捷键。 */}
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="放大" hint="" onClick={() => onScaleChange(Math.min(5, scale * 1.25))} />
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="缩小" hint="" onClick={() => onScaleChange(Math.max(0.05, scale / 1.25))} />
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="适合屏幕" onClick={() => { onReset(); setZoomOpen(false); }} />
                    <div className="my-1 h-px" style={{ background: theme.toolbar.border }} />
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="缩放至 50%" onClick={() => { onScaleChange(0.5); setZoomOpen(false); }} />
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="缩放至 100%" onClick={() => { onScaleChange(1); setZoomOpen(false); }} />
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="缩放至 200%" onClick={() => { onScaleChange(2); setZoomOpen(false); }} />
                </div>
            ) : null}

            {sortOpen ? (
                <div
                    ref={sortMenuRef}
                    className="paper-card anim-pop pointer-events-auto absolute bottom-[64px] z-30 w-max -translate-x-1/2 p-1.5"
                    style={{ left: sortPanelX || "50%", color: theme.toolbar.item }}
                >
                    <div className="px-2.5 pb-1 pt-0.5 text-sm font-medium opacity-65">自动排布 · {sortScopeHint}</div>
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="网格整理" hint="收拾整齐" onClick={() => { onSort("grid"); setSortOpen(false); }} />
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="按类型分区" hint="图/视频/音频分块" onClick={() => { onSort("type"); setSortOpen(false); }} />
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="按连线族谱" hint="源→生成 分层" onClick={() => { onSort("lineage"); setSortOpen(false); }} />
                    <ZoomItem theme={theme} hoverStyle={hoverStyle} label="按名称编号" hint="按类型+序号" onClick={() => { onSort("name"); setSortOpen(false); }} />
                </div>
            ) : null}

            {/* 与用户菜单里的入口共用同一个面板：原先这里是第二份手写清单，
                和另一份内容不一致（这份没提撤销/全选，那份把框选写错了）。 */}
            <ShortcutSettingsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        </div>
    );
}

function ToolbarButton({
    id,
    label,
    active,
    hovered,
    activeStyle,
    hoverStyle,
    wrapRef,
    onTipX,
    onHover,
    onClick,
    disabled = false,
    danger = false,
    children,
}: {
    id: string;
    label: string;
    active?: boolean;
    hovered: string | null;
    activeStyle?: CSSProperties;
    hoverStyle: CSSProperties;
    wrapRef: RefObject<HTMLDivElement | null>;
    onTipX: (x: number) => void;
    onHover: (id: string | null) => void;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    disabled?: boolean;
    danger?: boolean;
    children: ReactNode;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const transition = "background-color .18s cubic-bezier(0.22,1,0.36,1), color .18s cubic-bezier(0.22,1,0.36,1), opacity .18s cubic-bezier(0.22,1,0.36,1)";
    const dangerColor = colorTheme === "dark" ? "#EF4444" : "#DC2626";

    return (
        <Button
            type="text"
            aria-label={label}
            className="!h-8 !w-8 !min-w-8 !p-0"
            disabled={disabled}
            style={{ transition, ...(active ? activeStyle : hovered === id && !disabled ? hoverStyle : { color: danger ? dangerColor : theme.toolbar.item, opacity: disabled ? 0.35 : 1 }) }}
            icon={children}
            onMouseEnter={(event) => {
                onHover(id);
                onTipX(getTipX(wrapRef.current, event.currentTarget));
            }}
            onMouseLeave={() => onHover(null)}
            onClick={onClick}
        />
    );
}

function AlignButton({ theme, hoverStyle, label, onClick, children }: { theme: CanvasTheme; hoverStyle: CSSProperties; label: string; onClick: () => void; children: ReactNode }) {
    const transition = "background-color .18s cubic-bezier(0.22,1,0.36,1), color .18s cubic-bezier(0.22,1,0.36,1)";
    return (
        <Button
            type="text"
            aria-label={label}
            title={label}
            className="!h-9 !w-9 !min-w-9 !p-0"
            style={{ transition, color: theme.toolbar.item }}
            icon={children}
            onMouseEnter={(event) => Object.assign(event.currentTarget.style, hoverStyle)}
            onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
                event.currentTarget.style.color = theme.toolbar.item;
            }}
            onClick={onClick}
        />
    );
}

function ZoomItem({ theme, hoverStyle, label, hint, onClick }: { theme: CanvasTheme; hoverStyle: CSSProperties; label: string; hint?: string; onClick: () => void }) {
    return (
        <button
            type="button"
            className="flex w-full items-center justify-between gap-8 rounded-md px-2.5 py-1.5 text-left text-sm"
            style={{ color: theme.toolbar.item }}
            onMouseEnter={(event) => Object.assign(event.currentTarget.style, hoverStyle)}
            onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
                event.currentTarget.style.color = theme.toolbar.item;
            }}
            onClick={onClick}
        >
            <span>{label}</span>
            {hint ? <span className="text-xs opacity-50">{hint}</span> : null}
        </button>
    );
}

function Divider({ theme }: { theme: CanvasTheme }) {
    return <div className="mx-0.5 h-6 w-px" style={{ background: theme.toolbar.border }} />;
}

function DockTip({ label, x }: { label: string; x: number }) {
    return (
        <span
            className="anim-fade absolute bottom-[calc(100%+8px)] -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-[0_10px_28px_rgba(15,23,42,.16)] dark:shadow-[0_12px_30px_rgba(0,0,0,.45)]"
            style={{ left: x }}
        >
            {label}
        </span>
    );
}

function toolLabel(id: string) {
    if (id === "tool-undo") return "撤销";
    if (id === "tool-redo") return "重做";
    if (id === "tool-align") return "对齐";
    if (id === "tool-sort") return "排序";
    return "";
}

function getTipX(wrap: HTMLDivElement | null, target: HTMLElement) {
    if (!wrap) return 0;
    const wrapBox = wrap.parentElement?.getBoundingClientRect() || wrap.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return box.left - wrapBox.left + box.width / 2;
}
