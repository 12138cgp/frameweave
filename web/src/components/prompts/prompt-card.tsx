"use client";

import { Copy, ScrollText } from "@/components/icons";
import { useState } from "react";
import type { CSSProperties, ReactNode, SyntheticEvent } from "react";
import { Button, Card, Image, Tag } from "antd";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";
import { cn } from "@/lib/utils";

// 远程封面（如未镜像成功的 twitter 图）加载失败时换中性占位 logo，避免裂图
export function swapToFallbackCover(event: SyntheticEvent<HTMLImageElement>) {
    const img = event.currentTarget;
    if (!img.src.endsWith("/logo-mark.svg")) img.src = "/logo-mark.svg";
}

// 提示词封面：无图条目与加载失败统一渲染占位卡面（一排相同的品牌头像看起来像整页加载失败）
// zoomable：详情弹窗里用，点封面能放大看原图（列表卡片上不开——那里点击是「打开详情」）。
export function PromptCover({ src, alt, className, zoomable = false }: { src?: string; alt: string; className?: string; zoomable?: boolean }) {
    const [failed, setFailed] = useState(false);
    if (!src || failed) {
        return (
            <div className={cn("flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-stone-100 to-stone-200 dark:from-stone-900 dark:to-stone-800", className)}>
                <ScrollText className="size-7 text-stone-400 dark:text-stone-600" />
                <span className="font-heading text-xs tracking-wide text-stone-400 dark:text-stone-500">纯文字提示词</span>
            </div>
        );
    }
    if (zoomable) {
        return (
            <Image
                src={src}
                alt={alt}
                rootClassName="block w-full"
                className={cn("aspect-[4/3] w-full cursor-zoom-in object-cover", className)}
                onError={() => setFailed(true)}
                preview={{ mask: <span className="text-xs">点击查看大图</span> }}
            />
        );
    }
    return <img src={src} alt={alt} className={cn("aspect-[4/3] w-full object-cover", className)} onError={() => setFailed(true)} />;
}

export function PromptCard({
    item,
    onOpen,
    onCopy,
    actionLabel = "复制",
    actionIcon = <Copy className="size-3.5" />,
    actionType = "text",
    extraAction,
    className,
    style,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <Card
            className={cn("hover-lift group overflow-hidden !rounded-2xl !border-border bg-card", className)}
            style={style}
            styles={{ body: { padding: 0 } }}
            cover={
                <button type="button" className="block w-full cursor-pointer overflow-hidden text-left" onClick={onOpen}>
                    <PromptCover src={item.coverUrl} alt={item.title} className="transition duration-500 group-hover:scale-[1.03]" />
                </button>
            }
        >
            <button type="button" className="block w-full cursor-pointer text-left" onClick={onOpen}>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{item.title}</h2>
                        <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">{formatPromptDate(item.updatedAt)}</span>
                    </div>
                    <p className="mt-2 line-clamp-3 text-xs leading-5 text-stone-600 dark:text-stone-400">{item.prompt}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {item.tags.map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                    </div>
                </div>
            </button>
            <div className="flex items-center gap-2 px-4 pb-4">
                <Button block={actionType === "primary"} type={actionType} size="small" icon={actionIcon} onClick={onCopy}>
                    {actionLabel}
                </Button>
                {extraAction}
            </div>
        </Card>
    );
}
