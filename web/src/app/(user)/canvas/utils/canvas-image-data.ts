"use client";

export type ImageCropRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type ImageAngleTransform = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

export type ImageUpscaleAlgorithm = "nearest" | "bilinear" | "high";

export const MAX_UPSCALE_LONG_EDGE = 4096;

export type ImageUpscaleParams = {
    targetLongEdge: number;
    algorithm: ImageUpscaleAlgorithm;
};

export type ImageSplitParams = {
    rows: number;
    columns: number;
};

export type ImageSplitPiece = {
    row: number;
    column: number;
    dataUrl: string;
};

export async function cropDataUrl(dataUrl: string, crop?: ImageCropRect) {
    const image = await loadImage(dataUrl);
    if (crop) {
        return drawCrop(image, Math.floor(crop.x * image.width), Math.floor(crop.y * image.height), Math.ceil(crop.width * image.width), Math.ceil(crop.height * image.height));
    }
    const size = Math.min(image.width, image.height);
    const sx = Math.max(0, Math.floor((image.width - size) / 2));
    const sy = Math.max(0, Math.floor((image.height - size) / 2));
    return drawCrop(image, sx, sy, size, size);
}

export async function splitDataUrl(dataUrl: string, params: ImageSplitParams): Promise<ImageSplitPiece[]> {
    const image = await loadImage(dataUrl);
    const rows = Math.max(1, Math.floor(params.rows));
    const columns = Math.max(1, Math.floor(params.columns));
    const pieces: ImageSplitPiece[] = [];

    for (let row = 0; row < rows; row += 1) {
        const sy = Math.floor((row * image.height) / rows);
        const sh = Math.floor(((row + 1) * image.height) / rows) - sy;
        for (let column = 0; column < columns; column += 1) {
            const sx = Math.floor((column * image.width) / columns);
            const sw = Math.floor(((column + 1) * image.width) / columns) - sx;
            pieces.push({ row, column, dataUrl: drawCrop(image, sx, sy, sw, sh) });
        }
    }

    return pieces;
}

export async function transformAngleDataUrl(dataUrl: string, params: ImageAngleTransform) {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    const padding = Math.round(Math.max(image.width, image.height) * 0.18);
    canvas.width = image.width + padding * 2;
    canvas.height = image.height + padding * 2;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const horizontal = params.horizontalAngle / 60;
    const pitch = params.pitchAngle / 45;
    const distanceScale = 1.12 - params.cameraDistance * 0.035;
    const wideScale = params.wideAngle ? 0.88 : 1;
    const scale = Math.max(0.64, Math.min(1.1, distanceScale * wideScale));
    const width = image.width * scale * (1 - Math.abs(horizontal) * 0.28);
    const height = image.height * scale * (1 - Math.abs(pitch) * 0.18);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const skewX = horizontal * image.width * 0.18;
    const skewY = pitch * image.height * 0.12;
    const x = cx - width / 2 + horizontal * padding * 0.5;
    const y = cy - height / 2 + pitch * padding * 0.45;

    context.save();
    context.setTransform(1, pitch * 0.08, horizontal * -0.1, 1, 0, 0);
    context.drawImage(image, x + skewX, y + skewY, width, height);
    context.restore();

    if (params.wideAngle) {
        const gradient = context.createRadialGradient(cx, cy, Math.min(canvas.width, canvas.height) * 0.2, cx, cy, Math.max(canvas.width, canvas.height) * 0.62);
        gradient.addColorStop(0, "rgba(255,255,255,0)");
        gradient.addColorStop(1, "rgba(0,0,0,0.18)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
    }

    return canvas.toDataURL("image/png");
}

export async function upscaleDataUrl(dataUrl: string, params: ImageUpscaleParams) {
    const image = await loadImage(dataUrl);
    const { width, height } = resolveUpscaleSize(image.width, image.height, params.targetLongEdge);
    return params.algorithm === "high" ? drawStepUpscale(image, width, height) : drawResize(image, image.width, image.height, width, height, params.algorithm);
}

export function resolveUpscaleSize(width: number, height: number, targetLongEdge: number) {
    const longEdge = Math.max(1, width, height);
    const target = Math.min(MAX_UPSCALE_LONG_EDGE, Math.max(1, Math.round(targetLongEdge)));
    const scale = target / longEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function drawCrop(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const context = canvas.getContext("2d");
    if (!context) return image.src;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

function drawStepUpscale(image: HTMLImageElement, width: number, height: number) {
    let source: CanvasImageSource = image;
    let sourceWidth = image.width;
    let sourceHeight = image.height;

    while (sourceWidth * 2 < width && sourceHeight * 2 < height) {
        const nextWidth = sourceWidth * 2;
        const nextHeight = sourceHeight * 2;
        const next = drawResizeCanvas(source, sourceWidth, sourceHeight, nextWidth, nextHeight, "high");
        source = next;
        sourceWidth = nextWidth;
        sourceHeight = nextHeight;
    }

    return drawResize(source, sourceWidth, sourceHeight, width, height, "high");
}

function drawResize(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    return drawResizeCanvas(source, sourceWidth, sourceHeight, width, height, algorithm).toDataURL("image/png");
}

function drawResizeCanvas(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    context.imageSmoothingEnabled = algorithm !== "nearest";
    context.imageSmoothingQuality = algorithm === "bilinear" ? "medium" : "high";
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
    return canvas;
}

function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = dataUrl;
    });
}

// 取中位数:对一组数排序后取中间值,偶数个时取中间两个的平均;空数组兜底为 0
function median(values: number[]) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// splitDataUrl 的逆操作:把 N 张图按行列网格拼回到一张画布上
// cells 为行优先 cells[row][col];非空项是已被调用方解析为同源 data:/blob: 的可绘制图片 URL,null 表示空槽(留透明)
export async function combineGridDataUrl(cells: (string | null)[][], opts?: { gap?: number; background?: string; maxLongEdge?: number }): Promise<string> {
    const gap = Math.max(0, Math.floor(opts?.gap ?? 0));
    const background = opts?.background;
    const maxLongEdge = Math.max(1, Math.floor(opts?.maxLongEdge ?? MAX_UPSCALE_LONG_EDGE));

    const rows = cells.length;
    const cols = cells.reduce((max, row) => Math.max(max, row.length), 0);

    // 并行加载所有非空单元格(调用方已对上游做节流,加载已解析的 data/blob URL 开销很低)
    const tasks: { row: number; column: number; promise: Promise<HTMLImageElement> }[] = [];
    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < cols; column += 1) {
            const url = cells[row]?.[column];
            if (url) tasks.push({ row, column, promise: loadImage(url) });
        }
    }
    const loaded = await Promise.all(tasks.map((task) => task.promise));
    if (loaded.length === 0) throw new Error("没有可拼合的图片");
    const images = new Map<string, HTMLImageElement>();
    tasks.forEach((task, index) => images.set(`${task.row}:${task.column}`, loaded[index]));

    // 目标单元格尺寸取所有已加载图片宽/高的中位数(用中位数而非最大值,避免某张超大重生成图把整张画布撑大)
    let targetW = Math.max(1, Math.round(median(loaded.map((image) => image.naturalWidth || image.width))));
    let targetH = Math.max(1, Math.round(median(loaded.map((image) => image.naturalHeight || image.height))));

    // 钳制:若临时画布长边超过 maxLongEdge,则按比例同时缩小 targetW/targetH 并向下取整,保证最终长边 ≤ maxLongEdge
    const provisionalLongEdge = Math.max(cols * targetW + Math.max(0, cols - 1) * gap, rows * targetH + Math.max(0, rows - 1) * gap);
    if (provisionalLongEdge > maxLongEdge) {
        const scale = maxLongEdge / provisionalLongEdge;
        targetW = Math.max(1, Math.floor(targetW * scale));
        targetH = Math.max(1, Math.floor(targetH * scale));
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, cols * targetW + Math.max(0, cols - 1) * gap);
    canvas.height = Math.max(1, rows * targetH + Math.max(0, rows - 1) * gap);
    const context = canvas.getContext("2d");
    if (!context) return canvas.toDataURL("image/png");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    // 指定背景色则先铺满整张画布;否则保持透明(PNG 保留 alpha)
    if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);
    }

    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < cols; column += 1) {
            const image = images.get(`${row}:${column}`);
            if (!image) continue;
            const dx = column * (targetW + gap);
            const dy = row * (targetH + gap);
            const imgW = image.naturalWidth || image.width;
            const imgH = image.naturalHeight || image.height;
            // COVER 居中裁剪:按较大缩放比铺满目标框,再从源图中心裁出对应区域
            const scale = Math.max(targetW / imgW, targetH / imgH);
            const sCropW = targetW / scale;
            const sCropH = targetH / scale;
            const sx = (imgW - sCropW) / 2;
            const sy = (imgH - sCropH) / 2;
            context.drawImage(image, sx, sy, sCropW, sCropH, dx, dy, targetW, targetH);
        }
    }

    return canvas.toDataURL("image/png");
}
