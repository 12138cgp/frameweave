"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { App, Button, Empty, Tag } from "antd";
import { Copy, FileText, ImageOff, LoaderCircle, Music2, Settings2, Video } from "@/components/icons";

import { fetchSharedCanvas, forkSharedCanvas, sharedCanvasFileUrl } from "@/services/canvas-share";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/app/(user)/canvas/types";
import { CanvasCreditSourceDialog } from "@/app/(user)/canvas/components/canvas-credit-source-dialog";

type SharedProject = {
    id: string;
    title: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

export default function SharedCanvasPage() {
    const params = useParams<{ code: string }>();
    const code = params?.code || "";
    const router = useRouter();
    const pathname = usePathname();
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const [project, setProject] = useState<SharedProject | null>(null);
    const [title, setTitle] = useState("");
    const [error, setError] = useState("");
    const [forking, setForking] = useState(false);
    const [creditSourceOpen, setCreditSourceOpen] = useState(false);

    useEffect(() => {
        if (!code) return;
        void fetchSharedCanvas(code)
            .then((payload) => {
                setTitle(payload.title || "未命名画布");
                setProject(JSON.parse(payload.project) as SharedProject);
            })
            .catch((err) => setError(err instanceof Error ? err.message : "分享不存在或已失效"));
    }, [code]);

    const copyToMyCanvas = () => {
        if (!user) {
            router.push(`/login?redirect=${encodeURIComponent(pathname || "/")}`);
            return;
        }
        setCreditSourceOpen(true);
    };

    // 选好积分来源后再 fork：把选中的项目（""=个人积分）作为副本的积分来源
    const confirmCopy = async (creditProjectId: string) => {
        setCreditSourceOpen(false);
        setForking(true);
        try {
            const newCanvasId = await forkSharedCanvas(code, creditProjectId);
            message.success("已复制到我的画布");
            router.push(`/canvas/${newCanvasId}`);
        } catch (err) {
            message.error(err instanceof Error ? err.message : "复制失败");
            setForking(false);
        }
    };

    if (error) {
        return (
            <div className="flex min-h-[60vh] items-center justify-center">
                <Empty description={error} />
            </div>
        );
    }
    if (!project) {
        return (
            <div className="flex min-h-[60vh] items-center justify-center text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
            </div>
        );
    }

    return (
        <div className="anim-fade flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border bg-background/85 px-5 py-3 backdrop-blur">
                <div className="flex min-w-0 items-center gap-3">
                    <h1 className="font-heading truncate text-lg font-medium tracking-wide">{title}</h1>
                    <Tag className="m-0">只读分享 · {project.nodes.length} 个节点</Tag>
                </div>
                <Button type="primary" className="hover-lift" icon={<Copy className="size-4" />} loading={forking} disabled={!isReady} onClick={() => void copyToMyCanvas()}>
                    {user ? "复制到我的画布" : "登录后复制到我的画布"}
                </Button>
            </div>
            <SharedCanvasViewer code={code} project={project} />
            <CanvasCreditSourceDialog open={creditSourceOpen} onCancel={() => setCreditSourceOpen(false)} onConfirm={confirmCopy} />
        </div>
    );
}

// 轻量只读渲染：把全部节点 fit 进视口，渲染图片/文本/视频内容与连线，不可编辑。
function SharedCanvasViewer({ code, project }: { code: string; project: SharedProject }) {
    const layout = useMemo(() => {
        const nodes = project.nodes || [];
        if (!nodes.length) return null;
        const left = Math.min(...nodes.map((n) => n.position.x));
        const top = Math.min(...nodes.map((n) => n.position.y));
        const right = Math.max(...nodes.map((n) => n.position.x + n.width));
        const bottom = Math.max(...nodes.map((n) => n.position.y + n.height));
        return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    }, [project]);

    if (!layout) {
        return (
            <div className="flex flex-1 items-center justify-center">
                <Empty description="这个画布是空的" />
            </div>
        );
    }

    const nodeById = new Map((project.nodes || []).map((node) => [node.id, node]));

    return (
        <div className="relative min-h-0 flex-1 overflow-auto bg-stone-100 p-6 dark:bg-stone-950">
            <div className="relative mx-auto" style={{ width: layout.width, height: layout.height, maxWidth: "100%", transformOrigin: "top left" }}>
                <svg className="absolute left-0 top-0 overflow-visible" width={layout.width} height={layout.height} style={{ pointerEvents: "none" }}>
                    {(project.connections || []).map((connection) => {
                        const from = nodeById.get(connection.fromNodeId);
                        const to = nodeById.get(connection.toNodeId);
                        if (!from || !to) return null;
                        const x1 = from.position.x + from.width - layout.left;
                        const y1 = from.position.y + from.height / 2 - layout.top;
                        const x2 = to.position.x - layout.left;
                        const y2 = to.position.y + to.height / 2 - layout.top;
                        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
                        return <path key={connection.id} d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`} fill="none" stroke="#94A3B8" strokeWidth={1.5} />;
                    })}
                </svg>
                {(project.nodes || []).map((node) => (
                    <SharedNode key={node.id} code={code} node={node} offsetX={layout.left} offsetY={layout.top} />
                ))}
            </div>
        </div>
    );
}

// 分享是只读、面向未登录访客：媒体地址候选按可靠性排序，逐个 onError 回退，任一可用即显示。
// 1) content 若是公网直链 / DataURL（AI 生成的图/视频多为 TOS 直链）——访客可直接加载；
// 2) 有 storageKey 时用公开分享文件接口按 owner 的文件取回（content 为会话级 blob: 死链时兜底）。
function collectMediaSrc(code: string, node: CanvasNodeData): string[] {
    const list: string[] = [];
    const content = node.metadata?.content || "";
    if (/^(https?:|data:)/i.test(content)) list.push(content);
    const storageKey = node.metadata?.storageKey;
    if (storageKey) list.push(sharedCanvasFileUrl(code, storageKey));
    return list;
}

function SharedMedia({ kind, candidates, title }: { kind: "image" | "video" | "audio"; candidates: string[]; title?: string }) {
    const [index, setIndex] = useState(0);
    const advance = () => setIndex((current) => current + 1);
    const src = candidates[index];
    if (!src) {
        return (
            <div className="flex size-full flex-col items-center justify-center gap-2 text-stone-400">
                <ImageOff className="size-8" />
                <span className="text-xs">{title || "媒体暂不可用"}</span>
            </div>
        );
    }
    if (kind === "video") {
        return <video key={src} src={src} className="size-full object-cover" controls muted preload="metadata" onError={advance} />;
    }
    if (kind === "audio") {
        return (
            <div className="flex size-full items-center justify-center px-3">
                <audio key={src} src={src} controls className="w-full" onError={advance} />
            </div>
        );
    }
    return <img key={src} src={src} alt={title} className="size-full object-cover" loading="lazy" onError={advance} />;
}

function SharedNode({ code, node, offsetX, offsetY }: { code: string; node: CanvasNodeData; offsetX: number; offsetY: number }) {
    const style: React.CSSProperties = {
        left: node.position.x - offsetX,
        top: node.position.y - offsetY,
        width: node.width,
        height: node.height,
    };
    const baseClass = "absolute overflow-hidden rounded-2xl border border-border bg-card shadow-sm";

    if (node.type === CanvasNodeType.Image) {
        return (
            <div className={baseClass} style={style}>
                <SharedMedia kind="image" candidates={collectMediaSrc(code, node)} title={node.title} />
            </div>
        );
    }
    if (node.type === CanvasNodeType.Video) {
        return (
            <div className={baseClass} style={style}>
                <SharedMedia kind="video" candidates={collectMediaSrc(code, node)} title={node.title} />
            </div>
        );
    }
    if (node.type === CanvasNodeType.Audio) {
        const audioSrc = collectMediaSrc(code, node);
        if (audioSrc.length) {
            return (
                <div className={baseClass} style={style}>
                    <SharedMedia kind="audio" candidates={audioSrc} title={node.title} />
                </div>
            );
        }
    }
    if (node.type === CanvasNodeType.Text) {
        return (
            <div className={`${baseClass} p-3`} style={style}>
                <div className="size-full overflow-hidden whitespace-pre-wrap break-words font-mono text-sm text-stone-700 dark:text-stone-200">{node.metadata?.content || ""}</div>
            </div>
        );
    }
    const Icon = node.type === CanvasNodeType.Video ? Video : node.type === CanvasNodeType.Audio ? Music2 : node.type === CanvasNodeType.Config ? Settings2 : FileText;
    return (
        <div className={`${baseClass} grid place-items-center`} style={style}>
            <div className="flex flex-col items-center gap-2 text-stone-400">
                <Icon className="size-8" />
                <span className="text-xs">{node.title || node.type}</span>
            </div>
        </div>
    );
}
