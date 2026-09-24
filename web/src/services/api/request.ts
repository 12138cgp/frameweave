import axios from "axios";

export type ApiParams = Record<string, string | string[] | number | number[] | undefined>;

// 会话失效（单设备登录被顶号/JWT 过期）的全局信号：后端返回 HTTP 401 + code 401 时广播，
// 由 ClientRootInit 统一清会话并跳登录。用事件而非直接 import user store，避免循环依赖。
export const SESSION_EXPIRED_EVENT = "app:session-expired";

export function notifySessionExpired() {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

// 兜底拦截：部分调用方（如生成请求）绕过 apiRequest 直接用 axios，401 也要触发统一登出。
// 仅限本站相对路径——local 渠道直连上游的绝对 URL 请求 401 是渠道密钥问题，与会话无关。
axios.interceptors.response.use((response) => {
    const url = response.config?.url || "";
    if (url.startsWith("/") && !url.startsWith("//") && (response.status === 401 || (response.data as { code?: number } | undefined)?.code === 401)) {
        notifySessionExpired();
    }
    return response;
});

type ApiResponse<T> = {
    code: number;
    data: T;
    msg: string;
};

export function compactApiParams(params: ApiParams) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== undefined && (!Array.isArray(value) || value.length > 0))) as ApiParams;
}

export function serializeApiParams(params?: ApiParams) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => queryParams.append(key, String(item)));
        else queryParams.set(key, String(value));
    }
    return queryParams;
}

export async function apiGet<T>(url: string, params?: ApiParams, token?: string) {
    return apiRequest<T>({
        url,
        method: "GET",
        params: params || undefined,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
}

export async function apiPost<T>(url: string, body?: unknown, token?: string) {
    return apiRequest<T>({
        url,
        method: "POST",
        data: body ?? {},
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
}

export async function apiDelete<T>(url: string, token?: string) {
    return apiRequest<T>({
        url,
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
}

async function apiRequest<T>(config: { url: string; method: "GET" | "POST" | "DELETE"; params?: ApiParams; data?: unknown; headers?: Record<string, string> }) {
    let response;
    const startedAt = Date.now();
    try {
        response = await axios.request<ApiResponse<T>>({
            url: config.url,
            method: config.method,
            params: config.params,
            paramsSerializer: { serialize: (params) => serializeApiParams(params as ApiParams).toString() },
            data: config.data,
            headers: config.headers,
            validateStatus: () => true,
        });
    } catch {
        // 连不上服务器。这是所有 API 的统一出口，一处记录就覆盖全部接口——
        // 「东西没保存上去」的根因很多时候就是这里，而以前它一句话都不留。
        logApiFailure(config.url, config.method, 0, "接口连接失败", Date.now() - startedAt);
        throw new Error("接口连接失败，请确认后端服务已启动");
    }

    const result = response.data;
    if (!result || typeof result !== "object") {
        throw new Error(response.status === 404 ? "接口不存在，请确认后端服务已启动" : "接口返回异常，请稍后重试");
    }

    const payload = result as ApiResponse<T>;
    if (response.status === 401 || payload.code === 401) {
        notifySessionExpired();
        throw new Error(payload.msg || "登录已失效，请重新登录");
    }
    if (response.status < 200 || response.status >= 300 || payload.code !== 0) {
        logApiFailure(config.url, config.method, response.status, payload.msg || "请求失败", Date.now() - startedAt);
        throw new Error(payload.msg || "请求失败");
    }

    return payload.data;
}

// 记一条接口失败。
//
// 用动态 import 而不是顶部静态 import：action-log 依赖 use-user-store（取当前 userId），
// 而 use-user-store 又依赖本模块发请求——静态引会成环。
// 失败一律吞掉：日志系统绝不能让一个本来只是「接口报错」的场景升级成整个请求链路崩掉。
function logApiFailure(url: string, method: string, status: number, reason: string, ms: number) {
    // /api/my/reports 自己失败时不记，否则「提交反馈失败」会在下一次提交时又把自己写进去，越滚越大
    if (url.includes("/my/reports")) return;
    void import("@/services/action-log")
        .then(({ logActionAggregated }) => {
            // 同一个接口连续失败会刷屏（同步每 3 秒重试一次），聚合成一条带次数的
            logActionAggregated(`api_failed:${url.split("?")[0]}`, { url, method, status, reason, ms }, 10_000);
        })
        .catch(() => {});
}
