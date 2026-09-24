import type { ChatCompletionMessage } from "@/services/api/image";
import { buildImageReferencePromptText, imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";
import { getGenerationResourceNodes } from "../utils/canvas-resource-references";
import { computeDefaultNodeName } from "../utils/node-naming";

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

export type NodeGenerationInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    // 节点自定义命名（双击改名后写）：用于引用标签优先显示用户改过的名字，未改则回退默认「类型+序号」。
    name?: string;
    nameIsCustom?: boolean;
    nameSeq?: number;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

// 判断 prompt 是否带 @[node:] 引用 token。务必用「无 /g」的副本——带 /g 的正则有 lastIndex 状态，
// 复用会在偶数次调用时误判为不匹配（与 canvas-mention-composer 的 MENTION_TOKEN_PATTERN 注释同源）。
const HAS_MENTION_TOKEN = /@\[node:/;

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    // Config 节点保持原有 composerContent 行为；其余任意节点只要正文带 @[node:] token，
    // 就走 token 解析分支，让「正文 chip 顺序 = 实际发送参考集合 = 编号」三者同源（修编号不同步根因）。
    const useComposerContext = (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) || HAS_MENTION_TOKEN.test(prompt);
    if (useComposerContext) {
        return buildComposerGenerationContext(inputs, prompt);
    }

    const upstreamText = inputs
        .map((input) => input.text)
        .filter(Boolean)
        .join("\n\n");
    const referenceImages = inputs.filter((input) => Boolean(input.image)).map((input, index) => ({ ...(input.image as ReferenceImage), label: generationLabel("image", index) }));
    const referenceVideos = inputs.filter((input) => Boolean(input.video)).map((input, index) => ({ ...(input.video as ReferenceVideo), label: generationLabel("video", index) }));
    const referenceAudios = inputs.filter((input) => Boolean(input.audio)).map((input, index) => ({ ...(input.audio as ReferenceAudio), label: generationLabel("audio", index) }));

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string): NodeGenerationContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const referenceImages: ReferenceImage[] = [];
    const referenceVideos: ReferenceVideo[] = [];
    const referenceAudios: ReferenceAudio[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (input) {
            let label = labelByNodeId.get(input.nodeId);
            if (!label) {
                label = generationLabel(input.type, counts[input.type]);
                counts[input.type] += 1;
                labelByNodeId.set(input.nodeId, label);
                if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
                else if (input.image) referenceImages.push({ ...input.image, label });
                else if (input.video) referenceVideos.push({ ...input.video, label });
                else if (input.audio) referenceAudios.push({ ...input.audio, label });
            }
            nextPrompt += input.type === "text" ? `【${label}】` : label;
        }
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;

    if (!hasToken) {
        return {
            prompt,
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: textBlocks.length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
        const image = readReferenceImage(node);
        if (image) return [{ nodeId: node.id, type: "image" as const, title: node.title, name: node.name, nameIsCustom: node.nameIsCustom, nameSeq: node.nameSeq, image }];
        const video = readReferenceVideo(node);
        if (video) return [{ nodeId: node.id, type: "video" as const, title: node.title, name: node.name, nameIsCustom: node.nameIsCustom, nameSeq: node.nameSeq, video }];
        const audio = readReferenceAudio(node);
        if (audio) return [{ nodeId: node.id, type: "audio" as const, title: node.title, name: node.name, nameIsCustom: node.nameIsCustom, nameSeq: node.nameSeq, audio }];
        const text = readNodeTextInput(node);
        if (text) return [{ nodeId: node.id, type: "text" as const, title: node.title, name: node.name, nameIsCustom: node.nameIsCustom, nameSeq: node.nameSeq, text }];
        return [];
    });
}

// 找出「连线接入了、但提示词里没提到」的参考输入（生成前提醒用户是否忘了用）。
// 「提到」= 提示词含该节点的 @[node:id]、或它的参考标签（图片N/视频N/音频N/文本N）、或它的自定义名。
// 视频/图片节点会把接入参考自动全发给模型，但用户没在提示词里提到多半是忘了用 → 据此提醒。
export function findUnusedReferenceInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationInput[] {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    if (inputs.length === 0) return [];
    const counters = { image: 0, video: 0, audio: 0, text: 0 };
    const unused: NodeGenerationInput[] = [];
    for (const input of inputs) {
        const label = inputLabel(input);
        if (prompt.includes(`@[node:${input.nodeId}]`)) continue;
        if (label && prompt.includes(label)) continue;
        unused.push(input);
    }
    return unused;
}

export function buildNodeChatMessages(context: NodeGenerationContext): ChatCompletionMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: buildImageReferencePromptText(context.prompt, context.referenceImages) }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    // ⚠️ 覆写 dataUrl 之前先把原地址留在 sourceUrl 里。
    // 参考快照(metadata.references)是在本函数【之后】记录的，那时 dataUrl 已经是 base64，
    // 只有公网地址、没有 storageKey 的参考图会因此在快照里整条消失，
    // 导致该节点重试时报「参考图片已丢失」且永远无法恢复。
    // 命中条件是「参考图只有公网地址、没有 storageKey」，这类图相当常见；
    // 一旦快照写坏就只能靠这里留的 sourceUrl 兜底，事后没有任何办法补回来。
    return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, sourceUrl: image.sourceUrl || image.dataUrl, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

// 引用标签 = 节点显示名：改过名用自定义名，否则「类型前缀 + 稳定序号 nameSeq」。
// 与画布节点自身名字、界面引用 chip、发送给模型的提示词四处同一个名字，不随连线/@ 顺序变化。
function inputLabel(input: NodeGenerationInput): string {
    if (input.nameIsCustom && input.name && input.name.trim()) return input.name.trim();
    return computeDefaultNodeName(input.type, input.nameSeq);
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return seedanceReferenceLabel("video", index);
    if (type === "audio") return seedanceReferenceLabel("audio", index);
    return `文本${index + 1}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return null;
    // 已通过火山方舟人像资产认证（Active）的节点，生成时自动以 asset:// 引用，
    // 命中 resolveSeedanceImageUrl 的 asset:// 透传，做到「无感」使用。
    const assetUri = node.metadata.portraitAssetStatus === "active" ? node.metadata.portraitAssetUri : undefined;
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        url: assetUri || undefined,
        storageKey: node.metadata.storageKey,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    // 与图片同理：已通过火山素材授权(Active)的视频节点，生成时以 asset:// 引用。
    // 含真人的参考视频只有走 asset:// 才不会被 InputVideoSensitiveContentDetected 拒掉。
    const assetUri = node.metadata.portraitAssetStatus === "active" ? node.metadata.portraitAssetUri : undefined;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: assetUri || node.metadata.content,
        // 认证后 url 被换成火山的 asset://，素材本体地址单独带一份：非火山的模型不认 asset://，只能用它。
        sourceUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    // 音频【不】走 asset://：所有模型都不需要音频做素材授权，而 asset:// 是火山专有协议，
    // 一旦写进 url，非火山的模型就永远拿不到这段音频。
    // 存量已认证的音频节点（metadata 里还留着 portraitAssetUri）在这里一并回到真实地址。
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        sourceUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
        // bytes 供 seed-audio 的 10MB 参考上限预检用。不带它的话那条校验是死代码
        // （ReferenceAudio 上永远没有这个字段，警告一次都不会触发）。
        bytes: node.metadata.bytes,
    };
}
