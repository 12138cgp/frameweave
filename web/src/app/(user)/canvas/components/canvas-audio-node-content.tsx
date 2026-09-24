"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Music2, Pause, Play, Scissors, X } from "@/components/icons";

import { audioBufferToWavBlob, decodeAudioFromUrl, extractWaveformPeaks } from "@/lib/audio-utils";

const WAVE_BARS = 256;
const MIN_GAP = 0.05; // 选区最小时长（秒）
const HANDLE_HIT = 14; // 句柄命中宽度（px，仅用于命中判断）

// 模块级解码缓存：同一 src 的多个音频节点 / 重渲染复用，避免重复解码。
const DECODE_CACHE = new Map<string, { buffer: AudioBuffer; peaks: number[] }>();

export interface CanvasAudioNodeContentProps {
    src: string; // audio URL (node.metadata.content)
    title?: string; // node title
    durationMs?: number; // fallback duration in ms, shown before decode finishes; may be undefined
    colors: {
        fill: string; // node background
        text: string; // primary text color
        muted: string; // secondary text + UNSELECTED/unplayed waveform bars
        accent: string; // PLAYED waveform + SELECTED region + handles (brand cinnabar)
        border: string; // handle/confirm-bar borders
        panel: string; // confirm-bar background
    };
    trimming: boolean; // when true, render inline trim mode (handles + confirm bar)
    onTrimConfirm: (blob: Blob, durationMs: number) => void; // parent uploads the WAV + replaces node
    onTrimCancel: () => void; // parent exits trim mode
}

type DragMode = "start" | "end" | "region";

export function CanvasAudioNodeContent(props: CanvasAudioNodeContentProps): ReactNode {
    const { src, title, durationMs, colors, trimming, onTrimConfirm, onTrimCancel } = props;

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const waveWrapRef = useRef<HTMLDivElement | null>(null);
    const bufferRef = useRef<AudioBuffer | null>(null);
    const peaksRef = useRef<number[]>([]);
    const rafRef = useRef<number | null>(null);

    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [duration, setDuration] = useState<number>(durationMs ? durationMs / 1000 : 0);
    const [currentTime, setCurrentTime] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [waveSize, setWaveSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
    const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

    // 拖拽状态：用 ref 在 pointermove 中读取，避免闭包过期。
    const dragRef = useRef<{ mode: DragMode; rect: DOMRect; grabOffset: number } | null>(null);

    // ---- 解码（挂载 + src 变化），带缓存与竞态/卸载保护 ----
    useEffect(() => {
        if (!src) {
            setStatus("error");
            return;
        }
        let cancelled = false;

        const cached = DECODE_CACHE.get(src);
        if (cached) {
            bufferRef.current = cached.buffer;
            peaksRef.current = cached.peaks;
            setDuration(cached.buffer.duration);
            setStatus("ready");
            return;
        }

        setStatus("loading");
        bufferRef.current = null;
        peaksRef.current = [];
        decodeAudioFromUrl(src)
            .then((buffer) => {
                if (cancelled) return;
                const peaks = extractWaveformPeaks(buffer, WAVE_BARS);
                DECODE_CACHE.set(src, { buffer, peaks });
                bufferRef.current = buffer;
                peaksRef.current = peaks;
                setDuration(buffer.duration);
                setStatus("ready");
            })
            .catch(() => {
                if (cancelled) return;
                // 解码失败：降级为原生播放器（见渲染分支）。
                setStatus("error");
            });

        return () => {
            cancelled = true;
        };
    }, [src]);

    // ---- 进入裁切模式时初始化选区为 [0, duration]（false→true 翻转时重置）----
    useEffect(() => {
        if (trimming) {
            const total = bufferRef.current?.duration || duration || 0;
            setRange({ start: 0, end: total });
        }
        // 仅在 trimming 翻转时重置；duration 在 ready 后已稳定。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trimming]);

    // duration 在解码完成后才确定，若此时已在裁切模式且选区为空，则补一次初始化。
    useEffect(() => {
        if (trimming && duration > 0 && range.end <= 0) {
            setRange({ start: 0, end: duration });
        }
    }, [trimming, duration, range.end]);

    // ---- 容器尺寸（ResizeObserver）----
    useLayoutEffect(() => {
        const wrap = waveWrapRef.current;
        if (!wrap) return;
        const measure = () => {
            setWaveSize({ w: wrap.clientWidth, h: wrap.clientHeight });
        };
        measure();
        let ro: ResizeObserver | null = null;
        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver(() => measure());
            ro.observe(wrap);
        }
        return () => {
            ro?.disconnect();
        };
    }, [status]);

    // ---- 绘制波形 ----
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const peaks = peaksRef.current;
        const cssWidth = waveSize.w;
        const cssHeight = waveSize.h;
        if (cssWidth <= 0 || cssHeight <= 0) return;

        const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
        canvas.width = Math.max(1, Math.round(cssWidth * dpr));
        canvas.height = Math.max(1, Math.round(cssHeight * dpr));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        const mid = cssHeight / 2;
        const total = duration || 1;

        if (!peaks.length || status !== "ready") {
            // 解码中：扁平占位波形（居中细条）。
            const placeholderBars = 64;
            const barW = cssWidth / placeholderBars;
            ctx.fillStyle = withAlpha(colors.muted, 0.5);
            for (let i = 0; i < placeholderBars; i++) {
                const h = 2;
                ctx.fillRect(i * barW, mid - h / 2, Math.max(1, barW - 1), h);
            }
            return;
        }

        const barW = cssWidth / peaks.length;
        const playFrac = total > 0 ? currentTime / total : 0;

        for (let i = 0; i < peaks.length; i++) {
            const frac = i / peaks.length;
            const t = frac * total;
            const h = Math.max(1, peaks[i] * (cssHeight - 6));
            const x = i * barW;

            let color: string;
            if (trimming) {
                const inSel = t >= range.start && t <= range.end;
                color = inSel ? colors.accent : withAlpha(colors.muted, 0.4);
            } else {
                const played = frac <= playFrac;
                color = played ? colors.accent : colors.muted;
            }
            ctx.fillStyle = color;
            ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h);
        }

        // 非裁切模式：绘制播放头竖线。
        if (!trimming && playFrac > 0 && playFrac <= 1) {
            const px = playFrac * cssWidth;
            ctx.fillStyle = colors.accent;
            ctx.fillRect(Math.min(cssWidth - 1, px), 0, 1.5, cssHeight);
        }
    }, [status, waveSize, currentTime, duration, range, trimming, colors]);

    // ---- 播放 rAF：平滑更新播放头 ----
    const stopRaf = useCallback(() => {
        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (!playing) {
            stopRaf();
            return;
        }
        const tick = () => {
            const audio = audioRef.current;
            if (audio) setCurrentTime(audio.currentTime);
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => stopRaf();
    }, [playing, stopRaf]);

    // ---- 卸载清理 ----
    useEffect(() => {
        return () => {
            stopRaf();
            const audio = audioRef.current;
            if (audio) {
                try {
                    audio.pause();
                } catch {
                    /* noop */
                }
            }
        };
    }, [stopRaf]);

    const totalDuration = useMemo(() => {
        if (bufferRef.current?.duration) return bufferRef.current.duration;
        if (duration > 0) return duration;
        if (durationMs && durationMs > 0) return durationMs / 1000;
        const audio = audioRef.current;
        if (audio && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
        return 0;
    }, [duration, durationMs]);

    // ---- 播放控制 ----
    const togglePlay = useCallback(
        (event: ReactPointerEvent | React.MouseEvent) => {
            event.stopPropagation();
            const audio = audioRef.current;
            if (!audio) return;
            if (playing) {
                audio.pause();
                setPlaying(false);
            } else {
                void audio.play().catch(() => setPlaying(false));
                setPlaying(true);
            }
        },
        [playing],
    );

    const onAudioPause = useCallback(() => setPlaying(false), []);
    const onAudioEnded = useCallback(() => {
        setPlaying(false);
        setCurrentTime(0);
    }, []);
    const onAudioTimeUpdate = useCallback(() => {
        const audio = audioRef.current;
        if (audio && !playing) setCurrentTime(audio.currentTime);
    }, [playing]);

    // ---- 波形点击 seek（非裁切模式）----
    const handleWaveClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (trimming) return;
            event.stopPropagation();
            const wrap = waveWrapRef.current;
            const audio = audioRef.current;
            if (!wrap || !audio || totalDuration <= 0) return;
            const rect = wrap.getBoundingClientRect();
            if (rect.width <= 0) return;
            const frac = clamp((event.clientX - rect.left) / rect.width, 0, 1);
            const t = frac * totalDuration;
            try {
                audio.currentTime = t;
            } catch {
                /* noop */
            }
            setCurrentTime(t);
        },
        [trimming, totalDuration],
    );

    // ---- 裁切拖拽 ----
    const fracToTime = useCallback((frac: number) => clamp(frac, 0, 1) * (totalDuration || 0), [totalDuration]);

    const onHandlePointerDown = useCallback(
        (mode: DragMode) => (event: ReactPointerEvent<HTMLDivElement>) => {
            event.stopPropagation();
            event.preventDefault();
            const wrap = waveWrapRef.current;
            if (!wrap) return;
            const rect = wrap.getBoundingClientRect();
            if (rect.width <= 0) return;
            let grabOffset = 0;
            if (mode === "region" && totalDuration > 0) {
                // 记录指针相对选区起点的偏移，拖动时保持选区宽度。
                const pointerTime = clamp((event.clientX - rect.left) / rect.width, 0, 1) * totalDuration;
                grabOffset = pointerTime - range.start;
            }
            dragRef.current = { mode, rect, grabOffset };
            try {
                event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
                /* noop */
            }
        },
        [range.start, totalDuration],
    );

    const onHandlePointerMove = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const drag = dragRef.current;
            if (!drag) return;
            event.stopPropagation();
            const { rect } = drag;
            if (rect.width <= 0 || totalDuration <= 0) return;
            const t = clamp((event.clientX - rect.left) / rect.width, 0, 1) * totalDuration;

            setRange((prev) => {
                if (drag.mode === "start") {
                    return { start: clamp(t, 0, prev.end - MIN_GAP), end: prev.end };
                }
                if (drag.mode === "end") {
                    return { start: prev.start, end: clamp(t, prev.start + MIN_GAP, totalDuration) };
                }
                // region：整体平移，保持宽度。
                const width = prev.end - prev.start;
                let nextStart = t - drag.grabOffset;
                nextStart = clamp(nextStart, 0, totalDuration - width);
                return { start: nextStart, end: nextStart + width };
            });
        },
        [totalDuration],
    );

    const onHandlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        event.stopPropagation();
        dragRef.current = null;
        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            /* noop */
        }
    }, []);

    // ---- 生成 / 取消 ----
    const handleGenerate = useCallback(
        (event: ReactPointerEvent | React.MouseEvent) => {
            event.stopPropagation();
            const buffer = bufferRef.current;
            if (!buffer) return;
            try {
                const blob = audioBufferToWavBlob(buffer, range.start, range.end);
                onTrimConfirm(blob, Math.round((range.end - range.start) * 1000));
            } catch {
                /* 生成失败时静默；上层不感知，避免白屏 */
            }
        },
        [range.start, range.end, onTrimConfirm],
    );

    const handleCancel = useCallback(
        (event: ReactPointerEvent | React.MouseEvent) => {
            event.stopPropagation();
            onTrimCancel();
        },
        [onTrimCancel],
    );

    const stop = useCallback((event: ReactPointerEvent | React.MouseEvent) => event.stopPropagation(), []);

    // ===== 渲染：解码失败降级为原生播放器 =====
    if (status === "error") {
        return (
            <div
                data-canvas-no-zoom
                className="flex h-full w-full flex-col justify-center gap-3 px-4"
                style={{ background: colors.fill, color: colors.text }}
            >
                <div className="flex min-w-0 items-center gap-2 text-sm" style={{ color: colors.muted }}>
                    <Music2 className="size-4 shrink-0" />
                    <span className="truncate">{title || "音频"}</span>
                </div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={src} controls className="w-full" data-canvas-no-zoom />
                {trimming ? (
                    <span className="text-xs" style={{ color: colors.muted }}>
                        无法截取
                    </span>
                ) : null}
            </div>
        );
    }

    const selStart = range.start;
    const selEnd = range.end;
    const startFrac = totalDuration > 0 ? clamp(selStart / totalDuration, 0, 1) : 0;
    const endFrac = totalDuration > 0 ? clamp(selEnd / totalDuration, 0, 1) : 1;
    const selDurSec = Math.max(0, selEnd - selStart);

    return (
        <div
            data-canvas-no-zoom
            className="flex h-full w-full flex-col overflow-hidden"
            style={{ background: colors.fill, color: colors.text }}
        >
            {/* 隐藏的播放元素 */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio
                ref={audioRef}
                src={src}
                preload="metadata"
                className="hidden"
                onPause={onAudioPause}
                onEnded={onAudioEnded}
                onTimeUpdate={onAudioTimeUpdate}
            />

            {/* 标题行 */}
            <div className="flex min-w-0 items-center gap-2 px-3 pt-3 text-xs" style={{ color: colors.muted }}>
                <Music2 className="size-3.5 shrink-0" />
                <span className="truncate">{title || "音频"}</span>
            </div>

            {/* 波形区 */}
            <div className="relative min-h-0 flex-1 px-3 py-2">
                <div
                    ref={waveWrapRef}
                    className="relative h-full w-full"
                    style={{ cursor: trimming ? "default" : status === "ready" ? "pointer" : "default" }}
                    onClick={handleWaveClick}
                >
                    <canvas ref={canvasRef} className="block h-full w-full" />

                    {/* 裁切覆盖层 */}
                    {trimming && status === "ready" && totalDuration > 0 ? (
                        <div className="pointer-events-none absolute inset-0">
                            {/* 选区时长徽标 */}
                            <div
                                className="pointer-events-none absolute -top-0.5 z-20 -translate-x-1/2 rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
                                style={{
                                    left: `${((startFrac + endFrac) / 2) * 100}%`,
                                    background: colors.accent,
                                    color: colors.fill,
                                }}
                            >
                                {selDurSec.toFixed(2)}s
                            </div>

                            {/* 中间高亮区（可整体拖动） */}
                            <div
                                className="pointer-events-auto absolute top-0 bottom-0 cursor-grab"
                                style={{
                                    left: `${startFrac * 100}%`,
                                    width: `${Math.max(0, (endFrac - startFrac) * 100)}%`,
                                    background: withAlpha(colors.accent, 0.14),
                                    borderTop: `1px solid ${withAlpha(colors.accent, 0.5)}`,
                                    borderBottom: `1px solid ${withAlpha(colors.accent, 0.5)}`,
                                }}
                                onPointerDown={onHandlePointerDown("region")}
                                onPointerMove={onHandlePointerMove}
                                onPointerUp={onHandlePointerUp}
                                onPointerCancel={onHandlePointerUp}
                                onClick={stop}
                            />

                            {/* 左句柄 */}
                            <TrimHandle
                                side="left"
                                leftFrac={startFrac}
                                colors={colors}
                                onPointerDown={onHandlePointerDown("start")}
                                onPointerMove={onHandlePointerMove}
                                onPointerUp={onHandlePointerUp}
                                onClick={stop}
                            />
                            {/* 右句柄 */}
                            <TrimHandle
                                side="right"
                                leftFrac={endFrac}
                                colors={colors}
                                onPointerDown={onHandlePointerDown("end")}
                                onPointerMove={onHandlePointerMove}
                                onPointerUp={onHandlePointerUp}
                                onClick={stop}
                            />
                        </div>
                    ) : null}
                </div>
            </div>

            {/* 底部：裁切确认栏 或 播放/时间栏 */}
            {trimming ? (
                <div
                    className="flex items-center gap-2 px-2.5 py-2"
                    style={{ background: colors.panel, borderTop: `1px solid ${colors.border}` }}
                    onClick={stop}
                    onPointerDown={stop}
                >
                    <button
                        type="button"
                        aria-label="取消截取"
                        className="flex size-6 shrink-0 items-center justify-center rounded-md"
                        style={{ border: `1px solid ${colors.border}`, color: colors.text }}
                        onClick={handleCancel}
                        onPointerDown={stop}
                    >
                        <X className="size-3.5" />
                    </button>
                    <span className="flex shrink-0 items-center gap-1 text-xs" style={{ color: colors.muted }}>
                        <Scissors className="size-3" />
                        截取
                    </span>
                    <span className="min-w-0 flex-1 truncate text-center text-[11px] tabular-nums" style={{ color: colors.text }}>
                        {formatTime(selStart)} - {formatTime(selEnd)}
                    </span>
                    <button
                        type="button"
                        className="shrink-0 rounded-md px-3 py-1 text-xs font-medium"
                        style={{ background: colors.accent, color: colors.fill }}
                        onClick={handleGenerate}
                        onPointerDown={stop}
                    >
                        生成
                    </button>
                </div>
            ) : (
                <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-1">
                    <button
                        type="button"
                        aria-label={playing ? "暂停" : "播放"}
                        disabled={status !== "ready"}
                        className="flex size-8 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
                        style={{ background: colors.accent, color: colors.fill }}
                        onClick={togglePlay}
                        onPointerDown={stop}
                    >
                        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
                    </button>
                    <span className="text-xs tabular-nums" style={{ color: colors.muted }}>
                        {formatTime(currentTime)} / {formatTime(totalDuration)}
                    </span>
                </div>
            )}
        </div>
    );
}

export default CanvasAudioNodeContent;

// ---- 内部子组件：裁切句柄 ----
function TrimHandle({
    side,
    leftFrac,
    colors,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onClick,
}: {
    side: "left" | "right";
    leftFrac: number;
    colors: CanvasAudioNodeContentProps["colors"];
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onClick: (event: React.MouseEvent) => void;
}): ReactNode {
    return (
        <div
            className="pointer-events-auto absolute top-0 bottom-0 z-10 flex cursor-ew-resize items-center justify-center"
            style={{
                left: `${leftFrac * 100}%`,
                width: HANDLE_HIT,
                transform: side === "left" ? "translateX(-50%)" : "translateX(-50%)",
                touchAction: "none",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={onClick}
        >
            {/* 竖条 + 抓握感 */}
            <div
                className="flex h-full w-[3px] flex-col items-center justify-center rounded-full"
                style={{ background: colors.accent }}
            >
                <div className="flex flex-col gap-0.5">
                    <span className="block h-2 w-[1px] rounded-full" style={{ background: colors.fill, opacity: 0.7 }} />
                    <span className="block h-2 w-[1px] rounded-full" style={{ background: colors.fill, opacity: 0.7 }} />
                </div>
            </div>
        </div>
    );
}

// ---- 工具函数 ----
function clamp(value: number, min: number, max: number): number {
    if (max < min) return min;
    return value < min ? min : value > max ? max : value;
}

// mm:ss
function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// 给十六进制 / rgb 颜色叠加 alpha（用于半透明波形与高亮）。
function withAlpha(color: string, alpha: number): string {
    const a = clamp(alpha, 0, 1);
    const hex = color.trim();
    // #RGB / #RRGGBB
    const m3 = /^#([0-9a-fA-F]{3})$/.exec(hex);
    if (m3) {
        const r = parseInt(m3[1][0] + m3[1][0], 16);
        const g = parseInt(m3[1][1] + m3[1][1], 16);
        const b = parseInt(m3[1][2] + m3[1][2], 16);
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    const m6 = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (m6) {
        const r = parseInt(m6[1].slice(0, 2), 16);
        const g = parseInt(m6[1].slice(2, 4), 16);
        const b = parseInt(m6[1].slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    // rgb(...) → rgba(...)
    const mr = /^rgb\(([^)]+)\)$/.exec(hex);
    if (mr) return `rgba(${mr[1]}, ${a})`;
    // 已是 rgba 或其它格式：直接返回（无法可靠注入 alpha）。
    return hex;
}
