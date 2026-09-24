import { apiGet, compactApiParams } from "./request";

// 「用户操作审计」：后台改用户时留下的痕迹。仅超管可见。
//
// 为什么需要它：像「某个用户最近有没有改过密码」这类问题，没有这张表根本查不出来——
// 库里没有任何记录用户改动的地方，users.updated_at 又会被之后的登录覆盖掉。
//
// ⚠️ 服务端保证：password / channelKeys 只记「改过」这个事实，from/to 恒为空串，
// 绝不下发密码哈希或渠道 Key 的值（见 service/user_audit.go 的三条红线 + 单测）。
// 前端展示这两类字段时也不要去猜值、不要显示占位密文，如实写「已修改」即可。

export type UserAuditChange = {
    field: string;
    from: string;
    to: string;
};

export type UserAuditLog = {
    id: string;
    targetUserId: string;
    targetUsername: string;
    action: "create" | "update";
    operatorId: string;
    operatorName: string;
    // changes 是 JSON 字符串，解析后为 UserAuditChange[]
    changes: string;
    ip: string;
    createdAt: string;
};

export type UserAuditLogsResponse = {
    items: UserAuditLog[];
    total: number;
};

export type UserAuditQuery = {
    targetUserId?: string;
    operatorId?: string;
    keyword?: string;
    page?: number;
    pageSize?: number;
};

// 字段名 → 中文。没列到的字段原样显示英文键名，不要吞掉——
// 宁可显示得丑，也不能让新加的字段在审计里"消失"。
export const userAuditFieldLabels: Record<string, string> = {
    password: "密码",
    channelKeys: "渠道密钥",
    username: "用户名",
    role: "角色",
    status: "状态",
    groupId: "所属分组",
    email: "邮箱",
    phone: "手机号",
    displayName: "显示名",
    creatorId: "归属管理员",
};

// 这两个字段服务端只记「改过」，不记值。
export const userAuditSensitiveFields = new Set(["password", "channelKeys"]);

export function parseUserAuditChanges(raw: string): UserAuditChange[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as UserAuditChange[]) : [];
    } catch {
        return [];
    }
}

export async function fetchUserAuditLogs(query: UserAuditQuery, token?: string) {
    return apiGet<UserAuditLogsResponse>("/api/admin/user-audit-logs", compactApiParams({ ...query }), token);
}
