import axios from "axios";

import { useUserStore } from "@/stores/use-user-store";

export type PortraitAssetStatus = "processing" | "active" | "failed";

// 火山 CreateAsset 的 AssetType 支持 Image / Video / Audio 三类。
export type PortraitAssetKind = "image" | "video" | "audio";

export type PortraitAsset = {
    id: string;
    userId: string;
    title: string;
    sourceUrl: string;
    storageKey: string;
    groupId: string;
    assetId: string;
    projectName: string;
    kind?: PortraitAssetKind;
    status: PortraitAssetStatus;
    errorMsg?: string;
    createdAt: string;
    updatedAt: string;
};

// 火山素材资产的硬性规格（见「创建素材资产 CreateAsset」文档）。
// 提交前先自查，能把「提交完等几分钟才拿到一句 Failed」变成即时的、说得清原因的提示。
// 帧率(24~60fps)浏览器侧拿不到，只能交给火山判，失败提示里会带上这条。
export const VOLC_ASSET_SPEC = {
    video: {
        formats: ["video/mp4", "video/quicktime"],
        extensions: [".mp4", ".mov"],
        durationSec: [2, 15] as const,
        edgePx: [300, 6000] as const,
        totalPixels: [409600, 2086876] as const,
        aspect: [0.4, 2.5] as const,
        maxBytes: 200 * 1024 * 1024,
    },
    audio: {
        formats: ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"],
        extensions: [".wav", ".mp3"],
        durationSec: [2, 15] as const,
        maxBytes: 15 * 1024 * 1024,
    },
} as const;

type MediaProbe = { durationMs?: number; width?: number; height?: number; bytes?: number; mimeType?: string; name?: string };

// validateVolcAssetMedia 返回不合规原因（合规时返回空串）。只校验浏览器侧拿得到的项，
// 拿不到的字段一律放行——宁可交给火山判，也不要因为本地元数据缺失就挡住用户。
export function validateVolcAssetMedia(kind: PortraitAssetKind, probe: MediaProbe): string {
    if (kind === "image") return "";
    const spec = kind === "video" ? VOLC_ASSET_SPEC.video : VOLC_ASSET_SPEC.audio;
    const label = kind === "video" ? "参考视频" : "参考音频";

    const mime = (probe.mimeType || "").toLowerCase();
    const name = (probe.name || "").toLowerCase();
    // 先拓宽成 readonly string[]：直接对「联合的元组类型」调 .some() 会触发 TS2349
    // （两个分支的回调形参类型不同，签名不兼容）。而本项目构建关了类型检查，这种错只会在运行时炸。
    const extensions: readonly string[] = spec.extensions;
    const formats: readonly string[] = spec.formats;
    const extOk = extensions.some((ext) => name.endsWith(ext));
    const mimeOk = formats.some((f) => mime === f);
    // 两者都拿得到却都不匹配才判失败：容器与 MIME 常有出入（如 mov 被标成 video/mp4）。
    if (mime && name && !mimeOk && !extOk) return `${label}格式需为 ${extensions.join(" / ")}，当前为 ${mime || name}`;

    if (probe.bytes && probe.bytes > spec.maxBytes) {
        return `${label}体积 ${(probe.bytes / 1048576).toFixed(1)}MB 超过火山上限 ${spec.maxBytes / 1048576}MB`;
    }
    if (probe.durationMs && probe.durationMs > 0) {
        const seconds = probe.durationMs / 1000;
        const [min, max] = spec.durationSec;
        if (seconds < min || seconds > max) {
            return `${label}时长 ${seconds.toFixed(1)} 秒不在火山要求的 ${min}~${max} 秒内，请先裁剪`;
        }
    }
    if (kind === "video" && probe.width && probe.height) {
        const { edgePx, totalPixels, aspect } = VOLC_ASSET_SPEC.video;
        const { width, height } = probe;
        if (width < edgePx[0] || height < edgePx[0] || width > edgePx[1] || height > edgePx[1]) {
            return `${label}尺寸 ${width}×${height} 超出火山要求的边长 ${edgePx[0]}~${edgePx[1]}px`;
        }
        const total = width * height;
        if (total < totalPixels[0] || total > totalPixels[1]) {
            return `${label}总像素 ${(total / 10000).toFixed(1)} 万（${width}×${height}）超出火山要求的 ${(totalPixels[0] / 10000).toFixed(1)}~${(totalPixels[1] / 10000).toFixed(1)} 万，请降到 1080P 以内`;
        }
        const ratio = width / height;
        if (ratio < aspect[0] || ratio > aspect[1]) {
            return `${label}宽高比 ${ratio.toFixed(2)} 超出火山要求的 ${aspect[0]}~${aspect[1]}`;
        }
    }
    return "";
}

type ApiEnvelope<T> = T | { code?: number; data?: T | null; msg?: string };
type ReferenceMediaUploadResponse = { id: string; url: string; mimeType: string; bytes: number };

function authHeaders() {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("人像资产认证需要先登录");
    return { Authorization: `Bearer ${token}` };
}

function unwrap<T>(payload: ApiEnvelope<T>, fallback: string): T {
    if (payload && typeof payload === "object" && "code" in payload) {
        const envelope = payload as { code?: number; data?: T | null; msg?: string };
        if (envelope.code && envelope.code !== 0) throw new Error(envelope.msg || fallback);
        if (envelope.data === null || envelope.data === undefined) throw new Error(envelope.msg || fallback);
        return envelope.data;
    }
    return payload as T;
}

// 把人设图上传为公网可访问 URL（供火山方舟主动拉取入库）。
async function uploadPortraitSource(file: File) {
    const body = new FormData();
    body.append("file", file, file.name);
    const response = await axios.post<ApiEnvelope<ReferenceMediaUploadResponse>>("/api/v1/media/references", body, { headers: authHeaders() });
    const payload = unwrap(response.data, "人设图上传失败");
    if (!payload.url) throw new Error("人设图上传后没有返回公网 URL，请检查服务端 PUBLIC_BASE_URL");
    return payload.url;
}

// 提交人设图到火山方舟资产库入库审核，返回入库记录（初始通常为 processing）。
export async function submitPortraitAsset(input: { file: File; storageKey?: string; contentHash?: string; title?: string; kind?: PortraitAssetKind }) {
    const url = await uploadPortraitSource(input.file);
    const response = await axios.post<ApiEnvelope<PortraitAsset>>(
        "/api/portrait-assets",
        { url, storageKey: input.storageKey || "", contentHash: input.contentHash || "", title: input.title || "", kind: input.kind || "image" },
        { headers: { ...authHeaders(), "Content-Type": "application/json" } },
    );
    return unwrap(response.data, "提交火山素材授权失败");
}

// 素材已经在公共读的桶里（画布上的视频/音频节点几乎都是这种）时的直提路径：
// 直接把现成的公网地址交给火山拉取，既不重新上传也不让服务端重抓——
// 视频动辄十几 MB，多走一遍传输纯属浪费，而且火山本来就只认 URL。
export async function submitPortraitAssetByUrl(input: { url: string; storageKey?: string; contentHash?: string; title?: string; kind: PortraitAssetKind }) {
    const response = await axios.post<ApiEnvelope<PortraitAsset>>(
        "/api/portrait-assets",
        { url: input.url, storageKey: input.storageKey || "", contentHash: input.contentHash || "", title: input.title || "", kind: input.kind },
        { headers: { ...authHeaders(), "Content-Type": "application/json" } },
    );
    return unwrap(response.data, "提交火山素材授权失败");
}

// 服务端重抓模式：客户端读不到本地像素（如画布从他人分享/下载导入、图仍在对方桶、浏览器跨域取不到）时的回退——
// 只把源图公网地址交给服务端，由服务端抓取转存进本用户桶后入库（对方分组桶公共读，服务端可直接 GET）。
export async function submitPortraitAssetFromUrl(input: { sourceUrl: string; storageKey?: string; title?: string; kind?: PortraitAssetKind }) {
    const response = await axios.post<ApiEnvelope<PortraitAsset>>(
        "/api/portrait-assets",
        { sourceUrl: input.sourceUrl, storageKey: input.storageKey || "", title: input.title || "", kind: input.kind || "image" },
        { headers: { ...authHeaders(), "Content-Type": "application/json" } },
    );
    return unwrap(response.data, "提交火山素材授权失败");
}

// 火山图片素材的宽高比区间是 (0.4, 2.5)。留一点余量再取整，避免刚好压在边界上被判超限
// （文档写的是开区间，实测报错也是 must be between）。
const PORTRAIT_ASPECT_MIN = 0.42;
const PORTRAIT_ASPECT_MAX = 2.4;
const PORTRAIT_EDGE_MIN = 300;

/**
 * 算出「把图放进一张合规画布」所需的画布尺寸与绘制位置。
 *
 * 为什么需要补边：三视图/长条人设图这类素材宽高比常常超过 2.5（实测 6057×2265 = 2.67），
 * 火山直接 400 `InvalidParameter.AspectRatioTooLarge`。而单纯缩放【不会改变宽高比】，
 * 所以原来的压缩逻辑救不了它。这里用留白补边（letterbox）把比例拉回区间——
 * 不裁掉任何内容、不拉伸变形，只在两侧加白边。人设图多是白底，补出来看不出来。
 *
 * 返回的 draw* 是原图在画布中的绘制区域（居中）。
 */
export function fitPortraitCanvas(width: number, height: number, maxEdge = 1536) {
    let w = Math.max(1, Math.round(width));
    let h = Math.max(1, Math.round(height));
    // 先按长边缩到 maxEdge 内（同时保证不超过火山 6000 的边长上限）
    const longest = Math.max(w, h);
    if (longest > maxEdge) {
        const scale = maxEdge / longest;
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
    }
    let canvasW = w;
    let canvasH = h;
    const ratio = w / h;
    if (ratio > PORTRAIT_ASPECT_MAX) {
        canvasH = Math.ceil(w / PORTRAIT_ASPECT_MAX); // 太宽 → 上下补白
    } else if (ratio < PORTRAIT_ASPECT_MIN) {
        canvasW = Math.ceil(h * PORTRAIT_ASPECT_MIN); // 太高 → 左右补白
    }
    // 短边不足 300 时整体放大（补边只会加大短边，所以放到最后判）
    const shortest = Math.min(canvasW, canvasH);
    if (shortest < PORTRAIT_EDGE_MIN) {
        const up = PORTRAIT_EDGE_MIN / shortest;
        canvasW = Math.ceil(canvasW * up);
        canvasH = Math.ceil(canvasH * up);
        w = Math.max(1, Math.round(w * up));
        h = Math.max(1, Math.round(h * up));
    }
    return {
        canvasW,
        canvasH,
        drawX: Math.round((canvasW - w) / 2),
        drawY: Math.round((canvasH - h) / 2),
        drawW: w,
        drawH: h,
        padded: canvasW !== w || canvasH !== h,
    };
}

// 入库前处理人设图：缩到长边 maxEdge 内、必要时留白补边把宽高比拉进火山区间、转 JPEG。
// 缩放是为了避免大图经慢链路被火山拉取超时；补边是为了长条三视图不被 AspectRatioTooLarge 拒掉。
export async function compressPortraitImage(dataUrl: string, maxEdge = 1536, quality = 0.85): Promise<string> {
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("图片解码失败"));
            image.src = dataUrl;
        });
        if (!img.width || !img.height) return dataUrl;
        const fit = fitPortraitCanvas(img.width, img.height, maxEdge);
        const canvas = document.createElement("canvas");
        canvas.width = fit.canvasW;
        canvas.height = fit.canvasH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return dataUrl;
        // 先铺白底：JPEG 没有透明通道，补出来的边必须有颜色；人设图基本都是白底，白边最不显眼。
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, fit.canvasW, fit.canvasH);
        ctx.drawImage(img, fit.drawX, fit.drawY, fit.drawW, fit.drawH);
        const out = canvas.toDataURL("image/jpeg", quality);
        // 补过边就必须用新图（原图比例不合规，回退等于必然被拒）；没补边时若压缩反而更大就用原图。
        if (fit.padded) return out;
        return out.length < dataUrl.length ? out : dataUrl;
    } catch {
        return dataUrl;
    }
}

// 计算图片内容的 SHA-256 指纹，用于按内容去重（同一张图只入库一次）。
export async function hashImageFile(file: File): Promise<string> {
    try {
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        return Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    } catch {
        return "";
    }
}

// 查询单条人像资产状态（后端会在 processing 时实时刷新一次）。
export async function getPortraitAsset(id: string) {
    const response = await axios.get<ApiEnvelope<PortraitAsset>>(`/api/portrait-assets/${encodeURIComponent(id)}`, { headers: authHeaders() });
    return unwrap(response.data, "查询人像资产失败");
}

// 列出当前用户的全部人像资产。
export async function listPortraitAssets() {
    const response = await axios.get<ApiEnvelope<PortraitAsset[]>>("/api/portrait-assets", { headers: authHeaders() });
    return unwrap(response.data, "获取人像资产列表失败");
}
