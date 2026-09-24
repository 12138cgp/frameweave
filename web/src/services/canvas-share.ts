"use client";

import { apiGet, apiPost } from "@/services/api/request";
import { collectStorageKeys } from "@/services/app-sync";
import { syncAppDataToCloud } from "@/services/cloud-sync";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";

export type SharedCanvasPayload = {
    code: string;
    title: string;
    project: string;
    fileKeys: string[];
    createdAt: string;
};

// 生成分享链接：先全量同步（确保画布引用的媒体已在服务器），再创建分享快照。
export async function shareCanvasProject(project: CanvasProject): Promise<string> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录");
    await syncAppDataToCloud();
    const fileKeys = collectStorageKeys(project);
    const result = await apiPost<{ code: string }>("/api/v1/canvas/share", { title: project.title, project: JSON.stringify(project), fileKeys }, token);
    return `${window.location.origin}/share/${result.code}`;
}

export async function fetchSharedCanvas(code: string): Promise<SharedCanvasPayload> {
    return apiGet<SharedCanvasPayload>(`/api/canvas/share/${encodeURIComponent(code)}`);
}

export function sharedCanvasFileUrl(code: string, storageKey: string) {
    return `/api/canvas/share/${encodeURIComponent(code)}/files/${encodeURIComponent(storageKey)}`;
}

// 复制分享的画布到当前账号（服务端深拷贝），随后做一次同步把新项目和媒体拉到本地。
// creditProjectId：接收方选的积分来源项目 id（""=个人积分），后端会覆盖副本继承的 projectId。
export async function forkSharedCanvas(code: string, creditProjectId?: string): Promise<string> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录");
    const result = await apiPost<{ projectId: string }>(`/api/v1/canvas/share/${encodeURIComponent(code)}/fork`, { projectId: creditProjectId || "" }, token);
    await syncAppDataToCloud();
    return result.projectId;
}
