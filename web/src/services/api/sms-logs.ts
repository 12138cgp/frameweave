import { apiGet, compactApiParams } from "./request";

// 短信发送状态：success 真实发送成功 / failed 真实发送失败 / skipped 跳过发送（未启用或字段不全）
export type SmsLogStatus = "success" | "failed" | "skipped";

// 短信发送记录
export type SmsLog = {
    id: number;
    phone: string;
    ip: string;
    templateId: string;
    sign: string;
    status: SmsLogStatus;
    requestPayload: string;
    responsePayload: string;
    errorCode: string;
    errorMessage: string;
    durationMs: number;
    requestId: string;
    messageId: string;
    createdAt: string;
};

// 短信发送记录汇总
export type SmsLogSummary = {
    successCount: number;
    failedCount: number;
    skippedCount: number;
    totalCount: number;
    ipCount: number;
};

// 查询参数：start/end 时间范围，keyword 搜手机号/模板 ID，ip 精确匹配客户端 IP，type 状态筛选，all=1 导出全量
export type SmsLogQuery = {
    start?: string;
    end?: string;
    keyword?: string;
    ip?: string;
    type?: SmsLogStatus | "";
    page?: number;
    pageSize?: number;
    all?: string;
};

export type SmsLogsResponse = {
    items: SmsLog[];
    total: number;
    summary: SmsLogSummary;
};

// 状态显示映射
export const smsLogStatusLabels: Record<SmsLogStatus, string> = {
    success: "成功",
    failed: "失败",
    skipped: "跳过",
};

export const smsLogStatusColors: Record<SmsLogStatus, string> = {
    success: "green",
    failed: "red",
    skipped: "default",
};

// 状态选项（用于筛选）
export const smsLogStatusOptions = [
    { value: "", label: "全部状态" },
    { value: "success", label: "成功" },
    { value: "failed", label: "失败" },
    { value: "skipped", label: "跳过" },
];

// 管理员查询短信发送记录
export async function fetchAdminSmsLogs(token: string, query: SmsLogQuery = {}) {
    return apiGet<SmsLogsResponse>("/api/admin/sms-logs", compactApiParams(query), token);
}
