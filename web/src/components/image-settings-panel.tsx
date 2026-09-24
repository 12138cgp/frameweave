"use client";

import { type ReactNode } from "react";
import { ConfigProvider } from "antd";

import { type CanvasTheme } from "@/lib/canvas-theme";
import { previewImageSize } from "@/services/api/image";
import { modelKindFromConfig, modelResolutionsFromConfig, type AiConfig } from "@/stores/use-config-store";

// 质量档 = 分辨率档（像素基准在 image.ts QUALITY_BASE：1k→1024 / 2k→2048 / 4k→2880）
export const qualityOptions = [
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
];
// 旧值（自动/高/中/低）映射到新档位，用于高亮回显
const QUALITY_LEGACY: Record<string, string> = { low: "1k", medium: "2k", high: "4k", auto: "2k" };

// 只存比例字符串到 config.size，实际像素由「质量+比例」算出
export const aspectOptions = [
    { value: "1:1", label: "1:1", width: 1, height: 1, icon: "square" },
    { value: "3:2", label: "3:2", width: 3, height: 2, icon: "landscape" },
    { value: "2:3", label: "2:3", width: 2, height: 3, icon: "portrait" },
    { value: "4:3", label: "4:3", width: 4, height: 3, icon: "landscape" },
    { value: "3:4", label: "3:4", width: 3, height: 4, icon: "portrait" },
    { value: "16:9", label: "16:9", width: 16, height: 9, icon: "landscape" },
    { value: "9:16", label: "9:16", width: 9, height: 16, icon: "portrait" },
];

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "count", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15, quickCount = 10 }: ImageSettingsPanelProps) {
    const quality = config.quality || "2k";
    const activeQuality = qualityOptions.some((item) => item.value === quality) ? quality : QUALITY_LEGACY[quality] || "2k";
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "1:1";
    const selectedAspect = aspectOptions.find((item) => item.value === activeSize);
    // 显示用：把「质量档 + 比例」解析成实际像素（与请求同一套逻辑，含 seedream 最小像素放大）
    const preview = previewImageSize(activeQuality, activeSize, config.model);
    // 后台给这个图片模型勾了可用画质档就只开那几档，没勾=不限制（全开）。
    // 用 config.model 优先、回落 imageModel，与 previewImageSize 取的是同一个模型字段。
    // 同视频面板：按"谁被标成 image 就用谁"来挑，避免在某些页面 config.model 存的是别类模型时查错。
    const imageModelName = [config.model, config.imageModel].filter(Boolean).find((n) => modelKindFromConfig(n as string) === "image") || config.model || config.imageModel || "";
    const allowedQualities = modelResolutionsFromConfig(imageModelName);

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className={className}
                style={{ color: theme.node.text }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-lg font-semibold">图像设置</div> : null}
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>质量</SettingTitle>
                    <div className="grid grid-cols-3 gap-2.5">
                        {qualityOptions.map((item) => (
                            <OptionPill key={item.value} selected={activeQuality === item.value} disabled={allowedQualities.length > 0 && !allowedQualities.includes(item.value)} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                    {allowedQualities.length && allowedQualities.length < qualityOptions.length ? (
                        <div className="text-[11px] leading-4 opacity-55">该模型仅支持 {allowedQualities.map((item) => item.toUpperCase()).join(" / ")}。</div>
                    ) : null}
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>宽高比</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {aspectOptions.map((item) => {
                            const itemSelected = selectedAspect?.value === item.value;
                            return (
                                <button
                                    key={item.value}
                                    type="button"
                                    className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border text-sm hover:opacity-80"
                                    style={{
                                        borderColor: itemSelected ? theme.node.activeStroke : theme.node.stroke,
                                        background: itemSelected ? settingSelectedFill(theme) : "transparent",
                                        color: itemSelected ? theme.node.activeStroke : theme.node.text,
                                        transition: SETTING_SELECT_TRANSITION,
                                    }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => onConfigChange("size", item.value)}
                                >
                                    <AspectIcon type={item.icon} width={item.width} height={item.height} color={itemSelected ? theme.node.activeStroke : theme.node.text} />
                                    <span>{item.label}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="text-xs" style={{ color: theme.node.muted }}>
                        {config.model?.toLowerCase().includes("gpt-image") || config.model?.toLowerCase().includes("gemini")
                            ? "图生图按所选比例输出。"
                            : "图生图（带参考图）时输出比例以参考图为主，仅靠提示词约束，可能与所选比例有偏差；需精确比例可换 gpt-image / gemini 模型或对结果裁切。"}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>尺寸</SettingTitle>
                    <div className="flex h-11 items-center justify-center rounded-xl border text-base font-medium tabular-nums" style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}>
                        {preview ? `${preview.width} × ${preview.height}` : "—"}
                    </div>
                    <div className="text-xs" style={{ color: theme.node.muted }}>
                        按「质量 + 宽高比」自动计算{config.model?.toLowerCase().includes("seedream") || config.model?.toLowerCase().includes("doubao") ? "（Seedream 会放大至最小像素要求）" : ""}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>生成张数</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {Array.from({ length: quickCount }, (_, index) => index + 1).map((value) => (
                            <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                {value} 张
                            </OptionPill>
                        ))}
                        <CountInput value={count} max={maxCount} theme={theme} onChange={(value) => onConfigChange("count", String(value || 1))} />
                    </div>
                </div>
            </div>
        </ImageSettingsTheme>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: { Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text } },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

// 选中态主色淡底：按当前主题的强调色（亮 #2563EB / 暗 #3B82F6）给出对应透明度的底色
export function settingSelectedFill(theme: CanvasTheme) {
    return theme.node.activeStroke.toLowerCase() === "#3B82F6" ? "rgba(59,130,246,.10)" : "rgba(37,99,235,.07)";
}

export const SETTING_SELECT_TRANSITION = "border-color 0.18s, background-color 0.18s, color 0.18s, opacity 0.18s";

export function imageQualityLabel(value: string) {
    const normalized = qualityOptions.some((item) => item.value === value) ? value : QUALITY_LEGACY[value] || value;
    return ({ "1k": "1K", "2k": "2K", "4k": "4K" } as Record<string, string>)[normalized] || normalized;
}

export function imageSizeLabel(size: string) {
    return aspectOptions.find((item) => item.value === size)?.label || size;
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    const className = disabled ? "h-9 cursor-not-allowed rounded-full border px-2 text-sm opacity-40" : "h-9 cursor-pointer rounded-full border px-2 text-sm hover:opacity-80";
    return (
        <button
            type="button"
            disabled={disabled}
            className={className}
            style={{
                background: selected ? settingSelectedFill(theme) : "transparent",
                borderColor: selected ? theme.node.activeStroke : theme.node.stroke,
                color: selected ? theme.node.activeStroke : theme.node.text,
                transition: SETTING_SELECT_TRANSITION,
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function CountInput({ value, max, theme, onChange }: { value: number; max: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="col-span-2 flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function AspectIcon({ type, width, height, color }: { type: string; width: number; height: number; color: string }) {
    if (type === "auto") return null;
    const ratio = width / Math.max(1, height);
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

