"use client";

import { useEffect, useMemo, useState } from "react";
import { Empty, Modal, Segmented } from "antd";
import { Check, FileText, Music2, Settings2, Video } from "@/components/icons";

import { useCanvasStore, canvasGroupIdOf } from "../stores/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";

// 「从其它子画布复制节点」：选一个同项目的兄弟子画布 → 勾选要复制的节点 → 复制到当前画布。
// 实际插入复用父组件的 onCopy（内部走 clipboardRef + pasteCopiedNodes，重映射 id / 偏移 / 去重命名全复用）。
export function CanvasCopyFromSiblingDialog({
    open,
    onClose,
    currentId,
    onCopy,
}: {
    open: boolean;
    onClose: () => void;
    currentId: string;
    onCopy: (nodes: CanvasNodeData[], connections: CanvasConnection[]) => void;
}) {
    const projects = useCanvasStore((state) => state.projects);
    const current = projects.find((project) => project.id === currentId);
    const groupId = current ? canvasGroupIdOf(current) : "";
    const siblings = useMemo(
        () => projects.filter((project) => canvasGroupIdOf(project) === groupId && project.id !== currentId).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")),
        [projects, groupId, currentId],
    );

    const [sourceId, setSourceId] = useState("");
    const [picked, setPicked] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (!open) return;
        const stillValid = sourceId && siblings.some((sib) => sib.id === sourceId);
        setSourceId(stillValid ? sourceId : siblings[0]?.id || "");
        setPicked(new Set());
        // 仅在「打开」时设默认来源 + 清空勾选；绝不随后台云同步导致的 projects/siblings 刷新而重跑，
        // 否则每次同步都会清掉用户已勾选的节点。切换来源子画布由 Segmented 的 onChange 单独清空。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const source = siblings.find((sib) => sib.id === sourceId);
    const sourceNodes = source?.nodes || [];

    const toggle = (id: string) => {
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };
    const toggleAll = () => setPicked((prev) => (prev.size === sourceNodes.length ? new Set() : new Set(sourceNodes.map((node) => node.id))));

    const confirm = () => {
        if (!source) return;
        const nodes = sourceNodes.filter((node) => picked.has(node.id));
        if (!nodes.length) return;
        const ids = new Set(nodes.map((node) => node.id));
        const connections = (source.connections || []).filter((conn) => ids.has(conn.fromNodeId) && ids.has(conn.toNodeId));
        onCopy(nodes, connections);
        onClose();
    };

    const allPicked = sourceNodes.length > 0 && picked.size === sourceNodes.length;
    const selectAllLabel = allPicked ? "取消全选" : "全选";

    return (
        <Modal
            open={open}
            title="从其它子画布复制节点"
            onOk={confirm}
            onCancel={onClose}
            okText={`复制 ${picked.size} 个节点到当前画布`}
            okButtonProps={{ disabled: picked.size === 0 }}
            cancelText="取消"
            width={680}
            destroyOnHidden
        >
            {siblings.length === 0 ? (
                <Empty description="这个项目还没有其它子画布" />
            ) : (
                <div className="space-y-3">
                    <Segmented
                        block
                        value={sourceId}
                        onChange={(value) => {
                            setSourceId(value as string);
                            setPicked(new Set());
                        }}
                        options={siblings.map((sib) => ({ label: sib.title || "未命名子画布", value: sib.id }))}
                    />
                    {sourceNodes.length === 0 ? (
                        <Empty description="该子画布还没有节点" />
                    ) : (
                        <>
                            <button type="button" className="text-xs text-[#2563EB] hover:underline dark:text-[#3B82F6]" onClick={toggleAll}>
                                {selectAllLabel}（共 {sourceNodes.length} 个节点）
                            </button>
                            <div className="grid max-h-[52vh] grid-cols-3 gap-2 overflow-auto sm:grid-cols-4">
                                {sourceNodes.map((node) => (
                                    <SiblingNodeItem key={node.id} node={node} checked={picked.has(node.id)} onToggle={() => toggle(node.id)} />
                                ))}
                            </div>
                        </>
                    )}
                </div>
            )}
        </Modal>
    );
}

function SiblingNodeItem({ node, checked, onToggle }: { node: CanvasNodeData; checked: boolean; onToggle: () => void }) {
    const content = node.metadata?.content;
    const isImage = node.type === CanvasNodeType.Image && Boolean(content);
    const cardClass = checked
        ? "relative block overflow-hidden rounded-lg border-2 border-[#2563EB] text-left transition dark:border-[#3B82F6]"
        : "relative block overflow-hidden rounded-lg border border-border text-left transition hover:border-stone-400";
    const Icon = node.type === CanvasNodeType.Video ? Video : node.type === CanvasNodeType.Audio ? Music2 : node.type === CanvasNodeType.Config ? Settings2 : FileText;

    return (
        <button type="button" onClick={onToggle} className={cardClass}>
            {isImage ? (
                <img src={content} alt={node.title} className="aspect-square w-full object-cover" loading="lazy" />
            ) : (
                <div className="flex aspect-square w-full items-center justify-center bg-stone-100 dark:bg-stone-800">
                    <Icon className="size-7 opacity-40" />
                </div>
            )}
            <div className="truncate px-1.5 py-1 text-[11px] text-stone-700 dark:text-stone-200">{node.title || node.type}</div>
            {checked ? (
                <span className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-[#2563EB] text-white dark:bg-[#3B82F6]">
                    <Check className="size-3.5" />
                </span>
            ) : null}
        </button>
    );
}
