import axios from "axios";

import { apiGet, apiDelete } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

export type GroupAssetKind = "image" | "video" | "audio";

export type GroupAsset = {
    id: string;
    groupId: string;
    ownerUserId: string;
    ownerName: string;
    sourceCanvasName: string;
    customName: string;
    kind: GroupAssetKind;
    url: string;
    storageKey: string;
    mimeType: string;
    bytes: number;
    width: number;
    height: number;
    durationMs: number;
    portraitAssetId: string;
    portraitAssetStatus: string;
    portraitAssetUri: string;
    projectId: string;
    projectName: string;
    createdAt: string;
};

function token() {
    const value = useUserStore.getState().token;
    if (!value) throw new Error("请先登录");
    return value;
}

// 团队素材展示名：就用上传时输入的名字。
//
// 以前是「上传者·来源画布名 自定义名」三段拼接，结果自己起的名字被前缀挤到后面、还常被省略号截掉，
// 一眼扫过去全是人名和画布名，反而看不出这素材是什么。上传者/来源画布改到 hover 浮窗里显示
// （见 groupAssetSourceLabel），需要时才看。
export function groupAssetDisplayName(asset: GroupAsset) {
    const name = (asset.customName || "").trim();
    if (name) return name;
    // 没起名字的（多为早期数据/直接拖上来的）回退到原来的来源描述，至少不是一片空白
    return `${asset.ownerName || "未知"}·${asset.sourceCanvasName || "未命名画布"}`;
}

// hover 浮窗里的来源说明：谁传的、来自哪个画布、什么时候。
export function groupAssetSourceLabel(asset: GroupAsset) {
    const parts = [`上传者：${asset.ownerName || "未知"}`];
    if ((asset.sourceCanvasName || "").trim()) parts.push(`来源画布：${asset.sourceCanvasName}`);
    if ((asset.createdAt || "").trim()) parts.push(`上传时间：${asset.createdAt.replace("T", " ").slice(0, 16)}`);
    return parts.join("\n");
}

export async function listGroupAssets() {
    return apiGet<GroupAsset[]>("/api/v1/group-assets", undefined, token());
}

export type UploadGroupAssetInput = {
    blob: Blob;
    kind: GroupAssetKind;
    customName: string;
    sourceCanvasName: string;
    mimeType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    portraitAssetId?: string;
    portraitAssetStatus?: string;
    portraitAssetUri?: string;
    projectId?: string;
    fileName?: string;
};

export async function uploadGroupAsset(input: UploadGroupAssetInput) {
    const body = new FormData();
    body.append("file", input.blob, input.fileName || "asset");
    body.append("kind", input.kind);
    body.append("custom_name", input.customName);
    body.append("source_canvas_name", input.sourceCanvasName);
    if (input.mimeType) body.append("mime_type", input.mimeType);
    if (input.width) body.append("width", String(Math.round(input.width)));
    if (input.height) body.append("height", String(Math.round(input.height)));
    if (input.durationMs) body.append("duration_ms", String(Math.round(input.durationMs)));
    if (input.portraitAssetId) body.append("portrait_asset_id", input.portraitAssetId);
    if (input.portraitAssetStatus) body.append("portrait_asset_status", input.portraitAssetStatus);
    if (input.portraitAssetUri) body.append("portrait_asset_uri", input.portraitAssetUri);
    if (input.projectId) body.append("project_id", input.projectId);
    const response = await axios.post("/api/v1/group-assets", body, { headers: { Authorization: `Bearer ${token()}` }, validateStatus: () => true });
    const payload = response.data as { code?: number; data?: GroupAsset; msg?: string };
    if (!payload || payload.code !== 0 || !payload.data) throw new Error(payload?.msg || "上传到团队失败");
    return payload.data;
}

export async function deleteGroupAsset(id: string) {
    return apiDelete<{ id: string }>(`/api/v1/group-assets/${encodeURIComponent(id)}`, token());
}
