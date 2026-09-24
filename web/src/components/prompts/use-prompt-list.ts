"use client";

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { ALL_PROMPTS_OPTION, fetchPrompts } from "@/services/api/prompts";

export const PROMPT_PAGE_SIZE = 20;

export function usePromptList({ keyword, tags, category, enabled = true }: { keyword: string; tags: string[]; category: string; enabled?: boolean }) {
    const query = useInfiniteQuery({
        queryKey: ["prompts", keyword, tags, category],
        queryFn: ({ pageParam }) => fetchPrompts({ keyword, tag: tags, category, page: pageParam, pageSize: PROMPT_PAGE_SIZE }),
        initialPageParam: 1,
        getNextPageParam: (lastPage, pages) => (pages.reduce((total, page) => total + page.items.length, 0) < lastPage.total ? pages.length + 1 : undefined),
        enabled,
    });
    const firstPage = query.data?.pages[0];
    return {
        query,
        items: useMemo(() => query.data?.pages.flatMap((page) => page.items) || [], [query.data?.pages]),
        tags: useMemo(() => [ALL_PROMPTS_OPTION, ...(firstPage?.tags || [])], [firstPage?.tags]),
        categories: useMemo(() => [ALL_PROMPTS_OPTION, ...(firstPage?.categories || [])], [firstPage?.categories]),
        // 带中文名与说明的分类选项。老接口只回编码数组时降级成「名字=编码」，
        // 至少不会整栏空白（比显示一串 slug 更糟的是什么都不显示）。
        categoryOptions: useMemo(() => {
            const all = { category: ALL_PROMPTS_OPTION, name: ALL_PROMPTS_OPTION, description: "", count: 0 };
            const options = firstPage?.categoryOptions;
            if (options && options.length) return [all, ...options];
            return [all, ...(firstPage?.categories || []).map((code) => ({ category: code, name: code, description: "", count: 0 }))];
        }, [firstPage?.categoryOptions, firstPage?.categories]),
        total: firstPage?.total || 0,
    };
}
