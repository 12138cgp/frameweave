"use client";

import { Suspense } from "react";

import { AdminTabHub } from "../admin-tab-hub";
import CreditLogs from "../credit-logs/page";
import GenerationStats from "../generation-stats/page";
import TaskLogs from "../task-logs/page";

// 用量分析：原「生成统计 / 点数日志 / 任务日志」三个平铺菜单合并而来。
// 三者回答的是同一个问题——谁用了多少、跑了什么、扣了多少点，分开放反而要来回跳。
export default function Inner() {
    return (
        <Suspense fallback={null}>
            <AdminTabHub
                tabs={[
                    { key: "stats", label: "生成统计", Component: GenerationStats },
                    { key: "credits", label: "点数日志", Component: CreditLogs },
                    { key: "tasks", label: "任务日志", Component: TaskLogs },
                ]}
            />
        </Suspense>
    );
}
