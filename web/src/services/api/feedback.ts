import { apiGet, apiPost, compactApiParams } from "@/services/api/request";

// 用户问题反馈。用户侧提交/查看自己的，管理员侧列表/详情/处理。

export type FeedbackCategory =
    | "canvas_lost"
    | "media_lost"
    | "gen_failed"
    | "sync_error"
    | "credits"
    | "slow"
    | "other";

export type FeedbackStatus = "open" | "handling" | "closed";

// 顺序即弹窗里的展示顺序：最需要日志佐证的排在最前面。
export const feedbackCategoryOptions: Array<{ value: FeedbackCategory; label: string; hint: string }> = [
    { value: "canvas_lost", label: "画布或内容不见了", hint: "画布消失、节点变少、之前做的东西打开后没了" },
    { value: "media_lost", label: "图片/视频丢失或打不开", hint: "白框、加载不出来、点开是坏的" },
    { value: "gen_failed", label: "生成失败或一直不出结果", hint: "报错、转圈很久、扣了点数没出东西" },
    { value: "sync_error", label: "同步异常", hint: "右上角一直提示同步失败、换设备打开对不上" },
    { value: "credits", label: "点数或计费有疑问", hint: "扣多了、没扣、失败没退" },
    { value: "slow", label: "卡顿或加载慢", hint: "画布拖不动、进画布很久" },
    { value: "other", label: "其它问题", hint: "" },
];

export const feedbackCategoryLabels: Record<string, string> = Object.fromEntries(
    feedbackCategoryOptions.map((option) => [option.value, option.label]),
);

export const feedbackStatusLabels: Record<string, string> = {
    open: "待处理",
    handling: "处理中",
    closed: "已处理",
};

export const feedbackStatusColors: Record<string, string> = {
    open: "red",
    handling: "blue",
    closed: "green",
};

export const feedbackStatusOptions = Object.entries(feedbackStatusLabels).map(([value, label]) => ({ value, label }));

export type SubmitFeedbackPayload = {
    category: FeedbackCategory;
    description: string;
    contact?: string;
    canvasId?: string;
    canvasTitle?: string;
    happenedAt?: string;
    /** 浏览器/设备/存储环境快照 */
    env?: unknown;
    /** 本机数据规模 */
    local?: unknown;
    /** 素材上传对账 */
    media?: unknown;
    /** 操作日志（环形缓冲导出） */
    log?: unknown[];
};

export async function submitFeedback(token: string, payload: SubmitFeedbackPayload) {
    return apiPost<{ id: number }>("/api/my/reports", payload, token);
}

export type MyFeedbackItem = {
    id: number;
    category: string;
    description: string;
    canvasTitle: string;
    status: FeedbackStatus;
    adminNote: string;
    handledAt: string;
    createdAt: string;
};

export async function fetchMyFeedbacks(token: string, params: { page?: number; pageSize?: number } = {}) {
    return apiGet<{ items: MyFeedbackItem[]; total: number }>("/api/my/reports", compactApiParams(params), token);
}

// ── 管理员侧 ──

export type AdminFeedbackItem = {
    id: number;
    userId: string;
    username: string;
    groupId: string;
    category: string;
    description: string;
    contact: string;
    canvasId: string;
    canvasTitle: string;
    happenedAt: string;
    env: string;
    local: string;
    server: string;
    logCount: number;
    logBytes: number;
    rawBytes: number;
    truncated: boolean;
    status: FeedbackStatus;
    adminNote: string;
    handlerId: string;
    handledAt: string;
    createdAt: string;
};

export type AdminFeedbackQuery = {
    status?: string;
    category?: string;
    keyword?: string;
    start?: string;
    end?: string;
    page?: number;
    pageSize?: number;
};

export async function fetchAdminFeedbacks(token: string, query: AdminFeedbackQuery = {}) {
    return apiGet<{ items: AdminFeedbackItem[]; total: number; openCount: number }>(
        "/api/admin/reports",
        compactApiParams(query),
        token,
    );
}

/** 操作日志的一条：t=时间戳 s=序号 e=事件名 u=用户 d=字段 */
export type FeedbackLogEntry = {
    t: number;
    s: number;
    e: string;
    u?: string;
    d?: Record<string, unknown>;
};

export async function fetchAdminFeedbackDetail(token: string, id: number) {
    return apiGet<{ report: AdminFeedbackItem; log: FeedbackLogEntry[] | null; logError: string }>(
        `/api/admin/reports/${id}`,
        undefined,
        token,
    );
}

export async function updateAdminFeedback(token: string, id: number, body: { status: FeedbackStatus; adminNote: string }) {
    return apiPost<{ id: number; status: string }>(`/api/admin/reports/${id}`, body, token);
}

/** 完整诊断包下载地址（含 env/client/server/log 四块，用编辑器搜比在表格里翻快得多） */
export function adminFeedbackLogURL(id: number): string {
    return `/api/admin/reports/${id}/log`;
}
