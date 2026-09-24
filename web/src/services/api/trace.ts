import axios from "axios";

// AI 调用追踪码：后端 handler/ai.go 在响应头 X-Request-Id 返回，与后台日志里的 trace= 对应，方便凭码查错误日志。

export function readResponseTraceId(headers: unknown): string {
    const h = headers as Record<string, string> | undefined;
    return (h?.["x-request-id"] || h?.["X-Request-Id"] || "") as string;
}

export function readErrorTraceId(error: unknown): string {
    return axios.isAxiosError(error) ? readResponseTraceId(error.response?.headers) : "";
}

// 把 trace 码挂到抛出的错误对象上，供调用方写进节点信息；fallbackTraceId 用于已拿到响应再手动抛错的场景。
export function attachTraceId(error: unknown, message: string, fallbackTraceId = ""): Error & { traceId?: string } {
    const wrapped = new Error(message) as Error & { traceId?: string };
    wrapped.traceId = readErrorTraceId(error) || fallbackTraceId || undefined;
    return wrapped;
}

export function errorTraceId(error: unknown): string {
    return (error as { traceId?: string } | undefined)?.traceId || "";
}
