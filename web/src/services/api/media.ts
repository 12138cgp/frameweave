import { useUserStore } from "@/stores/use-user-store";

import { apiGet, apiPost } from "./request";

// 服务端 ffprobe 出来的视频真实规格。
// 用在「浏览器解不了这个视频」的场合：H.265 之类的编码 <video> 直接 onerror，
// 前端读不到 videoWidth/videoHeight，节点框只能瞎猜，9:16 会被画成 16:9 带黑边。
export type ServerVideoProbe = {
    width: number;
    height: number;
    durationMs?: number;
    videoCodec: string;
    browserPlayable: boolean;
};

// ⚠️ token 必须显式传：apiRequest 不会自动带 Authorization（漏传会把用户踢去登录页）。
export async function probeVideoOnServer(storageKey: string) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("登录状态已失效，请重新登录后再试");
    return apiPost<ServerVideoProbe>("/api/v1/media/probe", { storageKey }, token);
}

// 预览版转码任务：把浏览器解不了的源片转成 H.264 720p，只用于画布里播放。
// 原片一个字节都不动——当参考、下载走的仍然是它。
export type MediaTranscodeJob = {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed";
    progress: number;
    sourceDurationMs: number;
    previewUrl: string;
    width: number;
    height: number;
    bytes: number;
    error: string;
    durationMs: number;
};

export async function submitMediaTranscode(storageKey: string) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("登录状态已失效，请重新登录后再试");
    return apiPost<MediaTranscodeJob>("/api/v1/media/transcode", { storageKey }, token);
}

export async function fetchMediaTranscode(jobId: string) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("登录状态已失效，请重新登录后再试");
    return apiGet<MediaTranscodeJob>(`/api/v1/media/transcode/${encodeURIComponent(jobId)}`, undefined, token);
}

// waitMediaTranscode 轮询到终态。
// 用挂钟预算而不是重试次数：部署重启会让接口连续几十秒不可达，
// 按次数算很容易在服务其实马上就要恢复时提前判死。
export async function waitMediaTranscode(jobId: string, onTick?: (job: MediaTranscodeJob) => void): Promise<MediaTranscodeJob> {
    const startedAt = Date.now();
    let failures = 0;
    while (Date.now() - startedAt < 65 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
            const job = await fetchMediaTranscode(jobId);
            failures = 0;
            onTick?.(job);
            if (job.status === "succeeded") return job;
            if (job.status === "failed") throw new Error(job.error || "转码失败");
        } catch (error) {
            if (error instanceof Error && /转码失败/.test(error.message)) throw error;
            failures += 1;
            // 连续 40 次（约两分钟）问不到才放弃，容得下一次部署重启。
            if (failures > 40) throw new Error("查不到转码任务状态");
        }
    }
    throw new Error("转码超时");
}
