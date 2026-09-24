"use client";

import { type ReactNode } from "react";
import { LayoutGrid } from "@/components/icons";

import { PickerShell } from "./canvas-image-option-popovers";
import { settingSelectedFill, SETTING_SELECT_TRANSITION } from "@/components/image-settings-panel";
import { IMAGE_VIEW_PRESETS, getImageViewPreset } from "@/lib/image-style-presets";
import type { CanvasTheme } from "@/lib/canvas-theme";

type Placement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

// 图片节点「视图(排版/姿势)」独立按钮，与「风格(质感)」分开、可叠加。
// 选了视图(如真人三视图)只控排版与姿势，质感仍由风格档决定；两者助提示词生成时一起追加。
export function CanvasViewPopover({ value, onChange, buttonClassName, onOpenChange, placement }: { value: string; onChange: (id: string) => void; buttonClassName?: string; onOpenChange?: (open: boolean) => void; placement?: Placement }) {
    const active = getImageViewPreset(value);
    return (
        <PickerShell
            icon={<LayoutGrid className="size-3.5" />}
            label={active ? active.nameZh : "视图"}
            selected={Boolean(active)}
            title="视图（排版/姿势，可叠加风格质感）"
            width={300}
            placement={placement}
            buttonClassName={buttonClassName}
            onOpenChange={onOpenChange}
            render={(close, theme) => (
                <div className="grid grid-cols-2 gap-2">
                    <ViewPill selected={!value} theme={theme} onClick={() => { onChange(""); close(); }}>
                        无
                    </ViewPill>
                    {IMAGE_VIEW_PRESETS.map((preset) => (
                        <ViewPill key={preset.id} selected={value === preset.id} theme={theme} title={preset.description} onClick={() => { onChange(preset.id); close(); }}>
                            {preset.nameZh}
                        </ViewPill>
                    ))}
                </div>
            )}
        />
    );
}

function ViewPill({ selected, theme, title, onClick, children }: { selected: boolean; theme: CanvasTheme; title?: string; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            title={title}
            className="h-9 min-w-0 cursor-pointer overflow-hidden rounded-full border px-2 text-sm hover:opacity-80"
            style={{
                background: selected ? settingSelectedFill(theme) : "transparent",
                borderColor: selected ? theme.node.activeStroke : theme.node.stroke,
                color: selected ? theme.node.activeStroke : theme.node.text,
                transition: SETTING_SELECT_TRANSITION,
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            <span className="block truncate">{children}</span>
        </button>
    );
}
