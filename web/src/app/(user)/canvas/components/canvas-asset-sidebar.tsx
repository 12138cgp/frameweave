import { Tabs } from "antd";
import { ChevronRight, Images } from "@/components/icons";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { LibraryTab, MyAssetsTab, type AssetPickerTab, type InsertAssetPayload } from "./asset-picker-modal";
import { TeamAssetsTab } from "./canvas-team-assets-tab";
import { PromptFavoritesTab } from "./canvas-prompt-favorites-tab";
import type { GroupAsset } from "@/services/api/group-assets";
import type { PromptFavorite } from "@/services/api/prompt-favorite";

// 固定在画布右侧、可展开/折叠的素材侧栏。复用 AssetPickerModal 的 LibraryTab / MyAssetsTab 列表与数据源。
export function CanvasAssetSidebar({
    open,
    activeTab,
    onTabChange,
    onToggle,
    onInsert,
    onInsertGroupAsset,
    onApplyFavorite,
    currentCanvasName,
    currentProjectId,
}: {
    open: boolean;
    activeTab: AssetPickerTab;
    onTabChange: (tab: AssetPickerTab) => void;
    onToggle: (open: boolean) => void;
    onInsert: (payload: InsertAssetPayload) => void;
    onInsertGroupAsset: (asset: GroupAsset) => void;
    // 把一条收藏的提示词/配置/风格填回画布（新建对应类型的节点）。
    onApplyFavorite: (item: PromptFavorite) => void;
    currentCanvasName?: string;
    currentProjectId?: string;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const panelShadow = colorTheme === "dark" ? "0 2px 8px rgba(0,0,0,.3), -8px 0 32px rgba(0,0,0,.4)" : "0 2px 8px rgba(15,23,42,.08), -8px 0 32px rgba(15,23,42,.12)";

    if (!open) {
        return (
            <button
                type="button"
                className="anim-fade absolute right-3 top-1/2 z-[60] flex h-24 w-9 -translate-y-1/2 flex-col items-center justify-center gap-1.5 rounded-full border backdrop-blur transition hover:opacity-100"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item, boxShadow: panelShadow }}
                onClick={() => onToggle(true)}
                aria-label="展开素材库"
                title="素材库"
            >
                <Images className="size-4.5" />
                <span className="text-[11px] font-medium leading-tight" style={{ writingMode: "vertical-rl" }}>
                    素材
                </span>
            </button>
        );
    }

    return (
        <aside
            className="anim-rise absolute bottom-[calc(0.75rem+var(--app-banner-h,0px))] right-3 top-20 z-[60] flex w-[340px] flex-col overflow-hidden rounded-2xl border backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: panelShadow }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
        >
            <div className="flex items-center justify-between gap-2 px-3 pt-3">
                <span className="flex items-center gap-2 text-sm font-medium" style={{ color: theme.node.text }}>
                    <Images className="size-4" />
                    素材库
                </span>
                <button
                    type="button"
                    className="grid size-7 place-items-center rounded-lg opacity-60 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    style={{ color: theme.toolbar.item }}
                    onClick={() => onToggle(false)}
                    aria-label="收起素材库"
                    title="收起"
                >
                    <ChevronRight className="size-4.5" />
                </button>
            </div>
            <Tabs
                className="flex min-h-0 flex-1 flex-col px-3 [&_.ant-tabs-content]:h-full [&_.ant-tabs-content-holder]:min-h-0 [&_.ant-tabs-content-holder]:flex-1 [&_.ant-tabs-content-holder]:overflow-y-auto [&_.ant-tabs-nav]:!mb-2"
                activeKey={activeTab}
                onChange={(key) => onTabChange(key as AssetPickerTab)}
                items={[
                    { key: "my-assets", label: "我的素材", children: <MyAssetsTab onInsert={onInsert} columns={2} pageSize={12} /> },
                    { key: "team-assets", label: "团队素材", children: <TeamAssetsTab onInsert={onInsertGroupAsset} currentCanvasName={currentCanvasName} currentProjectId={currentProjectId} columns={2} pageSize={24} /> },
                    { key: "library", label: "素材库", children: <LibraryTab onInsert={onInsert} columns={2} pageSize={12} /> },
                    { key: "prompt-favorites", label: "收藏提示词", children: <PromptFavoritesTab onApply={onApplyFavorite} columns={2} pageSize={12} /> },
                ]}
            />
        </aside>
    );
}
