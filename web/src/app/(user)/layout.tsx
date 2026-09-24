"use client";

import type { ReactNode } from "react";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { CoverBatchHost } from "@/components/layout/cover-batch-host";

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <AppTopNav />
            <div className="relative min-h-0 flex-1 overflow-hidden">
                {children}
                {/* 常驻批量封面 iframe（仅在 /cover-batch 显示），跨导航切换保留其状态 */}
                <CoverBatchHost />
            </div>
        </div>
    );
}
