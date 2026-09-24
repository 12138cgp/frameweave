"use client";

// 节点尺寸统一规范：媒体节点固定高度，宽度按素材宽高比缩放。
export const STANDARD_NODE_HEIGHT = 360;
export const AUDIO_NODE_HEIGHT = 240;
export const STANDARD_NODE_MAX_WIDTH = 720;

export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

// 统一规范：固定高度（默认 360），宽度 = 高度 × 素材宽高比，但宽度封顶 720（超宽素材改为定宽 720、高按比例缩）。
// 缺宽高时回退为正方形。
export function standardMediaSize(naturalWidth?: number, naturalHeight?: number, targetHeight = STANDARD_NODE_HEIGHT, maxWidth = STANDARD_NODE_MAX_WIDTH) {
    const w = Math.max(1, naturalWidth || 0);
    const h = Math.max(1, naturalHeight || 0);
    const ratio = w / h;
    const width = targetHeight * ratio;
    if (width > maxWidth) return { width: maxWidth, height: Math.round(maxWidth / ratio) };
    return { width: Math.round(width), height: targetHeight };
}

/**
 * 按「比例字符串」算出媒体节点的**终态**尺寸——与出图/出片后 standardMediaSize 的结果逐像素一致。
 *
 * 为什么要有这个：空节点原先走 nodeSizeFromRatio，把比例塞进 NODE_DEFAULT_SIZE 那个盒子
 * （图片 340×240），而成品走 standardMediaSize（以 STANDARD_NODE_HEIGHT=360 为基准），
 * 于是每次生成完节点都要 resize 一下：1:1 从 240×240 跳到 360×360、16:9 从 340×191 跳到 640×360。
 * 占位一开始就按终态算，这个跳动就没了，网格间距也不用生成后重排。
 *
 * 认 "1024x1024" / "16:9" / "16×9" 三种写法；认不出来返回 null，由调用方退回默认尺寸。
 */
export function expectedMediaSizeFromRatio(size?: string) {
    const match = String(size || "").match(/(\d+)\s*[:x×]\s*(\d+)/i);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!(width > 0) || !(height > 0)) return null;
    return standardMediaSize(width, height);
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
}
