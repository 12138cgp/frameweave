"use client";

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { nanoid } from "nanoid";
import { storageKey } from "@/constant/env";

import { localForageStorage } from "@/lib/localforage-storage";
import { addSyncTombstones } from "@/services/sync-tombstones";
import { setCustomImageStyles, setGroupImageStyles, type ImageStylePreset } from "@/lib/image-style-presets";
import { setCustomVideoStyles, setGroupVideoStyles, type VideoStylePreset } from "@/lib/video-style-presets";
import { listGroupStyles, type GroupStyle } from "@/services/api/group-style";

// 用户自定义预设 store（云同步域 "presets"）。含图片风格 + 视频风格两套；二期还会加自定义视图到同一 store。
// 每个自定义风格 = 内置预设结构 + previewStorageKey(预览图) + updatedAt(LWW)。
// 变更/回灌时调 setCustomImageStyles / setCustomVideoStyles 注册到各自 lib，让 get*StylePreset / 选择器 / compose* 同源。

export type CustomImageStyle = ImageStylePreset; // 含 previewStorageKey/custom/updatedAt
export type CustomVideoStyle = VideoStylePreset;

// 自定义风格表单入参（图片/视频通用）。
type StyleInput = { nameZh: string; injectPrompt: string; negativePrompt?: string; previewStorageKey?: string };
type StylePatch = Partial<Pick<CustomImageStyle, "nameZh" | "injectPrompt" | "negativePrompt" | "previewStorageKey">>;

type PresetStore = {
    hydrated: boolean;
    imageStyles: CustomImageStyle[];
    videoStyles: CustomVideoStyle[];
    addImageStyle: (input: StyleInput) => string;
    updateImageStyle: (id: string, patch: StylePatch) => void;
    removeImageStyle: (id: string) => void;
    replaceImageStyles: (list: CustomImageStyle[]) => void;
    addVideoStyle: (input: StyleInput) => string;
    updateVideoStyle: (id: string, patch: StylePatch) => void;
    removeVideoStyle: (id: string) => void;
    replaceVideoStyles: (list: CustomVideoStyle[]) => void;
    // —— 团队共享风格 —— //
    // 不进 persist / 不进 presets 云同步域：它是服务端按 group_id 下发的，本地缓存没有意义，
    // 反而会在换组/被取消共享后残留。每次打开选择器现拉。
    groupImageStyles: CustomImageStyle[];
    groupVideoStyles: CustomVideoStyle[];
    groupStylesLoading: boolean;
    loadGroupStyles: () => Promise<void>;
};

// 服务端 GroupStyle → 前端风格预设。category 固定成「团队共享」，让选择器能单独成组。
function toPreset(item: GroupStyle): CustomImageStyle {
    return {
        id: item.id,
        nameZh: item.nameZh || "未命名风格",
        nameEn: "",
        category: "团队共享",
        description: item.description || "",
        prefixPrompt: item.prefixPrompt || undefined,
        injectPrompt: item.injectPrompt || "",
        negativePrompt: item.negativePrompt || "",
        previewUrl: item.previewUrl || undefined,
        ownerName: item.ownerName || "",
        shared: true,
        updatedAt: item.updatedAt,
    } as CustomImageStyle;
}

const PRESET_STORE_KEY = storageKey("preset_store");

const presetStorage: PersistStorage<PresetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        return JSON.parse(value) as StorageValue<PresetStore>;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

// text 取字符串字段的安全值：非字符串（undefined / null / 数字 / 对象）一律当空串。
//
// 这个函数存在的理由：normalizeCustomStyle 的入参有两种来源——本地表单（字段齐全）和
// 【云端同步下发的 JSON】（字段完全不可控）。TypeScript 的 `nameZh: string` 只在编译期成立，
// 挡不住反序列化进来的任意结构。只要云端存着一条早期版本写下的残缺预设
// （比如只有 {id, name, updatedAt}），input.nameZh.trim() 就会抛 "undefined is not an object"。
// 更糟的是各数据域一旦用 Promise.all 并发，presets 一抛错整次同步全挂——
// 一条烂预设就能把该账号的【画布同步】也一起干掉，而且不留痕迹地持续下去。
// 所以规范化函数必须对每个字段都做防御，这正是"规范化"该干的事。
function text(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

// 归一：自定义风格无内置的分类/英文名概念，统一给固定分类与空英文名，custom=true。idPrefix 区分图片/视频。
// 入参放宽成 Record：它可能直接来自云端 JSON，不能假设结构。
function normalizeCustomStyle(input: Record<string, unknown>, category: string, idPrefix: string): CustomImageStyle {
    // nameZh 兜底顺序：nameZh → name（早期字段名）→ 占位，尽量不让用户的风格变成一排"未命名"
    const name = text(input.nameZh) || text(input.name) || "未命名风格";
    const inject = text(input.injectPrompt);
    return {
        id: text(input.id) || `${idPrefix}-${nanoid()}`,
        nameZh: name,
        nameEn: "",
        category,
        description: inject.slice(0, 60),
        injectPrompt: inject,
        negativePrompt: text(input.negativePrompt),
        previewStorageKey: typeof input.previewStorageKey === "string" ? input.previewStorageKey : undefined,
        custom: true,
        updatedAt: text(input.updatedAt) || new Date().toISOString(),
    };
}

// 把当前列表注册进各自 lib（供 get*StylePreset / compose* 拿到自定义档）。
function syncImageRegistry(list: CustomImageStyle[]) {
    setCustomImageStyles(list);
}
function syncVideoRegistry(list: CustomVideoStyle[]) {
    setCustomVideoStyles(list);
}

export const usePresetStore = create<PresetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            imageStyles: [],
            videoStyles: [],
            groupImageStyles: [],
            groupVideoStyles: [],
            groupStylesLoading: false,
            // 拉本组共享风格并注册进两个 lib。
            // 失败只吞掉不弹窗：这是选择器打开时的后台加载，网络抖一下不该挡住用户选内置风格。
            loadGroupStyles: async () => {
                if (get().groupStylesLoading) return;
                set({ groupStylesLoading: true });
                try {
                    const list = (await listGroupStyles()) || [];
                    const images = list.filter((item) => item.kind === "image").map(toPreset);
                    const videos = list.filter((item) => item.kind === "video").map(toPreset) as unknown as CustomVideoStyle[];
                    setGroupImageStyles(images);
                    setGroupVideoStyles(videos);
                    set({ groupImageStyles: images, groupVideoStyles: videos });
                } catch {
                    /* 后台加载失败不打断选择器 */
                } finally {
                    set({ groupStylesLoading: false });
                }
            },
            addImageStyle: (input) => {
                const preset = normalizeCustomStyle(input, "我的风格", "custom-style");
                const next = [preset, ...get().imageStyles];
                syncImageRegistry(next);
                set({ imageStyles: next });
                return preset.id;
            },
            updateImageStyle: (id, patch) => {
                const next = get().imageStyles.map((s) => {
                    if (s.id !== id) return s;
                    return normalizeCustomStyle({ ...s, ...patch, id: s.id, nameZh: patch.nameZh ?? s.nameZh, injectPrompt: patch.injectPrompt ?? s.injectPrompt }, "我的风格", "custom-style");
                });
                syncImageRegistry(next);
                set({ imageStyles: next });
            },
            removeImageStyle: (id) => {
                void addSyncTombstones("presets", [id]);
                const next = get().imageStyles.filter((s) => s.id !== id);
                syncImageRegistry(next);
                set({ imageStyles: next });
            },
            replaceImageStyles: (list) => {
                const normalized = (list || []).map((s) => normalizeCustomStyle(s, "我的风格", "custom-style"));
                syncImageRegistry(normalized);
                set({ imageStyles: normalized });
            },
            addVideoStyle: (input) => {
                const preset = normalizeCustomStyle(input, "我的视频风格", "custom-vstyle");
                const next = [preset, ...get().videoStyles];
                syncVideoRegistry(next);
                set({ videoStyles: next });
                return preset.id;
            },
            updateVideoStyle: (id, patch) => {
                const next = get().videoStyles.map((s) => {
                    if (s.id !== id) return s;
                    return normalizeCustomStyle({ ...s, ...patch, id: s.id, nameZh: patch.nameZh ?? s.nameZh, injectPrompt: patch.injectPrompt ?? s.injectPrompt }, "我的视频风格", "custom-vstyle");
                });
                syncVideoRegistry(next);
                set({ videoStyles: next });
            },
            removeVideoStyle: (id) => {
                void addSyncTombstones("presets", [id]);
                const next = get().videoStyles.filter((s) => s.id !== id);
                syncVideoRegistry(next);
                set({ videoStyles: next });
            },
            replaceVideoStyles: (list) => {
                const normalized = (list || []).map((s) => normalizeCustomStyle(s, "我的视频风格", "custom-vstyle"));
                syncVideoRegistry(normalized);
                set({ videoStyles: normalized });
            },
        }),
        {
            name: PRESET_STORE_KEY,
            storage: presetStorage,
            partialize: (state) => ({ imageStyles: state.imageStyles, videoStyles: state.videoStyles }) as StorageValue<PresetStore>["state"],
            onRehydrateStorage: () => (state) => {
                if (state) {
                    syncImageRegistry(state.imageStyles || []);
                    syncVideoRegistry(state.videoStyles || []);
                }
                usePresetStore.setState({ hydrated: true });
            },
        },
    ),
);
