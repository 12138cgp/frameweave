"use client";

import { RequireAuth } from "@/components/require-auth";

// 批量封面的实际 iframe 由 (user) 布局层的 <CoverBatchHost /> 常驻渲染（覆盖在本页之上、跨导航保留状态）。
// 本页只作路由占位 + 登录态校验；切到本路由时 host 会把 iframe display 出来盖住这个占位。
export default function CoverBatchPage() {
    return (
        <RequireAuth>
            <div className="h-full w-full bg-background" />
        </RequireAuth>
    );
}
