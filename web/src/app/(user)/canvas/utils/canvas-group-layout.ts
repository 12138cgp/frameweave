import type { CanvasConnection, CanvasNodeData, Position } from "../types";

const COL_GAP = 120;
const ROW_GAP = 48;

// 组内自动排序：按连线流向把成员分层（左→右），层内按原垂直顺序排行。
// 输入：组成员节点 + 全量连线（内部自动裁剪成组内子图）。
// 输出：仅包含「位置需要变化」的节点 id → 新位置（世界坐标）。
export function computeGroupLayout(members: CanvasNodeData[], connections: CanvasConnection[]): Map<string, Position> {
    const result = new Map<string, Position>();
    if (members.length < 2) return result;

    const memberIds = new Set(members.map((node) => node.id));
    // 组内子图：只保留两端都在组内、且非自环的连线（去重）
    const edgeSet = new Set<string>();
    const edges: { from: string; to: string }[] = [];
    for (const connection of connections) {
        if (!memberIds.has(connection.fromNodeId) || !memberIds.has(connection.toNodeId)) continue;
        if (connection.fromNodeId === connection.toNodeId) continue;
        const key = `${connection.fromNodeId}->${connection.toNodeId}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({ from: connection.fromNodeId, to: connection.toNodeId });
    }

    // 无任何组内连线 → 退化成网格布局
    if (edges.length === 0) return gridLayout(members, result);

    const layer = topologicalLayers(members, edges);

    // 把成员按层分桶；层内保持原有垂直顺序（y 升序，y 相同按 x）
    const buckets = new Map<number, CanvasNodeData[]>();
    let maxLayer = 0;
    for (const node of members) {
        const lv = layer.get(node.id) ?? 0;
        maxLayer = Math.max(maxLayer, lv);
        const bucket = buckets.get(lv);
        if (bucket) bucket.push(node);
        else buckets.set(lv, [node]);
    }

    // 整体原点：以现有成员包围盒左上角为基准，避免排序后整组跳到别处
    const originX = Math.min(...members.map((node) => node.position.x));
    const originY = Math.min(...members.map((node) => node.position.y));

    let colX = originX;
    for (let lv = 0; lv <= maxLayer; lv++) {
        const bucket = buckets.get(lv);
        if (!bucket || bucket.length === 0) continue;
        bucket.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
        const colWidth = Math.max(...bucket.map((node) => node.width));
        let rowY = originY;
        for (const node of bucket) {
            // 同层节点水平居中对齐到列中线
            const x = colX + (colWidth - node.width) / 2;
            place(result, node, x, rowY);
            rowY += node.height + ROW_GAP;
        }
        colX += colWidth + COL_GAP;
    }

    return result;
}

// Kahn 拓扑分层：每个节点的层 = 其所有上游层的最大值 + 1。
// 环：被环卡住、入度始终降不到 0 的剩余节点统一压到当前最大层之后，绝不死循环。
function topologicalLayers(members: CanvasNodeData[], edges: { from: string; to: string }[]): Map<string, number> {
    const indegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const node of members) {
        indegree.set(node.id, 0);
        adjacency.set(node.id, []);
    }
    for (const edge of edges) {
        adjacency.get(edge.from)!.push(edge.to);
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }

    const layer = new Map<string, number>();
    let queue = members.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
    queue.forEach((id) => layer.set(id, 0));
    const resolved = new Set<string>(queue);

    while (queue.length > 0) {
        const next: string[] = [];
        for (const id of queue) {
            const currentLayer = layer.get(id) ?? 0;
            for (const to of adjacency.get(id) ?? []) {
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

    // 环里的孤岛节点：未被解析的，统一放到已知最大层 + 1
    const maxResolvedLayer = resolved.size ? Math.max(...Array.from(resolved).map((id) => layer.get(id) ?? 0)) : 0;
    for (const node of members) {
        if (!resolved.has(node.id)) layer.set(node.id, maxResolvedLayer + 1);
    }

    return layer;
}

// 网格退化布局：合理列数（≈√n，向上取整）逐行铺开。行高/列宽取该行/列最大尺寸。
function gridLayout(members: CanvasNodeData[], result: Map<string, Position>): Map<string, Position> {
    const sorted = [...members].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
    const originX = Math.min(...members.map((node) => node.position.x));
    const originY = Math.min(...members.map((node) => node.position.y));

    // 预先算每行高、每列宽
    const rowCount = Math.ceil(sorted.length / cols);
    const rowHeights = new Array(rowCount).fill(0);
    const colWidths = new Array(cols).fill(0);
    sorted.forEach((node, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        rowHeights[row] = Math.max(rowHeights[row], node.height);
        colWidths[col] = Math.max(colWidths[col], node.width);
    });

    const colOffsets = new Array(cols).fill(0);
    for (let c = 1; c < cols; c++) colOffsets[c] = colOffsets[c - 1] + colWidths[c - 1] + COL_GAP;
    const rowOffsets = new Array(rowCount).fill(0);
    for (let r = 1; r < rowCount; r++) rowOffsets[r] = rowOffsets[r - 1] + rowHeights[r - 1] + ROW_GAP;

    sorted.forEach((node, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const x = originX + colOffsets[col] + (colWidths[col] - node.width) / 2;
        const y = originY + rowOffsets[row] + (rowHeights[row] - node.height) / 2;
        place(result, node, x, y);
    });

    return result;
}

function place(result: Map<string, Position>, node: CanvasNodeData, x: number, y: number) {
    if (Math.abs(x - node.position.x) > 0.5 || Math.abs(y - node.position.y) > 0.5) result.set(node.id, { x, y });
}
