"use client";

import localforage from "localforage";
import { nanoid } from "nanoid";
import { useUserStore } from "@/stores/use-user-store";
import { probeVideoOnServer, submitMediaTranscode, waitMediaTranscode } from "@/services/api/media";
import { setMediaTranscodeState } from "@/services/media-transcode-state";
import { pushMediaToCloud, waitMediaUploaded } from "@/services/media-uplink";
import { LOCAL_DB_NAME } from "@/constant/env";

// browserPlayable 只在视频上出现：false = 浏览器解不了（H.265 这类），此时 width/height 是 0，
// 真实规格随后由服务端 ffprobe 通过 VIDEO_META_PROBED_EVENT 补上。
export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number; browserPlayable?: boolean };

const store = localforage.createInstance({ name: LOCAL_DB_NAME, storeName: "media_files" });
const objectUrls = new Map<string, string>();
// 同一 storageKey 的并发解析去重：进画布时「后台水合」与「节点 onError 自愈」可能同时解析同一文件，
// 不去重则各自 fetch 一遍（同一视频/音频被从服务器重复下载）+ 各自 createObjectURL（rememberObjectUrl 撤销竞态）。
const inflight = new Map<string, Promise<string>>();

// 同一 storageKey 重新生成 Object URL 时，先释放旧 URL，避免内存泄漏
function rememberObjectUrl(key: string, url: string) {
    const prev = objectUrls.get(key);
    if (prev && prev !== url) URL.revokeObjectURL(prev);
    objectUrls.set(key, url);
}

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    // 同 image-storage：字节落地即上云，不等防抖同步（视频体积更大、丢了更疼）。
    pushMediaToCloud(storageKey, blob);
    const url = URL.createObjectURL(blob);
    rememberObjectUrl(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    // 浏览器解不了这个视频：宽高压根没读到。不编一个假的糊弄过去，改为后台找服务端要真实规格。
    if ("browserPlayable" in meta && meta.browserPlayable === false) scheduleServerVideoProbe(storageKey);
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
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
        // 本地缓存没有(跨设备/清缓存/尚未后台下载)→ 带 token 从服务器拉回自愈(视频/音频与图片一致);
        // 只在 miss(本就缺)时发一次网络,命中零开销。配合 applyData 前置:列表先出、媒体按需自愈。
        const healed = await healMediaFromServer(storageKey, useUserStore.getState().token);
        return healed || "";
    })();
    inflight.set(storageKey, task);
    try {
        return (await task) || fallback;
    } finally {
        inflight.delete(storageKey);
    }
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    rememberObjectUrl(storageKey, url);
    return url;
}

// 跨设备/清缓存/尚未下载时本地没有该媒体 → 带 token 从后端拉回(后端对 http(s) path 会 302 到 TOS)并写回本地缓存,
// 返回可用 URL;任何失败返回 null。与 image-storage.healImageFromServer 同构。
export async function healMediaFromServer(storageKey: string, token: string): Promise<string | null> {
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
    // 后端对缺失文件返回 JSON(非媒体类型)→ 视为拉取失败
    if (!blob || blob.type.includes("application/json")) return null;
    return setMediaBlob(storageKey, blob);
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    // 安全阀：「在用清单」为空时一律不清。空清单要么是真的没东西可清（那清了也没意义），
    // 要么是调用方在数据还没水合好时就问了——后者会把整机字节一次清光，且不可逆。
    if (!usedKeys.size) return;
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

export type VideoProbeMeta = { width: number; height: number; durationMs?: number; browserPlayable: boolean };

// 服务端探测回来的真实规格通过这个事件广播出去，由画布页把节点框改正。
export const VIDEO_META_PROBED_EVENT = "frameweave:video-meta-probed";

// 预览版转好了：画布页收到后把这个节点的播放源换成预览版（原片不动）。
export const VIDEO_PREVIEW_READY_EVENT = "frameweave:video-preview-ready";

// 浏览器读元数据的上限。正常几十毫秒就回来；卡这么久基本等于读不出来，
// 与其无限等下去把节点创建整个挂住，不如判失败、转由服务端去探。
const VIDEO_META_TIMEOUT_MS = 20_000;

// readVideoMeta 用浏览器读视频的宽高与时长。
//
// ⚠️ onerror 和 onloadedmetadata 绝不能共用一个回调：那样解码失败时会静默返回 1280x720。
// 于是用户传一段浏览器解不了的视频（比如 iPhone 拍的 H.265 竖屏），画布上的节点框就变成 16:9，
// 画面两侧一圈黑边——而文件本身完全正常，下载下来能好好播，用户只会觉得是产品把视频弄坏了。
// 现在失败就明说：browserPlayable=false 且宽高为 0，让调用方知道这个数不能用。
// 调用方本来就写了 `video.width || 1280` 的兜底，返回 0 不会让谁炸掉。
export function readVideoMeta(url: string): Promise<VideoProbeMeta> {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (playable: boolean) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            video.onloadedmetadata = null;
            video.onerror = null;
            const durationMs = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : undefined;
            resolve({ width: playable ? video.videoWidth : 0, height: playable ? video.videoHeight : 0, durationMs, browserPlayable: playable });
        };
        timer = setTimeout(() => finish(false), VIDEO_META_TIMEOUT_MS);
        video.onloadedmetadata = () => finish(video.videoWidth > 0 && video.videoHeight > 0);
        video.onerror = () => finish(false);
        video.preload = "metadata";
        video.src = url;
    });
}

// 同一个 storageKey 只找服务端探一次：探测要跑 ffprobe，重复问既费时又费钱。
const serverProbed = new Set<string>();

// scheduleServerVideoProbe 后台去问服务端要真实规格，拿到就广播出去。
//
// 刻意不在上传流程里同步等：源片可能有几百 MB，等它上完云再返回，
// 用户拖进来的视频节点要好几分钟才出现，那是比黑边严重得多的退步。
// 所以节点先建（框可能暂时不准），传完再悄悄改正。
// ensureVideoPreview 确保这个源片有一份能在浏览器里播的预览版。
//
// 服务端按 storageKey 去重，所以这里重复调用是安全的：已经转好的直接把地址还回来，
// 正在转的会拿到同一个任务号接着轮询——不会重复烧 CPU。
const previewRequested = new Set<string>();
export function ensureVideoPreview(storageKey: string) {
    if (typeof window === "undefined") return;
    const key = (storageKey || "").trim();
    if (!key || previewRequested.has(key)) return;
    previewRequested.add(key);
    void (async () => {
        try {
            const job = await submitMediaTranscode(key);
            let done = job;
            if (job.status !== "succeeded") {
                setMediaTranscodeState(key, { status: "running", progress: job.progress || 0 });
                done = await waitMediaTranscode(job.id, (tick) => {
                    setMediaTranscodeState(key, { status: "running", progress: tick.progress || 0 });
                });
            }
            setMediaTranscodeState(key, null);
            const previewUrl = (done.previewUrl || "").trim();
            if (!previewUrl) return;
            window.dispatchEvent(new CustomEvent(VIDEO_PREVIEW_READY_EVENT, { detail: { storageKey: key, previewUrl, width: done.width, height: done.height } }));
        } catch {
            // 转不出来就维持现状：节点该怎样还怎样，原片一个字节没动过。
            // 标记留 3 秒让用户看见「转换失败」，然后清掉并允许下次再试。
            setMediaTranscodeState(key, { status: "failed", progress: 0 });
            setTimeout(() => setMediaTranscodeState(key, null), 3000);
            previewRequested.delete(key);
        }
    })();
}

function scheduleServerVideoProbe(storageKey: string) {
    if (typeof window === "undefined") return;
    const key = (storageKey || "").trim();
    if (!key || serverProbed.has(key)) return;
    serverProbed.add(key);
    void (async () => {
        try {
            // 服务端要能公网取到这个文件才探得了，所以必须等上云完成。
            const uploaded = await waitMediaUploaded(key);
            if (!uploaded) return;
            const meta = await probeVideoOnServer(key);
            if (!meta || !(meta.width > 0) || !(meta.height > 0)) return;
            window.dispatchEvent(new CustomEvent(VIDEO_META_PROBED_EVENT, { detail: { storageKey: key, ...meta } }));
            // 服务端也说浏览器放不了 → 排一份 H.264 预览版，转好了再把播放源换过去。
            if (meta.browserPlayable === false) void ensureVideoPreview(key);
        } catch {
            // 探不到就算了：节点照常能用，只是框可能不是原始比例。
            // 这条链路是锦上添花，绝不能反过来变成新的故障源。
        }
    })();
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
