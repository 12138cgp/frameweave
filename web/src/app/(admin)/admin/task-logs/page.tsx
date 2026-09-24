"use client";

import dynamic from "next/dynamic";

// 纯客户端 admin 页,重内容拆到 task-logs-inner 并 ssr:false —— 让 Next SSG「Collecting page data」不评估它,
// 规避 bun 1.3.13 baseline 对该复杂模块的 SSG worker 段错误(exit132/SIGILL)。
const TaskLogsInner = dynamic(() => import("./task-logs-inner"), { ssr: false });

export default function AdminTaskLogsPage() {
    return <TaskLogsInner />;
}
