"use client";

import { useEffect, useRef, useState } from "react";

import type { CanvasNodeData, ViewportTransform } from "../types";

// 视口外这么多像素的节点也渲染标签，避免拖动/缩放时标签在边缘“弹进弹出”。
const CULL_MARGIN = 200;
// 标签贴在节点上边缘之上留出的间距（screen px，已随 uiScale 缩放）。
const GAP_PX = 6;

type NodeNameLabelLayerProps = {
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    /** 解析“自定义名或默认名”（由父组件提供）。 */
    getDisplayName: (node: CanvasNodeData) => string;
    /** 提交一个自定义名（空字符串 => 调用方恢复默认名）。 */
    onRename: (id: string, value: string) => void;
    selectedNodeIds?: Set<string>;
};

export function NodeNameLabelLayer({ nodes, viewport, viewportSize, getDisplayName, onRename, selectedNodeIds }: NodeNameLabelLayerProps): JSX.Element {
    const [editingId, setEditingId] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // 进入编辑态后自动聚焦并全选，方便直接覆盖输入。
    useEffect(() => {
        if (!editingId) return;
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.select();
    }, [editingId]);

    // 标签贴着节点一起缩放（放大画布时标签也一起变大），以画布 90% 时为基准大小，
    // 与节点悬浮工具栏 / 选区工具栏规格一致。
    const uiScale = viewport.k / 0.9;

    function commit(node: CanvasNodeData) {
        const input = inputRef.current;
        const value = input ? input.value.trim() : "";
        onRename(node.id, value);
        setEditingId(null);
    }

    function cancel() {
        setEditingId(null);
    }

    return (
        <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
            {nodes.map((node) => {
                // 世界坐标 → 屏幕坐标（与悬浮工具栏一致的视口变换）。
                const sx = viewport.x + node.position.x * viewport.k;
                const sy = viewport.y + node.position.y * viewport.k;

                // 视口剔除：屏幕左上角落在“视口范围 ± 边距”之外的节点不渲染标签。
                if (sx < -CULL_MARGIN || sx > viewportSize.width + CULL_MARGIN) return null;
                if (sy < -CULL_MARGIN || sy > viewportSize.height + CULL_MARGIN) return null;

                const isEditing = editingId === node.id;
                const isSelected = selectedNodeIds?.has(node.id) ?? false;
                const displayName = getDisplayName(node);

                return (
                    <div
                        key={node.id}
                        className="absolute"
                        style={{
                            // 锚点钉死在节点左上角(sx,sy)，并以此点为缩放原点 → 缩放时该点不动、标签零漂移。
                            left: sx,
                            top: sy,
                            transform: `scale(${uiScale})`,
                            transformOrigin: "left top",
                        }}
                    >
                        {/* 内层把标签上移到锚点之上(自身高度+间距)；位移在未缩放的局部坐标里、再由外层统一缩放，避免百分比位移与缩放不匹配导致的漂移。 */}
                        <div style={{ position: "absolute", left: 0, top: -GAP_PX, transform: "translateY(-100%)" }}>
                        {isEditing ? (
                            <input
                                ref={inputRef}
                                type="text"
                                defaultValue={displayName}
                                className="pointer-events-auto block max-w-[200px] rounded-md bg-black/70 px-2 py-1 text-[11px] leading-none text-white outline-none ring-1 ring-white/40"
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => event.stopPropagation()}
                                onDoubleClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => {
                                    // 阻止画布快捷键（Delete/Backspace/Cmd+C 等）在编辑时误触发。
                                    event.stopPropagation();
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        commit(node);
                                    } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        cancel();
                                    }
                                }}
                                onBlur={() => commit(node)}
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
                                    setEditingId(node.id);
                                }}
                            >
                                {displayName}
                            </button>
                        )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
