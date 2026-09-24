import axios from "axios";

import {
    audioMimeType,
    isSeedAudioModel,
    normalizeAudioFormatForModel,
    normalizeAudioFormatValue,
    normalizeAudioPitchValue,
    normalizeAudioRateValue,
    normalizeAudioSampleRate,
    normalizeAudioSpeedValue,
    normalizeAudioVoiceForModel,
} from "@/lib/audio-generation";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { attachTraceId, readResponseTraceId } from "@/services/api/trace";

function aiApiUrl(config: AiConfig, path: string) {
    return config.channelMode === "remote" ? `/api/v1${path}` : buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    const token = useUserStore.getState().token;
    return config.channelMode === "remote"
        ? {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              "Content-Type": "application/json",
          }
        : {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
          };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

/** 音频生成的参考素材（仅 seed-audio 用）。顺序【必须】与提示词里的 @音频N 编号一致。 */
export type AudioGenerationReferences = {
    audios: ReferenceAudio[];
    images: ReferenceImage[];
};

export async function requestAudioGeneration(config: AiConfig, prompt: string, references?: AudioGenerationReferences): Promise<{ blob: Blob; traceId: string; billedSeconds: number }> {
    const model = (config.model || config.audioModel).trim();
    assertAudioConfig(config, model);
    const format = normalizeAudioFormatForModel(model, normalizeAudioFormatValue(config.audioFormat));
    const instructions = config.audioInstructions.trim();
    // seed-audio(音频生成)：带参考素材 + 目标时长 + 音量/音调。
    // 其余模型(老的 TTS)一个新字段都不带——请求体与本改动前逐字段相同，老路零影响。
    const seedAudio = isSeedAudioModel(model);
    const seedAudioPayload = seedAudio ? buildSeedAudioPayload(config, references) : {};

    let traceId = "";
    try {
        const response = await axios.post<Blob>(
            aiApiUrl(config, "/audio/speech"),
            {
                model,
                input: prompt,
                voice: normalizeAudioVoiceForModel(model, config.audioVoice),
                response_format: format,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                ...(instructions ? { instructions } : {}),
                ...seedAudioPayload,
            },
            {
                headers: {
                    ...aiHeaders(config),
                    ...(config.channelMode === "remote" && config.projectId ? { "X-Project-ID": config.projectId } : {}),
                    ...(config.channelMode === "remote" && config.canvasId ? { "X-Canvas-ID": config.canvasId } : {}),
                },
                responseType: "blob",
            },
        );
        traceId = readResponseTraceId(response.headers);
        await assertAudioBlob(response.data);
        refreshRemoteUser(config);
        const blob = response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
        return { blob, traceId, billedSeconds: readBilledSeconds(response.headers) };
    } catch (error) {
        throw attachTraceId(error, readAxiosError(error, "音频生成失败"), traceId);
    }
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

// buildSeedAudioPayload 组装音频生成的扩展字段。
// 参考素材只发【地址】，字节由后端自己去取——桶不一定公共读、上游能否读到我们的地址也没保证，
// 而且 3 条 10MB 的音频转成 base64 塞进浏览器请求体是 40MB 起步，用户上行先被拖死。
function buildSeedAudioPayload(config: AiConfig, references?: AudioGenerationReferences) {
    const audios = references?.audios || [];
    const images = references?.images || [];
    const refs = [
        ...audios.map((audio) => ({ kind: "audio", url: audio.sourceUrl || audio.url, storageKey: audio.storageKey })),
        ...images.map((image) => ({ kind: "image", url: image.sourceUrl || image.dataUrl, storageKey: image.storageKey })),
    ];
    // 不再发 target_seconds：上游没有时长参数，我们也不再往提示词里塞时长描述（不可靠）。
    // 后端因此按 service.AudioBillingDefaultSeconds 预扣，再按上游返回的真实秒数结算差额。
    return {
        sample_rate: normalizeAudioSampleRate(config.audioFormat, config.audioSampleRate),
        loudness_rate: normalizeAudioRateValue(config.audioLoudness),
        pitch_rate: normalizeAudioPitchValue(config.audioPitch),
        ...(refs.length ? { references: refs } : {}),
    };
}

// readBilledSeconds 读后端回的计费时长(上游 original_duration)。
// 响应体是音频字节，塞不下 JSON，所以时长走响应头。读不到就当 0（不显示，也不用于任何计算）。
function readBilledSeconds(headers: unknown): number {
    const value = (headers as Record<string, string> | undefined)?.["x-audio-billed-duration"];
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return seconds;
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (config.channelMode === "local" && !config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (config.channelMode === "local" && !config.apiKey.trim()) throw new Error("请先配置 API Key");
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "音频生成失败");
    if (payload.error?.message) throw new Error(payload.error.message);
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
