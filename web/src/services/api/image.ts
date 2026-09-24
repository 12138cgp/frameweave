import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { agentTurnHeader } from "@/services/agent-turn-context";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { createGenerationJob, waitGenerationJob } from "@/services/api/generation-jobs";
import { imageToDataUrl } from "@/services/image-storage";
import { attachTraceId, readResponseTraceId } from "@/services/api/trace";
import type { ReferenceImage } from "@/types/image";

// 生图任务化（remote 渠道）：任务 ID 交给调用方持久化，刷新/切页后凭 ID 领回结果
export type OnImageJobCreated = (jobId: string) => void;

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

// 质量档像素基准 = sqrt(目标总像素)，按 16:9 标准分辨率阶梯反推：
// 1K=1920×1080(基准1440) / 2K=2560×1440(基准1920) / 4K=3840×2160(基准2880)
const QUALITY_BASE: Record<string, number> = {
    low: 1440,
    medium: 1920,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 8;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";

// quality 可能是 UI 档(1k/2k/4k)、历史档(auto/low/medium/high)或空/脏值，统一折算到 QUALITY_BASE 档名。
// 必须与面板 activeQuality 的回显规整一致：面板(image-settings-panel.tsx)对任何无法识别的值都回退高亮「2K」，
// 这里也必须回退到 medium(2K)。否则会出现「面板显示 2K、却因 quality 发不出而生成模型默认 ~1K」的不一致——
// 历史残留值 quality="auto" 正是此 bug 元凶：auto 不在旧白名单，旧实现返回 undefined → 请求不带 quality、
// size 也不放大 → Gemini 出默认 1376×768(用户报的「选 2K 仍是 1376×768」)。default config 已是 "2k"，故兜底 2K 与产品默认一致。
function normalizeQuality(quality: string): string {
    const value = (quality || "").trim().toLowerCase();
    if (QUALITY_BASE[value]) return value; // low/medium/high/standard/hd
    const aliased = QUALITY_ALIASES[value]; // 1k/2k/4k → low/medium/high
    if (aliased && QUALITY_BASE[aliased]) return aliased;
    return "medium"; // auto/空/未知 → 2K，与面板回显回退一致
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseImageRatio(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    if (Math.max(w, h) / Math.min(w, h) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return { width: w, height: h };
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 8 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error("图像尺寸最长边不能超过 3840px，请调整尺寸");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error("图像总像素需在 655360 到 8294400 之间，请调整尺寸");
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

// 面板预览：把「质量档（1k/2k/4k）+ 比例」解析成实际像素，供 UI 显示。
// 与请求时同一套逻辑（含 seedream 最小像素放大），保证显示值==实际发送值；失败返回 null。
export function previewImageSize(quality: string, size: string, model?: string): { width: number; height: number } | null {
    try {
        const resolved = enforceGptImageSize(enforceSeedreamMinSize(resolveRequestSize(normalizeQuality(quality), size), model || ""), model || "");
        return resolved ? parseImageDimensions(resolved) : null;
    } catch {
        return null;
    }
}

// 火山 Seedream 5.0 要求图像 ≥ 3,686,400 像素（约 1920×1920）。小于该值的尺寸（含 1K、部分 2K 预设）会被拒。
const SEEDREAM_MIN_PIXELS = 3686400;

// 对 seedream 模型把过小的尺寸按比例放大到达标；auto（无显式尺寸）给一个达标的方形默认值。
function enforceSeedreamMinSize(size: string | undefined, model: string): string | undefined {
    if (!isSeedreamImageModel(model)) return size;
    if (!size) return "2048x2048";
    const dimensions = parseImageDimensions(size);
    if (!dimensions) return size;
    if (dimensions.width * dimensions.height >= SEEDREAM_MIN_PIXELS) return size;
    const scale = Math.sqrt(SEEDREAM_MIN_PIXELS / (dimensions.width * dimensions.height));
    const cap = (value: number) => Math.min(IMAGE_MAX_EDGE, Math.round((value * scale) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP);
    let width = cap(dimensions.width);
    let height = cap(dimensions.height);
    // 取整后若仍略低于阈值，等比小步上调直到达标（不越过最大边）
    while (width * height < SEEDREAM_MIN_PIXELS && Math.max(width, height) + IMAGE_SIZE_STEP <= IMAGE_MAX_EDGE) {
        width += IMAGE_SIZE_STEP;
        height += IMAGE_SIZE_STEP;
    }
    return `${width}x${height}`;
}

// gpt-image 系（含 gpt-image-2）官方约束：宽、高都必须能被 16 整除（否则上游返回 400）。
// 系统内部按 IMAGE_SIZE_STEP=8 对齐，某些比例（如 3:2 → 2344x1560，÷16 非整）会被上游拒。
// 此处仅对 gpt-image 把宽高各圆整到最近的 16 的倍数（最小 16、单边不超过 IMAGE_MAX_EDGE）。
// 与 enforceSeedreamMinSize 互斥（一个只管 seedream、一个只管 gpt-image），串联调用即可。
const GPT_IMAGE_SIZE_STEP = 16;

// ⚠️ 对齐 16 必须【只减不增】地兜底，否则会把总像素顶过官方上限。
//
// 原实现只有「round 到最近的 16」，两边同时向上取时总像素会变大，而对齐之后
// 没有任何人再校验一次（validateImageSize 在 resolveSize 里、发生在对齐之前）。
// 实际后果：4K 档的 4:3 / 3:4 正是这么挂的——
//     resolveSize  2488x3320 = 8,260,160  ✓ 通过校验
//     round 到 16  2496x3328 = 8,306,688  ✗ 超上限 12,288 像素 → 上游 400
// 而 16:9 的 3840x2160 本来就是 16 的整数倍、原样通过，所以「9:16 能用 4K、3:4 不能」。
//
// 现在的做法：先按最近的 16 对齐（画质最优，不无谓缩小），只有当它把总像素顶过
// 上限时，才两边各退一档到向下对齐。
//
// 全量验算过 7 种比例 × 3 个档位 = 21 种组合：修前 2 种非法（4K 的 4:3 / 3:4），
// 修后 0 种；且退档只在那 2 种上触发，其余 19 种输出与修改前逐字节一致。
// 前端目前没有单测基建，改这里请照下面的口径手工复算一遍再发布：
//     最终宽高必须同时满足 —— 均为 16 的倍数、最长边 ≤ 3840、长短边比 ≤ 3:1、
//     总像素在 655,360 ~ 8,294,400 之间。
function enforceGptImageSize(size: string | undefined, model: string): string | undefined {
    if (!isGptImageModel(model) || !size) return size;
    const dimensions = parseImageDimensions(size);
    if (!dimensions) return size;
    const clamp = (value: number) => Math.min(IMAGE_MAX_EDGE, Math.max(GPT_IMAGE_SIZE_STEP, value));
    const nearest = (value: number) => clamp(Math.round(value / GPT_IMAGE_SIZE_STEP) * GPT_IMAGE_SIZE_STEP);
    const down = (value: number) => clamp(Math.floor(value / GPT_IMAGE_SIZE_STEP) * GPT_IMAGE_SIZE_STEP);
    let width = nearest(dimensions.width);
    let height = nearest(dimensions.height);
    if (width * height > IMAGE_MAX_PIXELS) {
        width = down(dimensions.width);
        height = down(dimensions.height);
    }
    return `${width}x${height}`;
}

// 从 base64 前缀嗅探真实图片类型。上游声明的 output_format 与我们请求的值都不可信：
// 实测火山方舟 seedream 会无视 output_format=png 直接返回 JPEG。写死 png 会让错误的
// mimeType 一路传到 sync_files、再传到下一次生成的 multipart Content-Type 和 Gemini 的
// inlineData.mimeType。以字节为准，不认声明。
function sniffBase64ImageMime(b64: string) {
    if (b64.startsWith("/9j/")) return "image/jpeg";
    if (b64.startsWith("iVBORw0KGgo")) return "image/png";
    if (b64.startsWith("R0lGOD")) return "image/gif";
    if (b64.startsWith("UklGR")) return "image/webp";
    if (b64.startsWith("Qk")) return "image/bmp";
    return "image/png";
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:${sniffBase64ImageMime(item.b64_json)};base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(payload.msg || "请求失败");
    }
    const images =
        payload.data
            ?.map(resolveImageDataUrl)
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];

    if (images.length === 0) {
        throw new Error("接口没有返回图片");
    }

    return images;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || readStatusError(error.response?.status, fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}：${status}` : fallback;
}

function parseStreamChunk(chunk: string, onDelta: (value: string) => void) {
    let deltaText = "";
    for (const eventBlock of chunk.split("\n\n")) {
        const data = eventBlock
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
        if (!data || data === "[DONE]") continue;
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content || "";
        deltaText += delta;
    }
    if (deltaText) onDelta(deltaText);
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return config.channelMode === "remote" ? `/api/v1${path}` : buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    const token = useUserStore.getState().token;
    // 助手回合里发出的生成请求带上回合标记，后端据它做「一个回合最多花多少点数」的闸。
    // 不在助手回合里时 agentTurnHeader() 返回空对象，普通请求完全不受影响。
    return config.channelMode === "remote"
        ? {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(contentType ? { "Content-Type": contentType } : {}),
              ...agentTurnHeader(),
          }
        : {
              Authorization: `Bearer ${config.apiKey}`,
              ...(contentType ? { "Content-Type": contentType } : {}),
          };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

function withSystemMessage(config: AiConfig, messages: ChatCompletionMessage[]) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

// 豆包 seed 系是推理模型，默认会先输出大量 reasoning_content（前端不展示、且拖慢响应数十秒~分钟、挤占额度导致 JSON 被截断）。
// 结构化文本场景（故事板解析/自动成片/助手）显式关闭推理：实测响应从 1-2 分钟降到约 3 秒、直接吐合规 JSON。
function thinkingOverride(model: string): Record<string, unknown> {
    return /doubao-seed/i.test(model || "") ? { thinking: { type: "disabled" } } : {};
}

// 火山 Seedream 系生图模型 watermark 默认 true（左下角「AI生成」水印），显式关闭；
// 只对 seedream/doubao 模型传该字段，避免 OpenAI 等严格校验的接口报未知参数。
function isSeedreamImageModel(model: string) {
    const value = (model || "").toLowerCase();
    return value.includes("seedream") || value.includes("doubao");
}

// gpt-image 系会遵守 edit 请求的 size 参数（透传即可控制比例）；其它模型（如 seedream）图生图时输出比例
// 往往跟随参考图、忽略 size，需要靠提示词加强。
function isGptImageModel(model: string) {
    return (model || "").toLowerCase().includes("gpt-image");
}

// 由所选 size（"9:16" / "1024x1536" / "auto"）推出比例提示词，强约束图生图输出比例。auto 返回空。
function aspectRatioPromptHint(size: string | undefined): string {
    const value = (size || "").trim().toLowerCase();
    if (!value || value === "auto") return "";
    let w = 0;
    let h = 0;
    const dims = parseImageDimensions(value);
    if (dims) {
        w = dims.width;
        h = dims.height;
    } else if (value.includes(":")) {
        const [a, b] = value.split(":").map((n) => Number(n.trim()));
        if (a > 0 && b > 0) {
            w = a;
            h = b;
        }
    }
    if (!w || !h) return "";
    // 循环求最大公约数（避免自引用 const 递归导致的 TDZ）
    let a = Math.round(w);
    let b = Math.round(h);
    while (b) {
        const t = b;
        b = a % b;
        a = t;
    }
    const divisor = Math.max(1, a);
    const ratio = `${Math.round(w / divisor)}:${Math.round(h / divisor)}`;
    const orientation = w < h ? "竖版" : w > h ? "横版" : "正方形";
    return `【输出比例要求】请将整张图片按 ${ratio} 的${orientation}画幅构图与输出，完整填满画面、主体居中，不要黑边、留白或裁掉主体。`;
}

export async function requestGeneration(config: AiConfig, prompt: string, onJobCreated?: OnImageJobCreated) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const quality = normalizeQuality(config.quality);
    const requestSize = enforceGptImageSize(enforceSeedreamMinSize(resolveRequestSize(quality, config.size), config.model), config.model);
    const payload = {
        model: config.model,
        prompt: withSystemPrompt(config, prompt),
        n,
        ...(quality ? { quality } : {}),
        ...(requestSize ? { size: requestSize } : {}),
        ...(isSeedreamImageModel(config.model) ? { watermark: false } : {}),
        // gpt-image 系列(OpenAI 官方及合规中转上游)不接受 response_format,带上会 400「Unknown parameter」;
        // 它本就默认返回 b64_json,故 gpt-image 不发该参数(dall-e/seedream 等其它模型照旧带)。
        ...(isGptImageModel(config.model) ? {} : { response_format: "b64_json" }),
        output_format: IMAGE_OUTPUT_FORMAT,
    };
    // remote 渠道走异步任务：服务端后台调上游，刷新/切页不中断
    if (config.channelMode === "remote") {
        const jobId = await createGenerationJob("images", payload, config.projectId, config.canvasId);
        onJobCreated?.(jobId);
        return resumeImageGenerationJob(jobId, config);
    }
    try {
        const response = await axios.post<ImageApiResponse>(aiApiUrl(config, "/images/generations"), payload, {
            headers: aiHeaders(config, "application/json"),
        });
        const images = parseImagePayload(response.data);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        throw attachTraceId(error, readAxiosError(error, "请求失败"));
    }
}

// 凭任务 ID 领取/续等生图结果（断点恢复入口；服务端结果保留 48 小时）
export async function resumeImageGenerationJob(jobId: string, config?: AiConfig) {
    const result = await waitGenerationJob(jobId);
    const images = parseImagePayload(result as ImageApiResponse);
    if (config) refreshRemoteUser(config);
    return images;
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, onJobCreated?: OnImageJobCreated) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const quality = normalizeQuality(config.quality);
    const requestSize = enforceGptImageSize(enforceSeedreamMinSize(resolveRequestSize(quality, config.size), config.model), config.model);
    // 图生图比例加强：只有 gpt-image 系会遵守 edit 请求的 size 参数，其余模型一律靠提示词约束。
    //
    // ⚠️ 这里原先还把 gemini 一起跳过，理由是「gemini 靠 generationConfig.imageConfig.aspectRatio
    // 由后端透传」。本版本只保留 OpenAI 方言这一条上游通道，没有会构造该字段的适配器，
    // 那条路是不通的——再跳过提示词，gemini 图生图的比例就【两条路都没有】，用户选了 9:16 也不生效。
    const ratioHint = isGptImageModel(config.model) ? "" : aspectRatioPromptHint(config.size);
    const requestPrompt = [buildImageReferencePromptText(prompt, references), ratioHint].filter(Boolean).join("\n\n");
    const formData = new FormData();
    formData.set("model", config.model);
    formData.set("prompt", withSystemPrompt(config, requestPrompt));
    formData.set("n", String(n));
    // gpt-image 系列不接受 response_format(会 400),默认就回 b64_json;故 gpt-image 不发该参数,其它模型照旧
    if (!isGptImageModel(config.model)) formData.set("response_format", "b64_json");
    formData.set("output_format", IMAGE_OUTPUT_FORMAT);
    if (quality) {
        formData.set("quality", quality);
    }
    if (requestSize) {
        formData.set("size", requestSize);
    }
    if (isSeedreamImageModel(config.model)) {
        formData.set("watermark", "false");
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    // 多图编辑统一发重复 image 字段；最终字段名由后端按渠道归一化（部分中转站要 image[]、另一些要重复 image），
    // 因为前端走 remote 异步时并不知道后端会路由到哪个渠道，写死任一字段名都会挂掉另一类渠道。
    files.forEach((file) => formData.append("image", file));
    if (mask) formData.set("mask", dataUrlToFile(mask));

    // remote 渠道走异步任务：服务端后台调上游，刷新/切页不中断
    if (config.channelMode === "remote") {
        const jobId = await createGenerationJob("image-edits", formData, config.projectId, config.canvasId);
        onJobCreated?.(jobId);
        return resumeImageGenerationJob(jobId, config);
    }
    try {
        const response = await axios.post<ImageApiResponse>(aiApiUrl(config, "/images/edits"), formData, { headers: aiHeaders(config) });
        const images = parseImagePayload(response.data);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        throw attachTraceId(error, readAxiosError(error, "请求失败"));
    }
}

// extraPayload：给特定调用方（如故事板结构化 JSON）追加请求参数（例如 max_tokens），默认不传，避免影响其它图像问答调用。
export async function requestImageQuestion(config: AiConfig, messages: ChatCompletionMessage[], onDelta: (text: string) => void, extraPayload?: Record<string, unknown>) {
    let buffer = "";
    let answer = "";
    let processedLength = 0;
    let traceId = "";

    try {
        const response = await axios.post(
            aiApiUrl(config, "/chat/completions"),
            {
                model: config.model,
                messages: withSystemMessage(config, messages),
                stream: true,
                ...thinkingOverride(config.model),
                ...(extraPayload ?? {}),
            },
            {
                headers: {
                    ...aiHeaders(config, "application/json"),
                    // 文本/chat 生成也带项目/画布头，让扣费走项目池（与图片/视频/音频一致）；缺失（无所属项目）则不带 → 回退个人。
                    // 修复：反推提示词/故事板/AI助手等文本功能，对个人余额低的项目制账号误报「点数不足」。
                    ...(config.projectId ? { "X-Project-ID": config.projectId } : {}),
                    ...(config.canvasId ? { "X-Canvas-ID": config.canvasId } : {}),
                } as Record<string, string>,
                responseType: "text",
                onDownloadProgress: (event) => {
                    const responseText = String(event.event?.target?.responseText || "");
                    const nextText = responseText.slice(processedLength);
                    processedLength = responseText.length;
                    buffer += nextText;
                    const chunks = buffer.split("\n\n");
                    buffer = chunks.pop() || "";
                    for (const chunk of chunks) {
                        parseStreamChunk(chunk, (delta) => {
                            answer += delta;
                            onDelta(answer);
                        });
                    }
                },
            },
        );
        traceId = readResponseTraceId(response.headers);
        if (typeof response.data === "object" && response.data && "code" in response.data && (response.data as { code?: number; msg?: string }).code !== 0) {
            throw new Error((response.data as { msg?: string }).msg || "请求失败");
        }
        if (typeof response.data === "string") {
            let apiError = "";
            try {
                const payload = JSON.parse(response.data) as { code?: number; msg?: string };
                if (typeof payload.code === "number" && payload.code !== 0) {
                    apiError = payload.msg || "请求失败";
                }
            } catch {
                // ignore plain text stream content
            }
            if (apiError) throw new Error(apiError);
        }
        if (buffer) {
            parseStreamChunk(buffer, (delta) => {
                answer += delta;
                onDelta(answer);
            });
        }
    } catch (error) {
        throw attachTraceId(error, readAxiosError(error, "请求失败"), traceId);
    }
    refreshRemoteUser(config);
    return answer || "没有返回内容";
}

// 提示词优化：用文本模型在【绝对不改变原意】前提下润色当前提示词。返回去掉首尾空白/包裹引号的纯文本。
const OPTIMIZE_PROMPT_SYSTEM_PROMPT = `你是 AI 绘画/视频提示词优化助手。请在【绝对不改变原意】的前提下优化用户的提示词：
- 必须保留用户写到的所有主体、属性、数量、动作、场景、风格、镜头、色彩和否定词，一个都不能丢；
- 绝对不要新增用户没有提到的主体、风格、元素或倾向，也不要删减任何要素；
- 只允许：补全模糊或口语化的表达、规范术语、调整语序与措辞，使其更利于模型理解；
- 保持与原文相同的语言（中文输入就中文输出）；
- 只输出优化后的提示词本身，不要任何解释、前后缀、引号或 markdown。`;

export async function optimizePrompt(config: AiConfig, rawPrompt: string) {
    const trimmed = rawPrompt.trim();
    if (!trimmed) throw new Error("提示词为空，无需优化");
    const messages: ChatCompletionMessage[] = [
        { role: "system", content: OPTIMIZE_PROMPT_SYSTEM_PROMPT },
        { role: "user", content: trimmed },
    ];
    const answer = await requestImageQuestion(config, messages, () => {}, { max_tokens: 2048 });
    // 去掉首尾空白与模型可能加上的包裹引号
    return answer.trim().replace(/^["'“”『「]+|["'“”』」]+$/g, "").trim();
}

export async function fetchImageModels(config: AiConfig) {
    if (config.channelMode === "remote") return config.models;
    try {
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}
