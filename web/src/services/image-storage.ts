"use client";

import localforage from "localforage";
import { LOCAL_DB_NAME } from "@/constant/env";

import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import { useUserStore } from "@/stores/use-user-store";
import { pushMediaToCloud } from "@/services/media-uplink";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: LOCAL_DB_NAME, storeName: "image_files" });
const objectUrls = new Map<string, string>();
// 同一 storageKey 的并发解析去重：进画布时「后台水合」与「节点 onError 自愈」可能同时解析同一图片，
// 不去重则各自 fetch 一遍（重复下载）+ 各自 createObjectURL（rememberObjectUrl 撤销竞态）。
const inflight = new Map<string, Promise<string>>();

// 同一 storageKey 重新生成 Object URL 时，先释放旧 URL，避免内存泄漏
function rememberObjectUrl(key: string, url: string) {
    const prev = objectUrls.get(key);
    if (prev && prev !== url) URL.revokeObjectURL(prev);
    objectUrls.set(key, url);
}

// imageStringToBlob 把 data:/blob:/http(s) 图片地址取成 blob。
// data:/blob: 直接 fetch(同源、无 CORS)。远端 http(s)(部分 gpt-image 中转图床，
// 常不发 CORS 头，浏览器直取被拦成 "Failed to fetch")→ 先试直取，失败(CORS/网络)则走服务端转存
// (server 抓图存进本用户分组桶、返回已配 CORS 的桶地址)再取。根治「生成成功但取不到图 Failed to fetch」。
async function imageStringToBlob(input: string): Promise<Blob> {
    if (input.startsWith("data:") || input.startsWith("blob:")) {
        return (await fetch(input)).blob();
    }
    try {
        const res = await fetch(input);
        if (!res.ok) throw new Error(`image fetch not ok: ${res.status}`);
        return await res.blob();
    } catch {
        const rehosted = await persistImageViaServer(input);
        return (await fetch(rehosted)).blob();
    }
}

// persistImageViaServer 让服务端抓取远端图片、转存进本用户分组桶，返回可公网访问(桶已配公共读+CORS)的稳定地址。
async function persistImageViaServer(src: string): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = useUserStore.getState().token;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch("/api/v1/media/persist", { method: "POST", headers, body: JSON.stringify({ url: src, kind: "image" }) });
    const json = (await res.json()) as { code?: number; data?: { url?: string }; msg?: string };
    if (json.code !== 0 || !json.data?.url) throw new Error(json.msg || "图片转存失败");
    return json.data.url;
}

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await imageStringToBlob(input) : input;
    const storageKey = `image:${nanoid()}`;
    await store.setItem(storageKey, blob);
    // 字节一落地就往云端推一份，不等那次防抖同步——防抖会被连续编辑一再推后（最坏到兜底的 90 秒），
    // 那段窗口里这份字节只存在于本机，关浏览器/换设备就永久没了。上传幂等、失败无害（常规同步会重试）。
    pushMediaToCloud(storageKey, blob);
    const url = URL.createObjectURL(blob);
    rememberObjectUrl(storageKey, url);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    // 已有同 key 解析在进行 → 复用它,不重复下载(各调用方仍套各自 fallback)。
    const existing = inflight.get(storageKey);
    if (existing) return (await existing) || fallback;
    const task = (async () => {
        const blob = await store.getItem<Blob>(storageKey);
        if (blob) {
            const url = URL.createObjectURL(blob);
            rememberObjectUrl(storageKey, url);
            return url;
        }
        // 本地缓存没有（跨设备/清缓存/配额驱逐）→ 带 token 从服务器拉回自愈（healImageFromServer 内已写回本地缓存+建 ObjectURL）；
        // 只在 miss（本就是坏图）时才发一次网络，正常图（cache 命中）零开销。拉不到才回退（多为死 blob）。
        const healed = await healImageFromServer(storageKey, useUserStore.getState().token);
        return healed || "";
    })();
    inflight.set(storageKey, task);
    try {
        return (await task) || fallback;
    } finally {
        inflight.delete(storageKey);
    }
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    rememberObjectUrl(storageKey, url);
    // 广播「该 storageKey 已有可用新 URL」：画布页据此把仍是死 blob: 的节点 content 回写成活链，
    // 让参考图缩略图 / 下载 / 图片详情等直接读 content 的地方随大图 onError 自愈一起恢复。
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("image-blob-healed", { detail: { storageKey, url } }));
    return url;
}

// 跨设备/清缓存后本地没有该图 → 带 token 从后端拉回（后端对 http(s) path 会 302 到 TOS）并写回本地缓存，
// 返回可用的本地 ObjectURL；任何失败返回 null，交调用方显示重试态而非静默空白。
export async function healImageFromServer(storageKey: string, token: string): Promise<string | null> {
    if (!storageKey || !token) return null;
    let blob: Blob;
    try {
        const response = await fetch(`/api/v1/sync/files/${encodeURIComponent(storageKey)}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return null;
        blob = await response.blob();
    } catch {
        return null;
    }
    // 后端对缺失文件返回 JSON（非媒体类型）→ 视为拉取失败
    if (!blob || blob.type.includes("application/json")) return null;
    return setImageBlob(storageKey, blob);
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    // asset:// 是火山方舟肖像授权引用（仅视频上游可解析，浏览器取不到像素）→ 从不 fetch，改走 storageKey 自愈；fallback 也剔除 asset://。
    const safeFallback = image.url && !image.url.startsWith("asset://") ? image.url : "";
    let url = image.dataUrl || "";
    if (!url || url.startsWith("asset://")) {
        url = await resolveImageUrl(image.storageKey, safeFallback);
    }
    if (!url || url.startsWith("data:")) return url;
    if (url.startsWith("asset://")) return "";
    try {
        // content 是有效像素 URL / 活的 blob: 时直接取用（含批次选中子图的活 blob，保持「所见即所发」，不碰 storageKey）。
        const res = await fetch(url);
        // 4xx/5xx（如过期签名 URL/代理 404）fetch 不会抛，会把错误页正文当图片——显式 throw 转入自愈，别把错误页发给上游。
        if (!res.ok) throw new Error(`image fetch not ok: ${res.status}`);
        return blobToDataUrl(await res.blob());
    } catch {
        // content 失效（死 blob 跨会话/换域后 ERR_FILE_NOT_FOUND、或 http 4xx/5xx）→ 用 storageKey 从服务器自愈重取像素，避免图片生成整体失败。
        const healed = await resolveImageUrl(image.storageKey, "");
        if (healed && healed !== url && !healed.startsWith("asset://")) {
            if (healed.startsWith("data:")) return healed;
            const res2 = await fetch(healed);
            if (res2.ok) return blobToDataUrl(await res2.blob());
        }
        throw new Error("参考图已失效且无法自愈（缺少 storageKey）");
    }
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    // 安全阀：「在用清单」为空时一律不清。空清单要么是真的没东西可清（那清了也没意义），
    // 要么是调用方在数据还没水合好时就问了——后者会把整机字节一次清光，且不可逆。
    if (!usedKeys.size) return;
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
