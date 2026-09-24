"use client";

import localforage from "localforage";
import { LOCAL_DB_NAME } from "@/constant/env";

import type { AppSyncDomainKey } from "@/services/app-sync";

// 删除墓碑：记录「域:id → deletedAt」，随同步清单上云参与 LWW 合并，
// 解决本地删除被云端旧版本拉回的问题（多设备「删了又出现」）。
export type TombstoneMap = Record<string, string>;

// 墓碑保留 90 天后回收；超过 90 天未上线的设备可能把删过的数据带回来，可接受。
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const tombstoneStore = localforage.createInstance({ name: LOCAL_DB_NAME, storeName: "sync_tombstones" });

function tombstoneKey(domain: AppSyncDomainKey, id: string) {
    return `${domain}:${id}`;
}

// 删除入口统一调用：写墓碑后调度一次云同步，让删除尽快传播到云端。
// 动态 import 避免与 cloud-sync → app-sync → 本模块的静态依赖成环。
export async function addSyncTombstones(domain: AppSyncDomainKey, ids: string[]) {
    const deletedAt = new Date().toISOString();
    await Promise.all(ids.filter(Boolean).map((id) => tombstoneStore.setItem(tombstoneKey(domain, id), deletedAt)));
    void import("@/services/cloud-sync")
        .then((module) => module.scheduleCloudSync(2000))
        .catch(() => {});
}

export async function readSyncTombstones(domain: AppSyncDomainKey): Promise<TombstoneMap> {
    const prefix = `${domain}:`;
    const result: TombstoneMap = {};
    await tombstoneStore.iterate<string, void>((value, key) => {
        if (key.startsWith(prefix) && typeof value === "string") result[key.slice(prefix.length)] = value;
    });
    return result;
}

// 合并后落地：upserts 全量写入（幂等），removals 只删指定 id——
// 不做整域清空重写，避免误删同步期间并发新增的墓碑。
export async function writeSyncTombstones(domain: AppSyncDomainKey, upserts: TombstoneMap, removals: string[]) {
    await Promise.all(removals.map((id) => tombstoneStore.removeItem(tombstoneKey(domain, id))));
    await Promise.all(Object.entries(upserts).map(([id, deletedAt]) => tombstoneStore.setItem(tombstoneKey(domain, id), deletedAt)));
}

// ───────────────── 画布「节点/连线」级墓碑（带 rev，用于逐节点深合并）─────────────────
// key 形如 canvas#node:<id> / canvas#conn:<id>。用 '#' 分隔，故 readSyncTombstones('canvas')
// 按 'canvas:' 前缀扫描时【天然扫不到】这些子命名空间——老的项目级墓碑逻辑完全不受影响（向后兼容）。
// 值为 JSON 串 {deletedAt, rev}：rev=被删实体当时的最大 rev，保证删除单调战胜后续陈旧编辑。

export type RevTombstone = { deletedAt: string; rev: number };
export type RevTombstoneMap = Record<string, RevTombstone>;
// 节点/连线墓碑保留 365 天（小字符串、体积可忽略）：配合深合并的 rev=0 复活门控，进一步降低超长离线设备复活删除的概率。
export const NODE_TOMBSTONE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function revTombstoneKey(kind: "node" | "conn", id: string) {
    return `canvas#${kind}:${id}`;
}

// 写画布实体墓碑（删节点/连线时调用）。fire-and-forget 触发一次同步，让删除尽快上云。
export async function addCanvasRevTombstones(kind: "node" | "conn", items: Array<{ id: string; rev: number }>) {
    const deletedAt = new Date().toISOString();
    await Promise.all(
        items
            .filter((it) => it.id)
            .map((it) => tombstoneStore.setItem(revTombstoneKey(kind, it.id), JSON.stringify({ deletedAt, rev: it.rev || 0 } as RevTombstone))),
    );
    void import("@/services/cloud-sync")
        .then((module) => module.scheduleCloudSync(2000))
        .catch(() => {});
}

export async function readCanvasRevTombstones(kind: "node" | "conn"): Promise<RevTombstoneMap> {
    const prefix = `canvas#${kind}:`;
    const result: RevTombstoneMap = {};
    await tombstoneStore.iterate<string, void>((value, key) => {
        if (!key.startsWith(prefix) || typeof value !== "string") return;
        try {
            const parsed = JSON.parse(value) as Partial<RevTombstone>;
            if (parsed && typeof parsed.deletedAt === "string") result[key.slice(prefix.length)] = { deletedAt: parsed.deletedAt, rev: Number(parsed.rev) || 0 };
        } catch {
            // 损坏的墓碑跳过
        }
    });
    return result;
}

export async function writeCanvasRevTombstones(kind: "node" | "conn", upserts: RevTombstoneMap, removals: string[]) {
    await Promise.all(removals.map((id) => tombstoneStore.removeItem(revTombstoneKey(kind, id))));
    await Promise.all(Object.entries(upserts).map(([id, t]) => tombstoneStore.setItem(revTombstoneKey(kind, id), JSON.stringify(t))));
}

// ───────────────── 画布「真实删除」标记（P0 收缩护栏 confirmShrink 信号）─────────────────
// 仅当本设备确有真实删除（删节点/连线/项目）时置位；canvas 推送时消费置 confirmShrink=true 放行收缩，
// 区分「用户真删」与「陈旧设备整项目 LWW 误删」。推送失败会被恢复，保证重试仍带标记。
let canvasDeletionPending = false;
export function markCanvasDeletion() {
    canvasDeletionPending = true;
}
// 读取并清零（原子消费）：push 前取值；若 push 失败再调 markCanvasDeletion 恢复。
export function consumeCanvasDeletion() {
    const value = canvasDeletionPending;
    canvasDeletionPending = false;
    return value;
}
