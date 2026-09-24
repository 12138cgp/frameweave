"use client";

import { useCallback, useSyncExternalStore } from "react";

import { getMediaTranscodeState, subscribeMediaTranscode, type MediaTranscodeState } from "@/services/media-transcode-state";

/**
 * 订阅某个视频「转换可播放版本」的进度。
 * 返回 null = 本轮会话里没有它的记录（刷新过页面、或压根不需要转），此时什么都不该显示。
 */
export function useMediaTranscode(storageKey?: string): MediaTranscodeState | null {
    const subscribe = useCallback(
        (listener: () => void) => {
            if (!storageKey) return () => {};
            return subscribeMediaTranscode(storageKey, listener);
        },
        [storageKey],
    );
    const getSnapshot = useCallback(() => getMediaTranscodeState(storageKey), [storageKey]);
    return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
