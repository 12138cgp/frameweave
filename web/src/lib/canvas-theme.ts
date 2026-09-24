export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

// 画布主题：冷灰底 + 深石板文字 + 钴蓝强调（与 globals.css 设计 token 同源）
export const canvasThemes = {
    light: {
        canvas: {
            background: "#f5f7fb",
            dot: "rgba(100,116,139,.26)",
            line: "rgba(100,116,139,.10)",
            selectionStroke: "#2563eb",
            selectionFill: "rgba(37,99,235,.07)",
        },
        node: {
            label: "#475569",
            fill: "#ffffff",
            panel: "#f1f5f9",
            stroke: "#e2e8f0",
            activeStroke: "#2563eb",
            placeholder: "#94a3b8",
            text: "#0f172a",
            muted: "#64748b",
            faint: "#94a3b8",
        },
        toolbar: {
            panel: "rgba(255,255,255,.96)",
            border: "#e2e8f0",
            item: "#475569",
            itemHover: "#f1f5f9",
            activeBg: "#eff6ff",
            activeText: "#1d4ed8",
        },
    },
    dark: {
        canvas: {
            background: "#0b1220",
            dot: "rgba(148,163,184,.2)",
            line: "rgba(148,163,184,.08)",
            selectionStroke: "#3b82f6",
            selectionFill: "rgba(59,130,246,.12)",
        },
        node: {
            label: "#cbd5e1",
            fill: "#111a2e",
            panel: "#0f1830",
            stroke: "#26324d",
            activeStroke: "#3b82f6",
            placeholder: "#94a3b8",
            text: "#e2e8f0",
            muted: "#cbd5e1",
            faint: "#52607a",
        },
        toolbar: {
            panel: "rgba(17,26,46,.96)",
            border: "#26324d",
            item: "#cbd5e1",
            itemHover: "#1a2540",
            activeBg: "#172554",
            activeText: "#bfdbfe",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
