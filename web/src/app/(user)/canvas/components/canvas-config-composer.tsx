"use client";

import { useMemo } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { Button } from "antd";
import { X } from "@/components/icons";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasMentionComposer, MENTION_TOKEN_PATTERN, type ComposerItem } from "./canvas-mention-composer";
import type { NodeGenerationInput } from "./canvas-node-generation";

type CanvasConfigComposerProps = {
    value: string;
    inputs: NodeGenerationInput[];
    onChange: (value: string) => void;
    onClose: () => void;
};

// 兼容旧引用：原 CONFIG_REFERENCE_PATTERN 现统一为共享的 MENTION_TOKEN_PATTERN（同源 /@\[node:([^\]]+)\]/g）。
export const CONFIG_REFERENCE_PATTERN = MENTION_TOKEN_PATTERN;

export function CanvasConfigComposer({ value, inputs, onChange, onClose }: CanvasConfigComposerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    // NodeGenerationInput[] → ComposerItem[]：label 用现有 resourceLabel 现算（按当前 inputs 顺序编号），
    // previewUrl 取图片 dataUrl / 视频 url，text 用于文本 chip 显示与菜单副文案。
    const items = useMemo<ComposerItem[]>(
        () =>
            inputs.map((input) => ({
                nodeId: input.nodeId,
                type: input.type,
                label: resourceLabel(input, inputs),
                title: input.title,
                text: input.text,
                previewUrl: input.type === "image" ? input.image?.dataUrl : input.type === "video" ? input.video?.url : undefined,
            })),
        [inputs],
    );

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => event.stopPropagation();

    return (
        <div
            data-canvas-no-zoom
            className="anim-pop rounded-2xl border p-3 shadow-[0_18px_54px_rgba(15,23,42,.16)] backdrop-blur dark:shadow-[0_18px_54px_rgba(0,0,0,.5)]"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={stopCanvasInteraction}
            onPointerDown={stopCanvasInteraction}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                    <div className="shrink-0 text-xs font-semibold">组装提示词</div>
                    <div className="truncate text-[11px] opacity-55">@ 引用已连接素材，发送前按当前连接重新编号</div>
                </div>
                <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !p-0" icon={<X className="size-3.5" />} onClick={onClose} />
            </div>
            <div className="rounded-xl border" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                <CanvasMentionComposer
                    value={value}
                    items={items}
                    onChange={onChange}
                    placeholder="输入提示词，按 @ 引用连接的图片或文本"
                    className="min-h-28 px-3 py-2 text-sm leading-7"
                    style={{ color: theme.node.text }}
                />
            </div>
        </div>
    );
}

function resourceLabel(input: NodeGenerationInput, inputs: NodeGenerationInput[]) {
    const sameTypeInputs = inputs.filter((item) => item.type === input.type);
    const index = Math.max(0, sameTypeInputs.findIndex((item) => item.nodeId === input.nodeId));
    // 引用标签：节点被双击改过名（nameIsCustom）→ 用改过的名字；否则回退默认「类型+序号」。
    if (input.nameIsCustom && input.name && input.name.trim()) return input.name.trim();
    if (input.type === "image") return `图片${index + 1}`;
    if (input.type === "video") return `视频${index + 1}`;
    if (input.type === "audio") return `音频${index + 1}`;
    return `文本${index + 1}`;
}
