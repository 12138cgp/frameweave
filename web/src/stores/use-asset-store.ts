"use client";

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { storageKey } from "@/constant/env";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";
import { addSyncTombstones } from "@/services/sync-tombstones";

export type AssetKind = "text" | "image" | "video" | "audio" | "group";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & { data: { url: string; storageKey?: string; bytes: number; mimeType: string; durationMs?: number } };
// 组素材：整组打包（成员节点 + 内部连线的 JSON 快照），跨画布调回时重建节点/连线/组。
// nodes/connections 用 unknown[] 避免与 canvas 类型循环依赖（存/取两端在 ccp 里 cast）；媒体靠成员 metadata.storageKey 云同步 + 调回后节点自愈。
export type GroupAsset = AssetBase<"group"> & { data: { title: string; nodes: unknown[]; connections: unknown[] } };
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset | GroupAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

const ASSET_STORE_KEY = storageKey("asset_store");

// 等画布 store 水合完成，最多 10 秒。轮询而非订阅：这是一次性等待，水合通常几百毫秒内完成。
async function waitForCanvasHydration(store: { getState: () => { hydrated?: boolean } }) {
    for (let i = 0; i < 100; i += 1) {
        if (store.getState().hydrated) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await Promise.all(
            parsed.state.assets.map(async (asset) => {
                if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind === "audio" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind === "group") {
                    // 组素材封面是会话级 blob，跨会话失效 → 按 coverStorageKey 重解析
                    if (typeof asset.metadata?.coverStorageKey === "string" && asset.coverUrl.startsWith("blob:")) return { ...asset, coverUrl: await resolveImageUrl(asset.metadata.coverStorageKey, asset.coverUrl) };
                    return asset;
                }
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey)
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                        data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                    };
                if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
                const image = await uploadImage(asset.data.dataUrl);
                return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
            }),
        );
        return parsed;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                })),
            removeAsset: (id) => {
                // 写删除墓碑，云同步合并时阻止远端旧版本把删掉的素材拉回来
                void addSyncTombstones("assets", [id]);
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                });
            },
            replaceAssets: (assets) => set({ assets }),
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                    // ⚠️ 必须等画布 store 水合完成，才能拿 projects 当「在用清单」。
                    // 动态 import 只完成模块求值，persist 的水合是异步的——此刻 projects 仍是空初始态
                    // （use-canvas-store.ts 顶部注释已把这个空初始态列为丢数据的典型根因之一，
                    //  并为落盘路径加了 hasHydrated 门闩，唯独这里没有）。
                    // 而 /assets 页面根本不 import 画布 store，所以「在素材页删一个素材」几乎必然撞上：
                    // 清单里只剩 assets，画布里每一份媒体字节都会被当成无引用而删掉。
                    // GC 是尽力而为的清理：等不到就干脆不清——少清一次只是留点垃圾，错清一次不可逆。
                    if (!(await waitForCanvasHydration(useCanvasStore))) return;
                    const projects = useCanvasStore.getState().projects;
                    await cleanupUnusedImages({ assets: get().assets, projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects, extra });
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                useAssetStore.setState({ hydrated: true });
            },
        },
    ),
);
