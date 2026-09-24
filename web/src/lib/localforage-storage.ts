import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { LOCAL_DB_NAME } from "@/constant/env";

import { logAction } from "@/services/action-log";

localforage.config({
    name: LOCAL_DB_NAME,
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch (error) {
            // IndexedDB 写不进去（配额满、隐私模式、被禁用）是本地丢数据的头号原因，
            // 而这里一直是无声降级到 localStorage —— 后者只有 5MB，画布随便就超，
            // 于是变成「以为存下了，其实两边都没存住」。必须留痕。
            const name0 = error instanceof Error ? error.name : "";
            let fallbackOk = true;
            try {
                window.localStorage.setItem(name, value);
            } catch {
                fallbackOk = false;
            }
            logAction("idb_write_fallback", { key: name, bytes: value.length, errorName: name0, fallbackOk });
            if (!fallbackOk) throw error;
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};
