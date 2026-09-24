"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Palette } from "@/components/icons";
import { Button } from "antd";

import { settingSelectedFill, SETTING_SELECT_TRANSITION } from "@/components/image-settings-panel";
import { IMAGE_STYLE_PRESETS, IMAGE_STYLE_CATEGORIES, getImageStylePreset, type ImageStylePreset } from "@/lib/image-style-presets";
import { VIDEO_STYLE_PRESETS, VIDEO_STYLE_CATEGORIES, getVideoStylePreset } from "@/lib/video-style-presets";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CustomStyleSection, GroupStyleSection, type StyleKind } from "./canvas-custom-style";

type CanvasStylePopoverProps = {
    // 当前所选风格预设 id（空=无风格）。
    value: string;
    onChange: (id: string) => void;
    buttonClassName?: string;
    onOpenChange?: (open: boolean) => void;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    // 图片风格(默认) 还是 视频风格。决定预设表/分类/文案与写哪套自定义 store。
    kind?: StyleKind;
};

// 图片/视频风格各套预设的取用配置：让同一个弹层组件复用两套数据与文案。
function stylePresetConfig(kind: StyleKind) {
    if (kind === "video") {
        return {
            presets: VIDEO_STYLE_PRESETS as ImageStylePreset[],
            categories: VIDEO_STYLE_CATEGORIES,
            getPreset: getVideoStylePreset as (id?: string) => ImageStylePreset | undefined,
            title: "视频风格",
            hint: "只描述画面内容与动作，质感、运镜、氛围交给预设。",
            buttonTitle: "选择视频风格（画面质感、运镜、氛围交给预设）",
        };
    }
    return {
        presets: IMAGE_STYLE_PRESETS,
        categories: IMAGE_STYLE_CATEGORIES,
        getPreset: getImageStylePreset,
        title: "风格",
        hint: "只描述主体（人物/物体），质感、光影、镜头交给预设。",
        buttonTitle: "选择图片风格（只描述主体，质感交给预设）",
    };
}

// 图片/视频节点「风格」独立按钮 + 弹层：与「质量/比例/张数」设置分开，单独一个入口。
// 选一个风格后，生成时把该预设的质感助提示词追加到用户描述后（用户只需描述主体/画面）。
export function CanvasStylePopover({ value, onChange, buttonClassName, onOpenChange, placement = "topLeft", kind = "image" }: CanvasStylePopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const cfg = stylePresetConfig(kind);
    const activePreset = cfg.getPreset(value);
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            // 「新建/编辑风格」表单是 antd Modal（portal 到 body、在本弹层面板之外）：点它不该关闭风格弹层，
            // 否则弹层连同挂在里面的表单一起卸载（表现为「一点击就消失」）。antd 下拉/日期选择同理放行。
            if (target instanceof Element && target.closest(".ant-modal-root, .ant-modal-mask, .ant-modal-wrap, .ant-select-dropdown, .ant-picker-dropdown, .ant-message")) return;
            setOpen(false);
            onOpenChange?.(false);
        };
        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [onOpenChange, open]);

    const handleSelect = (id: string) => {
        onChange(id);
        updateOpen(false);
    };

    const panel =
        open && buttonRect ? (
            <StylePortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} value={value} kind={kind} onSelect={handleSelect} />
        ) : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button
                    size="small"
                    type="text"
                    className={`${buttonClassName || "!h-8 !max-w-[150px] !justify-start !rounded-full !px-2.5"} !transition hover:!brightness-[.96] dark:hover:!brightness-110`}
                    style={{ background: activePreset ? settingSelectedFill(theme) : theme.node.fill, color: activePreset ? theme.node.activeStroke : theme.node.text, borderColor: activePreset ? theme.node.activeStroke : undefined }}
                    icon={<Palette className="size-3.5" />}
                    onClick={() => updateOpen(!open)}
                    title={cfg.buttonTitle}
                >
                    <span className="truncate">{activePreset ? activePreset.nameZh : cfg.title}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function StylePortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    value,
    kind,
    onSelect,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasStylePopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    value: string;
    kind: StyleKind;
    onSelect: (id: string) => void;
}) {
    const width = 320;
    const gap = 8;
    const margin = 12;
    const isDark = theme === canvasThemes.dark;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(280, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(280, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        border: `1px solid ${theme.toolbar.border}`,
        borderRadius: 18,
        boxShadow: isDark ? "0 18px 54px rgba(0, 0, 0, .55)" : "0 18px 54px rgba(15, 23, 42, .16)",
        padding: 16,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-style-popover anim-pop"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <StylePicker theme={theme} value={value} kind={kind} onSelect={onSelect} />
        </div>,
        document.body,
    );
}

function StylePicker({ theme, value, kind, onSelect }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; value: string; kind: StyleKind; onSelect: (id: string) => void }) {
    const cfg = stylePresetConfig(kind);
    const [openCats, setOpenCats] = useState<Set<string>>(() => {
        const selectedCat = cfg.presets.find((preset) => preset.id === value)?.category;
        return new Set([selectedCat || cfg.categories[0]]);
    });

    return (
        <div className="space-y-2.5">
            <div className="text-sm font-semibold">{cfg.title}</div>
            <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                {cfg.hint}
            </div>
            <div className="grid grid-cols-3 gap-2.5">
                <StylePill selected={!value} theme={theme} onClick={() => onSelect("")}>
                    无风格
                </StylePill>
            </div>
            <CustomStyleSection theme={theme} value={value} kind={kind} onSelect={onSelect} />
            <GroupStyleSection theme={theme} value={value} kind={kind} onSelect={onSelect} />
            <div className="space-y-1">
                {cfg.categories.map((cat) => {
                    const presets = cfg.presets.filter((preset) => preset.category === cat);
                    if (presets.length === 0) return null;
                    const open = openCats.has(cat);
                    const hasSelected = presets.some((preset) => preset.id === value);
                    return (
                        <div key={cat}>
                            <button
                                type="button"
                                className="flex w-full items-center justify-between rounded-lg px-1.5 py-1.5 text-xs font-medium hover:opacity-80"
                                style={{ color: hasSelected ? theme.node.activeStroke : theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() =>
                                    setOpenCats((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(cat)) next.delete(cat);
                                        else next.add(cat);
                                        return next;
                                    })
                                }
                            >
                                <span>
                                    {cat}
                                    {hasSelected ? " · 已选" : ""}
                                </span>
                                <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", opacity: 0.6 }}>›</span>
                            </button>
                            {open ? (
                                <div className="grid grid-cols-2 gap-2 pb-1 pt-0.5">
                                    {presets.map((preset) => (
                                        <StylePill key={preset.id} selected={value === preset.id} theme={theme} title={preset.description} onClick={() => onSelect(preset.id)}>
                                            {preset.nameZh}
                                        </StylePill>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function StylePill({ selected, theme, title, onClick, children }: { selected: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; title?: string; onClick: () => void; children: ReactNode }) {
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
