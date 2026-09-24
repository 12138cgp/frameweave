import type { ComponentProps } from "react";
import { Zap } from "@/components/icons";

export function CreditSymbol({ className, ...props }: ComponentProps<"span">) {
    return (
        <span {...props} className={`inline-flex items-center justify-center ${className || ""}`}>
            <Zap className="size-[1em] fill-current" strokeWidth={2.4} />
        </span>
    );
}

export type ImageQualityRate = {
    quality: string;
    credits: number;
};

export type ModelCreditCost = {
    model: string;
    credits: number;
    // 图片按画质档分别定价；缺省/空 = 不分档，用 credits 一口价。与后端 model.ModelCost.QualityRates 对应。
    qualityRates?: ImageQualityRate[];
};

// 把画布上的画质选项归一成 1k / 2k / 4k 档。
//
// ⚠️ 必须与后端 service.ImageQualityTierFor（service/image_quality.go）逐分支对齐，
// 两边差一档，用户看到的预估价和实际扣的钱就对不上。
// 这类「前端算一套、后端算另一套」的分叉会直接变成钱：只要前端把视频 4K 档
// 一路兜底成 720p，用户就会看到 150 点、实扣 750 点，整整 5 倍。
//
// 空值/未知一律归 2k，与 services/api/image.ts 的 normalizeQuality 兜底（medium=2K）一致——
// 那边兜到 2K 就会真的按 2K 发出去，这里若兜成别的档，显示价立刻和实扣分叉。
export function normalizeImageQualityTier(quality?: string) {
    const value = (quality || "").trim().toLowerCase();
    if (["low", "1k", "standard"].includes(value)) return "1k";
    if (["high", "4k"].includes(value)) return "4k";
    return "2k";
}

// 取某模型的单价：图片传了 quality 就按档取，档上没配价（或没分档）回落一口价。
// 与后端 service.PickImageQualityCredits 同口径：**档价为 0 视作「这档没单独定价」而不是「免费」**。
export function modelCreditCost(modelCosts: ModelCreditCost[] | undefined, model: string, quality?: string) {
    const entry = modelCosts?.find((item) => item.model === model);
    if (!entry) return 0;
    if (quality) {
        const tier = normalizeImageQualityTier(quality);
        const rate = entry.qualityRates?.find((item) => (item.quality || "").trim().toLowerCase() === tier);
        if (rate && rate.credits > 0) return rate.credits;
    }
    return entry.credits || 0;
}

export function requestCreditCost(options: { channelMode: string; modelCosts?: ModelCreditCost[]; model: string; count?: string | number; quality?: string }) {
    if (options.channelMode !== "remote") return 0;
    const count = Math.max(1, Math.floor(Math.abs(Number(options.count)) || 1));
    return modelCreditCost(options.modelCosts, options.model, options.quality) * count;
}

export type VideoResolutionRate = {
    resolution: string;
    creditsPerSecond: number;
    // 带视频输入(视频生视频)每秒点数;缺省/0 = 回退不带输入价。与后端 model.VideoResolutionRate 对应。
    creditsPerSecondWithVideo?: number;
};

export type VideoModelCreditCost = {
    model: string;
    rates: VideoResolutionRate[];
};

// 智能时长（-1）按上限预扣的秒数，与后端 service.VideoBillingSmartDurationSeconds 保持一致。
export const VIDEO_BILLING_SMART_SECONDS = 15;

// 视频按「秒数 × 分辨率每秒积分」计费；模型未配置按秒计费时回退按次计费（与后端逻辑一致）。
export function videoRequestCreditCost(options: { channelMode: string; modelCosts?: ModelCreditCost[]; videoModelCosts?: VideoModelCreditCost[]; model: string; seconds?: string | number; resolution?: string; hasVideoInput?: boolean }) {
    if (options.channelMode !== "remote") return 0;
    const entry = options.videoModelCosts?.find((item) => item.model === options.model);
    if (!entry || !entry.rates.length) return requestCreditCost({ channelMode: options.channelMode, modelCosts: options.modelCosts, model: options.model, count: 1 });
    const resolution = normalizeBillingResolution(options.resolution || "");
    const rate = entry.rates.find((item) => item.resolution === resolution) || entry.rates.find((item) => item.resolution === "720p") || entry.rates[0];
    const rawSeconds = Math.floor(Number(options.seconds));
    const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : VIDEO_BILLING_SMART_SECONDS;
    // 带视频输入(接了参考视频=视频生视频)且配了带输入档(>0)用带输入价,否则一律回退不带输入价。与后端 service.videoRatePerSecond 一致。
    const perSecond = options.hasVideoInput && rate.creditsPerSecondWithVideo && rate.creditsPerSecondWithVideo > 0 ? rate.creditsPerSecondWithVideo : rate.creditsPerSecond;
    return perSecond * seconds;
}

export type AudioModelCreditCost = {
    model: string;
    creditsPerSecond: number;
    // 每 100 字（不足 100 按 100 算）积分。优先级高于 creditsPerSecond。
    creditsPer100Chars?: number;
};

// 按字数计费的档位，与后端 model.AudioCharBillingUnit 同值。
export const AUDIO_CHAR_BILLING_UNIT = 100;

// 音频生成没填目标时长时的默认预扣秒数，与后端 service.AudioBillingDefaultSeconds 一致。
export const AUDIO_BILLING_DEFAULT_SECONDS = 15;
// 音频出片硬上限，与后端 service.AudioBillingMaxSeconds 一致。
export const AUDIO_BILLING_MAX_SECONDS = 120;

// 音频按「秒数 × 每秒积分」计费；模型未配按秒价时回退按次计费（与后端 AudioModelCredits 一致）。
//
// ⚠️ 这里算出来的是【预扣额】，不是最终价。seed-audio 上游没有时长参数、出片秒数事前不可知，
// 所以提交时按 AUDIO_BILLING_DEFAULT_SECONDS 预扣，出片后由后端按 original_duration 结算差额
// （多退少补）。界面上必须让用户知道这一点，别让他以为是最终收费。
export function audioRequestCreditCost(options: { channelMode: string; modelCosts?: ModelCreditCost[]; audioModelCosts?: AudioModelCreditCost[]; model: string; seconds?: string | number; chars?: number }) {
    if (options.channelMode !== "remote") return 0;
    const entry = options.audioModelCosts?.find((item) => item.model === options.model);
    // 优先级必须与后端 handler/ai.go 一致：按字数 > 按秒 > 按次。
    if (entry && (entry.creditsPer100Chars || 0) > 0) {
        const chars = Math.max(0, Math.floor(Number(options.chars) || 0));
        const units = chars <= 0 ? 0 : Math.ceil(chars / AUDIO_CHAR_BILLING_UNIT);
        return (entry.creditsPer100Chars || 0) * units;
    }
    if (!entry || !(entry.creditsPerSecond > 0)) return requestCreditCost({ channelMode: options.channelMode, modelCosts: options.modelCosts, model: options.model, count: 1 });
    const rawSeconds = Math.round(Number(options.seconds));
    let seconds = AUDIO_BILLING_DEFAULT_SECONDS;
    if (Number.isFinite(rawSeconds) && rawSeconds > 0) seconds = Math.min(AUDIO_BILLING_MAX_SECONDS, rawSeconds);
    return entry.creditsPerSecond * seconds;
}

// 与后端 NormalizeVideoBillingResolution（service/settings.go）严格对齐：
// 各种分辨率写法归一成 480p / 720p / 1080p / 2160p。
//
// ⚠️ 这个函数只要和后端差一档，用户看到的价和实际扣的钱就对不上。
// 这不是假想风险，新增档位时最容易漏的就是这里：若后端 NormalizeVideoBillingResolution 已经认得
// "2160p"/"4k"，而这里没有对应分支、一路兜底 return "720p" ——
// 用户选 4K 会看到「150 点」（按 720p 的 10 点/秒 × 15 秒），实际被扣 750 点
// （按 2160p 的 50 点/秒），整整 5 倍。后端扣费是对的，错的是这里。
//
// 【改这个函数时必须同步核对后端那一份】，两边的分支要一一对应。
export function normalizeBillingResolution(value: string) {
    const normalized = value.trim().toLowerCase();
    if (["low", "480", "480p"].includes(normalized)) return "480p";
    if (["", "auto", "medium", "high", "720", "720p"].includes(normalized)) return "720p";
    if (["1080", "1080p", "fhd"].includes(normalized)) return "1080p";
    if (["2160", "2160p", "4k", "uhd"].includes(normalized)) return "2160p";
    const match = normalized.match(/^(\d+)x(\d+)$/);
    if (match) {
        const shortSide = Math.min(Number(match[1]), Number(match[2]));
        if (shortSide <= 560) return "480p";
        if (shortSide <= 900) return "720p";
        // 3840x2160 的短边是 2160，原先一律归到 1080p —— 同样会少报价。
        if (shortSide <= 1200) return "1080p";
        return "2160p";
    }
    return "720p";
}
