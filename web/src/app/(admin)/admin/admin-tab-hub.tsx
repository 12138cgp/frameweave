"use client";

import { Tabs } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ComponentType } from "react";
import { useMemo } from "react";

export type HubTab = {
    key: string;
    label: string;
    // 传组件本身而不是元素：未激活的页签根本不实例化，
    // 避免一进聚合页就把三个子页的请求同时打出去。
    Component: ComponentType;
};

/**
 * 后台聚合页：把原先几个平铺菜单合并成一个页面的多个页签。
 *
 * 两个刻意的设计：
 * 1. 只渲染当前激活的页签。子页各自在 useEffect 里拉数据，若一次性全挂上，
 *    进一次「用量分析」就会同时打三份查询（其中任务日志/生成统计都是重查询）。
 * 2. 当前页签写进 URL 的 ?tab=，刷新后停在原处，也能把某个页签的链接直接发给别人。
 *    用 replace 而不是 push，切页签不污染浏览器后退历史。
 */
export function AdminTabHub({ tabs }: { tabs: HubTab[] }) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();

    const active = useMemo(() => {
        const want = params.get("tab");
        return tabs.some((t) => t.key === want) ? (want as string) : tabs[0]?.key;
    }, [params, tabs]);

    const items = tabs.map((t) => {
        const Comp = t.Component;
        return { key: t.key, label: t.label, children: t.key === active ? <Comp /> : null };
    });

    return (
        <Tabs
            items={items}
            activeKey={active}
            onChange={(key) => router.replace(`${pathname}?tab=${key}`, { scroll: false })}
            destroyInactiveTabPane
        />
    );
}
