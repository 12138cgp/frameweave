"use client";

import { Suspense } from "react";

import { AdminTabHub } from "../admin-tab-hub";
import Pricing from "../pricing/page";
import Settings from "../settings/page";
import SmsLogs from "../sms-logs/page";
import UserAudit from "../user-audit/page";

// 系统：原「系统设置 / 分级定价 / 短信记录」，另加「操作审计」。
// 定价属于计费配置；短信记录紧挨着系统设置里的短信配置，出问题时「改配置 → 看有没有发出去」
// 在同一页里来回切，比在左侧菜单两头跳顺手。
export default function Inner() {
    return (
        <Suspense fallback={null}>
            <AdminTabHub
                tabs={[
                    { key: "settings", label: "系统设置", Component: Settings },
                    { key: "pricing", label: "分级定价", Component: Pricing },
                    { key: "sms", label: "短信记录", Component: SmsLogs },
                    // 操作审计：谁在什么时候改了哪个用户的什么字段。
                    // ⚠️ 光在 adminRoutes 里登记【不会】产生任何入口——那张表只管页头标题和左侧菜单高亮，
                    // 必须在这里挂成页签，否则只能靠手敲 URL 才进得去。
                    { key: "audit", label: "操作审计", Component: UserAudit },
                ]}
            />
        </Suspense>
    );
}
