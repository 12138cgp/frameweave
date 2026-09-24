import { CanvasNodeType } from "./types";
import type { CanvasNodeMetadata } from "./types";

type CanvasNodeSpec = {
    width: number;
    height: number;
    title: string;
    metadata?: CanvasNodeMetadata;
};

export const NODE_DEFAULT_SIZE = {
    [CanvasNodeType.Image]: { width: 340, height: 240, title: "New Generation" },
    [CanvasNodeType.Text]: { width: 340, height: 240, title: "Note" },
    [CanvasNodeType.Config]: { width: 340, height: 240, title: "生成配置" },
    [CanvasNodeType.Video]: { width: 640, height: 360, title: "Video" },
    [CanvasNodeType.Audio]: { width: 340, height: 240, title: "Audio" },
    [CanvasNodeType.Storyboard]: { width: 360, height: 264, title: "分镜故事板" },
    [CanvasNodeType.SceneCamera]: { width: 340, height: 248, title: "场景机位" },
    [CanvasNodeType.Stage]: { width: 360, height: 264, title: "3D 场景台" },
} satisfies Record<CanvasNodeType, { width: number; height: number; title: string }>;

export const NODE_SPECS = {
    [CanvasNodeType.Image]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Image],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Text]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Text],
        metadata: { content: "", status: "idle", fontSize: 14 },
    },
    [CanvasNodeType.Config]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Config],
        metadata: { content: "", status: "idle", generationMode: "image" },
    },
    [CanvasNodeType.Video]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Video],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Audio]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Audio],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Storyboard]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Storyboard],
        metadata: { status: "idle", storyboard: { mode: "auto" } },
    },
    [CanvasNodeType.SceneCamera]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.SceneCamera],
        metadata: { status: "idle", roomScene: { prompt: "", plan: null, camera: { x: 0.5, y: 0.82, angle: 0, fov: 60 } } },
    },
    [CanvasNodeType.Stage]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Stage],
        // ⚠️ status 只能是 idle，绝不能用 "loading" 表示 3D 工具正在加载：
        // 画布加载时的 resetInterruptedGeneration 会把「status=loading 且没有生成任务号」的节点
        // 一律判成中断、改写成红色报错态。场景台没有生成任务号，用 loading 等于每次刷新都变报错。
        metadata: { status: "idle", stage: { instanceId: "", captureCount: 0 } },
    },
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

export function getNodeSpec(type: CanvasNodeType) {
    return NODE_SPECS[type];
}
