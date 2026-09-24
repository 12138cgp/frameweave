"use client";

import { RequireAuth } from "@/components/require-auth";
import { APP_NAME } from "@/constant/env";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { App, Button } from "antd";
import { Download, FileUp, Plus } from "@/components/icons";

import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasCreditSourceDialog } from "./components/canvas-credit-source-dialog";
import { CanvasDeleteProjectsDialog } from "./components/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "./components/canvas-project-card";
import type { CanvasExportFile } from "./export-types";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasStore, groupCanvasProjects } from "./stores/use-canvas-store";
import { useCanvasUiStore } from "./stores/use-canvas-ui-store";
import { useMyProjectsStore } from "./stores/use-my-projects-store";
import { exportCanvasProjects } from "./utils/canvas-export";

export default function CanvasPage() {
    return (
        <RequireAuth>
            <CanvasPageInner />
        </RequireAuth>
    );
}

function CanvasPageInner() {
    const { message } = App.useApp();
    const router = useRouter();
    const inputRef = useRef<HTMLInputElement>(null);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const groups = useMemo(() => groupCanvasProjects(projects), [projects]);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const [creditSourceOpen, setCreditSourceOpen] = useState(false);
    const token = useUserStore((state) => state.token);
    const refreshMyProjects = useMyProjectsStore((state) => state.refresh);
    useEffect(() => {
        if (token) void refreshMyProjects(token);
    }, [token, refreshMyProjects]);

    const enterProject = (id: string) => {
        router.push(`/canvas/${id}`);
    };
    // 新建画布前先弹「选积分来源」，选完才创建（projectId ""=个人积分）
    const createAndEnter = () => setCreditSourceOpen(true);
    const confirmCreate = (projectId: string) => {
        setCreditSourceOpen(false);
        enterProject(createProject(`${APP_NAME} ${groups.length + 1}`, projectId || undefined));
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            await Promise.all(
                data.projects.flatMap((project) =>
                    project.files.map(async (item) => {
                        const blob = zip.get(item.path);
                        if (!blob) return;
                        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                        await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                    }),
                ),
            );
            data.projects.forEach((item) => importProject(item.project));
            message.success(`已导入 ${data.projects.length} 个画布`);
        } catch {
            message.error("导入失败，请选择有效的画布压缩包");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="anim-rise flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">画布库</p>
                        <h1 className="font-heading mt-3 text-3xl font-medium tracking-wide">{APP_NAME}</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `${APP_NAME}-${selectedIds.length}个项目`)}>
                                    导出选中
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    删除选中
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                删除全部
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            导入画布
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </div>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">正在加载画布...</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {groups.map((group, index) => (
                            <div key={group.groupId} className="anim-rise" style={{ "--rise-delay": `${Math.min(index, 12) * 40}ms` } as CSSProperties}>
                                <CanvasProjectCard group={group} />
                            </div>
                        ))}
                    </div>
                ) : (
                    <section className="anim-rise flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="font-heading text-xl font-medium tracking-wide">还没有画布</h2>
                        <p className="mt-3 text-sm text-stone-500">新建一个画布后，就可以独立保存节点、连线和画布外观。</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            新建画布
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasCreditSourceDialog open={creditSourceOpen} onCancel={() => setCreditSourceOpen(false)} onConfirm={confirmCreate} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
