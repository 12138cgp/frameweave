"use client";

import dynamic from "next/dynamic";

// ssr:false 外壳：后台重页面在 bun 1.3.13 的 SSG 阶段会段错误（task-logs 也是同款处理）。
const Inner = dynamic(() => import("./inner"), { ssr: false });

export default function AdminUsagePage() {
    return <Inner />;
}
