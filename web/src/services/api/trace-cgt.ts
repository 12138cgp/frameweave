"use client";

import { apiGet } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

// 按 trace_id 查这次生成对应的火山 cgt 任务号。会话内缓存，避免同一节点反复打开信息面板时重复请求。
const cache = new Map<string, string>();

export async function fetchTraceCgt(traceId: string): Promise<string> {
    const key = (traceId || "").trim();
    if (!key) return "";
    if (cache.has(key)) return cache.get(key) as string;
    const token = useUserStore.getState().token;
    if (!token) return "";
    try {
        const res = await apiGet<{ cgt: string }>(`/api/v1/trace-cgt/${encodeURIComponent(key)}`, undefined, token);
        const cgt = res?.cgt || "";
        if (cgt) cache.set(key, cgt);
        return cgt;
    } catch {
        return "";
    }
}
