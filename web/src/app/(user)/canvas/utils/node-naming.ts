import { CanvasNodeType } from "../types";
import type { CanvasNodeData } from "../types";

// 节点自定义命名的核心工具。场景台干净（不引 canvas-stage），prod-deploy 可直接 cp。
//
// 命名模型：每个节点有 nameSeq（创建时分配的「同类型稳定序号」，删除节点不重排号）+
// 可选的 name/nameIsCustom（用户双击改名后才写）。显示名 = 改过则用 name，否则「类型前缀+nameSeq」。

// 类型前缀用「字符串键」而非枚举成员引用（如 CanvasNodeType.Stage），
// 这样 prod-deploy 树没有 Stage 枚举成员时本文件依然能编译、两树通用。
const NODE_TYPE_LABELS: Record<string, string> = {
    image: "图片",
    text: "文本",
    config: "生成配置",
    video: "视频",
    audio: "音频",
    storyboard: "分镜",
    stage: "场景台",
    sceneCamera: "场景机位",
};

type NodeNameFields = Pick<CanvasNodeData, "type" | "name" | "nameIsCustom" | "nameSeq">;

export function getTypeLabel(type: CanvasNodeType | string): string {
    return NODE_TYPE_LABELS[type as string] ?? "节点";
}

// 默认名 = 类型前缀 + 稳定序号（无序号兜底 1）。
export function computeDefaultNodeName(type: CanvasNodeType | string, seq: number | undefined): string {
    return `${getTypeLabel(type)}${seq ?? 1}`;
}

// 节点当前显示名：用户改过且非空则用自定义 name，否则用默认名。
export function getNodeDisplayName(node: NodeNameFields): string {
    if (node.nameIsCustom && node.name && node.name.trim()) return node.name.trim();
    return computeDefaultNodeName(node.type, node.nameSeq);
}

// 为新建的某类型节点分配下一个稳定序号 = 同类型已有节点 nameSeq 的最大值 + 1。
// 删除节点不回收序号（删了图片1，图片2 仍是图片2，下一张是 max+1），符合「创建顺序」直觉。
export function nextNameSeq(nodes: Pick<CanvasNodeData, "type" | "nameSeq">[], type: CanvasNodeType): number {
    let max = 0;
    for (const node of nodes) {
        if (node.type === type && typeof node.nameSeq === "number" && node.nameSeq > max) max = node.nameSeq;
    }
    return max + 1;
}

// 复制命名：<基名>副本 / <基名>副本2 / 副本3 …（macOS 中文 Finder 同款，不会「副本副本副本」）。
// base = 源显示名去掉尾部已有的「副本」/「副本N」；在 existingNames 里取最小未占用的 k。
export function deriveCopyName(sourceDisplayName: string, existingNames: Set<string>): string {
    const base = sourceDisplayName.replace(/副本\d*$/u, "");
    for (let k = 1; k < 9999; k += 1) {
        const candidate = k === 1 ? `${base}副本` : `${base}副本${k}`;
        if (!existingNames.has(candidate)) return candidate;
    }
    return `${base}副本`;
}

// 收集当前所有节点的显示名（供 deriveCopyName 去重）。
export function collectDisplayNames(nodes: NodeNameFields[]): Set<string> {
    return new Set(nodes.map((node) => getNodeDisplayName(node)));
}

// 给一批缺 nameSeq 的节点（如老项目加载、或绕过中央创建路径建的节点）按出现顺序补稳定序号，
// 已有 nameSeq 的保留并计入各类型已用最大值，避免与新补的撞号。返回补好的新数组（不改原数组元素引用语义之外的字段）。
export function backfillNameSeq<T extends Pick<CanvasNodeData, "type" | "nameSeq">>(nodes: T[]): T[] {
    const used: Record<string, number> = {};
    for (const node of nodes) {
        if (typeof node.nameSeq === "number") {
            const cur = used[node.type] ?? 0;
            if (node.nameSeq > cur) used[node.type] = node.nameSeq;
        }
    }
    return nodes.map((node) => {
        if (typeof node.nameSeq === "number") return node;
        const next = (used[node.type] ?? 0) + 1;
        used[node.type] = next;
        return { ...node, nameSeq: next };
    });
}
