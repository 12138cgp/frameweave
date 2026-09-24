"use client";

import { useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { App, Avatar, Dropdown, Tooltip } from "antd";
import { CloudUpload, FolderKanban, Keyboard, KeyRound, LifeBuoy, LogOut, ReceiptText, Settings2, Shield, Zap } from "@/components/icons";
import type { ItemType } from "antd/es/menu/interface";
import dynamic from "next/dynamic";
import Link from "next/link";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { flushCloudSync } from "@/services/cloud-sync";

// 「我的消耗」抽屉(任务日志/点数日志):重表格组件按需加载且不参与 SSG,
// 规避 bun 1.3.13 对「复杂客户端模块」在 SSG 阶段的 SIGILL(exit 132,与 admin task-logs 页同款处理)。
const MyUsageDrawer = dynamic(() => import("@/components/layout/my-usage-drawer"), { ssr: false });
// 素材上传状态面板同样按需加载、不参与 SSG（与上面同款 bun SSG 规避）。
const MediaStatusModal = dynamic(() => import("@/components/layout/media-status-modal").then((m) => m.MediaStatusModal), { ssr: false });


// 「反馈问题」弹窗：同款按需加载 + 不参与 SSG。
const FeedbackModal = dynamic(() => import("@/components/layout/feedback-modal").then((m) => m.FeedbackModal), { ssr: false });

// 「修改密码」弹窗：同款按需加载 + 不参与 SSG。
const ChangePasswordModal = dynamic(() => import("@/components/layout/change-password-modal").then((m) => m.ChangePasswordModal), { ssr: false });

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    accountOpen?: boolean;
    onAccountOpenChange?: (open: boolean) => void;
    accountRef?: RefObject<HTMLDivElement | null>;
    getPopupContainer?: (node: HTMLElement) => HTMLElement;
    // 当前画布若归属某个项目（且在我参与的项目里命中），徽标改显该项目剩余积分；否则显示个人积分。
    projectCredits?: { name: string; credits: number } | null;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, accountOpen, onAccountOpenChange, accountRef, getPopupContainer, projectCredits }: UserStatusActionsProps) {
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const clearSession = useUserStore((state) => state.clearSession);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    // 退出登录:先把没推上云的编辑推完(此刻还握着当前账号 token)再清会话;8s 超时上限,网络卡也不困住用户。
    const handleLogout = async () => {
        const hide = message.loading("正在退出…", 0);
        try {
            await Promise.race([flushCloudSync(), new Promise((resolve) => setTimeout(resolve, 8000))]);
        } finally {
            hide();
        }
        // clearSession 已内置清理用户缓存的逻辑，无需额外调用
        await clearSession();
    };
    // 「我的消耗」抽屉开关;canvas 变体的下拉是受控 open,打开抽屉前先关菜单避免两层叠着(参照快捷键入口)。
    const [usageOpen, setUsageOpen] = useState(false);
    const handleOpenUsage = () => {
        onAccountOpenChange?.(false);
        setUsageOpen(true);
    };
    const handleCloseUsage = () => setUsageOpen(false);
    // 素材上传状态：让用户能自己看到「哪些图还只在本机」并一键补传，而不是只收到一个告警。
    const [mediaOpen, setMediaOpen] = useState(false);
    const handleOpenMedia = () => {
        onAccountOpenChange?.(false);
        setMediaOpen(true);
    };


    // 「反馈问题」：用户遇到画布/素材/同步问题时，连同操作日志和现场快照一起报给管理员。
    // 放在这里而不是某个页面角落，是因为出问题时用户第一反应就是点头像找出口。
    const [feedbackOpen, setFeedbackOpen] = useState(false);
    const handleOpenFeedback = () => {
        onAccountOpenChange?.(false);
        setFeedbackOpen(true);
    };

    // 「修改密码」：放在头像下拉里，已登录用户可随时改自己的密码。
    const [changePasswordOpen, setChangePasswordOpen] = useState(false);
    const handleOpenChangePassword = () => {
        onAccountOpenChange?.(false);
        setChangePasswordOpen(true);
    };
    const canvasTheme = canvasThemes[theme];
    const userName = user?.displayName || user?.username || "";
    const credits = user?.credits ?? 0;
    const avatarUrl = user?.avatarUrl?.trim();
    const avatarText = (userName.trim()[0] || "U").toUpperCase();
    const naturalIconClass = "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-[180ms] hover:bg-accent hover:text-foreground [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const versionStyle = iconStyle;
    const avatarStyle: CSSProperties | undefined = variant === "canvas" ? { borderColor: canvasTheme.toolbar.border, color: canvasTheme.node.text, background: "transparent" } : undefined;
    const menuItems: ItemType[] = [
        { key: "user", disabled: true, label: <span className="font-medium text-current">{userName}</span> },
        ...(user?.role === "admin" || user?.role === "admin_l2" ? [{ key: "admin", icon: <Shield className="size-4" />, label: <Link href="/admin">管理后台</Link> }] : []),
        ...(onOpenShortcuts ? [{ key: "shortcuts", icon: <Keyboard className="size-4" />, label: "快捷键", onClick: onOpenShortcuts }] : []),
        { key: "usage", icon: <ReceiptText className="size-4" />, label: "我的消耗", onClick: handleOpenUsage },
        { key: "media", icon: <CloudUpload className="size-4" />, label: "素材上传状态", onClick: handleOpenMedia },
        { key: "feedback", icon: <LifeBuoy className="size-4" />, label: "反馈问题", onClick: handleOpenFeedback },
        { key: "change-password", icon: <KeyRound className="size-4" />, label: "修改密码", onClick: handleOpenChangePassword },
        { type: "divider" },
        { key: "logout", icon: <LogOut className="size-4" />, label: "退出登录", onClick: handleLogout },
    ];

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {showConfig ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label="配置" title="配置">
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
            {variant === "canvas" ? null : <VersionReleaseModal style={versionStyle} />}
            {variant === "canvas" && user ? (
                <Tooltip title={projectCredits ? `项目「${projectCredits.name}」剩余积分：${projectCredits.credits.toLocaleString()}` : `个人积分：${credits.toLocaleString()}`} placement="bottom">
                    <div className="mx-1 flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium tabular-nums opacity-90 transition-opacity duration-[180ms] hover:opacity-100" style={{ color: canvasTheme.node.text }}>
                        {projectCredits ? <FolderKanban className="size-3.5 shrink-0 text-brand" aria-hidden /> : <Zap className="size-3.5 shrink-0 text-brand" aria-hidden />}
                        <span>{(projectCredits ? projectCredits.credits : credits).toLocaleString()}</span>
                    </div>
                </Tooltip>
            ) : null}
            {!user && onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label="快捷键" title="快捷键">
                    <Keyboard className="size-4" />
                </button>
            ) : null}
            {!user ? (
                <Link href="/login" className="ink-underline mx-1.5 text-sm font-medium text-muted-foreground transition-colors duration-[180ms] hover:text-foreground" style={iconStyle}>
                    登录
                </Link>
            ) : null}
            {user ? (
                <div ref={accountRef}>
                    <Dropdown open={accountOpen} onOpenChange={onAccountOpenChange} trigger={["click"]} placement="bottomRight" getPopupContainer={getPopupContainer} styles={{ root: { minWidth: 150 } }} menu={{ items: menuItems }}>
                        <button type="button" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-transparent p-0 text-[0] leading-[0] transition" aria-label="账户菜单">
                            <Avatar
                                size={24}
                                src={avatarUrl ? <img src={avatarUrl} alt={userName} referrerPolicy="no-referrer" /> : undefined}
                                alt={userName}
                                className="!flex !items-center !justify-center border border-border bg-transparent text-[11px] font-semibold text-foreground transition-colors duration-[180ms] hover:border-foreground/40"
                                style={avatarStyle}
                            >
                                {avatarText}
                            </Avatar>
                        </button>
                    </Dropdown>
                </div>
            ) : null}
            {usageOpen ? <MyUsageDrawer onClose={handleCloseUsage} /> : null}
            {mediaOpen ? <MediaStatusModal open onClose={() => setMediaOpen(false)} /> : null}
            {feedbackOpen ? <FeedbackModal open onClose={() => setFeedbackOpen(false)} /> : null}
            {changePasswordOpen ? <ChangePasswordModal open onClose={() => setChangePasswordOpen(false)} /> : null}
        </div>
    );
}
