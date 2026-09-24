import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, healMediaFromServer, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { waitMediaUploaded } from "@/services/media-uplink";
import { logAction } from "@/services/action-log";
import { imageToDataUrl } from "@/services/image-storage";
import { attachTraceId, readResponseTraceId } from "@/services/api/trace";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, NON_SEEDANCE_MAX_SECONDS, normalizeSeedanceOutputFormat, normalizeSeedanceResolution, seedanceCapability, seedanceOmniTaskType, seedanceUpstreamResolution, seedanceVideoReferenceError, videoRefLimits, videoSecondsCap, videoSecondsFloor, resolveVideoModeForRequest, videoDurationForcedSmart, videoRatioForcedAdaptive, videoSizePixels, SEEDANCE_DURATION_SMART, type VideoMode } from "@/lib/seedance-video";
import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { agentTurnHeader } from "@/services/agent-turn-context";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; error?: { message?: string } };
type ApiVideoResponse = VideoResponse | { code?: number; data?: VideoResponse | null; msg?: string };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; last_frame_url?: string } | null;
};
type ApiEnvelope<T> = T | { code?: number; data?: T | null; msg?: string };
type ReferenceMediaUploadResponse = { id: string; url: string; mimeType: string; bytes: number };

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; taskId?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance"; model: string; traceId?: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

function aiApiUrl(config: AiConfig, path: string) {
    return config.channelMode === "remote" ? `/api/v1${path}` : buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    const token = useUserStore.getState().token;
    return config.channelMode === "remote"
        ? {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(contentType ? { "Content-Type": contentType } : {}),
          }
        : {
              Authorization: `Bearer ${config.apiKey}`,
              ...(contentType ? { "Content-Type": contentType } : {}),
          };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

/** 画布节点上下文：让服务端在客户端没来得及同步时，能把成片放回原画布原位。 */
export type CanvasNodeContext = { nodeId: string; x: number; y: number; width: number; height: number };

// 仅创建任务时透传：当前画布所属项目积分池 ID，让扣费走项目池而非个人积分。轮询/取内容不带。
//
// X-Canvas-Node 是「把成片放回原位」的关键：
// 用户点完生成就关页/关机时，那个转圈的节点只存在于他浏览器里、从没同步上云，
// 服务端救援时翻遍云端画布也找不到它，只能把成片丢进「我的素材」让用户自己去翻。
// 提交这一刻把节点 id 和位置带上，服务端就能在原画布原位用【原节点 id】把它放回去 ——
// 用户回来同步时合并看到同一个节点，那个「失败重试」会直接变成成片。
function projectHeader(config: AiConfig, nodeContext?: CanvasNodeContext): Record<string, string> {
    if (config.channelMode !== "remote") return {};
    // 见 image.ts 的同名说明：助手回合里的视频生成也要带上回合标记，才能被预算闸管住。
    const agentHeader = agentTurnHeader();
    let nodeHeader: Record<string, string> = {};
    if (nodeContext?.nodeId) {
        // 只放 id 与数字，全 ASCII —— HTTP 头不能带中文（标题之类一律不放）
        nodeHeader = {
            "X-Canvas-Node": JSON.stringify({
                id: nodeContext.nodeId,
                x: Math.round(nodeContext.x || 0),
                y: Math.round(nodeContext.y || 0),
                w: Math.round(nodeContext.width || 0),
                h: Math.round(nodeContext.height || 0),
            }),
        };
    }
    return { ...agentHeader,
        ...(config.projectId ? { "X-Project-ID": config.projectId } : {}),
        ...(config.canvasId ? { "X-Canvas-ID": config.canvasId } : {}),
        ...nodeHeader,
    };
}

export async function requestVideoGeneration(
    config: AiConfig,
    prompt: string,
    references: ReferenceImage[] = [],
    videoReferences: ReferenceVideo[] = [],
    audioReferences: ReferenceAudio[] = [],
    onTaskCreated?: (task: VideoGenerationTask) => void,
    nodeContext?: CanvasNodeContext,
): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, nodeContext);
    // 把任务 ID 交给调用方持久化：超时/刷新后可以续查原任务，而不是重新创建（避免重复扣费、丢结果）
    onTaskCreated?.(task);
    return waitVideoGenerationTask(config, task);
}

// 等待既有任务完成（断点续查入口：任务在云端保留 48 小时）
export async function waitVideoGenerationTask(config: AiConfig, task: VideoGenerationTask): Promise<VideoGenerationResult> {
    // 长片档模型虽也走 OpenAI 方言(provider="openai")，但能出 30 秒长片，
    // 实测一条 6 秒 720P 就要 4.5 分钟；按其它渠道 10 分钟封顶，长片必然在还没出完时被判超时：
    // 钱已经扣了、用户先吃一次假失败。给它和 Seedance 一样的耐心。
    const longWait = task.provider === "seedance";
    const delayMs = longWait ? 5000 : 2500;
    // Seedance 长视频高峰期排队+生成可能超过 10 分钟，放宽到 30 分钟；其他渠道 10 分钟
    const maxAttempts = longWait ? 360 : 240;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const state = await pollVideoGenerationTask(config, task);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === maxAttempts - 1) throw new Error(`${task.provider === "seedance" ? "Seedance " : ""}视频生成耗时过长（云端任务可能仍在进行），点击重试会继续查询原任务，不会重复扣费`);
        await delay(delayMs);
    }
    throw new Error("视频生成超时，请稍后重试");
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], nodeContext?: CanvasNodeContext): Promise<VideoGenerationTask> {
    const model = (config.model || config.videoModel).trim();
    assertVideoConfig(config, model);
    if (isSeedanceVideoConfig({ ...config, model })) {
        return createSeedanceTask(config, model, prompt, references, videoReferences, audioReferences, nodeContext);
    }
    // 走到这里的一定是 OpenAI 方言那条路：支持 image/video/audio 混合参考的模型在上面就已经返回了。
    // 这条路只收参考图，带了参考视频/音频就当场报错——别让上游整单拒收后只回一句英文。
    if (videoReferences.length || audioReferences.length) {
        throw new Error("当前视频模型不支持参考视频或参考音频，请移除后重试");
    }
    return createOpenAIVideoTask(config, model, prompt, references, nodeContext);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask): Promise<VideoGenerationTaskState> {
    assertVideoConfig(config, task.model);
    const state = task.provider === "seedance" ? await pollSeedanceTask(config, task) : await pollOpenAIVideoTask(config, task);
    // 完成时把上游任务号(cgt)带回结果：后续转存 TOS 拿到永久地址后据此回填任务日志，供后台内联播放。
    if (state.status === "completed") return { status: "completed", result: { ...state.result, taskId: task.id } };
    return state;
}

// remote 渠道：让服务端把上游(火山 Seedance)的临时媒体 URL 转存到 TOS 对象存储，拿回稳定公网地址。
// 走服务端可绕开浏览器跨域(CORS)抓取失败、并用服务器/内网带宽下载，避免约 24h 后火山 URL 过期导致视频丢失。
export async function persistRemoteMedia(url: string, kind: "image" | "video" | "audio", mimeType?: string, taskId?: string): Promise<{ url: string; key: string; storageKey: string }> {
    const token = useUserStore.getState().token;
    const ext = mimeType && mimeType.includes("/") ? mimeType.split("/")[1].split(";")[0] : undefined;
    // taskId 仅视频转存时携带：服务端据此把成片永久地址回填任务日志（纯观测，供后台内联播放）。
    const body: Record<string, unknown> = { url, kind, ext, contentType: mimeType };
    if (taskId) body.taskId = taskId;
    const response = await axios.post<{ code?: number; msg?: string; data?: { url?: string; key?: string; storageKey?: string } }>(
        "/api/v1/media/persist",
        body,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    const data = response.data?.data;
    if (response.data?.code !== 0 || !data?.url) throw new Error(response.data?.msg || "媒体转存失败");
    // storageKey：服务端转存时顺手登记的 sync_files 凭据（handler/media_persist.go）。
    // 登记失败时服务端返回空串，此处照实透传，节点退回「只有公网地址」的老形态。
    return { url: data.url, key: data.key || "", storageKey: data.storageKey || "" };
}

// claimVideoTask 告诉服务端「这个视频我已经拿到并存好了」，服务端据此删掉退款候选。
// 不这么做的话服务端无从区分「客户端已收到」和「客户端根本没收到」（正常收尾会清掉节点上的
// videoTaskId，线索就断了），兜底扫描要么漏救、要么把每个正常视频都重复转存一遍。
// best-effort：失败只吞掉——最坏结果是兜底扫描多做一次转存，绝不能因此让用户的生成流程报错。
async function claimVideoTask(taskId?: string, storageKey?: string) {
    if (!taskId) return;
    try {
        const token = useUserStore.getState().token;
        // storageKey 只在【字节由前端上传】的那条路上带（走 OpenAI 方言的渠道取回的是 blob）：
        // 服务端据此按 user_id + storage_key 查出它自己登记的公网地址，回填 upstream_logs.result_url。
        // 🔴 传 key 而不是 url：url 由客户端给就等于让任何人往管理员会点开的字段里塞任意地址。
        // 另外 uploadMediaFile 返回的 url 是 URL.createObjectURL 产出的 blob: 本地地址，
        // 对服务端毫无意义，存进去就是一条死链。
        await axios.post(`/api/v1/videos/${encodeURIComponent(taskId)}/claimed`, storageKey ? { storageKey } : {}, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    } catch {
        // 静默：认领失败不影响用户，服务端兜底扫描仍会保住视频
    }
}

export async function storeGeneratedVideo(result: VideoGenerationResult, config?: AiConfig): Promise<UploadedFile> {
    if (result.blob) {
        const uploaded = await uploadMediaFile(result.blob, "video");
        await claimVideoTask(result.taskId);
        // 这条路（OpenAI 方言渠道，取回的是二进制）不经过 /media/persist，result_url 原先永远为空，
        // 后果是后台任务日志判不出「成功」、且服务端的送达核实（判据2 读的就是 result_url）几乎必然落空。
        // 等字节真的上云了再补一次认领、带上 storageKey，让服务端自己查地址回填。
        // ⚠️ 不 await：回填纯属观测，绝不能让用户多等一次上传。认领接口是幂等的，调两次安全。
        // ⚠️ 上传失败(ok=false)就不补：那时服务端根本没有这份文件，补了也查不到。
        void waitMediaUploaded(uploaded.storageKey).then((ok) => {
            if (ok) void claimVideoTask(result.taskId, uploaded.storageKey);
        });
        return uploaded;
    }
    if (result.url) {
        // remote 渠道优先转存到对象存储，得到稳定地址；转存失败兜底仍存原 URL（至少短期可看）。
        let url = result.url;
        let storageKey = "";
        let persisted = false;
        if (config?.channelMode === "remote") {
            try {
                const saved = await persistRemoteMedia(result.url, "video", result.mimeType, result.taskId);
                url = saved.url;
                // 有了它，节点的自愈链（canvas-node 的 healVideo → resolveMediaUrl → /sync/files/:key）
                // 才对服务端交付的成片有效——此前这里写死空串，那条链整条使不上劲，
                // 一次瞬时失败就会让节点永久显示「视频加载失败」。
                storageKey = saved.storageKey;
                persisted = true;
                logAction("video_persisted", { taskId: result.taskId });
            } catch (error) {
                // 落回原 URL；注意下面【不会】认领——留着退款候选让服务端兜底扫描接手。
                // 这一处以前是完全静默的 catch，而它恰恰是「成片进不了用户手里」的头号断点：
                // 转存失败 → 用户手里只剩一个 24 小时后就失效的上游临时地址。
                logAction("video_persist_failed", {
                    taskId: result.taskId,
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        }
        // 读真实宽高：此前 URL 路径不带尺寸 → 生成的视频节点退化成 640×360(16:9)默认、naturalWidth/Height 丢失，
        // 导致 9:16 视频节点框变 16:9，分享到组素材 / 拖出也跟着错。读出 videoWidth/videoHeight 一并返回（读失败则回退原行为）。
        const dims = await readVideoDimsFromUrl(url);
        // 只有确实转存进桶了才认领。
        //
        // 认领 = 告诉服务端「这个视频我拿到了」，服务端据此删掉退款候选、兜底扫描从此不再管它。
        // 原先无论转存成没成都认领：一旦 persist 抛错被上面的 catch 吞掉，用户手里只剩一个
        // 上游临时地址，而唯一能救他的机制已经被自己关掉了。
        // 转存失败时不认领，候选留着，服务端扫描会把成片转存进桶并回写——这正是它存在的意义。
        if (persisted || config?.channelMode !== "remote") await claimVideoTask(result.taskId);
        logAction("video_ready", { taskId: result.taskId, persisted, hasDims: Boolean(dims) });
        return { url, storageKey, bytes: 0, mimeType: result.mimeType || "video/mp4", width: dims?.width, height: dims?.height };
    }
    throw new Error("视频接口没有返回可播放的视频");
}

// readVideoDimsFromUrl 把视频 URL 加载进离屏 <video> 只读元数据拿固有宽高（读尺寸不需 CORS）；失败/超时/SSR 返回 null。
function readVideoDimsFromUrl(url: string): Promise<{ width: number; height: number } | null> {
    if (typeof document === "undefined") return Promise.resolve(null);
    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        let done = false;
        const finish = (w?: number, h?: number) => {
            if (done) return;
            done = true;
            video.removeAttribute("src");
            try {
                video.load();
            } catch {
                /* noop */
            }
            resolve(w && h ? { width: w, height: h } : null);
        };
        video.onloadedmetadata = () => finish(video.videoWidth, video.videoHeight);
        video.onerror = () => finish();
        setTimeout(() => finish(), 8000); // 兜底超时，绝不卡住生成完成
        video.src = url;
    });
}

async function createOpenAIVideoTask(
    config: AiConfig,
    model: string,
    prompt: string,
    references: ReferenceImage[],
    nodeContext?: CanvasNodeContext,
): Promise<VideoGenerationTask> {
    const body = new FormData();
    body.append("model", model);
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds, model));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality, model));
    body.append("preset", "normal");
    // 参考图上限统一走 videoRefLimits，别在这里写死数字。原先这里是 references.slice(0, 7)，
    // 超出的部分【静默丢弃】：用户接了 15 张只发出去 7 张，不报错也不提示，
    // 成片里那几张参考自然没生效。截断提示由调用方（画布）负责给。
    const refLimits = videoRefLimits(model);
    const files = await Promise.all(
        references.slice(0, refLimits.images).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })),
    );
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const response = await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: { ...aiHeaders(config), ...projectHeader(config, nodeContext) } });
        const created = unwrapVideoResponse(response.data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model, traceId: readResponseTraceId(response.headers) };
    } catch (error) {
        throw attachTraceId(error, readAxiosError(error, "视频任务创建失败"));
    }
}

// isTransientVideoPollError 判断「轮询任务状态」时的错误是否为瞬时可重试错误：网关 5xx / 限流 429 / 无响应的网络超时。
// 这类错误返回 pending、让上层轮询循环继续（仍受 maxAttempts≈30 分钟上限约束），避免一次抖动杀掉长耗时（尤其 4K）视频生成的整单；
// 确定性错误（4xx 鉴权/参数/任务不存在）仍抛出、快速失败。
function isTransientVideoPollError(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === undefined) return true; // 无响应：网络错误 / 超时
        return status >= 500 || status === 429;
    }
    return false;
}

// 把视频任务的原始失败原因（多为火山英文，如「output audio/video may contain sensitive information」）翻成友好中文。
// 视频任务失败原因走 HTTP 200 的任务体、不经后端 friendlyUpstreamError，故在前端补一层同义映射；命中才替换，否则原样返回（保留原文便于排查）。
function videoFailurePrefix(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.indexOf("output audio") >= 0 && lower.indexOf("sensitive") >= 0) {
        return "生成视频的音频轨被模型平台内容安全判定为敏感/违规（针对生成结果本身，非提示词），本次视频失败会自动退回积分。可调整提示词、关闭「生成音频」或更换参考素材后重试。原始错误：";
    }
    if (lower.indexOf("output video") >= 0 && lower.indexOf("sensitive") >= 0) {
        return "生成出的视频被模型平台内容安全判定为敏感/违规（针对生成结果本身，非提示词），本次积分已自动退回。可调整提示词（避开暴力、血腥、政治、色情、违禁）或更换参考素材后重试。原始错误：";
    }
    const generic = ["sensitive", "moderation", "content policy", "content_policy", "policy_violation", "prohibited", "敏感", "违规"];
    for (let i = 0; i < generic.length; i++) {
        if (lower.indexOf(generic[i]) >= 0 || msg.indexOf(generic[i]) >= 0) {
            return "内容被模型平台内容安全审核拦截（判定可能含敏感/违规信息）。请调整提示词或更换参考素材后重试；失败的视频会自动退回积分。原始错误：";
        }
    }
    if (lower.indexOf("copyright") >= 0 || msg.indexOf("版权") >= 0) {
        return "生成内容被判定可能涉及版权（如知名 IP/影视/品牌）。建议把提示词里的 IP 名改成通用描述、更换参考图后重试。原始错误：";
    }
    return "";
}

// 把视频任务的原始失败原因（多为火山英文，如「output audio/video may contain sensitive information」）翻成友好中文。
// 视频任务失败原因走 HTTP 200 的任务体、不经后端 friendlyUpstreamError，故在前端补一层同义映射；命中才替换，否则原样返回（保留原文便于排查）。
function humanizeVideoFailure(raw?: string, fallback = "视频生成失败"): string {
    const msg = (raw || "").trim();
    if (!msg) return fallback;
    const prefix = videoFailurePrefix(msg);
    if (prefix === "") return msg;
    return prefix + msg;
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model: task.model } : undefined })).data);
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model: task.model } : undefined, responseType: "blob" });
            await assertVideoBlob(content.data);
            refreshRemoteUser(config);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: humanizeVideoFailure(video.error?.message) };
        return { status: "pending" };
    } catch (error) {
        if (isTransientVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "视频任务查询失败"));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], nodeContext?: CanvasNodeContext): Promise<VideoGenerationTask> {
    // 2.0 系列要求音频必须搭配图片或视频；2.5 允许音频单独作参考（官方能力概述表）
    if (audioReferences.length && !references.length && !videoReferences.length && !seedanceCapability(model).allowAudioOnly) {
        throw new Error("该模型的参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    // 模式：落定成真正要发出去的那个。素材与模式失配时【抛错】而不是静默换一个——
    // 静默换等于"按钮写着图生视频、实际发的是别的"，正是本轮要根治的那类毛病。
    //
    // Seedance 的任务意图由 content[] 里每一项的 role 显式声明
    //（first_frame / last_frame / reference_image / reference_video / reference_audio），
    // 2.5 的全模态任务（参考/编辑/延长）另有一个顶层字段 omni_reference_task_type，见下面 payload。
    // ⚠️ 必须在参考素材校验【之前】算出 mode：视频编辑对参考视频有 4~30 秒的专属区间，
    //    校验函数要按模式取区间（见 seedanceVideoReferenceError）。
    const mode = resolveVideoModeForRequest(config.videoMode, model, {
        images: references.length,
        videos: videoReferences.length,
        audios: audioReferences.length,
    });
    assertSeedanceVideoReferences(videoReferences, model, mode);
    assertSeedanceAudioReferences(audioReferences, model);
    const content = await buildSeedanceContent(config, model, prompt, references, videoReferences, audioReferences, mode);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const outputFormat = normalizeSeedanceOutputFormat(config.videoOutputFormat, model);
    // 🔴 首帧 / 首尾帧模式下 ratio 必须是 "adaptive"——这是【上游硬约束】，不是我们给用户加的限制：
    //    火山《按 content.role 区分任务》表里，role=first_frame / last_frame 那一栏写明
    //    「ratio 必须为 adaptive，模型自动保持输出宽高比与 first_frame 指定的首帧图片一致」；
    //    传别的值是【报错】而不是静默回退，所以这一步不能省。
    // ⚠️ 只覆写【这一单发出去的】ratio：绝不去改 config.size，用户切回别的模式时他选的比例还在。
    // ⚠️ 更绝不能顺手把 resolution / vquality 一起改成 adaptive 或空值：那两个是计费口径，
    //    一旦落空会让前后端双双静默回落 720p 档 = 按 720p 的价收 1080p 的片（日志无痕）。
    //    ratio 与定价无关（定价只看 resolution，已实证），改它是安全的。
    const ratio = videoRatioForcedAdaptive(mode, model) ? "adaptive" : normalizeSeedanceRatio(config.size);
    // 🔴 duration = -1（智能时长）只在【视频编辑】这一档发，因为上游硬性要求「duration 必须 -1」，
    //    输出时长由源视频决定（实测：源片 4.06 秒 → 出片 4.06 秒），我们发几秒都没意义。
    // 🔴 这是全项目【唯一】允许向上游发 -1 的地方。别处发 -1 就是在漏钱：
    //    后端会把负数读成 0 秒，再按「智能时长」的默认秒数预扣 —— 出 30 秒的片只收那点钱。
    //    视频编辑这一档能发，前提是计费侧已改成按【源视频真实时长】结算
    //   （服务端 ProbeVideo 探源视频时长；探不到就报错拒绝，绝不回落到默认秒数）。
    //    ⚠️ 这条前提一旦没了（比如那段计费代码被回退），这里必须跟着一起回退，否则立刻开始漏钱。
    // ⚠️ 视频【延长】不在此列：官方示例是 "duration": 11，真实秒数；实测发 6 秒、源片 4.06 秒，
    //    出片 6.00 秒 —— duration 就是输出总长，按用户选的秒数扣费是对的。判据见 videoDurationPolicy。
    const duration = videoDurationForcedSmart(mode, model) ? SEEDANCE_DURATION_SMART : normalizeSeedanceDuration(config.videoSeconds, model);
    // omni_reference_task_type：2.5 的全模态任务类型，与 ratio / duration 平级的【顶层字段】。
    // null = 不发（2.0 系列、以及首帧/首尾帧这些靠 role 表达的任务）→ 请求体与改动前逐字节一致。
    // 显式发 "reference" 的理由见 seedanceOmniTaskType 的注释：不发时模型会按提示词自行判定任务类型，
    // 判成编辑/延长就会撞上那两者「ratio 必须 adaptive」的硬约束而异步报错。
    const omniTaskType = seedanceOmniTaskType(mode, model);
    const payload = {
        model,
        content,
        ratio,
        resolution: seedanceUpstreamResolution(normalizeSeedanceResolution(config.vquality, model)),
        duration,
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
        // 只有非 mp4 时才带这个参数：2.0 系列不认 output_format，无谓地传过去可能被拒
        ...(outputFormat === "mp4" ? {} : { output_format: outputFormat }),
        ...(omniTaskType ? { omni_reference_task_type: omniTaskType } : {}),
    };

    try {
        const response = await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: { ...aiHeaders(config, "application/json"), ...projectHeader(config, nodeContext) } });
        const created = unwrapSeedanceTask(response.data);
        if (!created.id) throw new Error("Seedance 接口没有返回任务 ID");
        return { id: created.id, provider: "seedance", model, traceId: readResponseTraceId(response.headers) };
    } catch (error) {
        throw attachTraceId(error, readAxiosError(error, "Seedance 任务创建失败"));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model: task.model } : undefined })).data);
        if (state.status === "succeeded") {
            const url = state.content?.video_url;
            if (!url) return { status: "failed", error: "Seedance 任务成功但没有返回视频 URL" };
            refreshRemoteUser(config);
            return { status: "completed", result: await videoResultFromUrl(url) };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") {
            let fb = "Seedance 视频生成失败";
            if (state.status === "expired") fb = "Seedance 视频生成超时";
            return { status: "failed", error: humanizeVideoFailure(state.error?.message, fb) };
        }
        return { status: "pending" };
    } catch (error) {
        if (isTransientVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "Seedance 任务查询失败"));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[], model = "", mode: string = "auto") {
    const error = seedanceVideoReferenceError(videoReferences, model, mode);
    if (error) throw new Error(error);
    const limits = seedanceCapability(model);
    // 单条时长区间与 seedanceVideoReferenceError 同源：视频编辑 4~30 秒（上游硬约束），
    // 其余模式 2 秒 ~ 模型上限（2.0 = 15 秒，2.5 = 30 秒）。
    // ⚠️ 这里以前写死 2000/15000，跟上面那个函数是两份数字；2.5 放开到 30 秒后，
    //    漏改一处就会变成「前一关放行、后一关拦下」，用户看到的是一条自相矛盾的报错。
    const minMs = mode === "video_edit" ? 4000 : 2000;
    const maxMs = mode === "video_edit" ? Math.min(30000, limits.referenceVideoMaxMs) : limits.referenceVideoMaxMs;
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < minMs || video.durationMs > maxMs) throw new Error(`Seedance 参考视频单个时长需要在 ${Math.round(minMs / 1000)}-${Math.round(maxMs / 1000)} 秒之间`);
        total += video.durationMs;
    }
    if (total > limits.referenceVideoTotalMs) throw new Error(`Seedance 参考视频总时长不能超过 ${Math.round(limits.referenceVideoTotalMs / 1000)} 秒`);
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[], model = "") {
    const limits = seedanceCapability(model);
    if (audioReferences.length > limits.audios) throw new Error(`Seedance 参考音频最多 ${limits.audios} 个`);
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > limits.referenceAudioTotalMs) throw new Error(`Seedance 参考音频总时长不能超过 ${Math.round(limits.referenceAudioTotalMs / 1000)} 秒`);
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    if (config.channelMode === "remote") return taskId ? `/api/v1/videos/${encodeURIComponent(taskId)}` : "/api/v1/videos";
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

// frameRoleMatches 判断这张参考图是不是 videoFrameRoles 里记的那一张。
//
// 画布那边写进去的键就是【节点 id】（见 canvas-node-prompt-panel 的 frameRoleKey），
// 对应下面的 image.id —— 正常路径只会命中这一项。另外三个字段是给非画布入口、以及
// 存量节点里可能存着地址型键的情况留的兼容，比一次不要钱，漏比一次就会静默退回接入顺序：
//   id        = 节点 id；
//   dataUrl   = 水合前的 metadata.content（就是 previewUrl）；
//   sourceUrl = 水合后留下的原地址（那时 dataUrl 已被 hydrateNodeGenerationContext 覆写成 base64）；
//   url       = 做过肖像授权的图被换成的 asset:// uri。
function frameRoleMatches(image: ReferenceImage, key?: string) {
    if (!key) return false;
    return key === image.id || key === image.sourceUrl || key === image.dataUrl || key === image.url;
}

// orderFrameImages 把首尾帧模式的两张参考图排成 [首帧, 尾帧]。
//
// 角色有两个来源，优先级从高到低：
//   ① config.videoFrameRoles —— 画布节点 metadata.videoFrameRoles 注入，即用户在参考图上点「首帧/尾帧」对调的结果；
//   ② image.frameRole —— 调用方直接标在参考素材上（非画布入口走这条）；
//   ③ 接入顺序兜底。
// ⚠️ ③ 只是兜底。「哪张是首帧」靠顺序猜，正是本次要根治的那类毛病；
//    地址型的键天然会失配（图片自愈换链、blob 重建都会换地址），所以兜底必须留着，但不该是常态。
// 返回 null = 张数不对，交回调用方按别的分支处理（1 张走 first_frame、其余退回 reference_image 老路）。
function orderFrameImages(references: ReferenceImage[], roles?: { first?: string; last?: string }): ReferenceImage[] | null {
    if (references.length !== 2) return null;
    const [a, b] = references;
    if (frameRoleMatches(a, roles?.last) || frameRoleMatches(b, roles?.first)) return [b, a];
    if (frameRoleMatches(a, roles?.first) || frameRoleMatches(b, roles?.last)) return [a, b];
    if (a.frameRole === "last" || b.frameRole === "first") return [b, a];
    return [a, b];
}

async function buildSeedanceContent(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], mode: VideoMode = "auto") {
    // 按【当前模型】截断参考素材。2.0 是 9/3/3，2.5 是 30/10/10。
    // 必须按模型取而不是固定常量：用户可能在 2.5 下接了 20 张图，再切回 2.0 生成，
    // 那就得截到 9 张，否则上游直接拒。
    // model 用外层传进来的形参而不是 config.model —— 视频路径下 config.model 可能是图片模型。
    const limits = seedanceCapability(model);
    const content: Array<Record<string, unknown>> = [];
    // 提示词前言（「参考素材编号：图片1、图片2……」）对所有模式一视同仁，首帧/首尾帧也照加。
    // 是有意的：用户的提示词里仍可能写 @图片1，去掉前言编号就对不上了。
    // 前言只是陈述编号、不声明任务类型（任务类型全在下面的 role 上），不会跟首尾帧语义打架。
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    // 图片的 role 按【模式】分派。Seedance 的任务意图就是靠它声明的（火山《按 content.role 区分任务》）：
    //   role=first_frame                    → 首帧生视频（我们这边叫「图生视频」）
    //   role=first_frame + role=last_frame  → 首尾帧生视频
    //   role=reference_image                → 全模态·参考生视频（人物/场景/风格参考，不是首尾帧）
    // 原先这里所有图片一律写死 reference_image，于是「图生视频/首尾帧」根本发不出正确形态。
    // ⚠️ auto / text_to_video / reference_to_video 必须走最后那条原样的 reference_image 分支，
    //    一个字节都不能变——那是改动前唯一验证过、也是绝大多数存量请求的形态。
    // ⚠️ 这两种带首帧的模式还要求 ratio=adaptive，那一步在 createSeedanceTask 里做（上游硬约束，见那边注释）。
    const frameImages = mode === "first_last_frame" ? orderFrameImages(references, config.videoFrameRoles) : null;
    if (frameImages) {
        // orderFrameImages 已把两张排成 [首帧, 尾帧]：用户在参考图上点过「首帧/尾帧」对调就按他的来，
        // 没点过才按接入顺序兜底。这里按下标取，不依赖 content[] 的顺序表达语义（语义全在 role 上）。
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, frameImages[0]) }, role: "first_frame" });
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, frameImages[1]) }, role: "last_frame" });
    } else if ((mode === "image_to_video" || mode === "first_last_frame") && references.length === 1) {
        // 首尾帧只接了【1 张】：按文档原文「输入 1 张图作为首帧生成视频，或输入 2 张图分别作为首帧和尾帧」，
        // 1 张就只发 role=first_frame（= 首帧生视频），不是错误形态。
        // 写成「恰好 2 张」的话，1 张会落到下面的 reference_image 老路上——
        // 用户选了首尾帧，发出去的却是参考生视频，语义整个错掉。
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, references[0]) }, role: "first_frame" });
    } else {
        // ⚠️ 落到这里的还包括「模式是 image_to_video/first_last_frame、但张数对不上」的极端情况
        //    （resolveVideoModeForRequest 已按素材条件拦过一道，正常进不来；这是第二道保险）。
        //    那时宁可退回 reference_image 老路把图【全发出去】，也不要只发一两张、把其余的静默丢掉。
        for (const image of references.slice(0, limits.images)) {
            content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
        }
    }
    for (const video of videoReferences.slice(0, limits.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, limits.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    if (config.channelMode === "remote") {
        return uploadReferenceMedia(dataUrlToFile({ ...image, dataUrl }));
    }
    return dataUrl;
}

// 取本地媒体字节，本地没有就从服务器自愈一次再取。
//
// getMediaBlob 只查本地 IndexedDB（file-storage.ts）——换设备、清过缓存、或大画布的懒加载还没轮到
// 这个节点时，必然 miss。而节点 metadata.content 里存的往往是上个会话的 blob: URL，早已失效。
// 原先 miss 之后直接去 fetch 那个死 blob，抛出的是浏览器原生 TypeError「Failed to fetch」：
// 既没治好，也让用户完全看不懂——典型形状是接了若干张图 + 一段音频去生成视频，
// 不到一秒就报错、请求压根没发到后端（钱没扣，但那一单直接废了）。
// 更迷惑的是「显示」走的是 resolveMediaUrl，那条本来就会自愈，所以症状是
// 「音频在画布上能正常播放，却当不了参考素材」。
// healMediaFromServer 拉回后会顺手 setMediaBlob 写回本地，所以自愈成功时再取一次必命中。
async function mediaBlobWithHeal(storageKey?: string) {
    if (!storageKey) return null;
    const cached = await getMediaBlob(storageKey);
    if (cached) return cached;
    // ⚠️ 必须包 try/catch：healMediaFromServer 末尾的 setMediaBlob 要写 IndexedDB，
    // 配额满（大画布很常见）或 Safari 无痕模式下会抛。异常一旦冒出去就会掐死整条素材解析，
    // 连调用方后面那个原本能成功的兜底都执行不到 —— 比「没自愈」更坏。
    try {
        const token = useUserStore.getState().token;
        if (!token) return null;
        if (!(await healMediaFromServer(storageKey, token))) return null;
        return await getMediaBlob(storageKey);
    } catch {
        return null;
    }
}

// 失效的 blob: 会让 fetch 抛 TypeError；包住它，让调用方落到自己那句中文报错而不是把
// 「Failed to fetch」原样甩给用户。
async function blobFromObjectUrl(url?: string) {
    if (!url || !url.startsWith("blob:")) return null;
    try {
        return await (await fetch(url)).blob();
    } catch {
        return null;
    }
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url)) return video.url;
    const isAssetUri = (video.url || "").startsWith("asset://");
    // asset:// 是素材授权协议：认证过的真人素材必须以它引用，否则会被内容审核拒掉。
    // 原样透传，由后端按 AssetID 反查登记时的公网地址——前端在这里判死只会白丢一单。
    if (isAssetUri) return video.url;
    // 到这里的 url 一定不是 asset://。它可能是个已失效的 blob:，而素材本体地址往往还留在 sourceUrl 里
    // （多半是个公网地址，直接拿来用即可）。⚠️ 有些节点【没有 storageKey】（服务端直接写公网地址的成片），只靠 blob 回退修不好。
    if (isPublicMediaUrl(video.sourceUrl || "")) return video.sourceUrl as string;
    const blob = (await mediaBlobWithHeal(video.storageKey)) || (await blobFromObjectUrl(video.sourceUrl || video.url));
    if (!blob) {
        throw new Error("参考视频必须是公网 URL、素材 ID，或本地已保存的视频");
    }
    const file = new File([blob], video.name || "reference-video.mp4", { type: video.type || blob.type || "video/mp4" });
    return uploadReferenceMedia(file);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url)) return audio.url;
    const isAssetUri = (audio.url || "").startsWith("asset://");
    // asset:// 是素材授权协议：认证过的真人素材必须以它引用，否则会被内容审核拒掉。
    // 原样透传，由后端按 AssetID 反查登记时的公网地址——前端在这里判死只会白丢一单。
    if (isAssetUri) return audio.url;
    // 到这里的 url 一定不是 asset://。它可能是个已失效的 blob:，而素材本体地址往往还留在 sourceUrl 里
    // （多半是个公网地址，直接拿来用即可）。⚠️ 有些节点【没有 storageKey】（服务端直接写公网地址的成片），只靠 blob 回退修不好。
    if (isPublicMediaUrl(audio.sourceUrl || "")) return audio.sourceUrl as string;
    const blob = (await mediaBlobWithHeal(audio.storageKey)) || (await blobFromObjectUrl(audio.sourceUrl || audio.url));
    if (!blob) {
        throw new Error("参考音频必须是公网 URL、素材 ID，或本地已保存的音频");
    }
    const file = new File([blob], audio.name || "reference-audio.mp3", { type: audio.type || blob.type || "audio/mpeg" });
    return uploadReferenceMedia(file);
}

async function uploadReferenceMedia(file: File) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("使用本地参考素材需要先登录，并在服务端配置 PUBLIC_BASE_URL");
    const body = new FormData();
    body.append("file", file, file.name);
    const response = await axios.post<ApiEnvelope<ReferenceMediaUploadResponse>>("/api/v1/media/references", body, { headers: { Authorization: `Bearer ${token}` } });
    const payload = unwrapEnvelope(response.data, "参考素材上传失败");
    if (!payload.url) throw new Error("参考素材上传后没有返回公网 URL");
    return payload.url;
}

async function videoResultFromUrl(url: string): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob" });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch {
        return { url, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (config.channelMode === "local" && !config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (config.channelMode === "local" && !config.apiKey.trim()) throw new Error("请先配置 API Key");
}

function normalizeVideoSeconds(value: string, model = "") {
    // 通用视频协议默认上限 15 秒。原先写的是 20，比实际能力宽，
    // 界面钳到 15 而请求层放到 20，中间那段只会换来一个上游拒收。
    // 上下限都按模型取：长片档是 4~30 秒，写死 15 的话「界面允许 30、请求层砍到 15」，
    // 用户按 30 秒付钱却只拿到 15 秒的片。
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(videoSecondsFloor(model), Math.min(videoSecondsCap(model) || NON_SEEDANCE_MAX_SECONDS, seconds)));
}

// normalizeVideoSize 把配置里的比例/尺寸换成发给通用视频接口的 size 字段（「宽x高」像素串）。
//
// 🔴 原先这里的比例白名单只有三项：
//        return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
//    于是 1:1 / 4:3 / 21:9 一律【静默】变成 1280x720 横屏——用户在界面上选了正方形，
//    拿到的是横片，前后端日志里都看不出哪一步出的错。3:4 更离谱：被映射成 720x1280（那是 9:16），
//    比例直接被换成了另一个。现在按 720p 像素表逐档映射（videoSizePixels），
//    表外的 "N:M"（如历史遗留的 2:3）也按数值找最接近的一档。
//
// ⚠️ 这处修复【与模式无关】，但会改到存量行为：默认的 16:9 / 9:16 逐字节不变，
//    而 1:1 / 4:3 / 3:4 / 2:3 / 21:9 这几档发出去的 size 会从今天的错值变成对的值。
//    要把本期收窄成「纯模式改动」，只需把这几行换回上面那条三项白名单即可，其余代码不受影响。
//
// ⚠️ "auto"/"adaptive" 返回 null，调用方的 if 判断使得 size 字段【整个不发】，由上游按缺省出片。
//    "auto" 本来就是这个行为；"adaptive" 以前会掉进 else 分支被打成 1280x720（=写死 16:9），
//    那与「自适应」这个选项的字面意思正相反。这两条第三方接口都不该替用户硬塞一个比例——
//    往外发一个没在对方文档里查到的取值（比如把 "adaptive" 当 size 发过去）风险更大，多半整单被拒。
function normalizeVideoSize(value: string) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "auto" || raw === "adaptive") return null;
    if (!raw) return "1280x720";
    return videoSizePixels(raw);
}

function normalizeVideoResolution(value: string, _model = "") {
    let normalized = "";
    if (value === "low") normalized = "480p";
    else if (value === "auto" || value === "high" || value === "medium") normalized = "720p";
    else normalized = `${value.replace(/p$/i, "") || "720"}p`;
    return normalized;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, "接口没有返回视频任务");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && typeof payload.code === "number") {
        if (payload.code !== 0) throw new Error(payload.msg || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "视频下载失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
