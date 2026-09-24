import axios from "axios";

import { apiDelete, apiGet, apiPost, compactApiParams } from "./request";

// 「收藏提示词」接口层。
//
// ⚠️ 每个调用都必须显式传 token。
// apiGet / apiPost / apiDelete 不会自动带 Authorization——这个项目没有注入 token 的拦截器。
// 漏传的后果不是「这个请求失败」那么轻：服务端返回 401 会触发全局 notifySessionExpired()，
// 用户当场被踢去登录页，而且调用处的 .catch 挡不住（notify 在 throw 之前就执行了）。
// 这不是理论风险：任何一个新增的 /api/my/* 调用漏了 token，症状都是全站「一打开画布就要重新登录」，
// 且排查时很难联想到是那个新功能引起的。新增调用请照下面的写法逐个显式传。

export type PromptFavoriteRef = {
    kind: string;
    label: string;
    text?: string;
    fileKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    // missing 服务端取不到源、没能转存成副本。展示时要标出来，别假装素材还在。
    missing?: boolean;
    sourceNodeId?: string;
    sourceStorageKey?: string;
};

export type PromptFavorite = {
    id: string;
    userId: string;
    username: string;
    groupId: string;
    groupName: string;
    canvasId: string;
    canvasTitle: string;
    sourceNodeId: string;
    kind: string;
    promptDraft: string;
    prompt: string;
    // config / styleSnapshot / references 都是服务端原样透传的 JSON 字符串，用下面的 parse* 解析。
    config: string;
    styleSnapshot: string;
    references: string;
    resultFileKey: string;
    resultMimeType: string;
    resultBytes: number;
    title: string;
    note: string;
    createdAt: string;
    updatedAt: string;
};

export type PromptFavoriteAssetInput = {
    kind: string;
    label: string;
    text?: string;
    storageKey?: string;
    url?: string;
    mimeType?: string;
    durationMs?: number;
    sourceNodeId?: string;
};

export type CreatePromptFavoritePayload = {
    canvasId: string;
    canvasTitle?: string;
    nodeId: string;
    kind: "image" | "video";
    title?: string;
    note?: string;
    promptDraft: string;
    prompt: string;
    config?: unknown;
    styleSnapshot?: unknown;
    references: PromptFavoriteAssetInput[];
    result?: PromptFavoriteAssetInput;
};

export type CreatePromptFavoriteResponse = {
    favorite: PromptFavorite;
    // missing 有几项素材没能转存成副本。>0 时要如实告诉用户，别让他以为都存下来了。
    missing: number;
};

export type PromptFavoritePage = {
    items: PromptFavorite[];
    total: number;
};

export async function createPromptFavorite(payload: CreatePromptFavoritePayload, token?: string) {
    return apiPost<CreatePromptFavoriteResponse>("/api/v1/prompt-favorites", payload, token);
}

export async function fetchMyPromptFavorites(query: { kind?: string; keyword?: string; page?: number; pageSize?: number }, token?: string) {
    return apiGet<PromptFavoritePage>("/api/v1/prompt-favorites", compactApiParams({ ...query }), token);
}

export type PromptFavoriteNodeRef = {
    id: string;
    sourceNodeId: string;
};

// fetchMyFavoriteNodes 取某画布里本人已收藏的 (收藏id, 节点id) 对，用于校正节点上的本地标记。
// 连收藏 id 一起取回是必须的——那个 id 就是「取消收藏」要用的。
export async function fetchMyFavoriteNodes(canvasId: string, token?: string) {
    return apiGet<{ nodes: PromptFavoriteNodeRef[] }>("/api/v1/prompt-favorite-nodes", { canvasId }, token);
}

export async function deletePromptFavorite(id: string, token?: string) {
    return apiDelete<{ deleted: number }>(`/api/v1/prompt-favorites/${encodeURIComponent(id)}`, token);
}

export function myPromptFavoriteFileURL(id: string, fileKey: string) {
    return `/api/v1/prompt-favorites/${encodeURIComponent(id)}/files/${encodeURIComponent(fileKey)}`;
}

// —— 管理端（仅超管）——

export async function fetchAdminPromptFavorites(query: { userId?: string; groupId?: string; kind?: string; keyword?: string; page?: number; pageSize?: number; all?: string }, token?: string) {
    return apiGet<PromptFavoritePage>("/api/admin/prompt-favorites", compactApiParams({ ...query }), token);
}

export function adminPromptFavoriteFileURL(id: string, fileKey: string) {
    return `/api/admin/prompt-favorites/${encodeURIComponent(id)}/files/${encodeURIComponent(fileKey)}`;
}

// parsePromptFavoriteRefs 解析 references。
// 脏数据一律当空数组：一条坏记录不该把整个列表炸掉。
export function parsePromptFavoriteRefs(raw: string): PromptFavoriteRef[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed as PromptFavoriteRef[];
    } catch {
        return [];
    }
}

// parsePromptFavoriteJSON 解析 config / styleSnapshot 这类透传 JSON，坏数据回 null。
export function parsePromptFavoriteJSON<T>(raw: string): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

// fetchPromptFavoriteBlob 按 URL 取收藏副本的字节。
//
// 为什么不能直接把 URL 塞进 <img src> / <video src>：这些接口要 Authorization 头，
// 而 img/video 标签发出的请求带不了头（后台那个「下载反馈日志」按钮就是踩了这个才坏掉的）。
// 项目里其它按 token 取媒体的地方也是这个套路，见 services/image-storage.ts 的 resolveImageUrl。
export async function fetchPromptFavoriteBlob(url: string, token?: string) {
    const response = await axios.get<Blob>(url, {
        responseType: "blob",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`取素材失败：HTTP ${response.status}`);
    return response.data;
}
