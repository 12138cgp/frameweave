"use client";

import { useEffect, useRef } from "react";
import { Button } from "antd";
import { Sparkles } from "@/components/icons";

// 底部更新横幅。
//
// 为什么不用弹窗：更新对用户【不紧急】——旧页面照常能用，刷新只是为了拿到新版本。
// 居中 Modal 会抢焦点、打断正在拖节点/写提示词/等出图的人，逼他当场做选择；
// 右下角通知虽然不抢焦点，但仍是一块方形的浮层，压在画布上。
// 一条贴着屏幕最底边的细横幅遮挡最小，而且始终看得见。
//
// 三条行为约定：
//  1. **没有关闭按钮**。用户不点那个按钮它就一直在——这正是要的效果：
//     不打断，但也不让人错过。
//  2. **动作文案和行为由调用方决定**，因为这条横幅承载两件不同的事：
//     · 版本更新（自动检测到新构建）→ 按钮「更新」，点了刷新页面拿新版本
//     · 系统公告（管理员发的通知）  → 按钮「知道了」，点了记为已读、关掉，**不刷新**
//     一开始两者共用「更新」，可公告很可能是「今晚 8 点维护」这类内容，
//     让用户去点「更新」既莫名其妙又什么都解决不了。
//  3. 出现时把 --app-banner-h 置为自身高度，画布底部那几个悬浮控件（工具栏、
//     小地图、素材侧栏）据此整体上抬，绝不被这条横幅盖住半截。
export const APP_BANNER_HEIGHT = 40;
const BANNER_VAR = "--app-banner-h";

// source 标明这条横幅是谁的，写进 data-app-banner 供彼此感知：
//   system = 管理员公告 / 版本更新（client-root-init 渲染，优先级最高）
//   guide  = 新功能引导（画布页渲染，见 canvas-feature-guide.tsx，会主动给 system 让位）
// 底部这一格同时只该有一条，两边靠这个属性互相看得见。
export function UpdateBanner({ message, actionLabel, onAction, source = "system" }: { message: string; actionLabel: string; onAction: () => void; source?: "system" | "guide" }) {
    const selfRef = useRef<HTMLDivElement | null>(null);
    // 让画布底部控件避开这条横幅。卸载时一定要还原，否则横幅没了控件还悬在半空。
    useEffect(() => {
        const root = document.documentElement;
        root.style.setProperty(BANNER_VAR, `${APP_BANNER_HEIGHT}px`);
        return () => {
            // 但别急着清零——引导给系统横幅让位的那一瞬间，两条会短暂共存。
            // 这时候若把高度归零，画布底部那排控件会掉下去、正好被留下的那条盖住半截。
            const others = Array.from(document.querySelectorAll("[data-app-banner]")).filter((el) => el !== selfRef.current);
            if (others.length) return;
            root.style.setProperty(BANNER_VAR, "0px");
        };
    }, []);

    return (
        <div
            ref={selfRef}
            data-app-banner={source}
            className="anim-rise fixed inset-x-0 bottom-0 z-[1200] flex items-center justify-center gap-3 border-t px-4 backdrop-blur"
            style={{
                height: APP_BANNER_HEIGHT,
                background: "color-mix(in srgb, var(--background) 88%, transparent)",
                borderColor: "var(--border)",
            }}
            role="status"
        >
            <Sparkles className="size-3.5 shrink-0 text-brand" aria-hidden />
            <span className="truncate text-[13px] text-foreground/85">{message}</span>
            <Button type="primary" size="small" onClick={onAction}>
                {actionLabel}
            </Button>
        </div>
    );
}

export default UpdateBanner;
