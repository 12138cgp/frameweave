"use client";

import dynamic from "next/dynamic";

// 纯客户端 admin 页：重内容（表格 + ZIP 打包 + 媒体预览）拆到 inner 并 ssr:false，
// 让 Next 的 SSG「Collecting page data」阶段不去评估它，规避 bun 1.3.13 对该类复杂模块的
// SSG worker 段错误（exit132/SIGILL）。同一套写法见 task-logs / usage / system / content。
const PromptFavoritesInner = dynamic(() => import("./inner"), { ssr: false });

export default function AdminPromptFavoritesPage() {
    return <PromptFavoritesInner />;
}
