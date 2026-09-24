import { computeGroupBounds } from "../components/canvas-group-box";
import type { CanvasGroup, CanvasNodeData, Position } from "../types";

// 为「新生成的节点」找一个不压别人、也不被别人压的落点。
//
// 为什么要单独写：utils 下已有的三个布局工具（canvas-group-layout / canvas-alignment /
// canvas-sort-layout）都是「给定一批节点、重排它们的位置」，会移动既有节点；
// 而批量重出只能动新节点、既有节点一根头发都不能碰。现有新建节点的落位则是固定偏移
// （canvas-client-page.tsx:2003/2029 的 +36、生成路径的源节点右侧 +96），批量时必然叠罗汉。
//
// 全文写成平铺 if/return，不用嵌套三元、不在模板串里调函数 —— 构建用的 bun 1.3.13
// 在这两种写法上会偶发构建期 SIGILL（进程 exit 132，且不指向具体行号，极难定位）。
// 摊平写法可以稳定绕开，代价只是多几行。

export type Rect = { x: number; y: number; w: number; h: number };

// 节点名字标签(NodeNameTag)贴在节点顶上方、不计入 node.height。
// 依据：components/canvas-node-hover-toolbar.tsx:235 用 `- 14 - 29 * viewport.k` 上抬工具栏避开它。
// 取 30（世界坐标）留一点余量；不算进去的话「几何零重叠」仍会盖住上方节点的名字。
const NAME_TAG_H = 30;

// 与生成路径既有的「源节点右侧 +96」视觉约定同量级
export const FREE_GAP_X = 96;
export const FREE_GAP_Y = 64;

// 环形搜索的最大圈数。14 圈已覆盖落点周围约 ±14 个节点位，再找不到就走兜底。
const MAX_RING = 14;

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
    if (a.x >= b.x + b.w + margin) return false;
    if (b.x >= a.x + a.w + margin) return false;
    if (a.y >= b.y + b.h + margin) return false;
    if (b.y >= a.y + a.h + margin) return false;
    return true;
}

export function nodeObstacleRect(node: CanvasNodeData): Rect {
    return {
        x: node.position.x,
        y: node.position.y - NAME_TAG_H,
        w: node.width,
        h: node.height + NAME_TAG_H,
    };
}

export function reservationRect(topLeft: Position, size: { width: number; height: number }): Rect {
    return {
        x: topLeft.x,
        y: topLeft.y - NAME_TAG_H,
        w: size.width,
        h: size.height + NAME_TAG_H,
    };
}

export type BuildObstaclesOptions = {
    // 只保留与该窗口相交的障碍物。大画布上节点以万计，不裁剪会让每次落点计算都做全量扫描。
    window?: Rect;
    // 折叠批次的隐藏子节点等不可见节点，不应参与避让（它们在屏幕上不占位）。
    isHidden?: (node: CanvasNodeData) => boolean;
    // 本次要重新安置的节点自身不算障碍物（否则永远和自己冲突）。
    excludeIds?: Set<string>;
};

// 障碍物 = 可见节点矩形(含名字标签) + 所有组框(含 padding)。
// 组框直接复用 computeGroupBounds，不自己重算 —— 本项目吃过多次「判据不同源」的亏。
export function buildObstacles(
    nodes: CanvasNodeData[],
    groups: CanvasGroup[],
    opts?: BuildObstaclesOptions,
): Rect[] {
    const out: Rect[] = [];
    const byId = new Map<string, CanvasNodeData>();
    for (const node of nodes) {
        byId.set(node.id, node);
    }
    for (const node of nodes) {
        if (opts && opts.excludeIds && opts.excludeIds.has(node.id)) continue;
        if (opts && opts.isHidden && opts.isHidden(node)) continue;
        const rect = nodeObstacleRect(node);
        if (opts && opts.window && !rectsOverlap(rect, opts.window)) continue;
        out.push(rect);
    }
    for (const group of groups) {
        const bounds = computeGroupBounds(group.memberNodeIds, byId);
        if (!bounds) continue;
        const rect: Rect = { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
        if (opts && opts.window && !rectsOverlap(rect, opts.window)) continue;
        out.push(rect);
    }
    return out;
}

function isFree(candidate: Rect, obstacles: Rect[], margin: number): boolean {
    for (const obstacle of obstacles) {
        if (rectsOverlap(candidate, obstacle, margin)) return false;
    }
    return true;
}

// 以 preferred 为中心向外一圈圈找空位。找到即返回该位置（节点左上角坐标）。
// 步长按「节点尺寸 + 间隙」，所以相邻候选位天然不会互相压。
// 优先级：同一圈内先右后下再左再上 —— 与生成路径「新节点落在源右侧」的既有直觉一致。
export function findFreeSpot(
    preferred: Position,
    size: { width: number; height: number },
    obstacles: Rect[],
    margin = 0,
): Position {
    if (isFree(reservationRect(preferred, size), obstacles, margin)) return preferred;

    const stepX = size.width + FREE_GAP_X;
    const stepY = size.height + FREE_GAP_Y;

    for (let ring = 1; ring <= MAX_RING; ring += 1) {
        const offsets: Array<{ dx: number; dy: number }> = [];
        // 右列、下行、左列、上行；同圈内按这个顺序铺，保证先右后下
        for (let dy = -ring; dy <= ring; dy += 1) offsets.push({ dx: ring, dy });
        for (let dx = ring - 1; dx >= -ring; dx -= 1) offsets.push({ dx, dy: ring });
        for (let dy = ring - 1; dy >= -ring; dy -= 1) offsets.push({ dx: -ring, dy });
        for (let dx = -ring + 1; dx <= ring; dx += 1) offsets.push({ dx, dy: -ring });

        for (const offset of offsets) {
            const candidate: Position = {
                x: preferred.x + offset.dx * stepX,
                y: preferred.y + offset.dy * stepY,
            };
            if (isFree(reservationRect(candidate, size), obstacles, margin)) return candidate;
        }
    }

    // 兜底：一路向右推出所有障碍物之外。宁可离得远，也不要盖在别人身上。
    let maxRight = preferred.x;
    for (const obstacle of obstacles) {
        const right = obstacle.x + obstacle.w;
        if (right > maxRight) maxRight = right;
    }
    return { x: maxRight + FREE_GAP_X, y: preferred.y };
}

export type BatchPlacement = { id: string; position: Position };

// 批量安置：逐个找空位，并把已定下的位置**加回障碍物**，
// 保证这一批新节点之间也不会互相重叠。
export function placeBatch(
    items: Array<{ id: string; preferred: Position; size: { width: number; height: number } }>,
    obstacles: Rect[],
    margin = 0,
): BatchPlacement[] {
    const working = obstacles.slice();
    const out: BatchPlacement[] = [];
    for (const item of items) {
        const position = findFreeSpot(item.preferred, item.size, working, margin);
        working.push(reservationRect(position, item.size));
        out.push({ id: item.id, position });
    }
    return out;
}
