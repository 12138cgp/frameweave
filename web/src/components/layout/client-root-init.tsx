"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { App } from "antd";
import { APP_NAME, storageKey } from "@/constant/env";

import { apiGet, SESSION_EXPIRED_EVENT } from "@/services/api/request";
import { bindActionLogUser, installActionLogHooks } from "@/services/action-log";
import { UpdateBanner } from "@/components/layout/update-banner";
import { AUTH_TOKEN_KEY } from "@/services/api/auth";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { flushCloudSync } from "@/services/cloud-sync";

// 「更新提醒」已读的 announcement id 列表（每用户每 id 只弹一次）。
const ANNOUNCEMENT_SEEN_KEY = storageKey("announcement-seen-v1");

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    // 自动版本检测：记下启动时的部署版本，轮询发现变化即提示刷新（杜绝用户卡在部署前的旧客户端）。
    const appBuildIdRef = useRef<string | null>(null);
    const updatePromptedRef = useRef(false);
    // 底部更新横幅：自动检测到新版本、或管理员发了更新提醒，都走这一条。
    // 不用弹窗也不用角落浮层——见 update-banner.tsx 顶部说明。
    // 公告与版本更新分开存：两者按钮文案和行为都不同（知道了/关掉 vs 更新/刷新）。
    // 同时出现时先显示公告——管理员写的话比「有新版本」具体得多。
    const [announcementBanner, setAnnouncementBanner] = useState<{ id: string; message: string } | null>(null);
    const [versionUpdateReady, setVersionUpdateReady] = useState(false);
    const [versionUpdating, setVersionUpdating] = useState(false);
    const pathname = usePathname();
    const router = useRouter();
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const token = useUserStore((state) => state.token);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";

    // 操作日志的全局钩子（JS 报错、未处理的 Promise 拒绝、页面生命周期、断网上线）。
    // 装得越早越好：装之前发生的事就是真的没了。放在这里是因为 ClientRootInit 包住整个应用。
    useEffect(() => {
        // 先注入「当前用户」的读取方式再装钩子：装钩子时会记一条 app_start，
        // 顺序反了那条就会缺 userId（虽不致命，但排查时会多一次困惑）。
        bindActionLogUser(() => useUserStore.getState().user?.id || "");
        installActionLogHooks();
    }, []);

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings, token]);

    useEffect(() => {
        if (!isLoginPage) void hydrateUser();
    }, [hydrateUser, isLoginPage]);

    // 「更新提醒」一次性弹窗：管理员在后台开启公告后，登录用户对每个 announcement id 只弹一次（可关闭）。
    // 弹出前先记下该 id 为已读，保证无论怎么关都不会重复弹；公告刷新由下方 60s 心跳轮询 /api/settings 驱动，
    // 已打开的页面也能在一次心跳内收到。
    const announcement = publicSettings?.announcement;
    useEffect(() => {
        if (isLoginPage || !token) return;
        if (!announcement?.enabled || !announcement.message || !announcement.id) return;
        const id = announcement.id;
        let seen: string[] = [];
        try {
            seen = JSON.parse(localStorage.getItem(ANNOUNCEMENT_SEEN_KEY) || "[]");
        } catch {
            seen = [];
        }
        if (Array.isArray(seen) && seen.includes(id)) return;
        // 已读标记推迟到用户【点了更新】才写：原先一显示就标已读，用户没看清就刷新掉，
        // 这条公告就永远不会再出现了。横幅本来就不打断人，没必要抢在前面标。
        setAnnouncementBanner({ id, message: announcement.message });
    }, [announcement?.enabled, announcement?.message, announcement?.id, isLoginPage, token]);

    // 公告点「知道了」：记为已读、关掉横幅。**不刷新页面**——公告可能只是「今晚 8 点维护」，
    // 跟版本没关系，刷新既没用又打断人。关掉后若有版本更新在等，横幅会自动换成那条。
    const handleAnnouncementAck = useCallback(() => {
        const id = announcementBanner?.id;
        if (id) {
            try {
                const raw = JSON.parse(localStorage.getItem(ANNOUNCEMENT_SEEN_KEY) || "[]");
                const seen = Array.isArray(raw) ? raw : [];
                localStorage.setItem(ANNOUNCEMENT_SEEN_KEY, JSON.stringify([...seen, id].slice(-50)));
            } catch {
                /* localStorage 不可用就算了，最多下次再提示一遍 */
            }
        }
        setAnnouncementBanner(null);
    }, [announcementBanner?.id]);

    // 版本更新点「更新」：刷新页面拿新构建。
    // 点「更新」= 先把手头的修改推上云、再载入新版本。
    //
    // 原先只有一句 window.location.reload()，横幅却写着「手头的工作会自动同步」——名不副实：
    // 刷新会撞上 cloud-sync 的 beforeunload 守卫（还有没推完的编辑时它会拦），
    // 用户于是莫名多出一个浏览器原生确认框（文案还改不了），反而以为出了故障。
    // 退出登录/切账号早就是「推完再走」，更新这里属于遗漏，这里补齐同一套。
    //
    // 8 秒封顶与退出登录同源：极端网络下宁可放行也不把用户困在这。
    // 推不完也照样 reload —— 没推上去的那部分仍在本地，beforeunload 会照旧拦一下，不会静默丢。
    const handleVersionUpdate = useCallback(async () => {
        if (versionUpdating) return; // 防连点：flush 期间再点没有意义
        setVersionUpdating(true);
        const hide = message.loading("正在同步你的修改…", 0);
        try {
            await Promise.race([flushCloudSync(), new Promise((resolve) => setTimeout(resolve, 8000))]);
        } finally {
            hide();
            window.location.reload();
        }
    }, [message, versionUpdating]);

    // 单设备登录被顶号的统一出口：任何请求收到 401 即广播本事件 → 清会话 + 提示 + 跳登录
    const sessionExpiredHandled = useRef(false);
    useEffect(() => {
        const onExpired = () => {
            if (sessionExpiredHandled.current) return;
            if (!useUserStore.getState().token) return;
            sessionExpiredHandled.current = true;
            void useUserStore.getState().clearSession();
            message.warning("登录已失效，可能账号已在其他设备登录");
            router.replace(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
            setTimeout(() => {
                sessionExpiredHandled.current = false;
            }, 3000);
        };
        window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
        return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    }, [message, router]);

    // 全局心跳：非 RequireAuth 页面（首页/提示词页等）也能发现被顶号；标签页回前台时立刻复核
    useEffect(() => {
        if (isLoginPage) return;
        // 自动版本检测：首次记录启动版本；之后每次心跳比对 /api/version，发现新部署即一次性提示刷新。
        const checkAppVersion = async () => {
            try {
                const res = await apiGet<{ buildId?: string }>("/api/version");
                const buildId = (res?.buildId || "").trim();
                if (!buildId) return;
                if (appBuildIdRef.current === null) {
                    appBuildIdRef.current = buildId;
                    return;
                }
                if (buildId !== appBuildIdRef.current && !updatePromptedRef.current) {
                    updatePromptedRef.current = true;
                    setVersionUpdateReady(true);
                    return;
                }
            } catch {
                /* 网络抖动忽略，下次心跳再试 */
            }
        };
        const tick = () => {
            if (document.visibilityState !== "visible") return;
            void checkAppVersion(); // 版本检测不依赖登录态，任何页面都生效
            void loadPublicSettings(); // 刷新公开配置（含「更新提醒」公告），让已打开的页面也能在一次心跳内收到
            if (!useUserStore.getState().token) return;
            void useUserStore.getState().hydrateUser();
        };
        void checkAppVersion(); // 进入即记录启动版本
        const timer = setInterval(tick, 60_000);
        const onVisible = () => {
            if (document.visibilityState === "visible") tick();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [isLoginPage, loadPublicSettings]);

    // 跨标签页同步登录态：另一个标签页登出/换号时，本页跟随（zustand persist 不自带跨页广播）
    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key !== AUTH_TOKEN_KEY) return;
            let nextToken = "";
            try {
                nextToken = event.newValue ? (JSON.parse(event.newValue)?.state?.token ?? "") : "";
            } catch {
                nextToken = "";
            }
            const current = useUserStore.getState().token;
            if (nextToken === current) return;
            if (!nextToken) {
                void useUserStore.getState().clearSession();
                return;
            }
            useUserStore.setState({ token: nextToken });
            void useUserStore.getState().hydrateUser();
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        if (!publicSettings) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        if (!publicSettings.modelChannel.allowCustomChannel) {
            openConfigDialog(false);
            message.error("后台未允许用户自定义渠道，请联系管理员进行配置");
            return;
        }
        updateConfig("channelMode", "local");
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
    }, [message, openConfigDialog, publicSettings, updateConfig]);

    return (
        <>
            {children}
            {/* 版本更新优先于公告。

                原先是反过来的（理由是「管理员写的话比『有新版本』具体」），但那样有个漏洞：
                公告只有用户点了「知道了」才消失，**一直不点就一直挂着**，版本更新提示就永远排不上，
                用户会毫不知情地卡在部署前的旧客户端上——而这正是当初做版本检测要杜绝的事。

                反过来则不丢公告：版本更新的动作是刷新页面，而公告的已读只在用户点「知道了」时才记，
                所以刷新之后那条公告会原样再出现，照样看得到。 */}
            {versionUpdateReady ? (
                <UpdateBanner
                    message={`${APP_NAME}已更新。点「更新」会先保存并同步你手头的工作，再载入新版本。`}
                    actionLabel={versionUpdating ? "同步中…" : "更新"}
                    onAction={handleVersionUpdate}
                />
            ) : announcementBanner ? (
                <UpdateBanner message={announcementBanner.message} actionLabel="知道了" onAction={handleAnnouncementAck} />
            ) : null}
        </>
    );
}
