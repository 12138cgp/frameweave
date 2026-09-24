"use client";

import { BarChartOutlined, HomeOutlined, LogoutOutlined, MessageOutlined, PictureOutlined, ProjectOutlined, SettingOutlined, TeamOutlined, UserOutlined } from "@/components/icons";
import { Button, Flex, Layout, Menu, Spin, Typography, theme } from "antd";
import Link from "next/link";
import { APP_NAME } from "@/constant/env";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect } from "react";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { adminLayoutStyle } from "@/lib/app-theme";
import type { UserRole } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

// 允许进入后台的角色：超管与二级管理员
const ADMIN_ROLES: UserRole[] = ["admin", "admin_l2"];

// roles：限定哪些角色可见该菜单。
//
// 原先是 15 条平铺菜单（超管），找一样东西要从头扫到尾。这里按「做同一件事」收成 7 条，
// 关系最近的几页合进同一个页面的页签（见各 hub 的 inner.tsx）：
//   用量分析 = 生成统计 + 点数日志 + 任务日志
//   内容管理 = 素材库 + 画布历史 + 提示词管理
//   系统     = 系统设置 + 分级定价 + 短信记录
// 旧路由（/admin/credit-logs 等）全部保留可直接访问，老书签与外部链接不会失效。
//
// 短信记录涉及全平台手机号与短信内容，属隐私敏感数据，仅超管可见；
// 后端路由也已挂在超管专用组（避免 L2 点进去看到 403 空页）。
const adminMenus: { key: string; icon: ReactNode; label: string; roles: UserRole[] }[] = [
    { key: "/admin/users", icon: <UserOutlined />, label: "用户管理", roles: ["admin", "admin_l2"] },
    { key: "/admin/groups", icon: <TeamOutlined />, label: "分组管理", roles: ["admin", "admin_l2"] },
    { key: "/admin/projects", icon: <ProjectOutlined />, label: "项目管理", roles: ["admin", "admin_l2"] },
    { key: "/admin/usage", icon: <BarChartOutlined />, label: "用量分析", roles: ["admin", "admin_l2"] },
    // 用户反馈单列一条、不并进「系统」：反馈的价值全在【被及时看到】，
    // 埋进二级页签就等于没有。二级管理员也开放（只看得到自己下辖用户的反馈，
    // 由 handler.adminReportScope 限定）——出问题的人往往就归他管，让他先看一眼最有用。
    { key: "/admin/feedback", icon: <MessageOutlined />, label: "用户反馈", roles: ["admin", "admin_l2"] },
    { key: "/admin/content", icon: <PictureOutlined />, label: "内容管理", roles: ["admin"] },
    { key: "/admin/system", icon: <SettingOutlined />, label: "系统", roles: ["admin"] },
];

// 路径前缀 → 页头标题 + 左侧菜单高亮项；更长前缀排在前，保证前缀匹配取最精确项。
//
// menuKey：该路径应该点亮哪一条菜单。合并进页签的旧路由仍可直接访问（老书签/外部链接不失效），
// 此时点亮它所归属的聚合菜单，避免出现「页面开着、左边没有任何一项高亮」的悬空状态。
const adminRoutes = [
    { key: "/admin/feedback", title: "用户反馈", menuKey: "/admin/feedback" },
    { key: "/admin/usage", title: "用量分析", menuKey: "/admin/usage" },
    { key: "/admin/content", title: "内容管理", menuKey: "/admin/content" },
    { key: "/admin/system", title: "系统", menuKey: "/admin/system" },
    { key: "/admin/canvas-history", title: "画布历史", menuKey: "/admin/content" },
    { key: "/admin/credit-logs", title: "点数日志", menuKey: "/admin/usage" },
    { key: "/admin/user-audit", title: "操作审计", menuKey: "/admin/system" },
    { key: "/admin/generation-stats", title: "生成统计", menuKey: "/admin/usage" },
    { key: "/admin/task-logs", title: "任务日志", menuKey: "/admin/usage" },
    { key: "/admin/sms-logs", title: "短信记录", menuKey: "/admin/system" },

    { key: "/admin/settings", title: "系统设置", menuKey: "/admin/system" },
    { key: "/admin/pricing", title: "分级定价", menuKey: "/admin/system" },
    { key: "/admin/prompts", title: "提示词管理", menuKey: "/admin/content" },
    { key: "/admin/prompt-favorites", title: "收藏提示词", menuKey: "/admin/content" },
    { key: "/admin/assets", title: "素材库管理", menuKey: "/admin/content" },
    { key: "/admin/projects", title: "项目管理", menuKey: "/admin/projects" },
    { key: "/admin/groups", title: "分组管理", menuKey: "/admin/groups" },
    { key: "/admin/users", title: "用户管理", menuKey: "/admin/users" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
    const { token: antToken } = theme.useToken();
    const router = useRouter();
    const pathname = usePathname();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const logout = useUserStore((state) => state.clearSession);
    const activeRoute = adminRoutes.find((route) => pathname.startsWith(route.key));
    // 高亮取 menuKey 而不是 key：旧路由（如 /admin/credit-logs）本身已不在菜单里，
    // 用它自己当 selectedKey 会导致左侧一项都不亮。
    const activeKey = activeRoute?.menuKey ?? "";
    const pageTitle = activeRoute?.title ?? "用户管理";
    const isAdminRole = user?.role ? ADMIN_ROLES.includes(user.role) : false;
    const visibleMenus = adminMenus.filter((item) => (user?.role ? item.roles.includes(user.role) : false));

    useEffect(() => {
        if (!isReady) return;
        if (!token) {
            router.replace("/login?redirect=/admin");
            return;
        }
        if (!user?.role || !ADMIN_ROLES.includes(user.role)) {
            router.replace("/");
        }
    }, [isReady, router, token, user?.role]);

    if (!isReady || !token || !isAdminRole) {
        return (
            <div className="anim-fade" style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: antToken.colorBgLayout }}>
                <Spin size="large" />
            </div>
        );
    }

    return (
        <Layout hasSider style={{ height: "100vh", overflow: "hidden", background: antToken.colorBgLayout }}>
            <Layout.Sider width={adminLayoutStyle.siderWidth} style={{ height: "100vh", overflow: "hidden", background: antToken.colorBgContainer, borderRight: `1px solid ${antToken.colorBorder}` }}>
                <Flex align="center" gap={12} style={{ height: adminLayoutStyle.brandHeight, padding: "0 20px", borderBottom: `1px solid ${antToken.colorBorderSecondary}` }}>
                    <img src="/logo-mark.svg" alt="" aria-hidden style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0 }} />
                    <Typography.Text className="font-heading" style={{ fontSize: 18, fontWeight: 500, letterSpacing: "0.02em" }}>
                        {APP_NAME}
                    </Typography.Text>
                </Flex>
                <Menu
                    mode="inline"
                    selectedKeys={[activeKey]}
                    style={adminLayoutStyle.menu}
                    items={visibleMenus.map((item) => ({
                        key: item.key,
                        icon: item.icon,
                        label: (
                            <Link href={item.key} style={{ color: "inherit" }}>
                                {item.label}
                            </Link>
                        ),
                        style: adminLayoutStyle.menuItem,
                    }))}
                />
                <Flex vertical gap={10} style={{ position: "absolute", bottom: 0, insetInline: 0, padding: "14px 16px", borderTop: `1px solid ${antToken.colorBorder}`, background: antToken.colorBgContainer }}>
                    <Button block icon={<HomeOutlined />} href="/canvas" target="_blank" rel="noreferrer">
                        前往画布
                    </Button>
                    <Button block icon={<LogoutOutlined />} onClick={logout}>
                        退出登录
                    </Button>
                </Flex>
            </Layout.Sider>
            <Layout style={{ background: antToken.colorBgLayout }}>
                <Layout.Header
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: adminLayoutStyle.headerHeight, padding: "0 24px", background: antToken.colorBgContainer, borderBottom: `1px solid ${antToken.colorBorder}` }}
                >
                    <Typography.Title level={5} style={{ margin: 0 }}>
                        {pageTitle}
                    </Typography.Title>
                    <Flex align="center" gap={4}>
                        <UserStatusActions showConfig={false} />
                    </Flex>
                </Layout.Header>
                <Layout.Content style={{ minHeight: 0, overflow: "auto" }}>{children}</Layout.Content>
            </Layout>
        </Layout>
    );
}
