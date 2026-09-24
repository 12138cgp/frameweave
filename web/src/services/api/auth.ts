import { apiGet, apiPost } from "@/services/api/request";

export const AUTH_TOKEN_KEY = "aicanvas-auth-token-v1";

export type UserRole = "guest" | "user" | "admin" | "admin_l2";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    credits: number;
    createdAt: string;
    updatedAt: string;
};

export type AuthSession = {
    token: string;
    user: AuthUser;
};

export type AuthPayload = {
    username: string;
    password: string;
};

export type SendSmsCodePayload = {
    phone: string;
};

export type SmsLoginPayload = {
    phone: string;
    code: string;
};

export async function login(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/login", payload);
}

export async function register(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/register", payload);
}

export async function sendSmsCode(payload: SendSmsCodePayload) {
    return apiPost<{ code: string }>("/api/auth/sms/send-code", payload);
}

export async function smsLogin(payload: SmsLoginPayload) {
    return apiPost<AuthSession>("/api/auth/sms/login", payload);
}

export async function fetchCurrentUser(token?: string) {
    return apiGet<AuthUser>("/api/auth/me", undefined, token);
}

// 修改密码：已登录用户校验旧密码后写入新密码。后端要求新密码至少 8 位。
export async function changePassword(token: string, payload: { oldPassword: string; newPassword: string }) {
    return apiPost<{ ok: boolean }>("/api/auth/change-password", payload, token);
}
