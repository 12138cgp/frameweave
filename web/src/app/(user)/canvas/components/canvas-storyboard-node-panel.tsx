"use client";

import { Button } from "antd";
import { Clapperboard, LayoutPanelLeft, LoaderCircle, Pencil } from "@/components/icons";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "../types";

type CanvasStoryboardNodePanelProps = {
    node: CanvasNodeData;
    parsing: boolean;
    onComposerToggle: () => void;
    onExpand: (nodeId: string) => void;
};

export function CanvasStoryboardNodePanel({ node, parsing, onComposerToggle, onExpand }: CanvasStoryboardNodePanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const state = node.metadata?.storyboard;
    const plan = state?.plan;
    const modeLabel = state?.mode === "custom" ? "我的分镜脚本" : "AI 自动成片";
    const shotCount = plan ? plan.segments.reduce((sum, segment) => sum + segment.shots.length, 0) : 0;
    const assetCount = plan ? plan.characters.length + plan.scenes.length : 0;
    const uploadedCount = state?.assets ? Object.keys(state.assets).length : 0;

    return (
        <div className="flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <Clapperboard className="size-4" />
                分镜故事板
            </div>
            <div className="mb-3 flex flex-col gap-1 text-xs opacity-70">
                <div>模式：{modeLabel}</div>
                {parsing ? (
                    <div className="inline-flex items-center gap-1.5 opacity-80">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        解析中…（约 15 秒）
                    </div>
                ) : plan ? (
                    <>
                        <div className="truncate">《{plan.title}》· {plan.segments.length} 段 · {shotCount} 镜</div>
                        <div>资产：{assetCount} 项{uploadedCount ? `（${uploadedCount} 个已上传）` : ""}</div>
                    </>
                ) : (
                    <div className="opacity-80">还没解析镜头，点「编辑」开始</div>
                )}
            </div>
            <div className="mt-auto grid cursor-default grid-cols-2 gap-2" onMouseDown={(event) => event.stopPropagation()}>
                <Button className="!h-9 !rounded-full" icon={<Pencil className="size-3.5" />} onClick={onComposerToggle}>
                    编辑
                </Button>
                <Button type="primary" className="hover-lift !h-9 !rounded-full" icon={<LayoutPanelLeft className="size-3.5" />} disabled={!plan} onClick={() => onExpand(node.id)}>
                    展开到画布
                </Button>
            </div>
        </div>
    );
}
