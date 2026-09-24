import type { CanvasNodeData, Position } from "../types";

export type AlignmentGuide = { orientation: "vertical" | "horizontal"; position: number; start: number; end: number };

export type SnapBox = { left: number; top: number; right: number; bottom: number };

export type AlignActionMode = "left" | "center-x" | "right" | "top" | "center-y" | "bottom" | "distribute-x" | "distribute-y";

const verticalLines = (box: SnapBox) => [box.left, (box.left + box.right) / 2, box.right];
const horizontalLines = (box: SnapBox) => [box.top, (box.top + box.bottom) / 2, box.bottom];

// 拖动吸附：moving 与 targets 的边/中线在 threshold（世界坐标）内时吸附，并返回对齐参考线。
export function computeAlignmentSnap(moving: SnapBox, targets: SnapBox[], threshold: number): { dx: number; dy: number; guides: AlignmentGuide[] } {
    let bestDx: number | null = null;
    let bestDy: number | null = null;
    const movingV = verticalLines(moving);
    const movingH = horizontalLines(moving);

    for (const target of targets) {
        for (const m of movingV) {
            for (const t of verticalLines(target)) {
                const d = t - m;
                if (Math.abs(d) <= threshold && (bestDx === null || Math.abs(d) < Math.abs(bestDx))) bestDx = d;
            }
        }
        for (const m of movingH) {
            for (const t of horizontalLines(target)) {
                const d = t - m;
                if (Math.abs(d) <= threshold && (bestDy === null || Math.abs(d) < Math.abs(bestDy))) bestDy = d;
            }
        }
    }

    const dx = bestDx ?? 0;
    const dy = bestDy ?? 0;
    const snapped: SnapBox = { left: moving.left + dx, right: moving.right + dx, top: moving.top + dy, bottom: moving.bottom + dy };
    const snappedV = verticalLines(snapped);
    const snappedH = horizontalLines(snapped);
    const EPS = 0.5;
    const vGuides = new Map<number, { start: number; end: number }>();
    const hGuides = new Map<number, { start: number; end: number }>();

    for (const target of targets) {
        if (snappedV.some((m) => verticalLines(target).some((t) => Math.abs(t - m) < EPS))) {
            const position = snappedV.find((m) => verticalLines(target).some((t) => Math.abs(t - m) < EPS))!;
            const key = Math.round(position * 2);
            const existing = vGuides.get(key);
            const start = Math.min(existing?.start ?? Infinity, snapped.top, target.top);
            const end = Math.max(existing?.end ?? -Infinity, snapped.bottom, target.bottom);
            vGuides.set(key, { start, end });
        }
        if (snappedH.some((m) => horizontalLines(target).some((t) => Math.abs(t - m) < EPS))) {
            const position = snappedH.find((m) => horizontalLines(target).some((t) => Math.abs(t - m) < EPS))!;
            const key = Math.round(position * 2);
            const existing = hGuides.get(key);
            const start = Math.min(existing?.start ?? Infinity, snapped.left, target.left);
            const end = Math.max(existing?.end ?? -Infinity, snapped.right, target.right);
            hGuides.set(key, { start, end });
        }
    }

    const guides: AlignmentGuide[] = [
        ...Array.from(vGuides.entries()).map(([key, range]) => ({ orientation: "vertical" as const, position: key / 2, ...range })),
        ...Array.from(hGuides.entries()).map(([key, range]) => ({ orientation: "horizontal" as const, position: key / 2, ...range })),
    ];

    return { dx, dy, guides };
}

// 多选对齐/等距：返回需要移动的节点新位置（仅包含位置有变化的节点）。
export function computeAlignedPositions(nodes: CanvasNodeData[], mode: AlignActionMode): Map<string, Position> {
    const result = new Map<string, Position>();
    if (nodes.length < 2) return result;

    const minLeft = Math.min(...nodes.map((n) => n.position.x));
    const maxRight = Math.max(...nodes.map((n) => n.position.x + n.width));
    const minTop = Math.min(...nodes.map((n) => n.position.y));
    const maxBottom = Math.max(...nodes.map((n) => n.position.y + n.height));

    const place = (node: CanvasNodeData, x: number, y: number) => {
        if (Math.abs(x - node.position.x) > 0.01 || Math.abs(y - node.position.y) > 0.01) result.set(node.id, { x, y });
    };

    if (mode === "left") nodes.forEach((n) => place(n, minLeft, n.position.y));
    else if (mode === "right") nodes.forEach((n) => place(n, maxRight - n.width, n.position.y));
    else if (mode === "center-x") nodes.forEach((n) => place(n, (minLeft + maxRight) / 2 - n.width / 2, n.position.y));
    else if (mode === "top") nodes.forEach((n) => place(n, n.position.x, minTop));
    else if (mode === "bottom") nodes.forEach((n) => place(n, n.position.x, maxBottom - n.height));
    else if (mode === "center-y") nodes.forEach((n) => place(n, n.position.x, (minTop + maxBottom) / 2 - n.height / 2));
    else if (mode === "distribute-x" && nodes.length >= 3) {
        const sorted = [...nodes].sort((a, b) => a.position.x + a.width / 2 - (b.position.x + b.width / 2));
        const firstCenter = sorted[0].position.x + sorted[0].width / 2;
        const lastCenter = sorted[sorted.length - 1].position.x + sorted[sorted.length - 1].width / 2;
        const step = (lastCenter - firstCenter) / (sorted.length - 1);
        sorted.forEach((n, i) => place(n, firstCenter + step * i - n.width / 2, n.position.y));
    } else if (mode === "distribute-y" && nodes.length >= 3) {
        const sorted = [...nodes].sort((a, b) => a.position.y + a.height / 2 - (b.position.y + b.height / 2));
        const firstCenter = sorted[0].position.y + sorted[0].height / 2;
        const lastCenter = sorted[sorted.length - 1].position.y + sorted[sorted.length - 1].height / 2;
        const step = (lastCenter - firstCenter) / (sorted.length - 1);
        sorted.forEach((n, i) => place(n, n.position.x, firstCenter + step * i - n.height / 2));
    }

    return result;
}
