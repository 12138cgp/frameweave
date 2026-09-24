"use client";

import { useRef, type ChangeEvent, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Slider } from "antd";
import { Camera, ScanLine, Upload, X } from "@/components/icons";

import { ModelPicker } from "@/components/model-picker";
import { type AiConfig } from "@/stores/use-config-store";
import { type RoomSceneState, type RoomPlan, type RoomCamera, type RoomItem, DEFAULT_ROOM_CAMERA } from "../utils/canvas-room-scene";

// SVG 视图尺寸与边距：房间归一化坐标 0..1 映射到这块内绘图区
const VIEW_W = 600;
const VIEW_H = 400;
const PAD = 40;
const PLOT_W = VIEW_W - PAD * 2;
const PLOT_H = VIEW_H - PAD * 2;

// 主色 / 深色系
const INK = "#0f172a";
const INK_SOFT = "#475569";
const ACCENT = "#2563EB";
const WINDOW_COLOR = "#3a6ea5";
const PAPER = "#f8fafc";

type DragKind = "position" | "heading";

export function CanvasRoomSceneDialog({ open, scene, config, generatingPlan, generatingAngle, onChange, onGeneratePlan, onGenerateAngle, onUploadRoomImage, onMissingConfig, onClose }: {
    open: boolean;
    scene: RoomSceneState;
    config: AiConfig;
    generatingPlan: boolean;
    generatingAngle: boolean;
    onChange: (scene: RoomSceneState) => void;
    onGeneratePlan: (prompt: string) => void;
    onGenerateAngle: (scene: RoomSceneState, planSnapshotDataUrl: string) => void;
    onUploadRoomImage: (file: File) => Promise<{ url: string; storageKey?: string } | null>;
    onMissingConfig?: () => void;
    onClose: () => void;
}): JSX.Element {
    const svgRef = useRef<SVGSVGElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const plan = scene.plan;
    const camera = scene.camera ?? DEFAULT_ROOM_CAMERA;

    // 选取房间参考照片 → 上传 → 写回 scene.refImageUrl / refImageStorageKey
    const handlePickRoomImage = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = ""; // 允许重复选同一文件
        if (!file) return;
        const r = await onUploadRoomImage(file);
        if (r) onChange({ ...scene, refImageUrl: r.url, refImageStorageKey: r.storageKey });
    };

    // 归一化坐标 → SVG 像素
    const toPx = (nx: number, ny: number): { x: number; y: number } => ({ x: PAD + nx * PLOT_W, y: PAD + ny * PLOT_H });
    // SVG 像素 → 归一化坐标（clamp 0..1）
    const toNorm = (px: number, py: number): { x: number; y: number } => ({
        x: clamp((px - PAD) / PLOT_W, 0, 1),
        y: clamp((py - PAD) / PLOT_H, 0, 1),
    });

    // 鼠标客户端坐标 → SVG 用户坐标（考虑 viewBox 缩放）
    const clientToSvg = (clientX: number, clientY: number): { x: number; y: number } | null => {
        const svg = svgRef.current;
        if (!svg) return null;
        const box = svg.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null;
        return {
            x: ((clientX - box.left) / box.width) * VIEW_W,
            y: ((clientY - box.top) / box.height) * VIEW_H,
        };
    };

    // 拖拽：相机位置 / 朝向把手（参照 crop-dialog 的 startDrag 思路）
    const startDrag = (kind: DragKind, event: ReactPointerEvent) => {
        if (!plan) return;
        event.preventDefault();
        event.stopPropagation();
        const move = (ev: PointerEvent) => {
            const svgPoint = clientToSvg(ev.clientX, ev.clientY);
            if (!svgPoint) return;
            if (kind === "position") {
                const norm = toNorm(svgPoint.x, svgPoint.y);
                onChange({ ...scene, camera: { ...camera, x: norm.x, y: norm.y } });
            } else {
                // 用相机点 → 鼠标的向量算角度，换算成「0=朝上、顺时针为正」
                const center = toPx(camera.x, camera.y);
                const angle = vectorToAngle(svgPoint.x - center.x, svgPoint.y - center.y);
                onChange({ ...scene, camera: { ...camera, angle } });
            }
        };
        const up = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
    };

    const handleGenerateAngle = async () => {
        const svg = svgRef.current;
        if (!plan || !svg) return;
        try {
            // 当前 SVG（含相机标记）序列化成 PNG dataURL
            const dataUrl = await svgToPngDataUrl(svg, VIEW_W, VIEW_H);
            onGenerateAngle(scene, dataUrl);
        } catch {
            // 截图失败则不触发出图
        }
    };

    return (
        <Modal title={<span className="font-heading font-medium tracking-wide">场景机位</span>} open={open} onCancel={onClose} footer={null} width={760} centered destroyOnHidden>
            <div className="space-y-4">
                {/* 顶部：房间描述 + 生成平面图 */}
                <div className="flex items-start gap-2">
                    <Input.TextArea
                        value={scene.prompt}
                        onChange={(event) => onChange({ ...scene, prompt: event.target.value })}
                        placeholder="描述房间，如「12㎡卧室，南墙一扇窗，东墙门，靠北放双人床，西墙书桌」"
                        autoSize={{ minRows: 2, maxRows: 4 }}
                        className="flex-1"
                    />
                    <Button type="primary" icon={<ScanLine className="size-4" />} loading={generatingPlan} disabled={generatingPlan || (!scene.prompt.trim() && !scene.refImageUrl)} onClick={() => onGeneratePlan(scene.prompt)}>
                        生成平面图
                    </Button>
                </div>

                {/* 房间参考照片上传（可选）：传图则据照片 + 描述生成平面图 */}
                <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handlePickRoomImage(event)} />
                    {scene.refImageUrl ? (
                        <div className="relative size-24 shrink-0 overflow-hidden rounded-lg border">
                            <img src={scene.refImageUrl} alt="房间参考照片" className="size-full object-cover" />
                            <button
                                type="button"
                                aria-label="移除房间照片"
                                className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75"
                                onClick={() => onChange({ ...scene, refImageUrl: undefined, refImageStorageKey: undefined })}
                            >
                                <X className="size-3" />
                            </button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            className="flex size-24 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--color-border,#cbd5e1)] text-center text-xs opacity-70 transition-colors hover:border-[#2563EB] hover:text-[#2563EB] hover:opacity-100"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <Upload className="size-4" />
                            <span>上传房间照片</span>
                            <span>（可选）</span>
                        </button>
                    )}
                    <p className="min-w-[180px] flex-1 text-xs leading-relaxed opacity-70">
                        可选：上传房间照片，将据照片 + 描述生成平面图；不传则仅按文字描述生成。
                    </p>
                </div>

                {/* 出图模型选择 */}
                <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2">
                    <span className="font-heading text-sm opacity-80">出图模型</span>
                    <ModelPicker config={config} value={scene.imageModel || config.imageModel} onChange={(model) => onChange({ ...scene, imageModel: model })} capability="image" onMissingConfig={onMissingConfig} />
                </div>

                {/* 中部：SVG 平面图编辑器 */}
                <div className="flex justify-center rounded-xl border bg-[var(--color-card,#fff)] p-2">
                    {plan ? (
                        <svg
                            ref={svgRef}
                            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                            className="block h-auto w-full max-w-full select-none"
                            style={{ touchAction: "none" }}
                            xmlns="http://www.w3.org/2000/svg"
                        >
                            <RoomPlanGraphics plan={plan} />
                            <CameraMarker camera={camera} toPx={toPx} onDragPosition={(e) => startDrag("position", e)} onDragHeading={(e) => startDrag("heading", e)} />
                        </svg>
                    ) : (
                        <div className="flex h-[260px] w-full items-center justify-center text-sm opacity-60">
                            先填房间描述并点「生成平面图」
                        </div>
                    )}
                </div>

                {/* 底部：视野角滑块 + 出图 / 关闭 */}
                <div className="flex flex-wrap items-center gap-4 rounded-xl border px-4 py-2">
                    <span className="text-sm opacity-80">视野角</span>
                    <div className="min-w-[180px] flex-1">
                        <Slider min={30} max={120} value={camera.fov} disabled={!plan} onChange={(value) => onChange({ ...scene, camera: { ...camera, fov: value } })} />
                    </div>
                    <span className="w-12 text-right text-sm tabular-nums opacity-80">{camera.fov}°</span>
                </div>

                <div className="flex items-center justify-end gap-2">
                    <Button icon={<Camera className="size-4" />} type="primary" loading={generatingAngle} disabled={!plan || generatingAngle} onClick={() => void handleGenerateAngle()}>
                        生成此机位角度
                    </Button>
                    <Button icon={<X className="size-4" />} onClick={onClose}>
                        关闭
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

// 房间边框（墙）、门窗开口、家具
function RoomPlanGraphics({ plan }: { plan: RoomPlan }): JSX.Element {
    const left = PAD;
    const top = PAD;
    const right = PAD + PLOT_W;
    const bottom = PAD + PLOT_H;
    return (
        <g>
            {/* 房间底纸 */}
            <rect x={left} y={top} width={PLOT_W} height={PLOT_H} fill={PAPER} stroke={INK} strokeWidth={4} rx={4} />

            {/* 开口（门 / 窗）画在对应墙上 */}
            {plan.openings.map((opening) => (
                <OpeningGraphic key={opening.id} opening={opening} left={left} top={top} right={right} bottom={bottom} />
            ))}

            {/* 家具 */}
            {plan.items.map((item) => (
                <ItemGraphic key={item.id} item={item} />
            ))}
        </g>
    );
}

// 单个开口：依据 wall + pos + len 在对应边定位
function OpeningGraphic({ opening, left, top, right, bottom }: { opening: RoomPlan["openings"][number]; left: number; top: number; right: number; bottom: number }): JSX.Element {
    const isWindow = opening.kind === "window";
    const color = isWindow ? WINDOW_COLOR : ACCENT;
    // 沿墙起止比例
    const s = clamp(opening.pos, 0, 1);
    const e = clamp(opening.pos + opening.len, 0, 1);

    // 计算开口两端点（沿墙方向）
    let p1: { x: number; y: number };
    let p2: { x: number; y: number };
    let normal: { x: number; y: number }; // 指向房间内侧的单位法向
    if (opening.wall === "top") {
        p1 = { x: left + s * PLOT_W, y: top };
        p2 = { x: left + e * PLOT_W, y: top };
        normal = { x: 0, y: 1 };
    } else if (opening.wall === "bottom") {
        p1 = { x: left + s * PLOT_W, y: bottom };
        p2 = { x: left + e * PLOT_W, y: bottom };
        normal = { x: 0, y: -1 };
    } else if (opening.wall === "left") {
        p1 = { x: left, y: top + s * PLOT_H };
        p2 = { x: left, y: top + e * PLOT_H };
        normal = { x: 1, y: 0 };
    } else {
        p1 = { x: right, y: top + s * PLOT_H };
        p2 = { x: right, y: top + e * PLOT_H };
        normal = { x: -1, y: 0 };
    }

    if (isWindow) {
        // 窗：墙上一段双线（沿墙的内外两条平行线）
        const off = 3;
        return (
            <g>
                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={PAPER} strokeWidth={6} />
                <line x1={p1.x - normal.x * off} y1={p1.y - normal.y * off} x2={p2.x - normal.x * off} y2={p2.y - normal.y * off} stroke={color} strokeWidth={1.5} />
                <line x1={p1.x + normal.x * off} y1={p1.y + normal.y * off} x2={p2.x + normal.x * off} y2={p2.y + normal.y * off} stroke={color} strokeWidth={1.5} />
            </g>
        );
    }

    // 门：墙上缺口 + 一段开门弧线（从一端向内侧扫出）
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const hinge = p1;
    const swingEnd = { x: hinge.x + normal.x * len, y: hinge.y + normal.y * len };
    const arc = `M ${p2.x} ${p2.y} A ${len} ${len} 0 0 1 ${swingEnd.x} ${swingEnd.y}`;
    return (
        <g>
            {/* 缺口：用底纸色盖掉墙体 */}
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={PAPER} strokeWidth={6} />
            {/* 门扇 */}
            <line x1={hinge.x} y1={hinge.y} x2={swingEnd.x} y2={swingEnd.y} stroke={color} strokeWidth={2} />
            {/* 开门弧 */}
            <path d={arc} fill="none" stroke={color} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
        </g>
    );
}

// 单个家具：圆角矩形 + 居中 label
function ItemGraphic({ item }: { item: RoomItem }): JSX.Element {
    const x = PAD + item.x * PLOT_W;
    const y = PAD + item.y * PLOT_H;
    const w = item.w * PLOT_W;
    const h = item.h * PLOT_H;
    return (
        <g>
            <rect x={x} y={y} width={w} height={h} rx={6} fill="#fff" stroke={INK_SOFT} strokeWidth={1.5} />
            <text x={x + w / 2} y={y + h / 2} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={INK} style={{ pointerEvents: "none" }}>
                {item.label}
            </text>
        </g>
    );
}

// 相机标记：圆点 + 视野锥 + 朝向把手
function CameraMarker({ camera, toPx, onDragPosition, onDragHeading }: {
    camera: RoomCamera;
    toPx: (nx: number, ny: number) => { x: number; y: number };
    onDragPosition: (event: ReactPointerEvent) => void;
    onDragHeading: (event: ReactPointerEvent) => void;
}): JSX.Element {
    const center = toPx(camera.x, camera.y);
    const coneLen = 90;
    // 朝向中心向量（angle: 0=朝上、顺时针正）
    const dir = angleToVector(camera.angle);
    const leftDir = angleToVector(camera.angle - camera.fov / 2);
    const rightDir = angleToVector(camera.angle + camera.fov / 2);
    const apex = center;
    const pL = { x: apex.x + leftDir.x * coneLen, y: apex.y + leftDir.y * coneLen };
    const pR = { x: apex.x + rightDir.x * coneLen, y: apex.y + rightDir.y * coneLen };
    const handle = { x: apex.x + dir.x * (coneLen + 18), y: apex.y + dir.y * (coneLen + 18) };
    return (
        <g>
            {/* 视野锥 */}
            <path d={`M ${apex.x} ${apex.y} L ${pL.x} ${pL.y} L ${pR.x} ${pR.y} Z`} fill={ACCENT} fillOpacity={0.14} stroke={ACCENT} strokeWidth={1} strokeOpacity={0.5} />
            {/* 朝向中线 */}
            <line x1={apex.x} y1={apex.y} x2={handle.x} y2={handle.y} stroke={ACCENT} strokeWidth={1.5} strokeDasharray="4 3" />
            {/* 朝向把手 */}
            <circle cx={handle.x} cy={handle.y} r={7} fill="#fff" stroke={ACCENT} strokeWidth={2} style={{ cursor: "grab" }} onPointerDown={onDragHeading} />
            {/* 相机圆点 */}
            <circle cx={center.x} cy={center.y} r={9} fill={ACCENT} stroke="#fff" strokeWidth={2.5} style={{ cursor: "move" }} onPointerDown={onDragPosition} />
        </g>
    );
}

// angle（0=朝上、顺时针正，度）→ SVG 单位向量（y 向下）
function angleToVector(angleDeg: number): { x: number; y: number } {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: Math.sin(rad), y: -Math.cos(rad) };
}

// SVG 向量（y 向下）→ angle（0=朝上、顺时针正，度，0..360）
function vectorToAngle(dx: number, dy: number): number {
    // 朝上为 -y，顺时针正 → atan2(dx, -dy)
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
}

// SVG → PNG dataURL（自包含 SVG，无外部图，不会 CORS 污染）
async function svgToPngDataUrl(svgEl: SVGSVGElement, width: number, height: number): Promise<string> {
    const serialized = new XMLSerializer().serializeToString(svgEl);
    const svgUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(serialized);
    return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) return reject(new Error("no ctx"));
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, width, height); // 白底
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("svg render failed"));
        img.src = svgUrl;
    });
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
