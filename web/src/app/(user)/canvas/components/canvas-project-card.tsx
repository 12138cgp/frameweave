"use client";

import { Check, Download, FolderKanban, Layers, Pencil, Trash2, X } from "@/components/icons";
import { useRouter } from "next/navigation";
import { Button, Input } from "antd";
import { APP_NAME } from "@/constant/env";

import { useCanvasStore, type ProjectGroup } from "../stores/use-canvas-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";
import { useMyProjectsStore } from "../stores/use-my-projects-store";
import { exportCanvasProjects } from "../utils/canvas-export";

// 列表页每张卡 = 一个「画布项目」（一组共享 canvasGroupId 的子画布）。
// 点开进入该项目最近更新的子画布；重命名/删除/导出/选择均作用于整组。
export function CanvasProjectCard({ group }: { group: ProjectGroup }) {
    const router = useRouter();
    const renameGroup = useCanvasStore((state) => state.renameGroup);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const myProjects = useMyProjectsStore((state) => state.projects);
    const sourceProject = group.projectId ? myProjects.find((item) => item.id === group.projectId) : undefined;

    const editing = editingId === group.groupId;
    const canvasIds = group.canvases.map((canvas) => canvas.id);
    const selected = canvasIds.length > 0 && canvasIds.every((id) => selectedIds.includes(id));
    const subCount = group.canvases.length;
    const open = () => router.push(`/canvas/${group.representative.id}`);
    const saveTitle = () => {
        renameGroup(group.groupId, editingTitle);
        stopEditing();
    };
    const toggleAll = (checked: boolean) => canvasIds.forEach((id) => toggleSelected(id, checked));

    return (
        <article className="paper-card hover-lift group flex h-full min-h-44 cursor-pointer flex-col justify-between p-5" onClick={() => !editing && open()}>
            <div className="flex items-start gap-3">
                <input
                    type="checkbox"
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => toggleAll(event.target.checked)}
                    className="mt-1 size-4 accent-[#2563EB] dark:accent-[#3B82F6]"
                    aria-label={`选择 ${group.groupTitle}`}
                />
                {editing ? (
                    <Input className="min-w-0" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveTitle()} autoFocus />
                ) : (
                    <button
                        type="button"
                        className="min-w-0 cursor-pointer text-left"
                        onClick={(event) => {
                            event.stopPropagation();
                            open();
                        }}
                    >
                        <h2 className="font-heading truncate text-xl font-medium tracking-wide">{group.groupTitle}</h2>
                        <p className="mt-3 flex flex-wrap items-center gap-x-2 text-sm leading-6 text-stone-600 dark:text-stone-400">
                            {subCount > 1 ? (
                                <span className="inline-flex items-center gap-1 text-[#2563EB] dark:text-[#3B82F6]">
                                    <Layers className="size-3.5" />
                                    {subCount} 个子画布
                                </span>
                            ) : null}
                            <span>{group.totalNodes} 个节点</span>
                        </p>
                        {group.projectId ? (
                            <span className="mt-2 inline-flex max-w-full items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs text-stone-600 dark:text-stone-300">
                                <FolderKanban className="size-3 shrink-0" />
                                <span className="truncate">{sourceProject ? sourceProject.name : "项目"}</span>
                            </span>
                        ) : (
                            <span className="mt-2 inline-flex items-center rounded-md px-2 py-0.5 text-xs text-stone-400 dark:text-stone-500">个人积分</span>
                        )}
                    </button>
                )}
            </div>
            <div className="mt-8 flex items-end justify-between gap-3">
                <p className="text-xs text-stone-500">更新于 {new Date(group.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <Button type="text" size="small" shape="circle" className="hover:!bg-accent" icon={<Check className="size-4" />} onClick={saveTitle} aria-label="保存名称" />
                            <Button type="text" size="small" shape="circle" className="hover:!bg-accent" icon={<X className="size-4" />} onClick={stopEditing} aria-label="取消重命名" />
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" className="hover:!bg-accent" icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(group.canvases, group.groupTitle || APP_NAME)} aria-label="导出项目" />
                            <Button type="text" size="small" shape="circle" className="hover:!bg-accent" icon={<Pencil className="size-4" />} onClick={() => startEditing(group.groupId, group.groupTitle)} aria-label="重命名项目" />
                            <Button type="text" size="small" shape="circle" className="hover:!bg-accent" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds(canvasIds)} aria-label="删除项目" />
                        </>
                    )}
                </div>
            </div>
        </article>
    );
}
