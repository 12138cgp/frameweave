"use client";

import React, { useEffect, useRef, useState } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasGroup, CanvasNodeData } from "../types";

// 组背景框留白（世界坐标，固定值，缩放时随画布一起缩放）
const GROUP_PADDING = 28;

export type GroupBounds = { left: number; top: number; width: number; height: number };

// 由成员节点实时计算组包围盒 + padding。成员为空返回 null（调用方应已自动删空组）。
export function computeGroupBounds(memberNodeIds: string[], nodeById: Map<string, CanvasNodeData>): GroupBounds | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let found = false;
    for (const id of memberNodeIds) {
        const node = nodeById.get(id);
        if (!node) continue;
        found = true;
        minX = Math.min(minX, node.position.x);
        minY = Math.min(minY, node.position.y);
        maxX = Math.max(maxX, node.position.x + node.width);
        maxY = Math.max(maxY, node.position.y + node.height);
    }
    if (!found) return null;
    return {
        left: minX - GROUP_PADDING,
        top: minY - GROUP_PADDING,
        width: maxX - minX + GROUP_PADDING * 2,
        height: maxY - minY + GROUP_PADDING * 2,
    };
}

type CanvasGroupBoxProps = {
    group: CanvasGroup;
    bounds: GroupBounds;
    scale: number;
    onMouseDown: (event: React.MouseEvent, groupId: string) => void;
    onRename: (groupId: string, title: string) => void;
    onContextMenu?: (event: React.MouseEvent, groupId: string) => void;
};

export function CanvasGroupBox({ group, bounds, scale, onMouseDown, onRename, onContextMenu }: CanvasGroupBoxProps) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const stroke = group.color || theme.canvas.selectionStroke;
    const fill = group.color ? hexToSoftFill(group.color) : theme.canvas.selectionFill;

    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(group.title || "");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editing) {
            setDraft(group.title || "");
            requestAnimationFrame(() => inputRef.current?.select());
        }
    }, [editing, group.title]);

    const commit = () => {
        setEditing(false);
        onRename(group.id, draft.trim());
    };

    // 标题栏 chrome 固定屏幕尺寸：用 1/scale 抵消世界容器缩放，缩放时标题不会糊/过小。
    // 但加上限：缩到约 40% 以下不再继续放大(否则极小缩放下标签占满屏)，改为随画布一起缩小。
    const inv = Math.min(1 / scale, 2.5);

    return (
        <div
            data-group-id={group.id}
            className="absolute cursor-move rounded-2xl border-2 border-dashed transition-colors"
            style={{
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
                borderColor: stroke,
                background: fill,
                zIndex: 0,
            }}
            onMouseDown={(event) => {
                if (editing) return;
                onMouseDown(event, group.id);
            }}
            onContextMenu={(event) => onContextMenu?.(event, group.id)}
        >
            <div
                className="absolute left-0 origin-bottom-left"
                style={{ bottom: "100%", transform: `scale(${inv})`, transformOrigin: "left bottom", paddingBottom: 6 }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {editing ? (
                    <input
                        ref={inputRef}
                        autoFocus
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={commit}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") commit();
                            if (event.key === "Escape") setEditing(false);
                        }}
                        className="rounded-lg border px-2 py-1 text-[13px] font-medium outline-none"
                        style={{ background: theme.toolbar.panel, borderColor: stroke, color: theme.node.text, minWidth: 120 }}
                        placeholder="组名称"
                    />
                ) : (
                    <button
                        type="button"
                        className="anim-pop max-w-[280px] truncate rounded-lg border px-2.5 py-1 text-[13px] font-medium backdrop-blur-md transition hover:opacity-90"
                        style={{ background: theme.toolbar.panel, borderColor: stroke, color: stroke }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => setEditing(true)}
                        title="点击重命名分组"
                    >
                        {group.title?.trim() || "未命名分组"}
                    </button>
                )}
            </div>
        </div>
    );
}

// 用户自定义 #rrggbb 组色 → 低透明度填充
function hexToSoftFill(hex: string): string {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!match) return "rgba(71,85,105,.06)";
    const value = match[1];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r},${g},${b},.08)`;
}
