"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent, MutableRefObject, PointerEvent } from "react";
import { Image } from "antd";
import { FileText, Image as ImageIcon, Music2, Video } from "@/components/icons";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

// @[node:id] 原子引用 token；与 canvas-config-composer 的 CONFIG_REFERENCE_PATTERN 同源，外部判断
// 「是否含 token」时务必用无 /g 的 /@\[node:/.test()，带 /g 的正则有 lastIndex 状态会误判。
export const MENTION_TOKEN_PATTERN = /@\[node:([^\]]+)\]/g;

export type ComposerItem = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    label: string;
    title: string;
    text?: string;
    previewUrl?: string;
};

type CanvasMentionComposerProps = {
    value: string;
    items: ComposerItem[];
    onChange: (value: string) => void;
    onSubmit?: () => void;
    placeholder?: string;
    className?: string;
    style?: CSSProperties;
};

type Token = { type: "text"; value: string } | { type: "reference"; nodeId: string };

type MentionState = {
    query: string;
    left: number;
    top: number;
};

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

export function CanvasMentionComposer({ value, items, onChange, onSubmit, placeholder, className, style }: CanvasMentionComposerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    // 自身上一次序列化得到的值：仅当外部 value 与之不同（外部改了）或编辑器未聚焦时才重建 DOM，
    // 避免用户输入过程中（onChange → 外部回传同一个 value）重建导致光标跳。
    const lastSerializedRef = useRef<string | null>(null);
    // 正在被拖动的引用 chip（dragstart 记下、dragend/drop 清空），onDrop 时把它从原位搬到落点。
    const draggingChipRef = useRef<HTMLElement | null>(null);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const tokens = useMemo(() => parseComposerTokens(value), [value]);
    const itemById = useMemo(() => new Map(items.map((item) => [item.nodeId, item])), [items]);
    const candidates = useMemo(() => {
        if (!mention) return [];
        const query = (mention.query || "").trim().toLowerCase();
        if (!query) return items;
        return items.filter((item) => `${item.label} ${item.title} ${item.text || ""}`.toLowerCase().includes(query));
    }, [items, mention]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        // 输入中途（编辑器聚焦且外部 value 等于自身上次序列化值）不重建 DOM，保住光标位置。
        if (document.activeElement === editor && lastSerializedRef.current === value) return;
        lastSerializedRef.current = value;
        editor.textContent = "";
        tokens.forEach((token) => {
            if (token.type === "text") {
                // 反序列化时把 \n 还原成显式 <br>：换行不依赖 white-space:pre-wrap，
                // 避免生成完成触发 DOM 重建后多行被压成一行（单 textNode 里的 \n 在 contentEditable 渲染不稳）。
                appendTextWithBreaks(editor, token.value);
                return;
            }
            const item = itemById.get(token.nodeId);
            // 连接已断 / 老纯文本「图片N」找不到对应 item → 不渲染 chip（渐进式兼容）。
            if (item) editor.append(createReferenceChip(item, theme, setImagePreview, draggingChipRef));
        });
    }, [itemById, theme, tokens, value]);

    const syncFromEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const next = serializeEditor(editor);
        lastSerializedRef.current = next;
        onChange(next);
        syncMention();
    };

    const syncMention = () => {
        const text = textBeforeCaret();
        const match = /@([^\s@]*)$/.exec(text);
        if (!match || !items.length) {
            closeMention();
            return;
        }
        // 菜单跟随光标：取折叠光标的视口坐标，换算成相对外层容器的 left/top，弹在光标下方（带左右边界 clamp）。
        const editor = editorRef.current;
        const container = editor?.parentElement;
        let left = 8;
        let top = 24;
        const selection = window.getSelection();
        if (editor && container && selection && selection.rangeCount) {
            const caret = selection.getRangeAt(0).cloneRange();
            caret.collapse(true);
            let caretRect = caret.getBoundingClientRect();
            if (!caretRect.height && caret.getClientRects().length) caretRect = caret.getClientRects()[0];
            if (caretRect.height || caretRect.top) {
                const containerRect = container.getBoundingClientRect();
                // 画布可缩放(scale)：getBoundingClientRect 是缩放后的视口坐标，而 absolute 定位用容器本地坐标，
                // 故视口坐标差需除以缩放系数(渲染宽/本地宽)还原。大框无缩放时 scale≈1。
                const scale = container.offsetWidth ? containerRect.width / container.offsetWidth : 1;
                const s = scale || 1;
                left = Math.max(4, Math.min((caretRect.left - containerRect.left) / s, container.clientWidth - 264));
                top = (caretRect.bottom - containerRect.top) / s + 6;
            }
        }
        setMention({ query: match[1] || "", left, top });
        setActiveIndex(0);
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(0);
    };

    const insertReference = (item: ComposerItem) => {
        const editor = editorRef.current;
        if (!editor) return;
        removeActiveMention();
        const chip = createReferenceChip(item, theme, setImagePreview, draggingChipRef);
        const space = document.createTextNode(" ");
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range) {
            range.insertNode(space);
            range.insertNode(chip);
            range.setStartAfter(space);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            editor.append(chip, space);
            placeCaretAtEnd(editor);
        }
        closeMention();
        const next = serializeEditor(editor);
        lastSerializedRef.current = next;
        onChange(next);
    };

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => event.stopPropagation();

    return (
        <div className="relative h-full w-full" onMouseDown={stopCanvasInteraction} onPointerDown={stopCanvasInteraction}>
            {placeholder && !value.trim() ? (
                // 占位符与编辑器共用同一份 className（行高/字号/内边距），保证文字与首行光标逐字对齐。
                <div className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words opacity-45 ${className || ""}`} style={{ color: theme.node.placeholder, ...style, background: "transparent", borderColor: "transparent" }}>
                    {placeholder}
                </div>
            ) : null}
            <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                className={`thin-scrollbar w-full overflow-y-auto whitespace-pre-wrap break-words outline-none ${className || ""}`}
                style={{ color: theme.node.text, ...style }}
                onInput={() => {
                    if (!composingRef.current) syncFromEditor();
                }}
                onCompositionStart={() => {
                    composingRef.current = true;
                }}
                onCompositionEnd={() => {
                    composingRef.current = false;
                    syncFromEditor();
                }}
                onPaste={(event: ClipboardEvent<HTMLDivElement>) => {
                    // 纯文本粘贴：避免带样式 HTML 破坏 contentEditable 结构 / 引入非法节点。
                    event.preventDefault();
                    const text = event.clipboardData.getData("text/plain");
                    if (text) document.execCommand("insertText", false, text);
                }}
                onDragOver={(event: DragEvent<HTMLDivElement>) => {
                    // 仅当我们自己的 chip 正在拖动时才允许 drop（preventDefault），避免拦截外部内容拖入。
                    if (!draggingChipRef.current) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event: DragEvent<HTMLDivElement>) => {
                    const chip = draggingChipRef.current;
                    if (!chip) return;
                    // 接管原生拖放：不 preventDefault 浏览器会把 chip 当 HTML 片段乱插、丢 data-reference-node-id 或破坏原子性。
                    event.preventDefault();
                    const editor = editorRef.current;
                    if (!editor) return;
                    const range = caretRangeFromPoint(event.clientX, event.clientY, editor);
                    draggingChipRef.current = null;
                    if (!range) return;
                    chip.remove();
                    range.insertNode(chip);
                    // 落点紧贴 chip 时补一个空格，保证 chip 后仍有可输入/落光标的位置。
                    const space = document.createTextNode(" ");
                    range.setStartAfter(chip);
                    range.collapse(true);
                    range.insertNode(space);
                    range.setStartAfter(space);
                    range.collapse(true);
                    const selection = window.getSelection();
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                    syncFromEditor();
                }}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                    event.stopPropagation();
                    if (mention && candidates.length) {
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            setActiveIndex((index) => (index + 1) % candidates.length);
                            return;
                        }
                        if (event.key === "ArrowUp") {
                            event.preventDefault();
                            setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
                            return;
                        }
                        if (event.key === "Enter") {
                            event.preventDefault();
                            insertReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
                            return;
                        }
                        if (event.key === "Escape") {
                            event.preventDefault();
                            closeMention();
                            return;
                        }
                    }
                    // Cmd/Ctrl+Enter 提交（仅 onSubmit 存在时）；普通 Enter 留作换行。
                    if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        onSubmit();
                        return;
                    }
                    if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentReference(event.key)) {
                        event.preventDefault();
                        requestAnimationFrame(syncFromEditor);
                        return;
                    }
                    requestAnimationFrame(syncMention);
                }}
                onBlur={() => window.setTimeout(closeMention, 120)}
            />
            {mention && candidates.length ? <MentionMenu items={candidates} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertReference} left={mention.left} top={mention.top} /> : null}
            {imagePreview ? <Image src={imagePreview} alt="引用图片预览" style={{ display: "none" }} preview={{ open: true, src: imagePreview, onOpenChange: (open) => !open && setImagePreview(null) }} /> : null}
        </div>
    );
}

function MentionMenu({ items, activeIndex, theme, onSelect, left, top }: { items: ComposerItem[]; activeIndex: number; theme: CanvasTheme; onSelect: (item: ComposerItem) => void; left: number; top: number }) {
    const selectedRef = useRef(false);
    const selectItem = (item: ComposerItem) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(item);
    };

    return (
        <div className="anim-pop absolute z-[90] max-h-56 w-64 overflow-y-auto rounded-xl border p-1 shadow-[0_18px_54px_rgba(15,23,42,.16)] dark:shadow-[0_18px_54px_rgba(0,0,0,.5)]" style={{ left, top, background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
            {items.map((item, index) => (
                <button
                    key={item.nodeId}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                    style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectItem(item);
                    }}
                >
                    <ResourcePreview item={item} />
                    <span className="min-w-0 flex-1">
                        <span className="block font-medium">{item.label}</span>
                        <span className="block truncate opacity-65">{item.text || item.title}</span>
                    </span>
                </button>
            ))}
        </div>
    );
}

function ResourcePreview({ item }: { item: ComposerItem }) {
    if (item.type === "image" && item.previewUrl) return <img src={item.previewUrl} alt="" className="size-9 rounded-md object-cover" />;
    if (item.type === "video" && item.previewUrl) return <video src={item.previewUrl} className="size-9 rounded-md bg-black object-cover" muted preload="metadata" />;
    const Icon = item.type === "audio" ? Music2 : item.type === "video" ? Video : item.type === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
}

function createReferenceChip(item: ComposerItem, theme: CanvasTheme, onImagePreview: (url: string) => void, draggingChipRef: MutableRefObject<HTMLElement | null>) {
    const wrapper = document.createElement("span");
    // 原子性 + 序列化锚点：contentEditable=false 让光标整块跨过 chip；dataset 记 nodeId 供序列化回 token。
    wrapper.contentEditable = "false";
    wrapper.dataset.referenceNodeId = item.nodeId;
    // 拖动能力：dragstart 记下本 chip，dragend 兜底清空（drop 成功也会清，这里防 drop 在编辑器外）。
    wrapper.setAttribute("draggable", "true");
    wrapper.addEventListener("dragstart", (event) => {
        // 阻止冒泡，避免触发画布平移相关 stopPropagation 链路上的副作用；占位 data 防个别浏览器取消拖拽。
        event.stopPropagation();
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", "");
        }
        draggingChipRef.current = wrapper;
    });
    wrapper.addEventListener("dragend", () => {
        draggingChipRef.current = null;
    });
    wrapper.className = "mx-px inline-flex h-7 max-w-40 items-center justify-center overflow-hidden rounded-full border px-2 text-xs font-medium leading-none align-middle";
    Object.assign(wrapper.style, chipStyle(theme));
    if (item.type === "image" && item.previewUrl) {
        const image = document.createElement("img");
        image.src = item.previewUrl;
        image.alt = item.title;
        image.className = "size-6 rounded object-cover";
        wrapper.className = "mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle";
        wrapper.appendChild(image);
        wrapper.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onImagePreview(item.previewUrl || "");
        });
    } else {
        // chip 显示文字：图/视/音用调用方现算好的 label；文本用 text || title。
        const display = item.type === "text" ? item.text || item.title : item.label;
        wrapper.title = item.type === "text" ? item.text || item.title : item.label;
        const text = document.createElement("span");
        text.className = "block truncate";
        text.textContent = display;
        wrapper.appendChild(text);
    }
    return wrapper;
}

// contentEditable 里按回车换行时，Chrome/Safari 默认把新行包成块级 <div>（Firefox 用 <br>）。
// 序列化必须把块边界还原成 \n，否则 <div>a</div><div>b</div> 会被拼成 "ab"，多行文本重新打开后换行/段落结构全丢。
const COMPOSER_BLOCK_TAGS = new Set(["DIV", "P", "LI", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE", "H1", "H2", "H3", "H4", "H5", "H6"]);

function serializeEditor(editor: HTMLElement) {
    return serializeNodes(editor.childNodes).replace(/﻿/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>) {
    let result = "";
    nodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) result += node.textContent || "";
        if (!(node instanceof HTMLElement)) return;
        const nodeId = node.dataset.referenceNodeId;
        if (nodeId) result += `@[node:${nodeId}]`;
        else if (node.tagName === "BR") result += "\n";
        else {
            // 块级元素代表新的一行：内容前补 \n（除非已在行首/开头），把 <div>/<p> 换行还原回 \n。
            if (COMPOSER_BLOCK_TAGS.has(node.tagName) && result && !result.endsWith("\n")) result += "\n";
            result += serializeNodes(node.childNodes);
        }
    });
    return result;
}

// 反序列化文本：按 \n 切行、行间插显式 <br>，确保换行稳定渲染（不依赖 white-space:pre-wrap），
// 与 serializeNodes 的 BR→\n 对称，往返无损。空行用相邻 <br> 表示，行内非空才补文本节点。
function appendTextWithBreaks(parent: HTMLElement, value: string) {
    const lines = value.split("\n");
    lines.forEach((line, index) => {
        if (index > 0) parent.append(document.createElement("br"));
        if (line) parent.append(document.createTextNode(line));
    });
}

function removeActiveMention() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const text = textBeforeCaret();
    const match = /@([^\s@]*)$/.exec(text);
    if (!match) return;
    range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
    range.deleteContents();
}

function deleteAdjacentReference(key: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const target = adjacentReferenceNode(range, key);
    if (!target) return false;
    const nextCaretNode = document.createTextNode("");
    target.replaceWith(nextCaretNode);
    range.setStart(nextCaretNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function adjacentReferenceNode(range: Range, key: string) {
    const container = range.startContainer;
    const offset = range.startOffset;
    const previous = key === "Backspace";
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
        return findReferenceSibling(container, previous);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && current.dataset.referenceNodeId ? current : null;
}

function textBeforeCaret() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const range = selection.getRangeAt(0).cloneRange();
    const editor = closestEditor(range.startContainer);
    if (!editor) return "";
    range.setStart(editor, 0);
    return range.toString();
}

function closestEditor(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[contenteditable='true']") || null;
}

function placeCaretAtEnd(element: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

// 把屏幕坐标解析成插入 Range：Chrome 用 caretRangeFromPoint，Firefox 用 caretPositionFromPoint（转 Range）。
function caretRangeFromPoint(clientX: number, clientY: number, editor: HTMLElement): Range | null {
    let range: Range | null = null;
    const docWithCaretRange = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const docWithCaretPosition = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    if (typeof docWithCaretRange.caretRangeFromPoint === "function") {
        range = docWithCaretRange.caretRangeFromPoint(clientX, clientY);
    } else if (typeof docWithCaretPosition.caretPositionFromPoint === "function") {
        const position = docWithCaretPosition.caretPositionFromPoint(clientX, clientY);
        if (position) {
            range = document.createRange();
            range.setStart(position.offsetNode, position.offset);
            range.collapse(true);
        }
    }
    if (!range) return null;
    // 落点必须在本编辑器内，否则丢弃（拖到编辑器外/占位层）。
    if (!editor.contains(range.startContainer)) return null;
    // 落点落进了某个原子 chip（contenteditable=false）内部 → 调整到该 chip 之后，避免插进原子块里。
    const atomic = closestAtomicReference(range.startContainer, editor);
    if (atomic) {
        range.setStartAfter(atomic);
        range.collapse(true);
    }
    return range;
}

function closestAtomicReference(node: Node, editor: HTMLElement): HTMLElement | null {
    let current: Node | null = node;
    while (current && current !== editor) {
        if (current instanceof HTMLElement && current.dataset.referenceNodeId) return current;
        current = current.parentNode;
    }
    return null;
}

function parseComposerTokens(value: string): Token[] {
    const tokens: Token[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(MENTION_TOKEN_PATTERN)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
        tokens.push({ type: "reference", nodeId: match[1] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
    return tokens;
}

function chipStyle(theme: CanvasTheme): CSSProperties {
    // 主色淡底引用 chip：亮色 #2563EB、暗色提亮 #3B82F6（与主题品牌色一致）
    const dark = theme === canvasThemes.dark;
    return dark
        ? { background: "rgba(59,130,246,.16)", borderColor: "rgba(59,130,246,.32)", color: "#3B82F6" }
        : { background: "rgba(37,99,235,.14)", borderColor: "rgba(37,99,235,.30)", color: "#2563EB" };
}
