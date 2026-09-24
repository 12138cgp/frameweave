"use client";

import { Button } from "antd";
import { LoaderCircle, Map, ScanEye } from "@/components/icons";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "../types";

type CanvasSceneCameraNodePanelProps = {
    node: CanvasNodeData;
    generating: boolean;
    onOpen: (nodeId: string) => void;
};

// 场景机位节点卡片：显示房间平面图状态 + 打开机位台按钮（出图链路在弹窗里）
export function CanvasSceneCameraNodePanel({ node, generating, onOpen }: CanvasSceneCameraNodePanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const scene = node.metadata?.roomScene;
    const itemCount = scene?.plan?.items.length ?? 0;
    const hasPlan = Boolean(scene?.plan);

    return (
        <div className="flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <Map className="size-4" />
                场景机位 · 房间平面
            </div>
            <div className="mb-3 flex flex-col gap-1 text-xs opacity-70">
                {generating ? (
                    <div className="inline-flex items-center gap-1.5 opacity-80">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        正在生成…
                    </div>
                ) : hasPlan ? (
                    <>
                        <div>平面图：{itemCount} 件家具</div>
                        <div className="opacity-80">在平面图上拖相机定位置与朝向,生成对应角度的场景图</div>
                    </>
                ) : (
                    <div className="opacity-80">用提示词生成房间俯视平面图,再拖相机出各角度场景图</div>
                )}
            </div>
            <div className="mt-auto cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                <Button type="primary" block className="hover-lift !h-9 !rounded-full" icon={<ScanEye className="size-3.5" />} onClick={() => onOpen(node.id)}>
                    打开场景机位台
                </Button>
            </div>
        </div>
    );
}
