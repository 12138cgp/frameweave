"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "antd";

import { settingSelectedFill, SETTING_SELECT_TRANSITION, qualityOptions, aspectOptions, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type Placement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
type Theme = (typeof canvasThemes)[keyof typeof canvasThemes];

// 共用的小弹层外壳：一个按钮 + 点开后定位的浮层（与设置/风格弹层同款骨架）。
export function PickerShell({
    icon,
    label,
    selected,
    title,
    width = 240,
    placement = "topLeft",
    buttonClassName,
    onOpenChange,
    render,
}: {
    icon?: ReactNode;
    label: string;
    selected?: boolean;
    title?: string;
    width?: number;
    placement?: Placement;
    buttonClassName?: string;
    onOpenChange?: (open: boolean) => void;
    render: (close: () => void, theme: Theme) => ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const updateOpen = (next: boolean) => {
        setOpen(next);
        onOpenChange?.(next);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            updateOpen(false);
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const panel =
        open && buttonRect ? (
            <Portal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} width={width} title={title}>
                {render(() => updateOpen(false), theme)}
            </Portal>
        ) : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button
                    size="small"
                    type="text"
                    className={`${buttonClassName || "!h-9 !min-w-0 !justify-start !rounded-full !px-2.5"} !transition hover:!brightness-[.96] dark:hover:!brightness-110`}
                    style={{ background: selected ? settingSelectedFill(theme) : theme.node.fill, color: selected ? theme.node.activeStroke : theme.node.text }}
                    icon={icon}
                    onClick={() => updateOpen(!open)}
                    title={title}
                >
                    <span className="whitespace-nowrap">{label}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function Portal({
    buttonRect,
    panelRef,
    placement,
    theme,
    width,
    title,
    children,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: Placement;
    theme: Theme;
    width: number;
    title?: string;
    children: ReactNode;
}) {
    const gap = 8;
    const margin = 12;
    const isDark = theme === canvasThemes.dark;
    const alignRight = placement.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(240, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(240, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        border: `1px solid ${theme.toolbar.border}`,
        borderRadius: 16,
        boxShadow: isDark ? "0 18px 54px rgba(0, 0, 0, .55)" : "0 18px 54px rgba(15, 23, 42, .16)",
        padding: 14,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="anim-pop"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {title ? (
                <div className="mb-2 text-xs font-medium" style={{ color: theme.node.muted }}>
                    {title}
                </div>
            ) : null}
            {children}
        </div>,
        document.body,
    );
}

function Pill({ selected, theme, onClick, children, title }: { selected: boolean; theme: Theme; onClick: () => void; children: ReactNode; title?: string }) {
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

const QUALITY_LEGACY: Record<string, string> = { low: "1k", medium: "2k", high: "4k", auto: "2k" };

// 质量（分辨率档）独立按钮

// 宽高比独立按钮

// 生成张数独立按钮

function AspectIcon({ width, height, color }: { width: number; height: number; color: string }) {
    const ratio = width / Math.max(1, height);
    const boxWidth = ratio >= 1 ? 22 : Math.max(9, 22 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(9, 22 / ratio) : 22;
    return (
        <span className="grid h-6 w-8 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}
