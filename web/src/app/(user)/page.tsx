"use client";

import { ArrowRight, LayoutGrid, Plus, Sparkles } from "@/components/icons";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { APP_NAME } from "@/constant/env";
import { App, Button, Carousel, Tag } from "antd";

import { fetchPrompts, type Prompt } from "@/services/api/prompts";
import { swapToFallbackCover } from "@/components/prompts/prompt-card";
import { resolveImageUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { syncAppDataToCloud } from "@/services/cloud-sync";
import { useCanvasStore } from "./canvas/stores/use-canvas-store";
import { CanvasNodeType } from "./canvas/types";
import { CanvasCreditSourceDialog } from "./canvas/components/canvas-credit-source-dialog";

/**
 * 首页（公开落地页，登录/未登录都可访问）。布局自上而下：
 *   1. 品牌标题。
 *   2. 「创建 / 最近创建的画布」——仅登录用户显示；首格「新建画布」是唯一创建入口，
 *      其余为最近编辑的画布卡片（封面取画布里第一张图片节点）。
 *   3. 「精选模板」轮播——拉取带封面的提示词模版（antd Carousel 自动播放）。
 *
 * 数据来源：
 *   - 模版：fetchPrompts()（GET /api/prompts），只取有封面的、最多 12 条。
 *   - 最近画布：useCanvasStore.projects（zustand + IndexedDB 持久化，仅本机数据）。
 *   - 画布封面：resolveImageUrl(storageKey) 从 IndexedDB 解析为 blob URL；若该图只在
 *     TOS、本机 IndexedDB 没有，会解析为空并用占位图（属正常，换设备/清缓存即如此）。
 *
 * 顶部导航（图片/视频/提示词模板/素材）由 AppTopNav 渲染，不在本页重复。
 */
export default function IndexPage() {
    const { message } = App.useApp();
    const router = useRouter();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const [templates, setTemplates] = useState<Prompt[]>([]);
    const [covers, setCovers] = useState<Record<string, string>>({});
    const [creditSourceOpen, setCreditSourceOpen] = useState(false);
    const syncedRef = useRef(false);

    // 登录用户进入首页时触发一次云端同步：拉取远端画布/素材/日志到本地，
    // 否则首页画布列表只显示本机数据，换设备登录看不到已有作品。
    useEffect(() => {
        if (!user) {
            syncedRef.current = false;
            return;
        }
        if (syncedRef.current) return;
        syncedRef.current = true;
        void syncAppDataToCloud().catch((error) => console.warn("首页云端同步失败", error));
    }, [user?.id]);

    useEffect(() => {
        void fetchPrompts({ pageSize: 48 })
            .then((data) => setTemplates(data.items.filter((item) => item.coverUrl).slice(0, 12)))
            .catch((error) => message.error(error instanceof Error ? error.message : "获取提示词失败"));
    }, [message]);

    // 最近编辑的画布（登录后才有；本机数据）
    const recent = useMemo(() => [...projects].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 7), [projects]);

    // 给每个画布取第一张图片节点做封面（IndexedDB 解析为 blob URL，无图则留空用占位）
    useEffect(() => {
        let alive = true;
        void Promise.all(
            recent.map(async (project) => {
                const node = project.nodes.find((item) => item.type === CanvasNodeType.Image && (item.metadata?.storageKey || item.metadata?.content?.startsWith("data:")));
                const url = node?.metadata?.storageKey ? await resolveImageUrl(node.metadata.storageKey, "") : node?.metadata?.content?.startsWith("data:") ? node.metadata.content : "";
                return [project.id, url] as const;
            }),
        ).then((entries) => {
            if (alive) setCovers(Object.fromEntries(entries));
        });
        return () => {
            alive = false;
        };
    }, [recent]);

    const startCreate = () => {
        if (!token) {
            router.push("/canvas");
            return;
        }
        setCreditSourceOpen(true);
    };

    const confirmCreate = (projectId: string) => {
        setCreditSourceOpen(false);
        router.push(`/canvas/${createProject(`${APP_NAME} ${projects.length + 1}`, projectId || undefined)}`);
    };

    const showRecent = Boolean(token);
    const slidesToShow = Math.min(3, Math.max(1, templates.length));

    return (
        <main className="bg-paper-grid relative h-full overflow-y-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="relative z-10 mx-auto max-w-7xl px-5 pb-16 sm:px-8">
                {/* 顶部：品牌标题 */}
                <section className="anim-rise flex flex-col items-center pt-14 pb-2 text-center sm:pt-20">
                    <h1 className="font-heading text-4xl font-medium leading-tight tracking-wide sm:text-6xl">
                        用节点编排你的 <span className="text-brand">AI 创作</span>
                    </h1>
                </section>

                {/* 中部：最近创建的画布 */}
                {showRecent ? (
                    <section className="anim-rise mt-10" style={{ "--rise-delay": "80ms" } as CSSProperties}>
                        {recent.length > 0 ? (
                            <div className="mb-5 flex items-end justify-between gap-4">
                                <div className="flex items-center gap-1.5 text-stone-500 dark:text-stone-400">
                                    <LayoutGrid className="size-4" />
                                    <span className="text-sm font-medium tracking-wide">最近的画布</span>
                                </div>
                                <Button type="link" href="/canvas" className="shrink-0" icon={<ArrowRight className="size-4" />} iconPlacement="end">
                                    全部画布
                                </Button>
                            </div>
                        ) : null}
                        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                            <button
                                type="button"
                                onClick={startCreate}
                                className="hover-lift group flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-stone-300 text-stone-500 transition hover:border-brand hover:text-brand dark:border-stone-700"
                            >
                                <span className="flex size-11 items-center justify-center rounded-full bg-brand/10 text-brand transition group-hover:bg-brand/15">
                                    <Plus className="size-5" />
                                </span>
                                <span className="text-sm font-medium">新建画布</span>
                            </button>
                            {recent.map((project) => (
                                <a key={project.id} href={`/canvas/${project.id}`} className="paper-card hover-lift group block overflow-hidden !p-0">
                                    <div className="relative h-32 overflow-hidden bg-stone-100 dark:bg-stone-900">
                                        {covers[project.id] ? (
                                            <img src={covers[project.id]} alt={project.title} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]" />
                                        ) : (
                                            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[rgba(37,99,235,0.10)] to-[rgba(251,191,36,0.10)] text-brand/60">
                                                <LayoutGrid className="size-7" />
                                            </div>
                                        )}
                                    </div>
                                    <div className="px-3.5 py-3">
                                        <h3 className="font-heading truncate text-sm font-medium tracking-wide">{project.title}</h3>
                                        <p className="mt-1 truncate text-xs text-stone-500">
                                            {project.nodes.length} 节点 · {new Date(project.updatedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}
                                        </p>
                                    </div>
                                </a>
                            ))}
                        </div>
                    </section>
                ) : null}

                {/* 底部：精选模板轮播 */}
                <section className="anim-rise mt-14" style={{ "--rise-delay": "160ms" } as CSSProperties}>
                    <div className="mb-5 flex items-end justify-between gap-4">
                        <div className="flex items-center gap-1.5 text-brand">
                            <Sparkles className="size-4" />
                            <span className="text-sm font-medium tracking-wide">精选模板</span>
                        </div>
                        <Button type="link" href="/prompts" className="shrink-0" icon={<ArrowRight className="size-4" />} iconPlacement="end">
                            查看全部
                        </Button>
                    </div>
                    {templates.length > 0 ? (
                        <div className="home-template-carousel">
                            <Carousel
                                autoplay
                                autoplaySpeed={3500}
                                speed={650}
                                dots
                                infinite={templates.length > slidesToShow}
                                slidesToShow={slidesToShow}
                                slidesToScroll={1}
                                responsive={[
                                    { breakpoint: 1024, settings: { slidesToShow: Math.min(2, templates.length) } },
                                    { breakpoint: 640, settings: { slidesToShow: 1 } },
                                ]}
                            >
                                {templates.map((item) => (
                                    <div key={item.id}>
                                        <a href="/prompts" className="group relative mx-2 block h-[280px] overflow-hidden rounded-2xl bg-stone-100 ring-1 ring-border transition duration-300 hover:ring-brand/50 dark:bg-stone-900 sm:h-[320px]">
                                            <img src={item.coverUrl || "/logo-mark.svg"} alt={item.title} className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.04]" onError={swapToFallbackCover} />
                                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-4 text-white">
                                                <div className="mb-2 flex flex-wrap gap-1.5">
                                                    {(item.tags ?? []).slice(0, 2).map((tag) => (
                                                        <Tag key={tag} variant="filled" className="m-0 border-0 bg-white/15 text-[11px] text-white backdrop-blur">
                                                            {tag}
                                                        </Tag>
                                                    ))}
                                                </div>
                                                <h3 className="text-base font-medium">{item.title}</h3>
                                                {item.prompt ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/70">{item.prompt}</p> : null}
                                            </div>
                                        </a>
                                    </div>
                                ))}
                            </Carousel>
                        </div>
                    ) : (
                        <div className="flex h-[260px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-stone-300 text-center dark:border-stone-700">
                            <div className="flex size-12 items-center justify-center rounded-full bg-brand/10 text-brand">
                                <Sparkles className="size-6" />
                            </div>
                            <p className="max-w-sm text-sm text-stone-500 dark:text-stone-400">还没有可展示的模版，去后台同步一批优质提示词即可。</p>
                            <Button type="primary" href="/admin/prompts" icon={<ArrowRight className="size-4" />} iconPlacement="end">
                                去同步提示词模板
                            </Button>
                        </div>
                    )}
                </section>
            </div>
            <CanvasCreditSourceDialog open={creditSourceOpen} onCancel={() => setCreditSourceOpen(false)} onConfirm={confirmCreate} />
        </main>
    );
}
