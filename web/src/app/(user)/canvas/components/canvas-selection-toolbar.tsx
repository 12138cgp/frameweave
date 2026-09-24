"use client";

import { useState } from "react";
import { Tooltip } from "antd";
import { ArrowDownUp, Grid3x3, ImagePlus, LayoutGrid, RefreshCw, ScanFace, Scissors, Video } from "@/components/icons";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "../types";
import type { SortMode } from "../utils/canvas-sort-layout";

const SORT_ITEMS: { mode: SortMode; label: string }[] = [
    { mode: "grid", label: "网格整理" },
    { mode: "type", label: "按类型分区" },
    { mode: "lineage", label: "按连线族谱" },
    { mode: "name", label: "按名称编号" },
];

export type SelectionToolbarBounds = {
    // 选区世界包围盒（已含成员，未含 padding）
    left: number;
    top: number;
    width: number;
};

type CanvasSelectionToolbarProps = {
    bounds: SelectionToolbarBounds | null;
    viewport: ViewportTransform;
    // 画布可视区尺寸：用于把工具栏夹在视口内，避免极端缩放/平移时被 section 的 overflow-hidden 裁掉
    viewportSize?: { width: number; height: number };
    // "group"：可打组（多选且不全在同一组）；"ungroup"：选中归属某组，可解组
    mode: "group" | "ungroup" | null;
    onGroup: () => void;
    onUngroup: () => void;
    // 组内排序（仅 ungroup 模式，即选中已在同一组时显示）：4 模式下拉，复用画布 computeSortLayout
    onSortMode?: (mode: SortMode) => void;
    // 阶段5：组内有待生成图片/视频节点时分别亮起
    canGenerateImage?: boolean;
    canGenerateVideo?: boolean;
    onAutoGenerateImage?: () => void;
    onAutoGenerateVideo?: () => void;
    // 拼合：选中 ≥2 张图片时亮起，把它们按位置网格无缝拼成一张图（切图的逆操作）
    canCombineGrid?: boolean;
    onCombineGrid?: () => void;
    // 整组一键肖像授权：组内有「已出图、未认证」的图片、且火山肖像授权已开启时亮起
    canFaceAuth?: boolean;
    onAuthGroupPortrait?: () => void;
    // 批量生成：按【当前选中集】算（不是整组），成组与否都显示。
    //   regenCount = 选中里已出内容、可重跑的节点数；emptyGenCount = 选中里还没内容、可生成的节点数
    regenCount?: number;
    emptyGenCount?: number;
    onBatchGenerate?: (mode: "regen-new" | "regen-overwrite" | "empty") => void;
};

export function CanvasSelectionToolbar({ bounds, viewport, viewportSize, mode, onGroup, onUngroup, onSortMode, canGenerateImage, canGenerateVideo, onAutoGenerateImage, onAutoGenerateVideo, canCombineGrid, onCombineGrid, canFaceAuth, onAuthGroupPortrait, regenCount = 0, emptyGenCount = 0, onBatchGenerate }: CanvasSelectionToolbarProps) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const [sortOpen, setSortOpen] = useState(false);
    const [batchOpen, setBatchOpen] = useState(false);

    if (!bounds || !mode) return null;

    // 浮在选区顶边上方中央，跟随视口缩放/平移。与 CanvasNodeHoverToolbar 同一套换算。
    const centerWorldX = bounds.left + bounds.width / 2;
    const rawLeft = viewport.x + centerWorldX * viewport.k;
    // 名字标签随节点缩放贴在节点顶上方,工具栏底边再上抬这段(随 k)避免放大盖住组内节点名字(与节点工具栏一致)。
    const rawTop = viewport.y + bounds.top * viewport.k - 16 - 29 * viewport.k;
    // 与 CanvasNodeHoverToolbar 一致：不做水平夹紧（否则靠近视口边缘的选区，工具栏会被拉回视口内、脱离选区漂移），
    // 始终钉在选区水平中心；垂直只保留“别被顶部裁掉”的下保护。
    const left = rawLeft;
    const top = viewportSize ? Math.max(rawTop, 8) : rawTop;
    const isGrouped = mode === "ungroup";
    // 与节点悬浮工具栏一致：缩到 40% 以下按比例缩小(下限 0.5)，正常缩放保持固定大小。
    const uiScale = viewport.k / 0.9;

    return (
        <div
            className="anim-pop pointer-events-auto absolute z-[75] flex items-center gap-1 rounded-full border px-1.5 py-1 backdrop-blur-md"
            style={{
                left,
                top,
                // 定位用独立 translate/scale 属性而非 transform：anim-pop(paper-pop-in) 动画会动 transform 并以 fill:both 钉死成 scale(1)，
                // 若写进 transform 会被它整个覆盖（实测 computed transform 退化成单位矩阵 → 工具栏不居中、偏半个身位、缩放失效）。与 CanvasNodeHoverToolbar 同款写法。
                translate: "-50% -100%",
                scale: `${uiScale}`,
                transformOrigin: "center bottom",
                background: theme.toolbar.panel,
                borderColor: theme.toolbar.border,
                color: theme.node.text,
                boxShadow: colorTheme === "dark" ? "0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.35)" : "0 1px 2px rgba(15,23,42,.06), 0 10px 30px rgba(15,23,42,.12)",
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {isGrouped ? (
                <>
                    <ToolbarButton title="解组" label="解组" icon={<Scissors className="size-4" />} onClick={onUngroup} theme={theme} />
                    <div className="relative">
                        <ToolbarButton title="组内排序（4 模式）" label="排序" icon={<ArrowDownUp className="size-4" />} onClick={() => setSortOpen((value) => !value)} theme={theme} />
                        {sortOpen ? (
                            <div className="absolute left-1/2 top-full z-10 mt-1.5 flex -translate-x-1/2 flex-col overflow-hidden rounded-xl border py-1 shadow-[0_10px_30px_rgba(0,0,0,.25)]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                                {SORT_ITEMS.map((item) => (
                                    <button key={item.mode} type="button" onClick={() => { onSortMode?.(item.mode); setSortOpen(false); }} className="whitespace-nowrap px-3.5 py-1.5 text-left text-[13px] font-medium transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }}>
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </div>
                    {canGenerateImage ? <ToolbarButton title="生成组内待出图节点" label="一键生图" icon={<ImagePlus className="size-4" />} onClick={onAutoGenerateImage} theme={theme} /> : null}
                    {canGenerateVideo ? <ToolbarButton title="生成组内待出视频节点（上游图未就绪会跳过）" label="一键生视频" icon={<Video className="size-4" />} onClick={onAutoGenerateVideo} theme={theme} /> : null}
                    {canFaceAuth ? <ToolbarButton title="把组内图片一键提交火山肖像授权（用作真人风格视频参考）" label="一键肖像授权" icon={<ScanFace className="size-4" />} onClick={onAuthGroupPortrait} theme={theme} /> : null}
                </>
            ) : (
                <ToolbarButton title="打组" label="打组" icon={<LayoutGrid className="size-4" />} onClick={onGroup} theme={theme} />
            )}
            {canCombineGrid ? <ToolbarButton title="把选中的多张图片拼合成一张网格图" label="拼合" icon={<Grid3x3 className="size-4" />} onClick={onCombineGrid} theme={theme} /> : null}
            {regenCount + emptyGenCount > 0 ? (
                <div className="relative">
                    <ToolbarButton title="对选中的节点批量生成（会二次确认）" label="批量生成" icon={<RefreshCw className="size-4" />} onClick={() => setBatchOpen((value) => !value)} theme={theme} />
                    {batchOpen ? (
                        <div className="absolute left-1/2 top-full z-10 mt-1.5 flex -translate-x-1/2 flex-col overflow-hidden rounded-xl border py-1 shadow-[0_10px_30px_rgba(0,0,0,.25)]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                            {regenCount > 0 ? (
                                <button type="button" onClick={() => { onBatchGenerate?.("regen-new"); setBatchOpen(false); }} className="whitespace-nowrap px-3.5 py-1.5 text-left text-[13px] font-medium transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }}>
                                    重出到新节点（{regenCount}）
                                </button>
                            ) : null}
                            {regenCount > 0 ? (
                                <button type="button" onClick={() => { onBatchGenerate?.("regen-overwrite"); setBatchOpen(false); }} className="whitespace-nowrap px-3.5 py-1.5 text-left text-[13px] font-medium transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }}>
                                    重出并覆盖原节点（{regenCount}）
                                </button>
                            ) : null}
                            {emptyGenCount > 0 ? (
                                <button type="button" onClick={() => { onBatchGenerate?.("empty"); setBatchOpen(false); }} className="whitespace-nowrap px-3.5 py-1.5 text-left text-[13px] font-medium transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }}>
                                    生成未出图的（{emptyGenCount}）
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function ToolbarButton({
    title,
    label,
    icon,
    onClick,
    disabled = false,
    theme,
}: {
    title: string;
    label: string;
    icon: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    theme: (typeof canvasThemes)["light"];
}) {
    return (
        <Tooltip title={title} placement="top">
            <button
                type="button"
                disabled={disabled}
                onClick={onClick}
                className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition ${disabled ? "cursor-not-allowed opacity-40" : "hover:bg-black/5 dark:hover:bg-white/10"}`}
                style={{ color: theme.node.text }}
            >
                {icon}
                <span>{label}</span>
            </button>
        </Tooltip>
    );
}
