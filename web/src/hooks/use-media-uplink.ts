"use client";

import { useCallback, useSyncExternalStore } from "react";

import { getMediaUplinkState, subscribeMediaUplink, type MediaUplinkState } from "@/services/media-uplink";

/**
 * 订阅某个媒体文件的「上云」状态（拖进画布的视频/图片在后台推服务端的那一步）。
 *
 * 返回 null = 这一轮会话里没有它的记录（刷新过页面、或是上一轮传的）。
 * 此时调用方必须**什么都不显示**，而不是显示一个永远转不完的圈——
 * 状态表只存在内存里，刷新后本来就无从判断，装作在传反而是误导。
 */
export function useMediaUplink(storageKey?: string): MediaUplinkState | null {
    const subscribe = useCallback(
        (listener: () => void) => {
            if (!storageKey) return () => {};
            return subscribeMediaUplink(storageKey, listener);
        },
        [storageKey],
    );
    const getSnapshot = useCallback(() => getMediaUplinkState(storageKey), [storageKey]);
    // 服务端渲染阶段一律 null：状态表是浏览器内存里的东西，SSR 没有也不该有。
    return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
