import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

type RouteContext = {
    params: Promise<{ path: string[] }>;
};

function proxyHeaders(request: NextRequest) {
    const headers = new Headers(request.headers);
    // 这些头在“重新发起一条 fetch 到后端”时都必须删除，否则会被原样转发、污染新连接：
    //  - host：目标主机变了；content-length：body 已缓冲、由 undici 按新长度重新成帧；
    //  - 其余为逐跳头（hop-by-hop，只对单段连接有效）。其中最关键的是 transfer-encoding：
    //    前置反代/CDN 对较大上传体常改用分块传输（Transfer-Encoding: chunked、无 Content-Length），
    //    该头若带进下面的 fetch，undici 直接抛 UND_ERR_INVALID_ARG: invalid transfer-encoding header → 502「接口连接失败」。
    //    小图走 Content-Length 不带此头、故能过——这正是“小图过、大图挂”的成因。
    //  - expect：大上传时客户端/前置反代常带 Expect: 100-continue，undici fetch 不支持、会抛
    //    UND_ERR_NOT_SUPPORTED: expect header not supported → 同样 502。我们已把 body 整个缓冲好、本就不需要 100-continue。
    for (const h of [
        "host",
        "content-length",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "proxy-connection",
        "expect",
    ]) {
        headers.delete(h);
    }
    headers.set("x-forwarded-host", request.nextUrl.host);
    headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
    return headers;
}

function responseHeaders(response: Response) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return headers;
}

// 上传体积上限（默认 300MB，可用 PROXY_MAX_UPLOAD_MB 覆盖）。proxy 会把整个上传体缓冲进内存再转发
//（不能改成流式：undici 对 multipart 的流式 body(duplex half) 会抛 UND_ERR_NOT_SUPPORTED，见下方 proxy 里的说明），
// 无上限时大文件并发上传可能撑爆 Next 进程内存（OOM）。
//
// 默认 300MB 是因为视频成片动辄一两百 MB。⚠️ 同一条上传链路上一共有四道体积闸，
// 生效的永远是最小的那一道，放开时必须四道一起改：
//   ① 画布客户端预检 canvas-client-page.tsx 的 MAX_BYTES
//   ② 本文件这道（PROXY_MAX_UPLOAD_MB）
//   ③ 后端 handler/sync.go 的 syncFileMaxBytes
//   ④ 前置反向代理（nginx 的 client_max_body_size，默认只有 1m）
// 第 ④ 道最容易漏，且症状最难认：请求在代理层就被截掉，前端拿不到业务错误，
// 用户只看到一个没有中文提示的 413。部署到新环境时先确认这一项。
const MAX_UPLOAD_BYTES = Number(process.env.PROXY_MAX_UPLOAD_MB || 300) * 1024 * 1024;

// bufferRequestBody 把请求体缓冲成内存 buffer，并强制不超过 MAX_UPLOAD_BYTES：
// 先按 Content-Length 快速拒绝；对无 Content-Length 的分块上传（chunked，正是大文件经前置反代后的常态）
// 则边读边累计、超限即中止，避免 arrayBuffer 无上限缓冲导致 OOM。tooLarge=true 时上层回 413。
async function bufferRequestBody(request: NextRequest): Promise<{ body?: ArrayBuffer; tooLarge?: boolean }> {
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_UPLOAD_BYTES) {
        return { tooLarge: true };
    }
    const reader = request.body?.getReader();
    if (!reader) {
        return { body: undefined };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (!value) {
            continue;
        }
        total += value.byteLength;
        if (total > MAX_UPLOAD_BYTES) {
            await reader.cancel();
            return { tooLarge: true };
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { body: merged.buffer as ArrayBuffer };
}

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    const apiBaseUrl = process.env.API_BASE_URL || "http://127.0.0.1:8080";
    const target = `${apiBaseUrl.replace(/\/$/, "")}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    // 先把请求体缓冲成 buffer 再转发：undici 对 multipart 大请求的流式 body（duplex half）会抛 UND_ERR_NOT_SUPPORTED，
    // 导致图生图垫图、参考图/视频上传等大请求 502。响应仍保持流式（见下方 new Response(response.body)），不影响 SSE。
    // bufferRequestBody 同时强制上传体不超过 MAX_UPLOAD_BYTES，防止超大上传缓冲撑爆内存（OOM）。
    let body: ArrayBuffer | undefined;
    if (hasBody) {
        const buffered = await bufferRequestBody(request);
        if (buffered.tooLarge) {
            return Response.json(
                { code: 1, data: null, msg: `上传内容过大（上限 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB），请压缩后重试` },
                { status: 413 },
            );
        }
        body = buffered.body;
    }

    try {
        const response = await fetch(target, {
            method: request.method,
            headers: proxyHeaders(request),
            body,
            redirect: "manual",
        });

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response),
        });
    } catch (error) {
        console.error("Failed to proxy", target, error);
        return Response.json({ code: 1, data: null, msg: "接口连接失败，请确认后端服务已启动" }, { status: 502 });
    }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
