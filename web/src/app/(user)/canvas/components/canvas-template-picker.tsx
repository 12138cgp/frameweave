"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Input, Modal, Spin, Tag } from "antd";
import { LayoutTemplate } from "@/components/icons";
import { useQuery } from "@tanstack/react-query";

import { fetchPrompts, type Prompt } from "@/services/api/prompts";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { cn } from "@/lib/utils";

// 「填空模板」来源的分类编码。它和其余分类的「成品案例」是两个品类：
// 案例照抄只能得到别人那张图，模板是带 [方括号] 占位符的骨架，填空后才是自己的提示词。
const TEMPLATE_CATEGORY = "freestylefly-templates";
// 该来源稳定在 46 条，一次取完，省掉分页与无限滚动。
const TEMPLATE_PAGE_SIZE = 60;

// 占位符形如 [产品类型]、[平台，如 iOS/Android/Web]。
// ⚠️ 内容里排除引号与方括号：JSON 结构模板正文里的 ["Innovative", "Minimalist"] 这类数组
// 否则会被当成占位符，给用户凭空多出一堆填不了的框。
const PLACEHOLDER_RE = /\[([^[\]\n"]{1,40})\]/g;

// 模板标题统一是「分类 · 模板名」，拆开用于左侧分组。拆不出来时整条当名字、归到「其它」。
function splitTemplateTitle(title: string) {
    const index = title.indexOf(" · ");
    if (index < 0) return { category: "其它", name: title };
    return { category: title.slice(0, index), name: title.slice(index + 3) };
}

function extractPlaceholders(text: string) {
    const found: string[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(PLACEHOLDER_RE)) {
        const key = match[1].trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        found.push(key);
    }
    return found;
}

// 没填的占位符【原样保留】——留着 [xxx] 用户一眼能看出还差什么，
// 比悄悄删掉留下一句不通顺的话要好。
function composeTemplate(text: string, values: Record<string, string>) {
    return text.replace(PLACEHOLDER_RE, (whole, raw: string) => {
        const value = (values[raw.trim()] || "").trim();
        return value || whole;
    });
}

export function CanvasTemplatePicker({
    buttonClassName,
    currentPrompt,
    onInsert,
    onOpenChange,
}: {
    buttonClassName?: string;
    currentPrompt: string;
    onInsert: (text: string) => void;
    onOpenChange?: (open: boolean) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [open, setOpen] = useState(false);
    const updateOpen = (next: boolean) => {
        setOpen(next);
        onOpenChange?.(next);
    };

    return (
        <>
            <Button
                size="small"
                type="text"
                className={`${buttonClassName || "!h-9 !min-w-0 !justify-start !rounded-full !px-2.5"} !transition hover:!brightness-[.96] dark:hover:!brightness-110`}
                style={{ background: theme.node.fill, color: theme.node.text }}
                icon={<LayoutTemplate className="size-3.5" />}
                onClick={() => updateOpen(true)}
                title="填空模板：挑一个骨架，填空生成提示词"
            >
                <span className="whitespace-nowrap">模板</span>
            </Button>
            {open ? <TemplateDialog currentPrompt={currentPrompt} onInsert={onInsert} onClose={() => updateOpen(false)} /> : null}
        </>
    );
}

function TemplateDialog({ currentPrompt, onInsert, onClose }: { currentPrompt: string; onInsert: (text: string) => void; onClose: () => void }) {
    const query = useQuery({
        queryKey: ["prompt-templates"],
        queryFn: () => fetchPrompts({ category: TEMPLATE_CATEGORY, pageSize: TEMPLATE_PAGE_SIZE }),
        staleTime: 5 * 60 * 1000,
    });
    const items = useMemo(() => query.data?.items || [], [query.data?.items]);

    const grouped = useMemo(() => {
        const map = new Map<string, Prompt[]>();
        for (const item of items) {
            const { category } = splitTemplateTitle(item.title);
            const list = map.get(category);
            if (list) list.push(item);
            else map.set(category, [item]);
        }
        return map;
    }, [items]);
    const categories = useMemo(() => [...grouped.keys()], [grouped]);

    const [category, setCategory] = useState("");
    const activeCategory = category && grouped.has(category) ? category : categories[0] || "";
    const list = grouped.get(activeCategory) || [];

    const [selectedId, setSelectedId] = useState("");
    const selected = list.find((item) => item.id === selectedId) || list[0];

    // 换模板就清空已填内容：上一套的填法搬到下一套多半驴唇不对马嘴。
    const [values, setValues] = useState<Record<string, string>>({});
    useEffect(() => {
        setValues({});
    }, [selected?.id]);

    const placeholders = useMemo(() => (selected ? extractPlaceholders(selected.prompt) : []), [selected]);
    const composed = useMemo(() => (selected ? composeTemplate(selected.prompt, values) : ""), [selected, values]);
    const filledCount = placeholders.filter((key) => (values[key] || "").trim()).length;

    return (
        <Modal
            open
            onCancel={onClose}
            footer={null}
            width={960}
            title={<span className="font-heading text-base font-medium tracking-wide">填空模板</span>}
        >
            {query.isLoading ? (
                <div className="flex h-64 items-center justify-center">
                    <Spin />
                </div>
            ) : !items.length ? (
                <Empty description="暂时没有取到模板，稍后再试" />
            ) : (
                <>
                    <div className="flex flex-wrap gap-1.5">
                        {categories.map((name) => (
                            <Tag.CheckableTag
                                key={name}
                                checked={name === activeCategory}
                                className={cn("prompt-filter-tag", name === activeCategory && "is-active")}
                                onChange={() => {
                                    setCategory(name);
                                    setSelectedId("");
                                }}
                            >
                                {name}
                            </Tag.CheckableTag>
                        ))}
                    </div>

                    <div className="mt-4 grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
                        <div className="max-h-[420px] space-y-1 overflow-auto pr-1">
                            {list.map((item) => {
                                const { name } = splitTemplateTitle(item.title);
                                const active = item.id === selected?.id;
                                return (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => setSelectedId(item.id)}
                                        className={cn(
                                            "block w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm transition",
                                            active ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900" : "hover:bg-stone-100 dark:hover:bg-stone-800",
                                        )}
                                    >
                                        <span className="line-clamp-2">{name}</span>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="min-w-0">
                            {selected ? (
                                <>
                                    {selected.preview ? (
                                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-3 text-xs leading-5 text-stone-600 dark:bg-stone-900 dark:text-stone-300">
                                            {selected.preview}
                                        </pre>
                                    ) : null}

                                    {placeholders.length ? (
                                        <div className="mt-4">
                                            <div className="mb-2 text-xs text-stone-500 dark:text-stone-400">
                                                填空（{filledCount}/{placeholders.length}）—— 留空的会原样保留 <code>[方括号]</code>，方便你之后自己补
                                            </div>
                                            <div className="grid max-h-52 gap-2 overflow-auto pr-1">
                                                {placeholders.map((key) => (
                                                    <div key={key} className="grid gap-1">
                                                        <label className="text-xs text-stone-500 dark:text-stone-400">{key}</label>
                                                        <Input.TextArea
                                                            autoSize={{ minRows: 1, maxRows: 3 }}
                                                            value={values[key] || ""}
                                                            placeholder={key}
                                                            onChange={(event) => setValues((prev) => ({ ...prev, [key]: event.target.value }))}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="mt-4 text-xs text-stone-500 dark:text-stone-400">这套模板没有占位符，直接填入后按需修改即可。</div>
                                    )}

                                    <div className="mt-4">
                                        <div className="mb-2 text-xs text-stone-500 dark:text-stone-400">成品预览</div>
                                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs leading-5 text-stone-700 ring-1 ring-border dark:bg-stone-900/60 dark:text-stone-300">
                                            {composed}
                                        </pre>
                                    </div>

                                    <div className="mt-4 flex flex-wrap gap-2">
                                        <Button
                                            type="primary"
                                            onClick={() => {
                                                onInsert(composed);
                                                onClose();
                                            }}
                                        >
                                            {currentPrompt.trim() ? "替换提示词" : "填入提示词"}
                                        </Button>
                                        {currentPrompt.trim() ? (
                                            <Button
                                                onClick={() => {
                                                    onInsert(`${currentPrompt.trimEnd()}\n\n${composed}`);
                                                    onClose();
                                                }}
                                            >
                                                追加到末尾
                                            </Button>
                                        ) : null}
                                    </div>
                                </>
                            ) : null}
                        </div>
                    </div>
                </>
            )}
        </Modal>
    );
}
