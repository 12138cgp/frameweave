"use client";

import type { RevTombstoneMap, TombstoneMap } from "@/services/sync-tombstones";

// 同步合并的纯逻辑：从 app-sync 抽出，供云端同步与本机持久化护栏共用，避免 store ↔ app-sync 循环依赖。

// 条目新鲜度：updatedAt 优先（状态更新场景，如断点续传把日志改成功），回退域默认时间键
export function getItemTime(item: Record<string, unknown>, timeKey: string) {
    return getTime(item, "updatedAt") || getTime(item, timeKey);
}

function getTime(item: Record<string, unknown>, key: string) {
    const value = item[key];
    if (typeof value === "number") return value;
    if (typeof value === "string") return Date.parse(value) || 0;
    return 0;
}

// 画布「有内容」判定：有节点或连线即非空。用于「空不覆盖非空」数据安全护栏。
export function isCanvasContentful(p: { nodes?: unknown[]; connections?: unknown[] }) {
    return (p.nodes?.length ?? 0) > 0 || (p.connections?.length ?? 0) > 0;
}

export function mergeById<T extends { id?: string }>(local: T[], remote: T[], timeKey: string, tombstones: TombstoneMap = {}, isContentful?: (item: T) => boolean) {
    const items = new Map<string, T>();
    remote.forEach((item) => {
        const id = item.id || "";
        if (id) items.set(id, item);
    });
    local.forEach((item) => {
        const id = item.id || "";
        if (!id) return;
        const current = items.get(id);
        if (!current) {
            items.set(id, item);
            return;
        }
        // 数据安全护栏：同一条目，「有内容」的一方永不被「空」的一方覆盖（无论谁的 updatedAt 更新），
        // 仅当两边都有内容、或都为空时，才按 updatedAt 取较新者。防止「较新的空画布」冲掉「较旧的有内容画布」。
        if (isContentful) {
            const localHas = isContentful(item);
            const currentHas = isContentful(current);
            if (localHas !== currentHas) {
                if (localHas) items.set(id, item);
                return;
            }
        }
        if (getItemTime(item as Record<string, unknown>, timeKey) >= getItemTime(current as Record<string, unknown>, timeKey)) items.set(id, item);
    });
    // 墓碑仲裁：条目在删除之后又被更新（异地编辑/重建）则条目胜出、墓碑原地作废；否则条目随删除出局
    Object.entries(tombstones).forEach(([id, deletedAt]) => {
        const item = items.get(id);
        if (!item) return;
        if (getItemTime(item as Record<string, unknown>, timeKey) > (Date.parse(deletedAt) || 0)) delete tombstones[id];
        else items.delete(id);
    });
    return Array.from(items.values()).sort((a, b) => getItemTime(b as Record<string, unknown>, timeKey) - getItemTime(a as Record<string, unknown>, timeKey));
}

// ───────────────── 画布域：节点/连线级深合并（根治多设备整项目 LWW 丢内容）─────────────────

type RevEntity = { id?: string; rev?: number; updatedAt?: string };
type CanvasProjectLike = {
    id?: string;
    updatedAt?: string;
    nodes?: RevEntity[];
    connections?: Array<RevEntity & { fromNodeId?: string; toNodeId?: string }>;
    groups?: Array<{ id?: string; memberNodeIds?: string[] }>;
};

function entityRev(item: RevEntity) {
    return item.rev || 0;
}

// 节点/连线仲裁：先比 rev（单调逻辑时钟），相等/缺失再退墙钟 updatedAt。
export function entityNewer(a: RevEntity, b: RevEntity) {
    const ra = entityRev(a);
    const rb = entityRev(b);
    if (ra !== rb) return ra > rb;
    return getItemTime(a as Record<string, unknown>, "updatedAt") >= getItemTime(b as Record<string, unknown>, "updatedAt");
}

// 并集合并实体 + rev 墓碑仲裁。localEdited：该 id 是否本机真编辑过（抗 TTL-GC 复活）。
function mergeRevEntities<T extends RevEntity>(local: T[], remote: T[], tombstones: RevTombstoneMap, localEdited: (id: string) => boolean): Map<string, T> {
    const items = new Map<string, T>();
    const remoteIds = new Set<string>();
    remote.forEach((it) => {
        if (it.id) {
            items.set(it.id, it);
            remoteIds.add(it.id);
        }
    });
    local.forEach((it) => {
        if (!it.id) return;
        const cur = items.get(it.id);
        if (!cur) {
            items.set(it.id, it);
            return;
        }
        if (entityNewer(it, cur)) items.set(it.id, it);
    });
    // rev 墓碑仲裁：仅当实体 rev 推进过墓碑 rev（删除后又被真编辑/重建）才复活、墓碑作废；否则随删除出局。
    Object.entries(tombstones).forEach(([id, t]) => {
        const it = items.get(id);
        if (!it) return;
        if (entityRev(it) > (t.rev || 0)) delete tombstones[id];
        else items.delete(id);
    });
    // 抗 TTL-GC 复活：rev=0（本机从没真编辑过）且远端也没有的实体，只能是本机陈旧残留，不得凭空注入。
    for (const [id, it] of Array.from(items.entries())) {
        if (entityRev(it) === 0 && !remoteIds.has(id) && !localEdited(id)) items.delete(id);
    }
    return items;
}

function mergeGroups<G extends { id?: string; memberNodeIds?: string[] }>(local: G[], remote: G[], aliveNodes: { has: (id: string) => boolean }, preferLocal: boolean): G[] {
    const map = new Map<string, G>();
    // 同 id 组冲突：取「项目 updatedAt 较新的一方」(preferLocal=本地较新)，另一方仅补缺(保留跨设备新建的组)。
    // 原为无条件远端优先——分组没有自己的时间戳、本地重命名(会 bump 项目 updatedAt)却永远打不赢云端旧名，
    // 合并在上传前就把新名换回旧名，形成死结 → 重命名"第二天"退回未命名。改随项目基底方后本地重命名能稳定胜出。
    const primary = preferLocal ? local : remote;
    const secondary = preferLocal ? remote : local;
    primary.forEach((g) => g.id && map.set(g.id, g));
    secondary.forEach((g) => {
        if (g.id && !map.has(g.id)) map.set(g.id, g);
    });
    const out: G[] = [];
    for (const g of map.values()) {
        const members = (g.memberNodeIds || []).filter((nid) => aliveNodes.has(nid));
        if (members.length === 0) continue; // 成员全不存活 → 空组丢弃
        out.push({ ...g, memberNodeIds: members });
    }
    return out;
}

// 画布域深合并：项目并集；同 id 项目下沉到节点/连线级并集（rev 仲裁 + 墓碑），杜绝整项目 LWW 丢内容。
// 入参的 *Tombstones 会被原地修剪（失效墓碑删除），与 mergeById 同约定。
export function mergeCanvasProjects<P extends CanvasProjectLike>(
    local: P[],
    remote: P[],
    projectTombstones: TombstoneMap,
    nodeTombstones: RevTombstoneMap,
    connTombstones: RevTombstoneMap,
    localEditedNode: (id: string) => boolean = () => false,
): P[] {
    const localMap = new Map<string, P>();
    const remoteMap = new Map<string, P>();
    local.forEach((p) => p.id && localMap.set(p.id, p));
    remote.forEach((p) => p.id && remoteMap.set(p.id, p));
    const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);

    const result: P[] = [];
    for (const id of allIds) {
        const l = localMap.get(id);
        const r = remoteMap.get(id);
        if (l && !r) {
            result.push(l);
            continue;
        }
        if (r && !l) {
            result.push(r);
            continue;
        }
        const lHas = isCanvasContentful(l as { nodes?: unknown[]; connections?: unknown[] });
        const rHas = isCanvasContentful(r as { nodes?: unknown[]; connections?: unknown[] });
        if (lHas !== rHas) {
            result.push(lHas ? (l as P) : (r as P)); // 非空恒胜空（沿用项目级护栏）
            continue;
        }
        const nodes = mergeRevEntities(l!.nodes || [], r!.nodes || [], nodeTombstones, localEditedNode);
        const conns = mergeRevEntities(l!.connections || [], r!.connections || [], connTombstones, () => true);
        const aliveConns = Array.from(conns.values()).filter((c) => {
            const cc = c as { fromNodeId?: string; toNodeId?: string };
            return !!cc.fromNodeId && !!cc.toNodeId && nodes.has(cc.fromNodeId) && nodes.has(cc.toNodeId); // 悬空连线丢弃
        });
        // 项目元信息（title/viewport/背景/chatSessions/分组等）取 updatedAt 较新方为基底；分组也随此基底方，保持一致。
        const localIsBase = getItemTime(l as Record<string, unknown>, "updatedAt") >= getItemTime(r as Record<string, unknown>, "updatedAt");
        const base = localIsBase ? l! : r!;
        const groups = mergeGroups(l!.groups || [], r!.groups || [], nodes, localIsBase);
        result.push({ ...(base as P), nodes: Array.from(nodes.values()), connections: aliveConns, groups } as P);
    }
    // 项目级墓碑仲裁（整项目删除）：项目更新晚于删除则复活、墓碑作废；否则随删除出局。
    Object.entries(projectTombstones).forEach(([id, deletedAt]) => {
        const idx = result.findIndex((p) => p.id === id);
        if (idx < 0) return;
        if (getItemTime(result[idx] as Record<string, unknown>, "updatedAt") > (Date.parse(deletedAt) || 0)) delete projectTombstones[id];
        else result.splice(idx, 1);
    });
    return result.sort((a, b) => getItemTime(b as Record<string, unknown>, "updatedAt") - getItemTime(a as Record<string, unknown>, "updatedAt"));
}
