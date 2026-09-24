import type { CSSProperties } from "react";
import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

// 中性色（冷灰 slate，与 globals.css / canvas-theme.ts 同源）
const neutral = {
    light: {
        primary: "#0f172a",
        primaryHover: "#020617",
        primaryText: "#ffffff",
        menuBg: "#eff6ff",
        menuText: "#1d4ed8",
        selectActiveBg: "#f1f5f9",
        selectSelectedBg: "#eff6ff",
        selectText: "#1d4ed8",
        tableSelectedBg: "rgba(37, 99, 235, 0.06)",
        tableSelectedHoverBg: "rgba(37, 99, 235, 0.1)",
    },
    dark: {
        primary: "#e2e8f0",
        primaryHover: "#f8fafc",
        primaryText: "#0b1220",
        menuBg: "#172554",
        menuText: "#bfdbfe",
        selectActiveBg: "#1a2540",
        selectSelectedBg: "#172554",
        selectText: "#bfdbfe",
        tableSelectedBg: "rgba(59, 130, 246, 0.12)",
        tableSelectedHoverBg: "rgba(59, 130, 246, 0.18)",
    },
};

export const adminLayoutStyle = {
    siderWidth: 232,
    headerHeight: 56,
    brandHeight: 64,
    menu: { borderInlineEnd: 0, padding: "18px 12px", fontSize: 15 } satisfies CSSProperties,
    menuItem: { height: 40, lineHeight: "40px", marginBlock: 2, borderRadius: 6 } satisfies CSSProperties,
};

// 主色（钴蓝），用于主按钮 / 链接 / 强调 / 选中焦点等。
const brand = {
    light: { primary: "#2563eb", primaryHover: "#1d4ed8" },
    dark: { primary: "#3b82f6", primaryHover: "#60a5fa" },
};

const surface = {
    light: {
        bgLayout: "#f5f7fb",
        bgContainer: "#ffffff",
        bgElevated: "#ffffff",
        border: "#e2e8f0",
        borderSecondary: "#eef2f7",
        text: "#0f172a",
        textSecondary: "#475569",
        textTertiary: "#64748b",
    },
    dark: {
        bgLayout: "#0b1220",
        bgContainer: "#111a2e",
        bgElevated: "#131d33",
        border: "#26324d",
        borderSecondary: "#1c2742",
        text: "#e2e8f0",
        textSecondary: "#94a3b8",
        textTertiary: "#7c8aa3",
    },
};

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? neutral.dark : neutral.light;
    const accent = dark ? brand.dark : brand.light;
    const paper = dark ? surface.dark : surface.light;

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "aicanvas-dark" : "aicanvas-light" },
        token: {
            colorPrimary: accent.primary,
            colorInfo: accent.primary,
            colorLink: accent.primary,
            colorLinkHover: accent.primaryHover,
            colorLinkActive: accent.primaryHover,
            colorTextLightSolid: "#ffffff",
            colorBgLayout: paper.bgLayout,
            colorBgContainer: paper.bgContainer,
            colorBgElevated: paper.bgElevated,
            colorBorder: paper.border,
            colorBorderSecondary: paper.borderSecondary,
            colorText: paper.text,
            colorTextSecondary: paper.textSecondary,
            colorTextTertiary: paper.textTertiary,
            colorError: dark ? "#ef4444" : "#dc2626",
            colorSuccess: dark ? "#34d399" : "#059669",
            colorWarning: dark ? "#fbbf24" : "#d97706",
            borderRadius: 6,
            borderRadiusLG: 8,
            borderRadiusSM: 4,
        },
        components: {
            Button: {
                primaryShadow: "none",
                borderRadius: 6,
                borderRadiusLG: 8,
                borderRadiusSM: 4,
            },
            Menu: {
                itemActiveBg: color.menuBg,
                itemHoverBg: color.menuBg,
                itemSelectedBg: color.menuBg,
                itemSelectedColor: color.menuText,
                darkItemHoverBg: neutral.dark.menuBg,
                darkItemSelectedBg: neutral.dark.menuBg,
                darkItemSelectedColor: neutral.dark.menuText,
            },
            Select: {
                optionActiveBg: color.selectActiveBg,
                optionSelectedBg: color.selectSelectedBg,
                optionSelectedColor: color.selectText,
            },
            Table: {
                rowSelectedBg: color.tableSelectedBg,
                rowSelectedHoverBg: color.tableSelectedHoverBg,
            },
            Segmented: {
                borderRadius: 6,
                borderRadiusSM: 4,
                borderRadiusLG: 8,
            },
        },
    };
}
