import { useUserStore } from "@/stores/use-user-store";

// 媒体「即刻上云」：字节一落地就往服务端推一份，不等那次防抖同步。
//
// 为什么必须这样：真正有丢失风险的是【字节】，不是画布 JSON。
// 原来的链路是「写进 IndexedDB → 等 3 秒防抖 → 整轮同步时才上传」，而防抖每次编辑都会重新计时，
// 用户连续操作时这一等可能长达 90 秒（兜底定时器）。这段窗口里字节只存在于这台机器：
// 关掉浏览器、切设备、浏览器清理存储，图就永久没了——典型场景是在笔记本上做完、换台式机打开，图全空。
//
// 上传是幂等的（按 storageKey 覆盖），失败也无所谓：常规同步仍会把它当作待上传项重试。
// 所以这里一律不阻塞出图、也绝不弹错打断用户。
//
// ⭐ 在「不阻塞」的前提下还必须做三件事。典型触发场景：用户拖进一个上百 MB 的视频后立刻发起需要云端文件的操作，
// 撞上「这个视频还没有同步到云端」：
//   ① 状态可查：谁在上云、传到百分之几、成功还是失败，都记在下面这张表里，画布节点和工具栏据此显示。
//   ② 真的读结果：原来是 `void fetch(...).catch(()=>{})`，连 response.ok 都不看——
//      413（体积超过前置反代上限）、401、500 全被当成上传成功，用户毫无察觉直到换设备发现文件没了。
//   ③ 可等待：「必须文件已在云端」这类操作可以 await 上云完成，而不是直接报错。
// 用 XMLHttpRequest 而不是 fetch，唯一原因是只有 xhr.upload 才有上传进度事件。

/** 上云状态。loaded/total 只覆盖「浏览器 → 服务端」这一段，100% 不等于可用（服务端还要推 TOS）。 */
export type MediaUplinkState = {
    status: "uploading" | "done" | "failed";
    loaded: number;
    total: number;
    /** 服务端已收下并落库（真正可用），此前即便进度 100% 也还不能用。 */
    settled: boolean;
    error?: string;
};

type Entry = {
    state: MediaUplinkState;
    /** 失败后重试要用；成功即丢弃引用，别一直攥着几百 MB。 */
    blob: Blob | null;
    resolve: ((ok: boolean) => void) | null;
    promise: Promise<boolean>;
    lastNotifiedAt: number;
};

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
// 这张表属于哪个账号。切账号必须整表清空——同一浏览器切号是跨账号串号的高发路径，
// 宁可让新账号显示「无状态」，也不能把上个账号的上传状态挂在新账号的节点上。
let ownerToken = "";
// 进度回调节流：画布本来就吃紧，几十毫秒一次的 setState 会直接掉帧。
const PROGRESS_NOTIFY_MS = 250;

function currentToken() {
    return useUserStore.getState().token || "";
}

function ensureOwner(token: string) {
    if (token === ownerToken) return;
    ownerToken = token;
    for (const entry of entries.values()) entry.resolve?.(false);
    entries.clear();
    for (const set of listeners.values()) for (const fn of set) fn();
}

function notify(key: string) {
    const set = listeners.get(key);
    if (!set) return;
    for (const fn of set) fn();
}

function setState(key: string, next: MediaUplinkState, force: boolean) {
    const entry = entries.get(key);
    if (!entry) return;
    // 必须换一个新对象：useSyncExternalStore 靠引用相等判断「没变」，原地改字段界面不会更新。
    entry.state = next;
    const now = Date.now();
    if (!force && now - entry.lastNotifiedAt < PROGRESS_NOTIFY_MS) return;
    entry.lastNotifiedAt = now;
    notify(key);
}

function finish(key: string, ok: boolean, error?: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entry.state = ok
        ? { status: "done", loaded: entry.state.total, total: entry.state.total, settled: true }
        : { status: "failed", loaded: entry.state.loaded, total: entry.state.total, settled: false, error: error || "上传失败" };
    if (ok) entry.blob = null;
    entry.lastNotifiedAt = Date.now();
    const resolve = entry.resolve;
    entry.resolve = null;
    resolve?.(ok);
    notify(key);
}

/** 解析 /api/v1/sync/files 的响应：HTTP 200 且业务 code===0 才算成功。 */
function readUploadOutcome(xhr: XMLHttpRequest): { ok: boolean; error?: string } {
    if (xhr.status < 200 || xhr.status >= 300) {
        // 413 多半来自前置反代（nginx client_max_body_size）或 Next 代理的上传上限，回的可能是 HTML，
        // 解析不出业务信息，直接按状态码给人话。
        if (xhr.status === 413) return { ok: false, error: "文件超过服务器允许的上传大小" };
        if (xhr.status === 401) return { ok: false, error: "登录已失效，请重新登录后重试" };
        return { ok: false, error: `服务器返回 ${xhr.status}` };
    }
    try {
        const payload = JSON.parse(xhr.responseText || "{}") as { code?: number; msg?: string };
        if (typeof payload.code === "number" && payload.code !== 0) return { ok: false, error: payload.msg || "上传失败" };
    } catch {
        // 200 但不是 JSON：当作成功太危险（代理/网关也可能 200 返回 HTML），按失败处理让同步兜底重传。
        return { ok: false, error: "服务器返回了无法识别的内容" };
    }
    return { ok: true };
}

function startUpload(key: string, blob: Blob, token: string) {
    const form = new FormData();
    form.set("storage_key", key);
    form.set("mime_type", blob.type || "application/octet-stream");
    form.set("file", blob, "blob");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/sync/files");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    // 刻意不设 xhr.timeout：300MB 的视频在慢上行下要传十几分钟，设了反而会中途掐断。
    xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        setState(key, { status: "uploading", loaded: event.loaded, total: event.total || blob.size, settled: false }, event.loaded >= (event.total || blob.size));
    };
    xhr.onload = () => {
        const outcome = readUploadOutcome(xhr);
        finish(key, outcome.ok, outcome.error);
    };
    xhr.onerror = () => finish(key, false, "网络中断");
    xhr.onabort = () => finish(key, false, "上传被取消");
    xhr.send(form);
}

/**
 * 立即把一个媒体字节推到云端。不阻塞、不抛错。
 * @returns 是否真的发起了上传（已在推送中/已传完/未登录时返回 false）
 */
export function pushMediaToCloud(storageKey: string, blob: Blob): boolean {
    if (typeof window === "undefined") return false;
    const key = (storageKey || "").trim();
    if (!key || !blob || !blob.size) return false;
    const token = currentToken();
    if (!token) return false;
    ensureOwner(token);
    // 同一个 key 正在推、或这一轮会话里已经推成功过，就不重复推（生成链路可能连续触发多次）
    const existing = entries.get(key);
    if (existing && existing.state.status !== "failed") return false;

    let resolve: ((ok: boolean) => void) | null = null;
    const promise = new Promise<boolean>((r) => {
        resolve = r;
    });
    entries.set(key, {
        state: { status: "uploading", loaded: 0, total: blob.size, settled: false },
        blob,
        resolve,
        promise,
        lastNotifiedAt: 0,
    });
    notify(key);
    startUpload(key, blob, token);
    return true;
}

/**
 * 查一条上云状态；没有记录（刷新过页面、或本就不是这一轮传的）返回 null——
 * 此时调用方应当**什么都不显示**，而不是显示一个永远转不完的圈。
 */
export function getMediaUplinkState(storageKey?: string): MediaUplinkState | null {
    if (!storageKey) return null;
    const token = currentToken();
    if (!token || token !== ownerToken) return null;
    return entries.get(storageKey)?.state || null;
}

/** 订阅某个 key 的上云状态变化（配 useSyncExternalStore 用）。 */
export function subscribeMediaUplink(storageKey: string, listener: () => void): () => void {
    let set = listeners.get(storageKey);
    if (!set) {
        set = new Set();
        listeners.set(storageKey, set);
    }
    set.add(listener);
    return () => {
        const current = listeners.get(storageKey);
        if (!current) return;
        current.delete(listener);
        if (!current.size) listeners.delete(storageKey);
    };
}

/**
 * 等这个文件上云完成。
 * 没有记录一律返回 true（可能是上一轮会话传的，服务端自己会判；不能因为查不到就拦住用户）。
 */
export function waitMediaUploaded(storageKey?: string): Promise<boolean> {
    if (!storageKey) return Promise.resolve(true);
    const token = currentToken();
    if (!token || token !== ownerToken) return Promise.resolve(true);
    const entry = entries.get(storageKey);
    if (!entry) return Promise.resolve(true);
    if (entry.state.status === "done") return Promise.resolve(true);
    if (entry.state.status === "failed") return Promise.resolve(false);
    return entry.promise;
}

/** 重推一次（失败后用户点「重试」）。拿不到字节引用时返回 false，由常规同步兜底。 */
export function retryMediaUpload(storageKey: string): boolean {
    const token = currentToken();
    if (!token || token !== ownerToken) return false;
    const entry = entries.get(storageKey);
    if (!entry || entry.state.status === "uploading") return false;
    const blob = entry.blob;
    if (!blob) return false;
    let resolve: ((ok: boolean) => void) | null = null;
    const promise = new Promise<boolean>((r) => {
        resolve = r;
    });
    entries.set(storageKey, { state: { status: "uploading", loaded: 0, total: blob.size, settled: false }, blob, resolve, promise, lastNotifiedAt: 0 });
    notify(storageKey);
    startUpload(storageKey, blob, token);
    return true;
}
