"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "@/components/icons";
import { Button } from "antd";

import { VideoSettingsPanel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { boolConfig, VIDEO_MODES_SELECTABLE, type VideoModeCounts } from "@/lib/seedance-video";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    // 参考素材数量：用来灰掉素材条件不满足的生成模式。不传则只按模型能力灰选（见 VideoSettingsPanel）。
    referenceCounts?: VideoModeCounts;
    // 摘要里要不要带模式前缀。现有两个调用点（画布视频节点、Config 节点）都只有这一个设置按钮，
    // 模式得靠它显示，所以默认带。留这个开关是给「旁边另有一个独立模式入口」的界面用的——
    // 那种场合再挂一遍前缀就是同一件事说两次，还白占按钮里本来就不够用的宽度。
    showModePrefix?: boolean;
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft", referenceCounts, showModePrefix = true }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
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
    }, [open]);

    const panel = open && buttonRect ? <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} referenceCounts={referenceCounts} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={`${buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} !transition hover:!brightness-[.96] dark:hover:!brightness-110`} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {/* 模式只在【不是当前默认档】时才占一段：这个按钮是 truncate 的，
                            天天挂一句"文生视频"只会把后面的清晰度/比例/时长三段挤没。
                            而一旦落到参考生视频、或用户显式选了首尾帧这类模式，它就是本次生成最要紧的信息，
                            必须排最前面、不被截掉。
                            ⚠️ auto 一并按"不显示"处理：它是存量节点里的值，界面上已经没有这一档，
                               显示成「自动」只会让人以为还能选（真正显示什么由弹层里的模式分段负责）。
                            ⚠️ 接了参考素材时 text_to_video 是不可能停留的（面板会落到参考生视频并写回），
                               所以这里不显示它不会掩盖任何信息。 */}
                        {showModePrefix ? videoModePrefix(config.videoMode) : ""}
                        {videoSizeLabel(config.size)} · {videoResolutionLabel(config.vquality)} · {videoSecondsLabel(config.videoSeconds, config.model || config.videoModel)}
                        {boolConfig(config.videoGenerateAudio, true) ? " · 🔊" : ""}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    referenceCounts,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasVideoSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    referenceCounts?: VideoModeCounts;
}) {
    const width = 356;
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
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        border: `1px solid ${theme.toolbar.border}`,
        borderRadius: 18,
        boxShadow: isDark ? "0 18px 54px rgba(0, 0, 0, .55)" : "0 18px 54px rgba(15, 23, 42, .16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover anim-pop"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <VideoSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" referenceCounts={referenceCounts} />
        </div>,
        document.body,
    );
}

// 按钮上那一小段模式前缀。默认档（文生视频）不显示，其余可选档都显示——
// 判据只有这一处，别在 JSX 里再写一遍字符串比较。
//
// ⚠️ 按 VIDEO_MODES_SELECTABLE 查而不是直接 videoModeLabel(value)：
//    后者对认不出来的取值（以及已经隐藏的 auto）会回落成「自动」，而界面上已经没有那一档，
//    在按钮上写「自动」只会让人以为还能选。查不到就什么都不显示，弹层里的模式分段说了算。
function videoModePrefix(mode: string | undefined) {
    const meta = VIDEO_MODES_SELECTABLE.find((item) => item.value === String(mode || "").trim());
    if (!meta || meta.value === "text_to_video") return "";
    return `${meta.label} · `;
}
