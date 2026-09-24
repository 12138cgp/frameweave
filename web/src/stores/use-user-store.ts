"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { AUTH_TOKEN_KEY, fetchCurrentUser, login, register, smsLogin, type AuthPayload, type AuthUser, type SmsLoginPayload } from "@/services/api/auth";
import { notifySessionExpired } from "@/services/api/request";
import { ensureLocalDataOwner, setLocalDataOwner } from "@/services/cache-isolation";
import { flushActionLog, logAction } from "@/services/action-log";

// 个人积分刷新完成事件：生成结束等场景会 hydrateUser 拉新余额，借此广播让
// 项目积分徽标（监听方自行拉 getMyProjects）同步刷新，避免 store 间互相依赖。
export const CREDITS_REFRESHED_EVENT = "frameweave:credits-refreshed";

type UserStore = {
    token: string;
    user: AuthUser | null;
    isReady: boolean;
    isLoading: boolean;
    setSession: (token: string, user: AuthUser) => void;
    clearSession: () => Promise<void>;
    hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>;
    register: (payload: AuthPayload) => Promise<AuthUser>;
    smsLogin: (payload: SmsLoginPayload) => Promise<AuthUser>;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            setSession: (token, user) => set({ token, user, isReady: true }),
            clearSession: async () => {
                // 退出/切账号是「本地数据被清空」的主要入口，必须留痕并【立刻落盘】——
                // 清完之后页面往往就跳走了，攒在内存里的日志会跟着一起没。
                logAction("session_cleared", { userId: get().user?.id || "", username: get().user?.username || "" });
                await flushActionLog().catch(() => {});
                // 登出时清理所有用户相关的本地缓存数据
                const { clearUserScopedCache } = await import("@/services/cache-isolation");
                await clearUserScopedCache();
                set({ token: "", user: null, isReady: true });
            },
            hydrateUser: async () => {
                const token = get().token;
                if (!token) {
                    set({ user: null, isReady: true });
                    return;
                }
                set({ isLoading: true });
                try {
                    const user = await fetchCurrentUser(token);
                    // 带着 token 却被认成 guest = token 已失效（被新设备顶号/过期）。
                    // 先广播（此刻 token 仍在，监听器才会弹「已在其他设备登录」提示并跳转），再兜底清会话。
                    if (user.role === "guest") {
                        notifySessionExpired();
                        set({ token: "", user: null, isReady: true, isLoading: false });
                        return;
                    }
                    set({ user, isReady: true, isLoading: false });
                    if (typeof window !== "undefined") window.dispatchEvent(new Event(CREDITS_REFRESHED_EVENT));
                } catch {
                    // 网络错误/服务暂不可用 ≠ 登录失效：保留 token，待下次复核，避免离线被误登出
                    set({ isReady: true, isLoading: false });
                }
            },
            login: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await login(payload);
                    logAction("session_login", { userId: session.user.id, username: session.user.username, method: "password" });
                    // 登录成功后立即检查并清理旧用户的本地缓存数据
                    await ensureLocalDataOwner(session.user.id);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    // 登录接口返回的 user 不含按分组算的能力字段（只有 /auth/me 有），
                    // 不补这一次的话，刚登录的用户要刷新一遍才看得到按分组开关控制的那些入口。
                    void get().hydrateUser();
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            register: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await register(payload);
                    // 注册成功后设置本地数据 owner
                    setLocalDataOwner(session.user.id);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    // 登录接口返回的 user 不含按分组算的能力字段（只有 /auth/me 有），
                    // 不补这一次的话，刚登录的用户要刷新一遍才看得到按分组开关控制的那些入口。
                    void get().hydrateUser();
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            smsLogin: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await smsLogin(payload);
                    // 登录成功后立即检查并清理旧用户的本地缓存数据
                    await ensureLocalDataOwner(session.user.id);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    // 同密码登录：补一次 /auth/me，把按分组算的能力字段填上。
                    void get().hydrateUser();
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
        }),
        {
            name: AUTH_TOKEN_KEY,
            partialize: (state) => ({ token: state.token }),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);
