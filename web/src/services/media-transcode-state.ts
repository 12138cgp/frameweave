"use client";

/**
 * 「转换可播放版本」的进度表。
 *
 * 与 media-uplink 同构、也同样只活在内存里：刷新页面就没有了，此时一律返回 null，
 * 调用方必须什么都不显示——装作在转反而是误导（服务端那边可能早转完了）。
 *
 * 存在的理由：源片是浏览器解不了的编码时，服务端要花「视频时长 × 约 0.3」的时间转一份 H.264 预览版。
 * 一段几分钟的片子就是一两分钟的等待，期间节点上如果一点动静都没有，用户只会以为卡死了。
 * 「上云」那一步已经有进度条，这一步不能没有。
 */
export type MediaTranscodeState = { status: "running" | "failed"; progress: number };

const states = new Map<string, MediaTranscodeState>();
const listeners = new Map<string, Set<() => void>>();

function emit(storageKey: string) {
    listeners.get(storageKey)?.forEach((listener) => listener());
}

export function getMediaTranscodeState(storageKey?: string): MediaTranscodeState | null {
    if (!storageKey) return null;
    return states.get(storageKey) || null;
}

/** 订阅某个 key 的转码状态变化（配 useSyncExternalStore 用）。 */
export function subscribeMediaTranscode(storageKey: string, listener: () => void): () => void {
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
 * 写入状态。
 * ⚠️ 值没变就不换对象：useSyncExternalStore 拿 getSnapshot 的返回值做引用比较，
 * 每次都 new 一个新对象会让 React 认为状态一直在变，直接陷入无限重渲染。
 */
export function setMediaTranscodeState(storageKey: string, next: MediaTranscodeState | null) {
    const key = (storageKey || "").trim();
    if (!key) return;
    if (!next) {
        if (!states.has(key)) return;
        states.delete(key);
        emit(key);
        return;
    }
    const prev = states.get(key);
    if (prev && prev.status === next.status && prev.progress === next.progress) return;
    states.set(key, next);
    emit(key);
}
