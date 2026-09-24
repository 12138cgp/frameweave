import localforage from "localforage";
import { LOCAL_DB_NAME } from "@/constant/env";

// 生图 / 视频生成页的「输入草稿」持久化：保存提示词、参考素材等输入内容，
// 刷新后自动恢复，避免刷新丢失正在编辑的内容。存 IndexedDB，无 localStorage 5MB 限制。
const draftStore = localforage.createInstance({ name: LOCAL_DB_NAME, storeName: "workbench_drafts" });

export async function loadDraft<T>(key: string): Promise<T | null> {
    if (typeof window === "undefined") return null;
    try {
        return (await draftStore.getItem<T>(key)) ?? null;
    } catch {
        return null;
    }
}

export function saveDraft(key: string, value: unknown): void {
    if (typeof window === "undefined") return;
    void draftStore.setItem(key, value).catch(() => {});
}
