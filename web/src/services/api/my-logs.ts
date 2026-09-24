import { apiGet, compactApiParams } from "./request";

// 「我的消耗」用户级接口:后端只回本人数据,出参为白名单字段(无渠道/上游标识/他人信息)。

export type MyCreditLog = {
    id: string;
    type: "admin_adjust" | "ai_consume" | "ai_refund";
    amount: number;
    // balance:个人流水=个人余额;项目流水=项目积分池余额(展示时标「(池)」)
    balance: number;
    model: string;
    // 来源:projectId 非空=该笔从项目积分池扣;空=个人积分
    projectId: string;
    projectName: string;
    remark: string;
    createdAt: string;
};

export type MyCreditLogSummary = {
    consume: number;
    refund: number;
    adjust: number;
    net: number;
    count: number;
};

export type MyCreditLogsResponse = {
    items: MyCreditLog[];
    total: number;
    summary: MyCreditLogSummary;
};

export type MyTaskLog = {
    id: string;
    kind: string; // text | image | video | audio | ""(旧数据)
    model: string;
    taskId: string; // 火山视频任务号 cgt-...;非视频为空
    status: string; // ok | fail | ""(未知)
    durationMs: number; // 0=未知/旧数据
    credits: number; // 本次实扣点数(0=免费/未知)
    refunded: boolean; // 已确认退款(视频生成失败退款)
    request: string; // 自己的提示词/参数摘要(base64 参考图已剥占位)
    resultUrl: string; // 自己的成片永久地址(仅视频、上线后新生成的才有)
    createdAt: string;
};

export type MyTaskLogsResponse = {
    items: MyTaskLog[];
    total: number;
};

export type MyLogsQuery = {
    type?: string; // 任务日志=kind(image/video/audio/text);点数日志=流水类型(ai_consume/...)
    source?: string; // 点数日志专用:__personal__=个人 / 项目 id / 空=全部
    start?: string;
    end?: string;
    page?: number;
    pageSize?: number;
};

export async function fetchMyCreditLogs(token: string, query: MyLogsQuery = {}) {
    return apiGet<MyCreditLogsResponse>("/api/my/credit-logs", compactApiParams(query), token);
}

export async function fetchMyTaskLogs(token: string, query: MyLogsQuery = {}) {
    return apiGet<MyTaskLogsResponse>("/api/my/task-logs", compactApiParams(query), token);
}
