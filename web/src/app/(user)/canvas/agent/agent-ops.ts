import { nanoid } from "nanoid";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ViewportTransform } from "../types";
import { getNodeDisplayName } from "../utils/node-naming";

// 画布助手的工具执行器。所有写操作都在这里落地。
//
// ⚠️ 全文最重要的一条铁律：**绝不整份替换 nodes / connections 数组，只能 map 既有数组。**
//
// 原因在 stores/use-canvas-store.ts:68 stampNodes：它把「旧数组里有、新数组里没有」的实体
// 算作 removed 并**落墓碑**。墓碑会跨设备生效 = 真删除。
// 所以助手只要有一次拿着不完整的数组调 setNodes，没带上的节点就会被当成用户删除，
// 而且是静默的、跨设备的、事后很难查的。必须 prev => prev.map(...)。
//
// 好消息是 rev 不用我们操心：stampNodes / stampConns 会自动按内容签名推 rev、记 updatedAt。
// 手动塞 rev 反而会打乱它的单调性。
//
// 第二条：metadata 走白名单。imageJobId / videoTaskId / storageKey / rev 这些跟扣费退款
// 直接挂钩的字段，模型永远碰不到——任务号被抹掉就是钱找不回来。
// 第一阶段的工具压根不改 metadata，这个白名单是给二期兜底的。

export type AgentCanvasApi = {
    getNodes: () => CanvasNodeData[];
    getConnections: () => CanvasConnection[];
    getSelectedNodeIds: () => Set<string>;
    getViewport: () => ViewportTransform;
    getViewportSize: () => { width: number; height: number };
    setNodes: (updater: (prev: CanvasNodeData[]) => CanvasNodeData[]) => void;
    setConnections: (updater: (prev: CanvasConnection[]) => CanvasConnection[]) => void;
    setSelectedNodeIds: (ids: Set<string>) => void;
    setViewport: (viewport: ViewportTransform) => void;
    createTextNode: (text: string, position: { x: number; y: number }, title?: string) => CanvasNodeData;
    /** 建一个待生成的图片/视频节点（不出图、不花钱）。转调画布自己的 createCanvasNode。 */
    createGenerationNode: (
        type: "image" | "video",
        prompt: string,
        position: { x: number; y: number },
        config?: { size?: string; quality?: string },
    ) => CanvasNodeData;
    /** 跑生成。转调 handleGenerateNode —— 和用户手动点生成完全同一条路径。 */
    generateNode: (nodeId: string, prompt?: string) => Promise<{ ok: boolean; message: string }>;
};

export type AgentOpResult = {
    ok: boolean;
    /** 回给模型的结果，会被 JSON.stringify 塞进 role=tool 的消息里 */
    payload: Record<string, unknown>;
};

const MAX_READ = 200;
const SUMMARY_TEXT = 80;

/** 只返回摘要字段。不给 content 正文、不给 storageKey——
 *  5000 个节点的画布，全字段返回一次就能把上下文打爆，而且 storageKey 没有给模型的理由。 */
function summarize(node: CanvasNodeData, connections: CanvasConnection[]): Record<string, unknown> {
    const m = node.metadata || {};
    const raw = String(m.promptDraft || m.prompt || (node.type === CanvasNodeType.Text ? m.content : "") || "");
    const text = raw.slice(0, SUMMARY_TEXT);
    let inbound = 0;
    let outbound = 0;
    for (const c of connections) {
        if (c.toNodeId === node.id) inbound += 1;
        if (c.fromNodeId === node.id) outbound += 1;
    }
    const out: Record<string, unknown> = {
        id: node.id,
        type: node.type,
        name: getNodeDisplayName(node),
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
        width: Math.round(node.width),
        height: Math.round(node.height),
        inbound,
        outbound,
    };
    if (text) out.text = text;
    if (raw.length > SUMMARY_TEXT) out.textTruncated = true;
    if (m.status) out.status = m.status;
    const hasContent = Boolean(m.content);
    out.generated = hasContent;
    return out;
}

function clampLimit(value: unknown, fallback: number, max: number) {
    const n = typeof value === "number" ? value : fallback;
    if (!Number.isFinite(n) || n <= 0) return fallback;
    if (n > max) return max;
    return Math.floor(n);
}

function nodeIdList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const v of value) {
        if (typeof v === "string" && v) out.push(v);
    }
    return out;
}

export async function runAgentOp(
    name: string,
    args: Record<string, unknown>,
    api: AgentCanvasApi,
    journal?: AgentJournal,
): Promise<AgentOpResult> {
    const nodes = api.getNodes();
    const connections = api.getConnections();
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // ── 读 ──────────────────────────────────────────────────────────────
    if (name === "canvas_get_selection") {
        const ids = api.getSelectedNodeIds();
        const picked: Record<string, unknown>[] = [];
        for (const n of nodes) {
            if (ids.has(n.id)) picked.push(summarize(n, connections));
        }
        return { ok: true, payload: { count: picked.length, nodes: picked } };
    }

    if (name === "canvas_get_viewport") {
        const vp = api.getViewport();
        const size = api.getViewportSize();
        const limit = clampLimit(args.limit, 60, MAX_READ);
        // 屏幕坐标 = 世界坐标 * k + offset，反解出世界坐标系里的可视矩形
        const left = -vp.x / vp.k;
        const top = -vp.y / vp.k;
        const right = left + size.width / vp.k;
        const bottom = top + size.height / vp.k;
        const picked: Record<string, unknown>[] = [];
        for (const n of nodes) {
            if (picked.length >= limit) break;
            const nr = n.position.x + n.width;
            const nb = n.position.y + n.height;
            if (nr < left || n.position.x > right || nb < top || n.position.y > bottom) continue;
            picked.push(summarize(n, connections));
        }
        return { ok: true, payload: { count: picked.length, truncated: picked.length >= limit, nodes: picked } };
    }

    if (name === "canvas_query_nodes") {
        const limit = clampLimit(args.limit, 40, 100);
        const wantType = typeof args.type === "string" ? args.type : "";
        const keyword = String(args.keyword || "").trim().toLowerCase();
        const matched: CanvasNodeData[] = [];
        for (const n of nodes) {
            if (wantType && String(n.type) !== wantType) continue;
            if (keyword) {
                const m = n.metadata || {};
                const hay = (getNodeDisplayName(n) + " " + String(m.promptDraft || m.prompt || "")).toLowerCase();
                if (hay.indexOf(keyword) < 0) continue;
            }
            matched.push(n);
        }
        const start = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
        const page = matched.slice(start, start + limit);
        const picked: Record<string, unknown>[] = [];
        for (const n of page) picked.push(summarize(n, connections));
        return { ok: true, payload: { total: matched.length, offset: start, returned: picked.length, nodes: picked } };
    }

    // ── 写 ──────────────────────────────────────────────────────────────
    if (name === "canvas_move_nodes") {
        const moves = Array.isArray(args.moves) ? args.moves : [];
        const target = new Map<string, { x: number; y: number }>();
        const unknown: string[] = [];
        for (const raw of moves) {
            if (!raw || typeof raw !== "object") continue;
            const m = raw as Record<string, unknown>;
            const id = typeof m.nodeId === "string" ? m.nodeId : "";
            if (!id) continue;
            if (!byId.has(id)) {
                unknown.push(id);
                continue;
            }
            const x = typeof m.x === "number" ? m.x : NaN;
            const y = typeof m.y === "number" ? m.y : NaN;
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            target.set(id, { x, y });
        }
        if (!target.size) return { ok: false, payload: { error: "没有任何有效的移动项", unknownNodeIds: unknown } };
        // ⚠️ map 既有数组，绝不整份替换
        api.setNodes((prev) =>
            prev.map((n) => {
                const t = target.get(n.id);
                if (!t) return n;
                return { ...n, position: { x: t.x, y: t.y } };
            }),
        );
        return { ok: true, payload: { moved: target.size, unknownNodeIds: unknown } };
    }

    if (name === "canvas_resize_nodes") {
        const sizes = Array.isArray(args.sizes) ? args.sizes : [];
        const target = new Map<string, { width: number; height: number }>();
        const unknown: string[] = [];
        for (const raw of sizes) {
            if (!raw || typeof raw !== "object") continue;
            const s = raw as Record<string, unknown>;
            const id = typeof s.nodeId === "string" ? s.nodeId : "";
            if (!id) continue;
            if (!byId.has(id)) {
                unknown.push(id);
                continue;
            }
            const w = typeof s.width === "number" ? s.width : NaN;
            const h = typeof s.height === "number" ? s.height : NaN;
            if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
            target.set(id, { width: Math.max(80, w), height: Math.max(60, h) });
        }
        if (!target.size) return { ok: false, payload: { error: "没有任何有效的尺寸项", unknownNodeIds: unknown } };
        api.setNodes((prev) =>
            prev.map((n) => {
                const t = target.get(n.id);
                if (!t) return n;
                return { ...n, width: t.width, height: t.height };
            }),
        );
        return { ok: true, payload: { resized: target.size, unknownNodeIds: unknown } };
    }

    if (name === "canvas_connect_nodes") {
        const links = Array.isArray(args.links) ? args.links : [];
        const exists = new Set<string>();
        for (const c of connections) exists.add(c.fromNodeId + "|" + c.toNodeId);
        const added: CanvasConnection[] = [];
        let skipped = 0;
        const unknown: string[] = [];
        for (const raw of links) {
            if (!raw || typeof raw !== "object") continue;
            const l = raw as Record<string, unknown>;
            const from = typeof l.fromNodeId === "string" ? l.fromNodeId : "";
            const to = typeof l.toNodeId === "string" ? l.toNodeId : "";
            if (!from || !to || from === to) {
                skipped += 1;
                continue;
            }
            if (!byId.has(from)) unknown.push(from);
            if (!byId.has(to)) unknown.push(to);
            if (!byId.has(from) || !byId.has(to)) continue;
            const key = from + "|" + to;
            if (exists.has(key)) {
                skipped += 1;
                continue;
            }
            exists.add(key);
            added.push({ id: nanoid(), fromNodeId: from, toNodeId: to });
        }
        if (!added.length) return { ok: false, payload: { error: "没有新增任何连线", skipped, unknownNodeIds: unknown } };
        api.setConnections((prev) => [...prev, ...added]);
        if (journal) {
            for (const c of added) journal.addedConnectionIds.push(c.id);
        }
        return { ok: true, payload: { added: added.length, skipped, unknownNodeIds: unknown } };
    }

    if (name === "canvas_disconnect_nodes") {
        const links = Array.isArray(args.links) ? args.links : [];
        const drop = new Set<string>();
        for (const raw of links) {
            if (!raw || typeof raw !== "object") continue;
            const l = raw as Record<string, unknown>;
            const from = typeof l.fromNodeId === "string" ? l.fromNodeId : "";
            const to = typeof l.toNodeId === "string" ? l.toNodeId : "";
            if (from && to) drop.add(from + "|" + to);
        }
        if (!drop.size) return { ok: false, payload: { error: "没有指定要断开的连线" } };
        let removed = 0;
        for (const c of connections) {
            if (drop.has(c.fromNodeId + "|" + c.toNodeId)) removed += 1;
        }
        if (!removed) return { ok: false, payload: { error: "这些连线本来就不存在", removed: 0 } };
        if (journal) {
            for (const c of connections) {
                if (drop.has(c.fromNodeId + "|" + c.toNodeId)) journal.removedConnections.push({ ...c });
            }
        }
        api.setConnections((prev) => prev.filter((c) => !drop.has(c.fromNodeId + "|" + c.toNodeId)));
        return { ok: true, payload: { removed } };
    }

    if (name === "canvas_select_nodes") {
        const ids = nodeIdList(args.nodeIds);
        const valid = ids.filter((id) => byId.has(id));
        api.setSelectedNodeIds(new Set(valid));
        return { ok: true, payload: { selected: valid.length, ignored: ids.length - valid.length } };
    }

    if (name === "canvas_set_viewport") {
        const ids = nodeIdList(args.nodeIds);
        if (ids.length) {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let hit = 0;
            for (const id of ids) {
                const n = byId.get(id);
                if (!n) continue;
                hit += 1;
                if (n.position.x < minX) minX = n.position.x;
                if (n.position.y < minY) minY = n.position.y;
                if (n.position.x + n.width > maxX) maxX = n.position.x + n.width;
                if (n.position.y + n.height > maxY) maxY = n.position.y + n.height;
            }
            if (!hit) return { ok: false, payload: { error: "给的节点 id 一个都不存在" } };
            const size = api.getViewportSize();
            const pad = 80;
            const w = Math.max(1, maxX - minX + pad * 2);
            const h = Math.max(1, maxY - minY + pad * 2);
            let k = Math.min(size.width / w, size.height / h);
            if (!Number.isFinite(k) || k <= 0) k = 1;
            if (k > 2) k = 2;
            if (k < 0.05) k = 0.05;
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            api.setViewport({ k, x: size.width / 2 - cx * k, y: size.height / 2 - cy * k });
            return { ok: true, payload: { framed: hit, k: Number(k.toFixed(3)) } };
        }
        const vp = api.getViewport();
        const x = typeof args.x === "number" ? args.x : vp.x;
        const y = typeof args.y === "number" ? args.y : vp.y;
        let k = typeof args.k === "number" ? args.k : vp.k;
        if (!Number.isFinite(k) || k <= 0) k = vp.k;
        if (k > 3) k = 3;
        if (k < 0.05) k = 0.05;
        api.setViewport({ x, y, k });
        return { ok: true, payload: { x: Math.round(x), y: Math.round(y), k: Number(k.toFixed(3)) } };
    }

    if (name === "canvas_create_text_node") {
        const text = String(args.text || "").trim();
        if (!text) return { ok: false, payload: { error: "文本内容不能为空" } };
        const vp = api.getViewport();
        const size = api.getViewportSize();
        let x = typeof args.x === "number" ? args.x : (size.width / 2 - vp.x) / vp.k;
        let y = typeof args.y === "number" ? args.y : (size.height / 2 - vp.y) / vp.k;
        if (!Number.isFinite(x)) x = 0;
        if (!Number.isFinite(y)) y = 0;
        const title = typeof args.title === "string" ? args.title : undefined;
        // 转调画布自己的建节点函数：它会补 nameSeq，否则「@图片3」这类引用编号会整体错乱
        const node = api.createTextNode(text, { x, y }, title);
        if (journal) journal.createdNodeIds.push(node.id);
        return { ok: true, payload: { nodeId: node.id, name: getNodeDisplayName(node) } };
    }

    if (name === "canvas_create_generation_node") {
        const kind = args.type === "video" ? "video" : "image";
        const prompt = String(args.prompt || "").trim();
        if (!prompt) return { ok: false, payload: { error: "提示词不能为空" } };
        const vp = api.getViewport();
        const size = api.getViewportSize();
        let x = typeof args.x === "number" ? args.x : (size.width / 2 - vp.x) / vp.k;
        let y = typeof args.y === "number" ? args.y : (size.height / 2 - vp.y) / vp.k;
        if (!Number.isFinite(x)) x = 0;
        if (!Number.isFinite(y)) y = 0;
        const refs = nodeIdList(args.referenceNodeIds).filter((id) => byId.has(id));
        // ⚠️ 光连线不算「用到参考素材」：平台判据是提示词里含 @[node:<id>] 或解析后的「图片N」标签
        //（canvas-node-generation.ts:154-155）。不写 token 就会弹「有参考素材没用到」，
        // 而且模型也不知道该拿这张图干嘛。所以这里把 @1 @2 换成正式 token，漏掉的自动补在末尾。
        const withTokens = injectReferenceTokens(prompt, refs);
        const node = api.createGenerationNode(kind, withTokens, { x, y }, {
            size: typeof args.size === "string" ? args.size : undefined,
            quality: typeof args.quality === "string" ? args.quality : undefined,
        });
        if (journal) journal.createdNodeIds.push(node.id);
        if (refs.length) {
            const added: CanvasConnection[] = refs.filter((id) => id !== node.id).map((from) => ({ id: nanoid(), fromNodeId: from, toNodeId: node.id }));
            api.setConnections((prev) => [...prev, ...added]);
            if (journal) {
                for (const c of added) journal.addedConnectionIds.push(c.id);
            }
        }
        return { ok: true, payload: { nodeId: node.id, type: kind, references: refs.length } };
    }

    if (name === "canvas_set_node_config") {
        const id = typeof args.nodeId === "string" ? args.nodeId : "";
        const node = byId.get(id);
        if (!node) return { ok: false, payload: { error: "没有这个节点：" + id } };
        if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) {
            return { ok: false, payload: { error: "只能改图片或视频节点的配置" } };
        }
        const patch: Record<string, string> = {};
        if (typeof args.size === "string" && args.size) patch.size = args.size;
        if (typeof args.quality === "string" && args.quality) {
            // 图片存 quality（1k/2k/4k），视频存 vquality（480/720/1080/2160，不带 p）
            if (node.type === CanvasNodeType.Video) patch.vquality = args.quality.replace(/p$/i, "");
            else patch.quality = args.quality;
        }
        let nextPrompt = "";
        if (typeof args.prompt === "string" && args.prompt.trim()) {
            const inbound: string[] = [];
            for (const c of connections) {
                if (c.toNodeId === id) inbound.push(c.fromNodeId);
            }
            nextPrompt = injectReferenceTokens(args.prompt.trim(), inbound);
        }
        if (!Object.keys(patch).length && !nextPrompt) return { ok: false, payload: { error: "没有指定要改什么" } };
        api.setNodes((prev) =>
            prev.map((n) => {
                if (n.id !== id) return n;
                const meta = { ...n.metadata, ...patch };
                if (nextPrompt) {
                    meta.prompt = nextPrompt;
                    meta.promptDraft = nextPrompt;
                }
                return { ...n, metadata: meta };
            }),
        );
        return { ok: true, payload: { nodeId: id, changed: { ...patch, prompt: nextPrompt ? "已更新" : undefined } } };
    }

    if (name === "canvas_generate_node") {
        const id = typeof args.nodeId === "string" ? args.nodeId : "";
        const node = byId.get(id);
        if (!node) return { ok: false, payload: { error: "没有这个节点：" + id } };
        if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) {
            return { ok: false, payload: { error: "只能对图片或视频节点跑生成，这个是 " + String(node.type) } };
        }
        const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
        const result = await api.generateNode(id, prompt);
        if (!result.ok) return { ok: false, payload: { error: result.message } };
        return { ok: true, payload: { nodeId: id, result: result.message } };
    }

    return { ok: false, payload: { error: "不认识的工具：" + name } };
}

/** 一次助手回合的记账。撤销靠它精确回退，而不是整份还原——
 *  整份还原会把用户在这期间手动加的东西一起抹掉（stampConns 会给它们落墓碑 = 跨设备真删）。 */
export type AgentJournal = {
    /** 回合开始时各节点的位置尺寸，用于回退 move/resize */
    geometry: Array<{ id: string; x: number; y: number; width: number; height: number }>;
    createdNodeIds: string[];
    addedConnectionIds: string[];
    removedConnections: CanvasConnection[];
};

export function startJournal(nodes: CanvasNodeData[]): AgentJournal {
    const geometry: AgentJournal["geometry"] = [];
    for (const n of nodes) {
        geometry.push({ id: n.id, x: n.position.x, y: n.position.y, width: n.width, height: n.height });
    }
    return { geometry, createdNodeIds: [], addedConnectionIds: [], removedConnections: [] };
}

export function journalTouched(j: AgentJournal) {
    return j.createdNodeIds.length > 0 || j.addedConnectionIds.length > 0 || j.removedConnections.length > 0;
}

/** 精确撤销：只回退这一回合动过的东西，不碰其它。 */
export function undoJournal(j: AgentJournal, api: AgentCanvasApi) {
    const geo = new Map(j.geometry.map((g) => [g.id, g]));
    const created = new Set(j.createdNodeIds);
    api.setNodes((prev) => {
        const kept = prev.filter((n) => !created.has(n.id));
        return kept.map((n) => {
            const g = geo.get(n.id);
            if (!g) return n;
            if (n.position.x === g.x && n.position.y === g.y && n.width === g.width && n.height === g.height) return n;
            return { ...n, position: { x: g.x, y: g.y }, width: g.width, height: g.height };
        });
    });
    const addedIds = new Set(j.addedConnectionIds);
    api.setConnections((prev) => {
        const kept = prev.filter((c) => !addedIds.has(c.id));
        const have = new Set(kept.map((c) => c.fromNodeId + "|" + c.toNodeId));
        const back: CanvasConnection[] = [];
        for (const c of j.removedConnections) {
            if (have.has(c.fromNodeId + "|" + c.toNodeId)) continue;
            back.push({ ...c });
        }
        return [...kept, ...back];
    });
}

/**
 * 把提示词里的 @1 @2 换成平台正式的 @[node:<id>] 引用，并把没被提到的参考素材补在末尾。
 *
 * 为什么必须做：平台判「参考素材有没有被用到」看的是提示词里有没有
 * @[node:<id>] token 或解析后的「图片N」标签（canvas-node-generation.ts:154-155）。
 * 只连线不写 token 会弹「有参考素材没用到」，而且模型也不知道该拿这张图干嘛。
 */
export function injectReferenceTokens(prompt: string, referenceNodeIds: string[]) {
    if (!referenceNodeIds.length) return prompt;
    let out = prompt;
    const used = new Set<string>();
    for (let i = 0; i < referenceNodeIds.length; i += 1) {
        const id = referenceNodeIds[i];
        const token = "@[node:" + id + "]";
        if (out.indexOf(token) >= 0) {
            used.add(id);
            continue;
        }
        // @1 / @2 …（从 1 开始数），只换独立出现的那些
        const mark = new RegExp("@" + String(i + 1) + "(?![0-9])", "g");
        if (mark.test(out)) {
            out = out.replace(mark, token);
            used.add(id);
        }
    }
    const missing = referenceNodeIds.filter((id) => !used.has(id));
    if (!missing.length) return out;
    const tail = missing.map((id) => "@[node:" + id + "]").join(" ");
    return out.trim() + "\n\n参考素材：" + tail;
}
