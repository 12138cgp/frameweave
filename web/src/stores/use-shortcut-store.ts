"use client";

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { storageKey } from "@/constant/env";

import { localForageStorage } from "@/lib/localforage-storage";
import { addSyncTombstones } from "@/services/sync-tombstones";
import { SHORTCUT_COMMANDS, type ShortcutBinding, type ShortcutCommandId } from "@/constant/shortcuts";

// 用户自定义快捷键。走独立的同步域 "shortcuts"，跟着账号跨设备走。
//
// 只存「用户改过的那几条」，没改过的命令不落库——这样以后调整默认键位时，
// 没自定义过的用户会自动拿到新默认值，而不是被一份早年写死的快照钉住。

type ShortcutStore = {
    hydrated: boolean;
    bindings: ShortcutBinding[];
    setChords: (id: ShortcutCommandId, chords: string[]) => void;
    resetCommand: (id: ShortcutCommandId) => void;
    resetAll: () => void;
    replaceBindings: (bindings: ShortcutBinding[]) => void;
};

const SHORTCUT_STORE_KEY = storageKey("shortcut_store");

const shortcutStorage: PersistStorage<ShortcutStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        return JSON.parse(value) as StorageValue<ShortcutStore>;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

// normalizeBinding 清洗一条绑定。
//
// 入参可能直接来自云端 JSON，结构完全不可控——TypeScript 的类型只在编译期成立。
// 这个项目为此付过代价：曾有一条字段残缺的预设让规范化函数抛异常，而当时所有域是
// Promise.all 并发的，一条烂数据把该账号的【画布同步】也一起干掉了。
// 所以每个字段都单独兜底，返回 null 表示这条丢弃。
function normalizeBinding(input: unknown, known: Set<string>): ShortcutBinding | null {
    if (!input || typeof input !== "object") return null;
    const raw = input as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    // 只认注册表里还存在的命令：云端可能留着旧版本的、或已经被删掉的命令 id。
    if (!id || !known.has(id)) return null;
    if (!Array.isArray(raw.chords)) return null;
    const chords: string[] = [];
    for (const chord of raw.chords) {
        if (typeof chord !== "string") continue;
        const value = chord.trim().toLowerCase();
        if (!value) continue;
        if (chords.includes(value)) continue;
        chords.push(value);
    }
    const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt.trim() : new Date().toISOString();
    return { id, chords, updatedAt };
}

export function normalizeBindings(input: unknown): ShortcutBinding[] {
    if (!Array.isArray(input)) return [];
    const known = new Set<string>(SHORTCUT_COMMANDS.map((command) => command.id));
    const result: ShortcutBinding[] = [];
    const seen = new Set<string>();
    for (const item of input) {
        const binding = normalizeBinding(item, known);
        if (!binding) continue;
        // 同一命令出现多条时以先出现的为准，避免云端脏数据造成界面闪烁。
        if (seen.has(binding.id)) continue;
        seen.add(binding.id);
        result.push(binding);
    }
    return result;
}

export const useShortcutStore = create<ShortcutStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            bindings: [],
            setChords: (id, chords) => {
                const clean = chords.map((chord) => chord.trim().toLowerCase()).filter(Boolean);
                const existing = get().bindings.filter((binding) => binding.id !== id);
                // ⚠️ updatedAt 必须在这里显式刷新。
                // 跨设备合并是按 updatedAt 比大小的（相等时本地胜），不刷新的话在 B 设备改的键位
                // 会被 A 设备上更早的旧值反推回去。自定义风格那边就踩过这个坑（改完同步不过去）。
                const next: ShortcutBinding = { id, chords: clean, updatedAt: new Date().toISOString() };
                set({ bindings: [next, ...existing] });
            },
            resetCommand: (id) => {
                const existing = get().bindings.find((binding) => binding.id === id);
                set({ bindings: get().bindings.filter((binding) => binding.id !== id) });
                // 写墓碑，否则云端那条自定义会在下次同步时被当作「本地缺失」重新拉回来，
                // 表现就是「点了恢复默认，刷新后又变回自定义的键」。
                if (existing) void addSyncTombstones("shortcuts", [id]);
            },
            resetAll: () => {
                const ids = get().bindings.map((binding) => binding.id);
                set({ bindings: [] });
                if (ids.length) void addSyncTombstones("shortcuts", ids);
            },
            // replaceBindings 同步下发与切账号清理共用的入口。
            // ⚠️ 必须无条件写入（包括空数组）：切账号时靠它把上一个账号的自定义清干净，
            // 加任何「空不覆盖非空」的护栏都会导致清不掉，那正是跨账号串号的形状。
            replaceBindings: (bindings) => set({ bindings: normalizeBindings(bindings) }),
        }),
        {
            name: SHORTCUT_STORE_KEY,
            storage: shortcutStorage,
            partialize: (state) => ({ bindings: state.bindings }) as ShortcutStore,
            // hydrated 必须置位，否则同步链路里的 waitForHydration 会永久挂起，
            // 整个账号的云同步都不会开始。
            onRehydrateStorage: () => (state) => {
                if (state) state.bindings = normalizeBindings(state.bindings);
                useShortcutStore.setState({ hydrated: true });
            },
        },
    ),
);
