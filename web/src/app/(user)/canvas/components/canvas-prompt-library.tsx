"use client";

import { useState } from "react";
import { Button, Tooltip } from "antd";
import { BookOpen } from "@/components/icons";

import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type CanvasPromptLibraryProps = {
    onSelect: (prompt: string) => void;
    // 受控模式：外部（如「⋯更多」下拉菜单项）控制弹层开关；传入后不再渲染内置触发按钮。
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
};

export function CanvasPromptLibrary({ onSelect, open: controlledOpen, onOpenChange: controlledOnOpenChange }: CanvasPromptLibraryProps) {
    const [internalOpen, setInternalOpen] = useState(false);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    // controlledOpen 传入即视为受控：只渲染弹层、不渲染内置触发按钮，开关交给外部。
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : internalOpen;
    const setOpen = isControlled ? (controlledOnOpenChange ?? (() => {})) : setInternalOpen;

    return (
        <>
            {isControlled ? null : (
                <Tooltip title="提示词模板">
                    <Button
                        type="text"
                        className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0"
                        style={{ color: theme.node.text }}
                        icon={<BookOpen className="size-3.5" />}
                        onClick={() => setOpen(true)}
                        aria-label="提示词模板"
                    />
                </Tooltip>
            )}
            <PromptSelectDialog open={open} onOpenChange={setOpen} onSelect={onSelect} />
        </>
    );
}
