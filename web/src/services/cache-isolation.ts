"use client";

import localforage from "localforage";
import { LOCAL_DB_NAME, storageKey } from "@/constant/env";

import { clearCanvasPersistence, useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { usePresetStore } from "@/stores/use-preset-store";
import { useShortcutStore } from "@/stores/use-shortcut-store";
import { useConfigStore } from "@/stores/use-config-store";

// 本地数据 owner 标记 key（存储在 localStorage）
const LOCAL_DATA_OWNER_KEY = storageKey("local_data_owner");

// 用户相关的 IndexedDB 存储名（账号切换时需清空）。
// 注意：image_files / media_files 不在此列。媒体字节本身不参与跨账号串号防护——
// 媒体只在被当前账号的画布/素材结构化数据引用到时才会解析显示或上传，而结构化数据（画布/素材/日志）已在此清空。
// 归属标记存于 localStorage，媒体字节存于 IndexedDB：浏览器「清站点数据」/隐私清理/Safari 定期清理会先抹掉 localStorage 标记，
// 下次登录 owner 不匹配即误判为「非本账号」并清空字节——而尚未上传成功的图，本地这份是唯一一份，清掉即永久丢失。
// 故媒体字节不随账号切换清理；孤立字节留给后续 cleanupUnused* 按引用关系 GC。
const USER_SCOPED_STORES = [
    "image_generation_logs",
    "video_generation_logs",
    "sync_tombstones",
    "workbench_drafts",
];

// 用户相关的 localStorage key 列表（不含 token，token 由 useUserStore 独立管理）
const USER_LOCALSTORAGE_KEYS = [
    storageKey("ai_config_store"),
    // 新功能引导「哪些功能已经试过」。不清的话，同一台电脑上第一个人看完引导，
    // 后来登录的同事就永远不会被提醒有新功能——而这个引导的定位就是「每个用户看一次」。
    storageKey("feature-guide-v2"),
];

/**
 * 切换账号时清空上一个用户的本地缓存数据。
 * 包括：IndexedDB 存储、画布数据、素材数据、AI 配置。
 */
export async function clearUserScopedCache() {
    if (typeof window === "undefined") return;

    try {
        // 1. 清空 IndexedDB 中的用户相关存储
        await Promise.all(
            USER_SCOPED_STORES.map(async (storeName) => {
                try {
                    const instance = localforage.createInstance({ name: LOCAL_DB_NAME, storeName });
                    await instance.clear();
                } catch {
                    // 忽略单个存储清空失败
                }
            }),
        );

        // 2. 清空画布数据（包括持久化）
        try {
            useCanvasStore.getState().replaceProjects([]);
            await clearCanvasPersistence();
        } catch {
            // 忽略
        }

        // 3. 清空素材数据 + 自定义风格预设
        //    预设（我的图片风格/视频风格）属于按账号隔离的数据，同样是结构化内容，
        //    切账号不清会跨账号残留（上一个账号的自定义风格出现在下一个账号的列表里）。
        try {
            useAssetStore.getState().replaceAssets([]);
            usePresetStore.getState().replaceImageStyles([]);
            usePresetStore.getState().replaceVideoStyles([]);
            // 自定义快捷键同属按账号隔离的结构化数据，同样要清。
            useShortcutStore.getState().replaceBindings([]);
        } catch {
            // 忽略
        }

        // 4. 清空 AI 配置（用户相关的 API Key、模型选择等）
        try {
            configStoreReset();
        } catch {
            // 忽略
        }

        // 5. 清空 localStorage 中的用户相关数据
        USER_LOCALSTORAGE_KEYS.forEach((key) => {
            try {
                window.localStorage.removeItem(key);
            } catch {
                // 忽略
            }
        });

        // 6. 清掉本地数据 owner 标记
        window.localStorage.removeItem(LOCAL_DATA_OWNER_KEY);
    } catch {
        // 整体兜底：缓存清理失败不应阻塞登录/登出流程
    }
}

/**
 * 设置当前本地数据的 owner（用于标记缓存归属）
 */
export function setLocalDataOwner(userId: string) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LOCAL_DATA_OWNER_KEY, userId);
}

/**
 * 获取当前本地数据的 owner
 */
export function getLocalDataOwner(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(LOCAL_DATA_OWNER_KEY);
}

/**
 * 检查并确保本地数据属于指定用户
 * 如果 owner 不匹配，会先清空旧数据
 */
export async function ensureLocalDataOwner(userId: string) {
    const owner = getLocalDataOwner();
    if (owner === userId) return;
    await clearUserScopedCache();
    setLocalDataOwner(userId);
}

// 重置 configStore 到默认值
function configStoreReset() {
    const state = useConfigStore.getState();
    // 用默认配置覆盖，通过调用 updateConfig 逐个字段重置
    // 这里直接用 setState 更高效
    state.updateConfig("channelMode", "remote");
    state.updateConfig("apiKey", "");
    state.updateConfig("baseUrl", "https://api.openai.com");
}
