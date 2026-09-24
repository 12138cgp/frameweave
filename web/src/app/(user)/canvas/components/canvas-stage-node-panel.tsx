"use client";

import { Button } from "antd";
import { Clapperboard, Video } from "@/components/icons";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "../types";

type CanvasStageNodePanelProps = {
    node: CanvasNodeData;
    onOpen: (nodeId: string) => void;
};

// 3D 场景台节点卡片：显示最近一次回传的截图做封面 + 打开按钮（真正的 3D 工具在 iframe 弹窗里）。
export function CanvasStageNodePanel({ node, onOpen }: CanvasStageNodePanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const stage = node.metadata?.stage;
    const captureCount = stage?.captureCount ?? 0;
    const cover = stage?.coverUrl || "";

    // 文案在 return 之前算好，JSX 属性里不写三元（本项目 bun SSG 段错误的已知触发写法）。
    let hint = "摆人物道具、走位掌镜，把机位截图发回画布";
    if (captureCount > 0) hint = `已回传 ${captureCount} 张机位截图`;

    return (
        <div className="flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <Clapperboard className="size-4" />
                3D 场景台
            </div>
            <StageCover cover={cover} />
            <div className="mb-3 text-xs opacity-70">{hint}</div>
            <div className="mt-auto cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                <Button type="primary" block className="hover-lift !h-9 !rounded-full" icon={<Video className="size-3.5" />} onClick={() => onOpen(node.id)}>
                    打开场景台
                </Button>
            </div>
        </div>
    );
}

function StageCover({ cover }: { cover: string }) {
    if (!cover) return null;
    return (
        <div className="mb-2 aspect-video w-full overflow-hidden rounded-lg bg-black/5 dark:bg-white/10">
            {/* 封面可能是失效的会话 blob:（本项目的老问题），取不到就直接隐藏，别显示破图 */}
            <img
                src={cover}
                alt="场景台封面"
                className="size-full object-cover"
                onError={(event) => {
                    event.currentTarget.style.display = "none";
                }}
            />
        </div>
    );
}
