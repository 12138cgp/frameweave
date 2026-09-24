import type { CanvasConnection, CanvasNodeData, Position } from "../types";
import { getNodeDisplayName } from "./node-naming";

// 画布「一键排序」的四种自动排布。核心思想:把「组」当成一个整体单元(包围盒块)、散节点各自成单元,
// 对单元做布局,再把每个单元的成员按同一位移整体平移 → 组内相对结构不变、组永远保持相邻。
// 统一产出 nodeId → 新绝对位置(仅返回真的移动了的),由调用方转成 delta 单次 setNodes(天然一步可撤回)。
export type SortMode = "grid" | "type" | "lineage" | "name";

const COL_GAP = 120; // 单元横向间距
const ROW_GAP = 64; // 单元纵向间距
const BAND_GAP = 120; // 「按类型分区」各类型带之间的间距

// 「按类型分区/按名称编号」的类型先后顺序;组作为特殊类别排在最后。
const TYPE_ORDER: Record<string, number> = { image: 0, video: 1, audio: 2, text: 3, config: 4, storyboard: 5, sceneCamera: 6, stage: 7, __group__: 8 };
function typeRank(type: string): number {
    return type in TYPE_ORDER ? TYPE_ORDER[type] : 90;
}

type Unit = {
    key: string; // 组 = "g:"+groupId,散节点 = "n:"+nodeId
    memberIds: string[]; // 参与排布的成员节点 id(散节点=[自己])
    x: number;
    y: number;
    w: number;
    h: number; // 当前包围盒左上 + 尺寸
    type: string; // 分类型用:组 = "__group__",散节点 = node.type
    seq: number; // 稳定序 = 成员里最小 nameSeq(网格/名称排序用)
    nameKey: string; // 名称排序键
};

function boundingBox(nodes: CanvasNodeData[]): { x: number; y: number; w: number; h: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
        if (node.position.x < minX) minX = node.position.x;
        if (node.position.y < minY) minY = node.position.y;
        if (node.position.x + node.width > maxX) maxX = node.position.x + node.width;
        if (node.position.y + node.height > maxY) maxY = node.position.y + node.height;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// 把参与排布的节点组装成「单元」:同组的在册成员合成一个包围盒块,散节点各自成块。
function buildUnits(scopeNodes: CanvasNodeData[], groupByNode: Map<string, string>): Unit[] {
    const groupMembers = new Map<string, CanvasNodeData[]>();
    const singles: CanvasNodeData[] = [];
    for (const node of scopeNodes) {
        const groupId = groupByNode.get(node.id);
        if (groupId) {
            const arr = groupMembers.get(groupId);
            if (arr) arr.push(node);
            else groupMembers.set(groupId, [node]);
        } else {
            singles.push(node);
        }
    }
    const units: Unit[] = [];
    for (const [groupId, members] of groupMembers) {
        const box = boundingBox(members);
        let seq = Number.MAX_SAFE_INTEGER;
        for (const member of members) seq = Math.min(seq, member.nameSeq ?? Number.MAX_SAFE_INTEGER);
        units.push({ key: "g:" + groupId, memberIds: members.map((member) => member.id), x: box.x, y: box.y, w: box.w, h: box.h, type: "__group__", seq, nameKey: "组:" + groupId });
    }
    for (const node of singles) {
        units.push({ key: "n:" + node.id, memberIds: [node.id], x: node.position.x, y: node.position.y, w: node.width, h: node.height, type: node.type, seq: node.nameSeq ?? Number.MAX_SAFE_INTEGER, nameKey: getNodeDisplayName(node) });
    }
    return units;
}

// 把一批「已排好序」的单元铺成网格(≈√n 列,行高/列宽取该行/列最大;单元在格内居中)。
// 写入 unitDelta(unitKey → 位移),返回本网格底部 y(供「分区」逐带向下叠放)。
function gridPlace(units: Unit[], originX: number, originY: number, unitDelta: Map<string, Position>): number {
    if (units.length === 0) return originY;
    const cols = Math.max(1, Math.ceil(Math.sqrt(units.length)));
    const rows = Math.ceil(units.length / cols);
    const colWidths = new Array(cols).fill(0);
    const rowHeights = new Array(rows).fill(0);
    units.forEach((unit, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        if (unit.w > colWidths[col]) colWidths[col] = unit.w;
        if (unit.h > rowHeights[row]) rowHeights[row] = unit.h;
    });
    const colOffsets = new Array(cols).fill(0);
    for (let c = 1; c < cols; c++) colOffsets[c] = colOffsets[c - 1] + colWidths[c - 1] + COL_GAP;
    const rowOffsets = new Array(rows).fill(0);
    for (let r = 1; r < rows; r++) rowOffsets[r] = rowOffsets[r - 1] + rowHeights[r - 1] + ROW_GAP;
    units.forEach((unit, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const targetX = originX + colOffsets[col] + (colWidths[col] - unit.w) / 2;
        const targetY = originY + rowOffsets[row] + (rowHeights[row] - unit.h) / 2;
        unitDelta.set(unit.key, { x: targetX - unit.x, y: targetY - unit.y });
    });
    return originY + rowOffsets[rows - 1] + rowHeights[rows - 1];
}

// Kahn 拓扑分层(键为 unit.key,环安全:环里降不到 0 的统一压到最大层之后,绝不死循环)。
function unitLayers(units: Unit[], edges: { from: string; to: string }[]): Map<string, number> {
    const indegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const unit of units) {
        indegree.set(unit.key, 0);
        adjacency.set(unit.key, []);
    }
    for (const edge of edges) {
        adjacency.get(edge.from)!.push(edge.to);
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
    const layer = new Map<string, number>();
    let queue = units.filter((unit) => (indegree.get(unit.key) ?? 0) === 0).map((unit) => unit.key);
    queue.forEach((key) => layer.set(key, 0));
    const resolved = new Set<string>(queue);
    while (queue.length > 0) {
        const next: string[] = [];
        for (const key of queue) {
            const currentLayer = layer.get(key) ?? 0;
            for (const to of adjacency.get(key) ?? []) {
                const remaining = (indegree.get(to) ?? 0) - 1;
                indegree.set(to, remaining);
                layer.set(to, Math.max(layer.get(to) ?? 0, currentLayer + 1));
                if (remaining === 0 && !resolved.has(to)) {
                    resolved.add(to);
                    next.push(to);
                }
            }
        }
        queue = next;
    }
    let maxResolved = 0;
    for (const key of resolved) maxResolved = Math.max(maxResolved, layer.get(key) ?? 0);
    for (const unit of units) if (!resolved.has(unit.key)) layer.set(unit.key, maxResolved + 1);
    return layer;
}

// 族谱式:按「跨单元连线」把单元分层(源在左、生成结果在右),层内按当前 y 排;无跨单元连线时退化网格。
function lineagePlace(units: Unit[], connections: CanvasConnection[], originX: number, originY: number, unitDelta: Map<string, Position>): void {
    const nodeToUnit = new Map<string, string>();
    for (const unit of units) for (const id of unit.memberIds) nodeToUnit.set(id, unit.key);
    const seen = new Set<string>();
    const edges: { from: string; to: string }[] = [];
    for (const connection of connections) {
        const fromUnit = nodeToUnit.get(connection.fromNodeId);
        const toUnit = nodeToUnit.get(connection.toNodeId);
        if (!fromUnit || !toUnit || fromUnit === toUnit) continue;
        const key = fromUnit + "->" + toUnit;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: fromUnit, to: toUnit });
    }
    if (edges.length === 0) {
        gridPlace([...units].sort((a, b) => a.y - b.y || a.x - b.x), originX, originY, unitDelta);
        return;
    }
    // 只对「参与连线」的单元分层;无连线的孤立单元不塞进最左「源」列(否则污染族谱语义),另铺在下方。
    const touched = new Set<string>();
    for (const edge of edges) {
        touched.add(edge.from);
        touched.add(edge.to);
    }
    const connected = units.filter((unit) => touched.has(unit.key));
    const isolated = units.filter((unit) => !touched.has(unit.key));
    const layer = unitLayers(connected, edges);
    const buckets = new Map<number, Unit[]>();
    let maxLayer = 0;
    for (const unit of connected) {
        const lv = layer.get(unit.key) ?? 0;
        if (lv > maxLayer) maxLayer = lv;
        const bucket = buckets.get(lv);
        if (bucket) bucket.push(unit);
        else buckets.set(lv, [unit]);
    }
    let colX = originX;
    let bottomY = originY;
    for (let lv = 0; lv <= maxLayer; lv++) {
        const bucket = buckets.get(lv);
        if (!bucket || bucket.length === 0) continue;
        bucket.sort((a, b) => a.y - b.y || a.x - b.x);
        const colWidth = Math.max(...bucket.map((unit) => unit.w));
        let rowY = originY;
        for (const unit of bucket) {
            const targetX = colX + (colWidth - unit.w) / 2;
            unitDelta.set(unit.key, { x: targetX - unit.x, y: rowY - unit.y });
            rowY += unit.h + ROW_GAP;
        }
        if (rowY > bottomY) bottomY = rowY;
        colX += colWidth + COL_GAP;
    }
    // 无连线的孤立单元:铺在族谱带下方
    if (isolated.length > 0) {
        gridPlace([...isolated].sort((a, b) => a.y - b.y || a.x - b.x), originX, bottomY + BAND_GAP, unitDelta);
    }
}

// 主入口。scopeNodes = 已过滤(排除隐藏批次子)的参与排布节点。返回 nodeId → 新绝对位置(仅移动的)。
export function computeSortLayout(scopeNodes: CanvasNodeData[], connections: CanvasConnection[], groupByNode: Map<string, string>, mode: SortMode): Map<string, Position> {
    const result = new Map<string, Position>();
    const units = buildUnits(scopeNodes, groupByNode);
    if (units.length < 2) return result;

    // 以现有单元包围盒左上角为原点,排完留在原地附近、不跳到画布 0,0。
    const originX = Math.min(...units.map((unit) => unit.x));
    const originY = Math.min(...units.map((unit) => unit.y));
    const unitDelta = new Map<string, Position>();

    if (mode === "lineage") {
        lineagePlace(units, connections, originX, originY, unitDelta);
    } else if (mode === "type") {
        const buckets = new Map<string, Unit[]>();
        for (const unit of units) {
            const bucket = buckets.get(unit.type);
            if (bucket) bucket.push(unit);
            else buckets.set(unit.type, [unit]);
        }
        const orderedTypes = [...buckets.keys()].sort((a, b) => typeRank(a) - typeRank(b));
        let bandY = originY;
        for (const type of orderedTypes) {
            const bucket = buckets.get(type)!;
            bucket.sort((a, b) => a.seq - b.seq || a.nameKey.localeCompare(b.nameKey, "zh"));
            const bottom = gridPlace(bucket, originX, bandY, unitDelta);
            bandY = bottom + BAND_GAP;
        }
    } else if (mode === "name") {
        const ordered = [...units].sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.seq - b.seq || a.nameKey.localeCompare(b.nameKey, "zh"));
        gridPlace(ordered, originX, originY, unitDelta);
    } else {
        // grid:保持大致阅读顺序(当前位置)收拾成整齐网格
        gridPlace([...units].sort((a, b) => a.y - b.y || a.x - b.x), originX, originY, unitDelta);
    }

    // 单元位移 → 各成员新绝对位置(整块平移,组内结构不变)
    const posById = new Map<string, Position>();
    for (const node of scopeNodes) posById.set(node.id, node.position);
    for (const unit of units) {
        const delta = unitDelta.get(unit.key);
        if (!delta) continue;
        if (Math.abs(delta.x) < 0.5 && Math.abs(delta.y) < 0.5) continue;
        for (const id of unit.memberIds) {
            const pos = posById.get(id);
            if (pos) result.set(id, { x: pos.x + delta.x, y: pos.y + delta.y });
        }
    }
    return result;
}
