"use client";

import { create } from "zustand";

import { getMyProjects, type MyProject } from "@/services/api/projects";

// 当前用户参与的项目（含积分池余额），供「新建画布选积分来源」弹窗与右上角积分徽标共用。
// 打开画布、新建画布、以及每次生成完成后都会 refresh，让项目池余额跟着扣费实时变化。
type MyProjectsStore = {
    projects: MyProject[];
    loading: boolean;
    loadedOnce: boolean;
    refresh: (token: string) => Promise<MyProject[]>;
    findProject: (projectId?: string) => MyProject | undefined;
};

let inflight: Promise<MyProject[]> | null = null;

export const useMyProjectsStore = create<MyProjectsStore>()((set, get) => ({
    projects: [],
    loading: false,
    loadedOnce: false,
    refresh: async (token) => {
        if (!token) {
            set({ projects: [], loadedOnce: true });
            return [];
        }
        // 多处（生成完成 + 徽标刷新）可能并发触发，合并为一次请求
        if (inflight) return inflight;
        set({ loading: true });
        inflight = getMyProjects(token)
            .then((items) => {
                set({ projects: items, loading: false, loadedOnce: true });
                return items;
            })
            .catch(() => {
                // 拉取失败保留旧数据，仅结束 loading，避免徽标闪回个人积分
                set({ loading: false, loadedOnce: true });
                return get().projects;
            })
            .finally(() => {
                inflight = null;
            });
        return inflight;
    },
    findProject: (projectId) => {
        if (!projectId) return undefined;
        return get().projects.find((item) => item.id === projectId);
    },
}));
