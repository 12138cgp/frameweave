"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Modal, Slider, Switch } from "antd";
import { ArrowUpRight, Circle, MousePointer2, Square, Trash2, Type, X } from "@/components/icons";
import { nanoid } from "nanoid";

import { readImageMeta } from "@/lib/image-utils";

export type CanvasImageAnnotatePayload = {
    dataUrl: string;
};

// 标注类型（坐标统一存「图片像素空间」，与展示缩放无关，保证导出 1:1 清晰）
type TextAnnotation = {
    id: string;
    kind: "text";
    color: string;
    x: number;
    y: number;
    text: string;
    fontSize: number;
    bold: boolean;
    background: boolean;
};

type ShapeAnnotation = {
    id: string;
    kind: "rect" | "ellipse";
    color: string;
    x: number;
    y: number;
    w: number;
    h: number;
    strokeWidth: number;
};

type ArrowAnnotation = {
    id: string;
    kind: "arrow";
    color: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    strokeWidth: number;
};

type Annotation = TextAnnotation | ShapeAnnotation | ArrowAnnotation;

type ToolId = "select" | "text" | "rect" | "ellipse" | "arrow";

type DragState =
    | { mode: "none" }
    | { mode: "move"; id: string; start: Point; original: Annotation }
    | { mode: "resize"; id: string; handle: HandleId; original: Annotation }
    | { mode: "draw"; id: string; start: Point };

type Point = { x: number; y: number };
type HandleId = "nw" | "ne" | "sw" | "se" | "p1" | "p2";

const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif";

// 预设颜色（覆盖常用标注色）
const PRESET_COLORS = ["#EF4444", "#FF9500", "#FFD60A", "#34C759", "#2563EB", "#AF52DE", "#FFFFFF", "#1C1C1E"];

const HANDLE_SCREEN_SIZE = 10; // 选中手柄在屏幕上的边长（px）
const HIT_TOLERANCE_SCREEN = 8; // 命中容差（屏幕 px）
const SELECTION_COLOR = "#2563EB";

export function CanvasNodeAnnotateDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageAnnotatePayload) => void }) {
    const imgRef = useRef<HTMLImageElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const dragRef = useRef<DragState>({ mode: "none" });

    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [annotations, setAnnotations] = useState<Annotation[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [tool, setTool] = useState<ToolId>("select");
    const [displayScale, setDisplayScale] = useState(1);
    const [defaults, setDefaults] = useState({ color: "#EF4444", bold: true, background: false });
    const [busy, setBusy] = useState(false);
    // 底图 <img> 像素是否已就绪（onLoad）。canvas 直接画底图需等它加载完，故用它触发重绘。
    const [imgReady, setImgReady] = useState(false);

    // 打开 / 切换图片时重置全部编辑状态
    useEffect(() => {
        if (!open) return;
        setAnnotations([]);
        setSelectedId(null);
        setEditingId(null);
        setTool("select");
        setBusy(false);
        setImgReady(false);
        dragRef.current = { mode: "none" };
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    // 监听画布的显示尺寸，换算图片像素 → 屏幕像素的缩放比（手柄大小、在位编辑框定位用）
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !image) return;
        const update = () => {
            const rect = canvas.getBoundingClientRect();
            if (rect.width > 0) setDisplayScale(rect.width / Math.max(1, canvas.width));
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [image]);

    // 任意状态变化后重绘画布（底图 + 标注 + 选中高亮手柄）。canvas 自己画底图、作为唯一可见层，
    // 避免「编辑态底层 <img> 被合成/重绘弄没」这类分层可见性问题；每次按键重绘都会重画底图，图恒在。
    useEffect(() => {
        // 正在文字在位编辑时不画选中框(否则空文字的选中虚线框会和 textarea 编辑框重叠成「多一个框」)。
        renderScene(canvasRef.current, imgRef.current, annotations, editingId ? null : selectedId, displayScale);
    }, [annotations, selectedId, editingId, displayScale, image, imgReady]);

    // 进入文字编辑：聚焦在位编辑框并选中文本
    useEffect(() => {
        if (!editingId) return;
        const node = editorRef.current;
        if (node) {
            node.focus();
            node.select();
        }
    }, [editingId]);

    const selected = annotations.find((item) => item.id === selectedId) || null;
    const editingText = editingId ? (annotations.find((item) => item.id === editingId) as TextAnnotation | undefined) || null : null;

    const updateAnnotation = (id: string, patch: Partial<Annotation>) => {
        setAnnotations((prev) => prev.map((item) => (item.id === id ? ({ ...item, ...patch } as Annotation) : item)));
    };

    const removeAnnotation = (id: string) => {
        setAnnotations((prev) => prev.filter((item) => item.id !== id));
        setSelectedId((current) => (current === id ? null : current));
        setEditingId((current) => (current === id ? null : current));
    };

    // 应用样式：有选中则改选中项，否则改「新建默认样式」
    const applyColor = (color: string) => {
        if (selected) updateAnnotation(selected.id, { color });
        else setDefaults((prev) => ({ ...prev, color }));
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!image) return;
        event.preventDefault();
        event.stopPropagation();
        // 正在文字编辑时，画布上任意点击先结束编辑、不触发其它动作
        if (editingId) {
            finishEditing();
            return;
        }
        const point = canvasPoint(event.currentTarget, event.clientX, event.clientY);
        const tolerance = HIT_TOLERANCE_SCREEN / Math.max(0.0001, displayScale);

        if (tool === "text") {
            const fontSize = defaultFontSize(image.height);
            const node: TextAnnotation = { id: nanoid(), kind: "text", color: defaults.color, x: point.x, y: point.y, text: "", fontSize, bold: defaults.bold, background: defaults.background };
            setAnnotations((prev) => [...prev, node]);
            setSelectedId(node.id);
            setEditingId(node.id);
            setTool("select");
            return;
        }

        if (tool === "rect" || tool === "ellipse" || tool === "arrow") {
            const node = createShapeStart(tool, point, defaults.color, image.height);
            setAnnotations((prev) => [...prev, node]);
            setSelectedId(node.id);
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { mode: "draw", id: node.id, start: point };
            return;
        }

        // select 模式：先判选中项的手柄（缩放），再判命中（移动），都没有则取消选中
        if (selected) {
            const handle = hitHandle(selected, point, tolerance, displayScale);
            if (handle) {
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = { mode: "resize", id: selected.id, handle, original: cloneAnnotation(selected) };
                return;
            }
        }
        const hit = hitTest(annotations, point, tolerance);
        if (hit) {
            setSelectedId(hit.id);
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { mode: "move", id: hit.id, start: point, original: cloneAnnotation(hit) };
            return;
        }
        setSelectedId(null);
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const state = dragRef.current;
        if (state.mode === "none" || !image) return;
        event.preventDefault();
        const point = canvasPoint(event.currentTarget, event.clientX, event.clientY);

        if (state.mode === "draw") {
            updateAnnotation(state.id, drawUpdate(state.id, state.start, point, annotations));
            return;
        }
        if (state.mode === "move") {
            updateAnnotation(state.id, moveUpdate(state.original, state.start, point));
            return;
        }
        if (state.mode === "resize") {
            updateAnnotation(state.id, resizeUpdate(state.original, state.handle, point));
        }
    };

    const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const state = dragRef.current;
        dragRef.current = { mode: "none" };
        if (state.mode === "draw") {
            // 点击未拖动 → 给形状一个默认尺寸，方便直接看到
            setAnnotations((prev) => prev.map((item) => (item.id === state.id ? ensureMinSize(item, image) : item)));
            setTool("select");
        }
        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            // 忽略未捕获指针的释放
        }
    };

    const finishEditing = () => {
        const id = editingId;
        setEditingId(null);
        if (!id) return;
        // 退出编辑时若文字为空则删除该标注
        setAnnotations((prev) => prev.filter((item) => item.kind !== "text" || item.id !== id || item.text.trim().length > 0));
    };

    const submit = async () => {
        if (!image || busy) return;
        finishEditing();
        setBusy(true);
        try {
            const result = await exportAnnotated(dataUrl, imgRef.current, annotations);
            onConfirm({ dataUrl: result });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1080} centered destroyOnHidden>
            <div className="grid gap-5 lg:grid-cols-[minmax(360px,1fr)_300px]">
                <div className="flex min-h-[360px] items-center justify-center rounded-xl border bg-black/5 p-0">
                    <div ref={wrapperRef} className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img ref={imgRef} src={dataUrl} alt="" className="block max-h-[68vh] max-w-full bg-transparent" draggable={false} onLoad={() => setImgReady(true)} />
                        {image ? (
                            <canvas
                                ref={canvasRef}
                                width={image.width}
                                height={image.height}
                                className={tool === "select" ? "absolute inset-0 h-full w-full cursor-default touch-none" : "absolute inset-0 h-full w-full cursor-crosshair touch-none"}
                                onPointerDown={handlePointerDown}
                                onPointerMove={handlePointerMove}
                                onPointerUp={handlePointerUp}
                                onPointerCancel={handlePointerUp}
                            />
                        ) : null}
                        {editingText ? (
                            <textarea
                                ref={editorRef}
                                value={editingText.text}
                                onChange={(event) => updateAnnotation(editingText.id, { text: event.target.value })}
                                onBlur={finishEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") finishEditing();
                                }}
                                spellCheck={false}
                                className="absolute z-10 m-0 resize-none overflow-hidden whitespace-pre rounded-sm border border-dashed border-[#2563EB] bg-transparent p-0 leading-tight caret-[#2563EB] outline-none"
                                style={editorStyle(editingText, displayScale)}
                            />
                        ) : null}
                    </div>
                </div>

                <div className="flex min-h-[360px] flex-col gap-4">
                    <div>
                        <h2 className="font-heading text-xl font-medium tracking-wide">文字标注</h2>
                        <div className="mt-1 text-sm opacity-60">{image ? `${image.width} × ${image.height}px` : "读取中"}</div>
                    </div>

                    <div className="grid grid-cols-5 gap-1.5">
                        <ToolButton active={tool === "select"} label="选择" onClick={() => setTool("select")} icon={<MousePointer2 className="size-5" />} />
                        <ToolButton active={tool === "text"} label="文字" onClick={() => setTool("text")} icon={<Type className="size-5" />} />
                        <ToolButton active={tool === "rect"} label="方框" onClick={() => setTool("rect")} icon={<Square className="size-5" />} />
                        <ToolButton active={tool === "ellipse"} label="圆圈" onClick={() => setTool("ellipse")} icon={<Circle className="size-5" />} />
                        <ToolButton active={tool === "arrow"} label="箭头" onClick={() => setTool("arrow")} icon={<ArrowUpRight className="size-5" />} />
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">颜色</div>
                        <div className="flex flex-wrap gap-1.5">
                            {PRESET_COLORS.map((color) => (
                                <ColorSwatch key={color} color={color} active={activeColor(selected, defaults) === color} onClick={() => applyColor(color)} />
                            ))}
                            <ColorPicker value={activeColor(selected, defaults)} onChange={applyColor} />
                        </div>
                    </div>

                    {renderProperties({ selected, defaults, setDefaults, updateAnnotation, removeAnnotation, image })}

                    <div className="mt-auto space-y-2 pt-2">
                        <div className="text-xs leading-relaxed opacity-55">{toolHint(tool)}</div>
                        <div className="flex items-center justify-between gap-2">
                            <Button onClick={() => setAnnotations([])} disabled={annotations.length === 0}>
                                清空
                            </Button>
                            <div className="flex items-center gap-2">
                                <Button icon={<X className="size-4" />} onClick={onClose}>
                                    取消
                                </Button>
                                <Button type="primary" loading={busy} onClick={() => void submit()} disabled={annotations.length === 0}>
                                    生成标注图
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function ToolButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
    return (
        <Button type={active ? "primary" : "default"} onClick={onClick} className="flex h-auto flex-col items-center gap-0.5 py-1.5" title={label}>
            {icon}
            <span className="text-[11px]">{label}</span>
        </Button>
    );
}

function ColorSwatch({ color, active, onClick }: { color: string; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={active ? "size-7 rounded-full ring-2 ring-[#2563EB] ring-offset-1" : "size-7 rounded-full ring-1 ring-black/15"}
            style={{ background: color }}
            title={color}
        />
    );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
    return (
        <label className="flex size-7 cursor-pointer items-center justify-center rounded-full ring-1 ring-black/15" title="自定义颜色" style={{ background: value }}>
            <input type="color" value={value} onChange={(event) => onChange(event.target.value)} className="size-0 opacity-0" />
        </label>
    );
}

// 选中文字 / 形状时的专属样式控件；无选中时编辑「新建默认」
function renderProperties(props: {
    selected: Annotation | null;
    defaults: { color: string; bold: boolean; background: boolean };
    setDefaults: React.Dispatch<React.SetStateAction<{ color: string; bold: boolean; background: boolean }>>;
    updateAnnotation: (id: string, patch: Partial<Annotation>) => void;
    removeAnnotation: (id: string) => void;
    image: { width: number; height: number } | null;
}) {
    const { selected, defaults, setDefaults, updateAnnotation, removeAnnotation } = props;

    if (selected && selected.kind === "text") {
        const node = selected;
        return (
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                        <span className="font-medium opacity-75">字号</span>
                        <span className="font-semibold">{Math.round(node.fontSize)}px</span>
                    </div>
                    <Slider min={12} max={Math.max(48, Math.round((props.image?.height || 1024) * 0.3))} step={1} value={Math.round(node.fontSize)} onChange={(value) => updateAnnotation(node.id, { fontSize: value })} />
                </div>
                <div className="flex items-center justify-between text-sm">
                    <span className="font-medium opacity-75">加粗</span>
                    <Switch checked={node.bold} onChange={(checked) => updateAnnotation(node.id, { bold: checked })} />
                </div>
                <div className="flex items-center justify-between text-sm">
                    <span className="font-medium opacity-75">底色衬底</span>
                    <Switch checked={node.background} onChange={(checked) => updateAnnotation(node.id, { background: checked })} />
                </div>
                <Button danger block icon={<Trash2 className="size-4" />} onClick={() => removeAnnotation(node.id)}>
                    删除此标注
                </Button>
            </div>
        );
    }

    if (selected && (selected.kind === "rect" || selected.kind === "ellipse" || selected.kind === "arrow")) {
        const node = selected;
        return (
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                        <span className="font-medium opacity-75">线宽</span>
                        <span className="font-semibold">{Math.round(node.strokeWidth)}px</span>
                    </div>
                    <Slider min={1} max={Math.max(12, Math.round((props.image?.height || 1024) * 0.04))} step={1} value={Math.round(node.strokeWidth)} onChange={(value) => updateAnnotation(node.id, { strokeWidth: value })} />
                </div>
                <Button danger block icon={<Trash2 className="size-4" />} onClick={() => removeAnnotation(node.id)}>
                    删除此标注
                </Button>
            </div>
        );
    }

    // 无选中：编辑新建文字的默认样式
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
                <span className="font-medium opacity-75">新文字加粗</span>
                <Switch checked={defaults.bold} onChange={(checked) => setDefaults((prev) => ({ ...prev, bold: checked }))} />
            </div>
            <div className="flex items-center justify-between text-sm">
                <span className="font-medium opacity-75">新文字底色</span>
                <Switch checked={defaults.background} onChange={(checked) => setDefaults((prev) => ({ ...prev, background: checked }))} />
            </div>
        </div>
    );
}

function toolHint(tool: ToolId) {
    if (tool === "select") return "点选标注后可拖拽移动、拖角缩放、改样式；双击空白处选不中即取消选中。";
    if (tool === "text") return "在图上点击放置文字，随即输入内容；按 Esc 或点别处完成。";
    if (tool === "arrow") return "在图上按住拖动画箭头：起点拖到要指向的位置。";
    return "在图上按住拖动画出形状；松手后自动切回选择，可继续调整。";
}

function activeColor(selected: Annotation | null, defaults: { color: string }) {
    if (selected) return selected.color;
    return defaults.color;
}

// ===== 几何 / 命中 =====

function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): Point {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function cloneAnnotation(node: Annotation): Annotation {
    return { ...node };
}

function defaultFontSize(height: number) {
    return Math.max(20, Math.round(height * 0.06));
}

function defaultStroke(height: number) {
    return Math.max(3, Math.round(height * 0.006));
}

function createShapeStart(kind: "rect" | "ellipse" | "arrow", point: Point, color: string, height: number): Annotation {
    const strokeWidth = defaultStroke(height);
    if (kind === "arrow") {
        return { id: nanoid(), kind, color, strokeWidth, x1: point.x, y1: point.y, x2: point.x, y2: point.y };
    }
    return { id: nanoid(), kind, color, strokeWidth, x: point.x, y: point.y, w: 0, h: 0 };
}

function drawUpdate(_id: string, start: Point, point: Point, annotations: Annotation[]): Partial<Annotation> {
    const node = annotations.find((item) => item.id === _id);
    if (node && node.kind === "arrow") return { x2: point.x, y2: point.y };
    return { x: start.x, y: start.y, w: point.x - start.x, h: point.y - start.y };
}

function moveUpdate(original: Annotation, start: Point, point: Point): Partial<Annotation> {
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    if (original.kind === "arrow") return { x1: original.x1 + dx, y1: original.y1 + dy, x2: original.x2 + dx, y2: original.y2 + dy };
    if (original.kind === "text") return { x: original.x + dx, y: original.y + dy };
    return { x: original.x + dx, y: original.y + dy };
}

function resizeUpdate(original: Annotation, handle: HandleId, point: Point): Partial<Annotation> {
    if (original.kind === "arrow") {
        if (handle === "p1") return { x1: point.x, y1: point.y };
        return { x2: point.x, y2: point.y };
    }
    if (original.kind === "rect" || original.kind === "ellipse") {
        const bounds = shapeBounds(original);
        let left = bounds.l;
        let top = bounds.t;
        let right = bounds.r;
        let bottom = bounds.b;
        if (handle === "nw") {
            left = point.x;
            top = point.y;
        } else if (handle === "ne") {
            right = point.x;
            top = point.y;
        } else if (handle === "sw") {
            left = point.x;
            bottom = point.y;
        } else if (handle === "se") {
            right = point.x;
            bottom = point.y;
        }
        return { x: left, y: top, w: right - left, h: bottom - top };
    }
    return {};
}

function ensureMinSize(node: Annotation, image: { width: number; height: number } | null): Annotation {
    if (!image) return node;
    if (node.kind === "arrow") {
        if (Math.abs(node.x2 - node.x1) + Math.abs(node.y2 - node.y1) > 6) return node;
        return { ...node, x2: node.x1 + Math.round(image.width * 0.18), y2: node.y1 };
    }
    if (node.kind === "rect" || node.kind === "ellipse") {
        if (Math.abs(node.w) > 6 && Math.abs(node.h) > 6) return normalizeShape(node);
        const w = Math.round(image.width * 0.24);
        const h = Math.round(image.height * 0.18);
        return { ...node, x: node.x - w / 2, y: node.y - h / 2, w, h };
    }
    return node;
}

function normalizeShape(node: ShapeAnnotation): ShapeAnnotation {
    const bounds = shapeBounds(node);
    return { ...node, x: bounds.l, y: bounds.t, w: bounds.w, h: bounds.h };
}

function shapeBounds(node: ShapeAnnotation) {
    const l = Math.min(node.x, node.x + node.w);
    const t = Math.min(node.y, node.y + node.h);
    const r = Math.max(node.x, node.x + node.w);
    const b = Math.max(node.y, node.y + node.h);
    return { l, t, r, b, w: r - l, h: b - t };
}

// 文字按换行拆行（空串返回空数组）。独立纯函数，避开 bun SSG 对「语句级 const 三元」的 codegen 坑。
function textLines(text: string) {
    if (text.length > 0) return text.split("\n");
    return [];
}

// 文字包围盒（用离屏 ctx 量测，缺省时按字号估算）
function textBounds(node: TextAnnotation) {
    const lines = textLines(node.text);
    const lineCount = Math.max(1, lines.length);
    const lineHeight = node.fontSize * 1.3;
    const ctx = measureContext();
    let width = node.fontSize * 2;
    if (ctx) {
        ctx.font = fontString(node.fontSize, node.bold);
        for (const line of lines) {
            const measured = ctx.measureText(line || " ").width;
            if (measured > width) width = measured;
        }
    }
    const padding = node.background ? node.fontSize * 0.3 : node.fontSize * 0.1;
    return { l: node.x - padding, t: node.y - padding, w: width + padding * 2, h: lineCount * lineHeight + padding * 2 };
}

function hitTest(annotations: Annotation[], point: Point, tolerance: number): Annotation | null {
    // 自顶向下（后绘制的在上层）取第一个命中
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
        const node = annotations[index];
        if (node.kind === "text") {
            const box = textBounds(node);
            if (point.x >= box.l && point.x <= box.l + box.w && point.y >= box.t && point.y <= box.t + box.h) return node;
        } else if (node.kind === "rect" || node.kind === "ellipse") {
            const bounds = shapeBounds(node);
            if (point.x >= bounds.l - tolerance && point.x <= bounds.r + tolerance && point.y >= bounds.t - tolerance && point.y <= bounds.b + tolerance) return node;
        } else if (node.kind === "arrow") {
            if (pointToSegment(point, { x: node.x1, y: node.y1 }, { x: node.x2, y: node.y2 }) <= tolerance + node.strokeWidth) return node;
        }
    }
    return null;
}

function hitHandle(node: Annotation, point: Point, tolerance: number, scale: number): HandleId | null {
    const radius = Math.max(tolerance, HANDLE_SCREEN_SIZE / Math.max(0.0001, scale));
    const handles = handlePoints(node);
    for (const handle of handles) {
        if (Math.abs(point.x - handle.x) <= radius && Math.abs(point.y - handle.y) <= radius) return handle.id;
    }
    return null;
}

function handlePoints(node: Annotation): { id: HandleId; x: number; y: number }[] {
    if (node.kind === "arrow") {
        return [
            { id: "p1", x: node.x1, y: node.y1 },
            { id: "p2", x: node.x2, y: node.y2 },
        ];
    }
    if (node.kind === "rect" || node.kind === "ellipse") {
        const bounds = shapeBounds(node);
        return [
            { id: "nw", x: bounds.l, y: bounds.t },
            { id: "ne", x: bounds.r, y: bounds.t },
            { id: "sw", x: bounds.l, y: bounds.b },
            { id: "se", x: bounds.r, y: bounds.b },
        ];
    }
    return [];
}

function pointToSegment(p: Point, a: Point, b: Point) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ===== 渲染 =====

function fontString(fontSize: number, bold: boolean) {
    if (bold) return `700 ${fontSize}px ${FONT_FAMILY}`;
    return `400 ${fontSize}px ${FONT_FAMILY}`;
}

let sharedMeasureContext: CanvasRenderingContext2D | null = null;
function measureContext() {
    if (sharedMeasureContext) return sharedMeasureContext;
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    sharedMeasureContext = canvas.getContext("2d");
    return sharedMeasureContext;
}

// 3 位十六进制颜色展开成 6 位（#f00 → ff0000）。独立纯函数，避开 bun SSG 三元 codegen 坑。
function expandHex(value: string) {
    if (value.length === 3) return value.split("").map((c) => c + c).join("");
    return value;
}

// 相对亮度 → 给文字配反差描边/衬底，保证任意底图都清晰
function relativeLuminance(hex: string) {
    const full = expandHex(hex.replace("#", ""));
    const r = parseInt(full.slice(0, 2), 16) / 255;
    const g = parseInt(full.slice(2, 4), 16) / 255;
    const b = parseInt(full.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastInk(hex: string) {
    if (relativeLuminance(hex) > 0.6) return "rgba(0,0,0,0.85)";
    return "rgba(255,255,255,0.92)";
}

function plateColor(hex: string) {
    if (relativeLuminance(hex) > 0.6) return "rgba(0,0,0,0.55)";
    return "rgba(255,255,255,0.82)";
}

function drawAnnotation(ctx: CanvasRenderingContext2D, node: Annotation) {
    ctx.save();
    if (node.kind === "rect") {
        const bounds = shapeBounds(node);
        ctx.strokeStyle = node.color;
        ctx.lineWidth = node.strokeWidth;
        ctx.lineJoin = "round";
        ctx.strokeRect(bounds.l, bounds.t, bounds.w, bounds.h);
    } else if (node.kind === "ellipse") {
        const bounds = shapeBounds(node);
        ctx.strokeStyle = node.color;
        ctx.lineWidth = node.strokeWidth;
        ctx.beginPath();
        ctx.ellipse(bounds.l + bounds.w / 2, bounds.t + bounds.h / 2, Math.max(1, bounds.w / 2), Math.max(1, bounds.h / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
    } else if (node.kind === "arrow") {
        drawArrow(ctx, node);
    } else if (node.kind === "text") {
        drawText(ctx, node);
    }
    ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, node: ArrowAnnotation) {
    const angle = Math.atan2(node.y2 - node.y1, node.x2 - node.x1);
    const head = Math.max(12, node.strokeWidth * 4.2);
    // 箭杆收短到箭头根部，避免线头穿出三角
    const baseX = node.x2 - Math.cos(angle) * head * 0.82;
    const baseY = node.y2 - Math.sin(angle) * head * 0.82;
    ctx.strokeStyle = node.color;
    ctx.fillStyle = node.color;
    ctx.lineWidth = node.strokeWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(node.x1, node.y1);
    ctx.lineTo(baseX, baseY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(node.x2, node.y2);
    ctx.lineTo(node.x2 - Math.cos(angle - Math.PI / 7) * head, node.y2 - Math.sin(angle - Math.PI / 7) * head);
    ctx.lineTo(node.x2 - Math.cos(angle + Math.PI / 7) * head, node.y2 - Math.sin(angle + Math.PI / 7) * head);
    ctx.closePath();
    ctx.fill();
}

function drawText(ctx: CanvasRenderingContext2D, node: TextAnnotation) {
    const lines = textLines(node.text);
    if (lines.length === 0) return;
    const lineHeight = node.fontSize * 1.3;
    ctx.font = fontString(node.fontSize, node.bold);
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    if (node.background) {
        const box = textBounds(node);
        ctx.fillStyle = plateColor(node.color);
        const radius = Math.min(box.h, box.w) * 0.12;
        roundRectPath(ctx, box.l, box.t, box.w, box.h, radius);
        ctx.fill();
    }

    for (let index = 0; index < lines.length; index += 1) {
        const y = node.y + index * lineHeight;
        if (!node.background) {
            ctx.lineWidth = Math.max(2, node.fontSize * 0.14);
            ctx.strokeStyle = contrastInk(node.color);
            ctx.lineJoin = "round";
            ctx.strokeText(lines[index], node.x, y);
        }
        ctx.fillStyle = node.color;
        ctx.fillText(lines[index], node.x, y);
    }
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

function renderScene(canvas: HTMLCanvasElement | null, baseImg: HTMLImageElement | null, annotations: Annotation[], selectedId: string | null, scale: number) {
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // canvas 作为唯一可见层先画底图（铺满 backing store=原图分辨率），再叠标注；底图未就绪则留空、由 onLoad 触发重绘。
    if (baseImg && baseImg.complete && (baseImg.naturalWidth || baseImg.width) > 0) {
        ctx.drawImage(baseImg, 0, 0, canvas.width, canvas.height);
    }
    for (const node of annotations) drawAnnotation(ctx, node);
    const selected = annotations.find((item) => item.id === selectedId);
    if (selected) drawSelectionChrome(ctx, selected, scale);
}

function drawSelectionChrome(ctx: CanvasRenderingContext2D, node: Annotation, scale: number) {
    const lineWidth = Math.max(1, 1.5 / Math.max(0.0001, scale));
    const handleSize = HANDLE_SCREEN_SIZE / Math.max(0.0001, scale);
    ctx.save();
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([handleSize, handleSize * 0.6]);
    if (node.kind === "text") {
        const box = textBounds(node);
        ctx.strokeRect(box.l, box.t, box.w, box.h);
    } else if (node.kind === "rect" || node.kind === "ellipse") {
        const bounds = shapeBounds(node);
        ctx.strokeRect(bounds.l, bounds.t, bounds.w, bounds.h);
    } else if (node.kind === "arrow") {
        ctx.beginPath();
        ctx.moveTo(node.x1, node.y1);
        ctx.lineTo(node.x2, node.y2);
        ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffffff";
    for (const handle of handlePoints(node)) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.lineWidth = lineWidth;
        ctx.strokeRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
    }
    ctx.restore();
}

// 在位文字编辑框的样式（屏幕坐标 = 图片坐标 × 显示缩放）
function editorStyle(node: TextAnnotation, scale: number): React.CSSProperties {
    // 高度随行数自适应:否则 textarea 默认约 2 行高、再换行就溢出重叠。与 drawText 的多行 lineHeight 1.3 一致,+2px 容 dashed 边框。
    const lines = Math.max(1, node.text.split("\n").length);
    return {
        left: node.x * scale,
        top: node.y * scale,
        minWidth: node.fontSize * scale * 2,
        height: Math.ceil(lines * node.fontSize * scale * 1.3) + 2,
        color: node.color,
        fontFamily: FONT_FAMILY,
        fontSize: node.fontSize * scale,
        fontWeight: node.bold ? 700 : 400,
        lineHeight: 1.3,
    };
}

// ===== 导出合成 =====

function loadImageEl(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = src;
    });
}

async function exportAnnotated(dataUrl: string, existing: HTMLImageElement | null, annotations: Annotation[]): Promise<string> {
    let base = existing;
    if (!base || !base.complete || base.naturalWidth === 0) base = await loadImageEl(dataUrl);
    const width = base.naturalWidth || base.width;
    const height = base.naturalHeight || base.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    for (const node of annotations) drawAnnotation(ctx, node);
    return canvas.toDataURL("image/png");
}
