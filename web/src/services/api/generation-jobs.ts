import axios from "axios";

import { useUserStore } from "@/stores/use-user-store";

// 异步生成任务（remote 渠道专用）：创建后立即返回任务 ID，上游调用在服务端后台执行，
// 浏览器刷新/切页/关闭都不会中断生成；凭任务 ID 轮询领取结果。
// 保留时长以服务端为准：终态任务 6 小时后清 payload/result 大 blob，整行 12 小时后删除
// （service/generation_job.go:40-41；原本是 48 小时，因每任务约 10MB blob 把库撑到 5.4GB 才收紧）。

type JobEnvelope = {
    code: number;
    msg?: string;
    data?: { id: string; status: string; error?: string; result?: unknown };
};

// 单次轮询请求的超时。查任务状态是一次极轻的读，正常毫秒级返回；给 20 秒纯粹是兜底：
// 没有它的话，一个「连上了但服务端不答」的请求（重启窗口里 nginx 会一直挂着）能让整个
// await 永不 settle，节点就无限期转圈、连下面的容忍上限都不会被触发。
const POLL_TIMEOUT_MS = 20_000;
// 「服务端连续查不通」的容忍时长。用墙钟而不是次数：次数乘以轮询间隔只有在「每次请求都秒回」
// 时才等于时长，而这个前提恰恰在重启窗口最容易破（请求可能各挂十几秒）。
const TRANSIENT_BUDGET_MS = 120_000;
const TRANSIENT_MESSAGE = "服务端连续无响应，暂时查不到生成结果；等服务恢复后在该节点点「重试」即可领回原任务，不会重复扣费";

function authHeaders() {
    const token = useUserStore.getState().token;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

// projectId：当前画布所属项目积分池。带上时后端扣费走项目池而非个人积分（仅创建任务这一步透传）。
// canvasId：当前画布 id（CanvasProject.id），透传为 X-Canvas-ID 供后端做画布维度的使用统计；不影响扣费。
export async function createGenerationJob(kind: "images" | "image-edits", body: unknown, projectId?: string, canvasId?: string): Promise<string> {
    try {
        const headers = { ...authHeaders(), ...(projectId ? { "X-Project-ID": projectId } : {}), ...(canvasId ? { "X-Canvas-ID": canvasId } : {}) };
        const response = await axios.post<JobEnvelope>(`/api/v1/generation-jobs?kind=${kind}`, body, { headers });
        if (response.data.code !== 0 || !response.data.data?.id) throw new Error(response.data.msg || "生成任务创建失败");
        return response.data.data.id;
    } catch (error) {
        throw new Error(readJobAxiosError(error, "生成任务创建失败"));
    }
}

// 发一次查询请求，不做任何错误包装——留给调用方按用途区分「瞬时」与「确定性」错误。
async function requestGenerationJob(id: string) {
    const response = await axios.get<JobEnvelope>(`/api/v1/generation-jobs/${encodeURIComponent(id)}`, { headers: authHeaders(), timeout: POLL_TIMEOUT_MS });
    if (response.data.code !== 0 || !response.data.data) throw new Error(response.data.msg || "生成任务查询失败");
    return response.data.data;
}

// isRetryableJobError 标记「这一轮没领到，但任务多半还在服务端」，与「任务确实失败/不存在」区分开。
//
// 这个区分是有代价的才做的：调用方（画布重试）原本对任何异常都会清掉 imageJobId 并立刻重建任务，
// 而重建 = 再扣一次费，且原任务后来出的那张图再没有节点持有它的 id、等于凭空消失。
// 服务重启期间领不到结果恰恰属于「任务还在」，所以这类错误要能被调用方认出来、原样等下去。
const JOB_RETRYABLE = "jobRetryable";

export function isRetryableJobError(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && (error as Record<string, unknown>)[JOB_RETRYABLE] === true);
}

function retryableJobError(message: string) {
    const error = new Error(message);
    (error as unknown as Record<string, unknown>)[JOB_RETRYABLE] = true;
    return error;
}

// isTransientJobPollError 判断轮询任务状态时的错误是否「瞬时可重试」：网关 5xx / 限流 429 / 无响应。
// 与视频侧 isTransientVideoPollError 同规则（services/api/video.ts）。
//
// 之所以敢把「等一等」和「已经没救了」这么分，靠的是后端两个稳定约定：
//   ① 业务失败（任务不存在/已过期）走 handler.Fail：只写 {code:1,msg}，HTTP 状态仍是 200，
//      axios 压根不 reject —— 它在上面 requestGenerationJob 里就变成普通 Error 抛出，
//      走不到本函数，仍然是立即失败。
//   ② 登录失效走 handler.FailAuth，发的是【真 401】（handler/response.go:39-43，/api/v1 整组挂
//      middleware.UserAuth）。401 既不 ≥500 也不是 429 → 同样判为确定性错误、立即失败，
//      不会被误当成「等等就好」而把被顶号的用户晾两分钟。
// 于是能落进「瞬时」这一档的只剩 5xx / 429 / 无响应，绝大多数来自 Next 代理层连不上 Go 后端
// （route.ts 返回 502「接口连接失败，请确认后端服务已启动」）或 nginx 网关 —— 正是部署重启窗口。
// 少数情况是 Go 侧 panic 被 gin 的 Recovery 兜成 500（router.go 用的是 gin.Default()），
// 那种情况多等这一会儿也无害：任务本身还在，等不到就按下面的预算超时收场。
function isTransientJobPollError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    if (status === undefined) return true; // 无响应：服务重启中 / 网络抖动 / 本次请求超时
    return status >= 500 || status === 429;
}

// 轮询专用取任务：瞬时错误返回 null（值得再等一轮），确定性错误照旧抛出。
async function pollGenerationJob(id: string) {
    try {
        return await requestGenerationJob(id);
    } catch (error) {
        if (isTransientJobPollError(error)) return null;
        throw new Error(readJobAxiosError(error, "生成任务查询失败"));
    }
}

// 轮询直至出结果；2.5s × 240 = 10 分钟上限（服务端任务超时 15 分钟，超时积分自动退回）
export async function waitGenerationJob(id: string): Promise<unknown> {
    const maxAttempts = 240;
    // 部署重启时后端会有几十秒查不通（代理层返回 502）。原先这里一次 502 就把整单判死——
    // 哪怕服务端把「还没发给上游」的任务重新排队、后来真的出图了，用户看到的也只是失败。
    // 故瞬时错误放行继续轮询，但只容忍连续 TRANSIENT_BUDGET_MS（远超一次部署的不可用窗口），
    // 避免后端真的挂了还傻等满 10 分钟。查通任意一次即清零重新计。
    let transientSince = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const job = await pollGenerationJob(id);
        if (!job) {
            if (!transientSince) transientSince = Date.now();
            else if (Date.now() - transientSince > TRANSIENT_BUDGET_MS) throw retryableJobError(TRANSIENT_MESSAGE);
            if (attempt === maxAttempts - 1) break;
            await delay(2500);
            continue;
        }
        transientSince = 0;
        if (job.status === "succeeded") return job.result;
        if (job.status === "failed") throw new Error(job.error || "生成失败");
        if (attempt === maxAttempts - 1) break;
        await delay(2500);
    }
    // 循环是在「一直没查通」的状态下走完的：报连不上，别报耗时过长（那会让人以为服务端还在画）。
    if (transientSince) throw retryableJobError(TRANSIENT_MESSAGE);
    // 这条【不】标 retryable：任务确实还在服务端跑，但已经 10 分钟，此时该让调用方按老路走
    // （清 id、重新生成）。标了的话用户会被锁在「只能继续等」里，直到服务端 15 分钟超时才解套。
    throw new Error("生成耗时过长（服务端仍在处理），稍后重试可继续领取结果");
}

function readJobAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ msg?: string }>(error)) {
        return error.response?.data?.msg || fallback;
    }
    return error instanceof Error ? error.message : fallback;
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
