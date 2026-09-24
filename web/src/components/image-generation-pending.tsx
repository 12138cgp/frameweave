"use client";

import { useEffect, useState } from "react";
import { LoaderCircle } from "@/components/icons";

import { formatDuration } from "@/lib/image-utils";
import { cn } from "@/lib/utils";

const pendingMessages = ["正在创建图片", "马上就好了", "再等等", "正在整理细节"];
const messageFadeMs = 280;

export function ImageGenerationPending({ className, label, compact = false }: { className?: string; label?: string; compact?: boolean }) {
    const [tick, setTick] = useState(0);
    const [messageIndex, setMessageIndex] = useState(0);
    const [messageVisible, setMessageVisible] = useState(true);

    useEffect(() => {
        const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
        return () => window.clearInterval(timer);
    }, []);

    const targetIndex = Math.floor(tick / 2) % pendingMessages.length;

    // 轮播文案淡入淡出（纯展示 state）：先淡出旧文案，到点后切换文字再淡入
    useEffect(() => {
        if (label || targetIndex === messageIndex) return;
        setMessageVisible(false);
        const timer = window.setTimeout(() => {
            setMessageIndex(targetIndex);
            setMessageVisible(true);
        }, messageFadeMs);
        return () => window.clearTimeout(timer);
    }, [label, targetIndex, messageIndex]);

    const progress = Math.min(98, 10 + (1 - Math.exp(-tick / 28)) * 88);

    return (
        <div className={cn("relative overflow-hidden bg-[#EEF2F7] dark:bg-[#141f36]", compact ? "min-h-24" : "aspect-[4/3]", className)}>
            {/* 径向点纹 */}
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(100,116,139,0.32) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                    maskImage: "radial-gradient(ellipse at 38% 68%, black 0%, black 28%, transparent 60%)",
                }}
            />
            {/* 扫光层（生成中占位统一语言） */}
            <div className="anim-shimmer pointer-events-none absolute inset-0" />
            <div className="absolute left-4 top-4 flex items-center gap-2 text-[15px] font-medium text-[#52607A] dark:text-[#CBD5E1]">
                <LoaderCircle className="size-4 animate-spin" />
                <span className={cn("transition-opacity duration-300", messageVisible ? "opacity-100" : "opacity-0")}>{label || pendingMessages[messageIndex]}</span>
            </div>
            <div className="absolute bottom-4 left-4 right-4">
                <div className="mb-2 flex items-center justify-between text-xs text-[#7C8AA3] dark:text-[#94A3B8]">
                    <span>{formatDuration(tick * 1000)}</span>
                    <span>{Math.floor(progress)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#0F172A]/10 dark:bg-[#E2E8F0]/12">
                    <div className="h-full rounded-full bg-[#2563EB] transition-[width] duration-500 ease-out dark:bg-[#3B82F6]" style={{ width: `${progress}%` }} />
                </div>
            </div>
        </div>
    );
}
