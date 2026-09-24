"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, RotateCcw, ShieldCheck, Square, Wrench, X } from "@/components/icons";
import { Switch, Tooltip } from "antd";

import type { AgentChatMessage } from "@/services/api/agent-chat";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

import type { CanvasAssistantReference } from "../types";
import { MAX_ROUNDS, runAgentTurn, type AgentEvent, type ConfirmRequest } from "./agent-loop";
import { findAgentTool } from "./agent-tools";
import { journalTouched, undoJournal, type AgentCanvasApi, type AgentJournal } from "./agent-ops";

// 画布助手的对话界面。
//
// 第一阶段只做「排版」：能读选区/视口、能移动/改尺寸/连线/断线/选中/移视角/建文本节点，
// **不能生成任何东西、不能删除任何东西**。所以这里不需要点数预估、不需要模型选择器。
//
// 用户选定的模型：deepseek-v4-flash-260425（火山方舟）。
// 实测它的 function calling 流式分片正常，一次就把 3×2 预览墙算对了。

const AGENT_MODEL = "deepseek-v4-flash-260425";

// canvasThemes 是 { light, dark } 两个字面量对象，取值类型是二者的联合。
// 写成 canvasThemes["light"] 会漏掉 dark，传参时报 TS2322（工具栏那边就是这么错的）。
type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type Bubble =
    | { kind: "user"; id: string; text: string }
    | { kind: "assistant"; id: string; text: string }
    | { kind: "tool"; id: string; name: string; label: string; state: "running" | "ok" | "fail" | "rejected"; summary: string }
    | { kind: "note"; id: string; text: string };

let seq = 0;
function nextId() {
    seq += 1;
    return "b" + String(seq);
}

export function CanvasAgentView({ api, selectedRefs = [] }: { api: AgentCanvasApi; selectedRefs?: CanvasAssistantReference[] }) {
    const theme = canvasThemes[useThemeStore((s) => s.theme)];
    const effectiveConfig = useEffectiveConfig();
    const [bubbles, setBubbles] = useState<Bubble[]>([]);
    const [history, setHistory] = useState<AgentChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [running, setRunning] = useState(false);
    const [confirmWrites, setConfirmWrites] = useState(true);
    const [pending, setPending] = useState<ConfirmRequest | null>(null);
    const [journal, setJournal] = useState<AgentJournal | null>(null);
    const [rounds, setRounds] = useState(0);
    const resolveRef = useRef<((ok: boolean) => void) | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [bubbles, pending]);

    const push = useCallback((b: Bubble) => setBubbles((prev) => [...prev, b]), []);

    const handleEvent = useCallback(
        (event: AgentEvent) => {
            if (event.kind === "round") {
                setRounds(event.index);
                return;
            }
            if (event.kind === "assistant-delta") {
                setBubbles((prev) => {
                    const last = prev[prev.length - 1];
                    if (last && last.kind === "assistant") {
                        const copy = prev.slice(0, -1);
                        copy.push({ ...last, text: last.text + event.text });
                        return copy;
                    }
                    return [...prev, { kind: "assistant", id: nextId(), text: event.text }];
                });
                return;
            }
            if (event.kind === "tool-start") {
                push({ kind: "tool", id: event.callId, name: event.name, label: event.label, state: "running", summary: "" });
                return;
            }
            if (event.kind === "tool-done") {
                setBubbles((prev) =>
                    prev.map((b) => {
                        if (b.kind !== "tool" || b.id !== event.callId) return b;
                        return { ...b, state: event.ok ? "ok" : "fail", summary: event.summary };
                    }),
                );
                return;
            }
            if (event.kind === "tool-rejected") {
                setBubbles((prev) =>
                    prev.map((b) => {
                        if (b.kind !== "tool" || b.id !== event.callId) return b;
                        return { ...b, state: "rejected", summary: "已拒绝" };
                    }),
                );
                return;
            }
            if (event.kind === "error") {
                push({ kind: "note", id: nextId(), text: event.message });
            }
        },
        [push],
    );

    const askConfirm = useCallback((req: ConfirmRequest) => {
        setPending(req);
        return new Promise<boolean>((resolve) => {
            resolveRef.current = (ok: boolean) => {
                setPending(null);
                resolveRef.current = null;
                resolve(ok);
            };
        });
    }, []);

    const send = useCallback(async () => {
        const text = input.trim();
        if (!text || running) return;
        setInput("");
        push({ kind: "user", id: nextId(), text });
        setRunning(true);
        setRounds(0);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const result = await runAgentTurn({
                config: { ...effectiveConfig, textModel: AGENT_MODEL, model: AGENT_MODEL },
                api,
                userText: text,
                history,
                confirmWrites,
                onConfirm: askConfirm,
                onEvent: handleEvent,
                signal: controller.signal,
            });
            setHistory((prev) => [...prev, ...result.appended]);
            if (journalTouched(result.journal)) setJournal(result.journal);
            if (result.stoppedBy === "aborted") push({ kind: "note", id: nextId(), text: "已中断" });
        } catch (error) {
            const message = error instanceof Error ? error.message : "助手出错了";
            push({ kind: "note", id: nextId(), text: message });
        } finally {
            setRunning(false);
            abortRef.current = null;
            if (resolveRef.current) resolveRef.current(false);
        }
    }, [api, askConfirm, confirmWrites, effectiveConfig, handleEvent, history, input, push, running]);

    const stop = useCallback(() => {
        const controller = abortRef.current;
        if (controller) controller.abort();
        if (resolveRef.current) resolveRef.current(false);
    }, []);

    const undo = useCallback(() => {
        if (!journal) return;
        undoJournal(journal, api);
        setJournal(null);
        push({ kind: "note", id: nextId(), text: "已撤销助手这次的改动" });
    }, [api, journal, push]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* 顶部：确认开关 + 撤销 */}
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: theme.node.stroke }}>
                <Tooltip title="关掉之后，移动/连线这类改画布的操作就不再逐条问你了。读取类操作本来就不问。">
                    <div className="flex items-center gap-1.5 text-[12px]" style={{ color: theme.node.text }}>
                        <ShieldCheck className="size-3.5" />
                        <span>改动前确认</span>
                        <Switch size="small" checked={confirmWrites} onChange={setConfirmWrites} disabled={running} />
                    </div>
                </Tooltip>
                {journal ? (
                    <button
                        type="button"
                        onClick={undo}
                        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                    >
                        <RotateCcw className="size-3.5" />
                        撤销这次操作
                    </button>
                ) : null}
            </div>

            {/* 对话区 */}
            <div ref={listRef} className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-auto p-3">
                {bubbles.length === 0 ? (
                    <div className="space-y-2 rounded-xl border p-3 text-[12px] leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                        <div className="font-medium">我可以帮你整理画布</div>
                        <div className="opacity-70">比如：选中几张图后说「排成 3 行 2 列，间距 40」，或者「把这些按类型分开摆」「把它们都连到那个视频节点」。</div>
                        <div className="opacity-70">当前版本只会排版和连线，**不会生成图片视频，也不会删东西**。</div>
                    </div>
                ) : null}
                {bubbles.map((b) => (
                    <BubbleRow key={b.id} bubble={b} theme={theme} />
                ))}
                {pending ? <ConfirmCard req={pending} theme={theme} onAnswer={(ok) => resolveRef.current?.(ok)} /> : null}
            </div>

            {/* 输入区 */}
            <div className="border-t p-2" style={{ borderColor: theme.node.stroke }}>
                {selectedRefs.length ? (
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] opacity-55" style={{ color: theme.node.text }}>
                            已选中 {selectedRefs.length} 个
                        </span>
                        {selectedRefs.slice(0, 10).map((ref, index) => (
                            <Tooltip key={ref.id} title={ref.title || ref.id}>
                                <div
                                    className="relative size-9 shrink-0 overflow-hidden rounded-md border"
                                    style={{ borderColor: theme.node.stroke, background: theme.node.fill }}
                                >
                                    {ref.dataUrl ? (
                                        <img src={ref.dataUrl} alt="" className="size-full object-cover" />
                                    ) : (
                                        <span className="flex size-full items-center justify-center text-[9px] opacity-60" style={{ color: theme.node.text }}>
                                            {ref.type}
                                        </span>
                                    )}
                                    <span className="absolute left-0 top-0 rounded-br bg-black/55 px-1 text-[9px] leading-[13px] text-white">{index + 1}</span>
                                </div>
                            </Tooltip>
                        ))}
                        {selectedRefs.length > 10 ? (
                            <span className="text-[11px] opacity-55" style={{ color: theme.node.text }}>
                                +{selectedRefs.length - 10}
                            </span>
                        ) : null}
                    </div>
                ) : null}
                {running ? (
                    <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] opacity-60" style={{ color: theme.node.text }}>
                        <LoaderCircle className="size-3 animate-spin" />
                        <span>第 {rounds} / {MAX_ROUNDS} 轮</span>
                    </div>
                ) : null}
                <div className="flex items-end gap-1.5">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key !== "Enter" || e.shiftKey) return;
                            e.preventDefault();
                            void send();
                        }}
                        rows={2}
                        placeholder="让我帮你排版，比如「把选中的排成 3 列」"
                        className="thin-scrollbar min-h-[46px] flex-1 resize-none rounded-xl border bg-transparent px-2.5 py-2 text-[13px] outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    />
                    {running ? (
                        <button type="button" onClick={stop} className="flex size-9 items-center justify-center rounded-full bg-[#DC2626] text-white transition hover:opacity-90">
                            <Square className="size-4" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => void send()}
                            disabled={!input.trim()}
                            className="flex size-9 items-center justify-center rounded-full transition disabled:opacity-35"
                            style={{ background: theme.node.text, color: theme.canvas.background }}
                        >
                            <ArrowUp className="size-4" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function BubbleRow({ bubble, theme }: { bubble: Bubble; theme: CanvasTheme }) {
    if (bubble.kind === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[86%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[13px] leading-6" style={{ background: theme.node.text, color: theme.canvas.background }}>
                    {bubble.text}
                </div>
            </div>
        );
    }
    if (bubble.kind === "assistant") {
        return (
            <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl border px-3 py-2 text-[13px] leading-6" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                {bubble.text}
            </div>
        );
    }
    if (bubble.kind === "note") {
        return (
            <div className="px-1 text-[12px] leading-5 opacity-60" style={{ color: theme.node.text }}>
                {bubble.text}
            </div>
        );
    }
    let icon = <LoaderCircle className="size-3.5 animate-spin" />;
    let tint = "opacity-70";
    if (bubble.state === "ok") {
        icon = <Check className="size-3.5" />;
        tint = "";
    }
    if (bubble.state === "fail" || bubble.state === "rejected") {
        icon = <X className="size-3.5" />;
        tint = "text-[#DC2626] dark:text-[#EF4444]";
    }
    return (
        <div className={"flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] " + tint} style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <Wrench className="size-3.5 opacity-60" />
            <span className="flex-1">{bubble.label}</span>
            {icon}
            {bubble.summary && bubble.state !== "ok" ? <span className="opacity-70">{bubble.summary}</span> : null}
        </div>
    );
}

function ConfirmCard({ req, theme, onAnswer }: { req: ConfirmRequest; theme: CanvasTheme; onAnswer: (ok: boolean) => void }) {
    // 花钱的操作卡片要长得不一样——用户得一眼看出这一步要扣点，而不是跟「移动节点」混在一起。
    const isMoney = findAgentTool(req.name)?.tier === "money";
    return (
        <div className="rounded-xl border-2 p-3" style={{ borderColor: theme.canvas.selectionStroke, background: theme.canvas.selectionFill }}>
            <div className="mb-2 text-[13px] font-medium" style={{ color: theme.node.text }}>
                {req.label}
            </div>
            <div className="mb-2.5 text-[11px] opacity-70" style={{ color: theme.node.text }}>
                {isMoney ? "⚡ 这一步会真的调用模型、消耗你的点数。确认后才会执行。" : "助手要改动画布，确认后才会执行。"}
            </div>
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={() => onAnswer(true)}
                    className="flex-1 rounded-lg px-3 py-1.5 text-[13px] font-medium transition hover:opacity-90"
                    style={isMoney ? { background: "#DC2626", color: "#fff" } : { background: theme.node.text, color: theme.canvas.background }}
                >
                    {isMoney ? "确认花点数生成" : "批准"}
                </button>
                <button
                    type="button"
                    onClick={() => onAnswer(false)}
                    className="flex-1 rounded-lg border px-3 py-1.5 text-[13px] transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                >
                    拒绝
                </button>
            </div>
        </div>
    );
}
