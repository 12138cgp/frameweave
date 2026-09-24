"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { ArrowDownUp, Copy, FolderPlus, LayoutGrid, Link2, Plus, ScanFace, Scissors, Share2, Trash2 } from "@/components/icons";

import type { ContextMenuState } from "../types";
import type { SortMode } from "../utils/canvas-sort-layout";

export function CanvasNodeContextMenu({
    menu,
    onClose,
    onDuplicate,
    onDuplicateNoConnections,
    onDelete,
    onGroup,
    onUngroup,
    onSortMode,
    onSaveGroup,
    onAuthGroup,
    canFaceAuth = false,
    canGroup = false,
    connectSelectionCount = 0,
    onConnectSelectionIn,
    onConnectSelectionOut,
}: {
    menu: ContextMenuState;
    onClose: () => void;
    onDuplicate: () => void;
    onDuplicateNoConnections: () => void;
    onDelete: () => void;
    onGroup?: () => void;
    onUngroup?: () => void;
    onSortMode?: (mode: SortMode) => void;
    onSaveGroup?: () => void;
    // 整组一键肖像授权：仅火山肖像授权开启时(canFaceAuth)在组菜单里出现
    onAuthGroup?: () => void;
    canFaceAuth?: boolean;
    canGroup?: boolean;
    // 批量连线：多选且右键的就是选中之一时，这两项才出现。计数已排除右键的那个节点自己。
    connectSelectionCount?: number;
    onConnectSelectionIn?: () => void;
    onConnectSelectionOut?: () => void;
}) {
    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className="anim-pop fixed z-[80] min-w-44 overflow-hidden rounded-xl border border-border bg-popover py-1 text-popover-foreground shadow-[0_16px_40px_rgba(15,23,42,.18)] dark:shadow-[0_18px_45px_rgba(0,0,0,.45)]"
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {menu.type === "node" ? <MenuButton icon={<Plus className="size-4" />} label="复制节点（含连线）" onClick={onDuplicate} /> : null}
            {menu.type === "node" ? <MenuButton icon={<Copy className="size-4" />} label="复制节点（不含连线）" onClick={onDuplicateNoConnections} /> : null}
            {menu.type === "node" && canGroup ? <MenuButton icon={<LayoutGrid className="size-4" />} label="打组" onClick={onGroup} /> : null}
            {menu.type === "node" && connectSelectionCount > 0 ? <MenuButton icon={<Link2 className="size-4" />} label={`将选中的 ${connectSelectionCount} 个节点接入此节点`} onClick={onConnectSelectionIn} /> : null}
            {menu.type === "node" && connectSelectionCount > 0 ? <MenuButton icon={<Share2 className="size-4" />} label={`此节点接出到选中的 ${connectSelectionCount} 个节点`} onClick={onConnectSelectionOut} /> : null}
            {menu.type === "group" ? (
                <>
                    <MenuButton icon={<ArrowDownUp className="size-4" />} label="网格整理" onClick={() => onSortMode?.("grid")} />
                    <MenuButton icon={<ArrowDownUp className="size-4" />} label="按类型分区" onClick={() => onSortMode?.("type")} />
                    <MenuButton icon={<ArrowDownUp className="size-4" />} label="按连线族谱" onClick={() => onSortMode?.("lineage")} />
                    <MenuButton icon={<ArrowDownUp className="size-4" />} label="按名称编号" onClick={() => onSortMode?.("name")} />
                </>
            ) : null}
            {menu.type === "group" ? <MenuButton icon={<FolderPlus className="size-4" />} label="整组存入素材" onClick={onSaveGroup} /> : null}
            {menu.type === "group" && canFaceAuth ? <MenuButton icon={<ScanFace className="size-4" />} label="一键肖像授权" onClick={onAuthGroup} /> : null}
            {menu.type === "group" ? <MenuButton icon={<Scissors className="size-4" />} label="解组" onClick={onUngroup} /> : null}
            {menu.type === "group" ? null : <MenuButton icon={<Trash2 className="size-4" />} label="删除" onClick={onDelete} danger />}
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    return (
        <button
            type="button"
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors duration-150 hover:bg-accent ${danger ? "text-[#DC2626] dark:text-[#EF4444]" : ""}`}
            onClick={onClick}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}
