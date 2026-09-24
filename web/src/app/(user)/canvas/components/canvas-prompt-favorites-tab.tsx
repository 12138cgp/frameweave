"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Empty, Input, Modal, Pagination, Spin, Tag } from "antd";
import { Image as ImageIcon, Star, Trash2, Video as VideoIcon } from "@/components/icons";

import { useCopyText } from "@/hooks/use-copy-text";
import { useUserStore } from "@/stores/use-user-store";
import { deletePromptFavorite, fetchMyPromptFavorites, fetchPromptFavoriteBlob, myPromptFavoriteFileURL, parsePromptFavoriteJSON, parsePromptFavoriteRefs, type PromptFavorite, type PromptFavoriteRef } from "@/services/api/prompt-favorite";

// 「收藏提示词」列表。
//
// ⚠️ 数据源是服务端 prompt_favorites 表，**不是** useAssetStore。
// 「我的素材」那套是前端 IndexedDB + 整包 JSON 云同步，服务端从不解析；而收藏要让管理员
// 批量提取，所以单独落表。别为了「看起来统一」把它塞回 assetStore——那等于让后端去解析前端结构。

type FavoriteConfig = {
    model?: string;
    size?: string;
    quality?: string;
    seconds?: number;
    vquality?: string;
};

// FavoriteMedia 取一份收藏副本并渲染。
//
// 不能直接把 URL 塞进 src：这些接口要 Authorization 头，而 img/video 标签发的请求带不了头。
// 所以先 fetch 成 blob 再转 object URL（与 image-storage.ts 的 resolveImageUrl 同一套路）。
function FavoriteMedia({ favoriteId, fileKey, mimeType, kind, className }: { favoriteId: string; fileKey?: string; mimeType?: string; kind: string; className?: string }) {
    const token = useUserStore((state) => state.token);
    const [url, setUrl] = useState("");
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!fileKey) return;
        let cancelled = false;
        let objectUrl = "";
        void (async () => {
            try {
                const blob = await fetchPromptFavoriteBlob(myPromptFavoriteFileURL(favoriteId, fileKey), token || undefined);
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setUrl(objectUrl);
            } catch {
                // 取不到就显示占位，不弹错误——缩略图挂掉不该打断用户浏览列表。
                if (!cancelled) setFailed(true);
            }
        })();
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [favoriteId, fileKey, token]);

    const boxClass = className || "size-full";
    if (!fileKey || failed) {
        return <div className={`grid place-items-center rounded-lg bg-black/5 text-[11px] opacity-50 dark:bg-white/10 ${boxClass}`}>无预览</div>;
    }
    if (!url) {
        return (
            <div className={`grid place-items-center rounded-lg bg-black/5 dark:bg-white/10 ${boxClass}`}>
                <Spin size="small" />
            </div>
        );
    }
    if (kind === "video") {
        return <video className={`rounded-lg object-cover ${boxClass}`} src={url} controls preload="metadata" />;
    }
    if (kind === "audio") {
        return <audio className="w-full" src={url} controls preload="metadata" />;
    }
    return <img className={`rounded-lg object-cover ${boxClass}`} src={url} alt="收藏预览" />;
}

function refKindLabel(kind: string) {
    if (kind === "image") return "图片";
    if (kind === "video") return "视频";
    if (kind === "audio") return "音频";
    return "文本";
}

function formatFavoriteTime(value: string) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
}

// 摘要文案：优先烘焙版（带「图片1」这类编号，更接近用户当时看到的内容），退回原文。
function favoriteSummary(item: PromptFavorite) {
    const text = item.prompt || item.promptDraft || "";
    return text.trim();
}

export function PromptFavoritesTab({ onApply, columns = 2, pageSize = 12 }: { onApply?: (item: PromptFavorite) => void; columns?: number; pageSize?: number }) {
    const token = useUserStore((state) => state.token);
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const [items, setItems] = useState<PromptFavorite[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(false);
    const [draftKeyword, setDraftKeyword] = useState("");
    const [keyword, setKeyword] = useState("");
    const [detail, setDetail] = useState<PromptFavorite | null>(null);

    const load = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        try {
            const data = await fetchMyPromptFavorites({ keyword, page, pageSize }, token);
            setItems(data?.items || []);
            setTotal(data?.total || 0);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载收藏失败");
        } finally {
            setLoading(false);
        }
    }, [keyword, page, pageSize, token, message]);

    useEffect(() => {
        void load();
    }, [load]);

    const removeFavorite = (item: PromptFavorite) => {
        modal.confirm({
            title: "删除这条收藏？",
            content: "提示词和已保存的参考素材副本都会被删除，不影响画布上的原节点。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await deletePromptFavorite(item.id, token || undefined);
                    message.success("已删除");
                    setDetail(null);
                    void load();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除失败");
                }
            },
        });
    };

    const applyFavorite = (item: PromptFavorite) => {
        if (!onApply) return;
        onApply(item);
        setDetail(null);
    };

    const gridClass = columns === 2 ? "grid grid-cols-2 gap-2" : "grid grid-cols-3 gap-3";

    if (!token) {
        return <Empty description="登录后可查看收藏" />;
    }

    return (
        <div className="flex min-h-0 flex-col gap-2">
            <Input.Search
                allowClear
                size="small"
                placeholder="搜提示词 / 画布名"
                value={draftKeyword}
                onChange={(event) => setDraftKeyword(event.target.value)}
                onSearch={(value) => {
                    setKeyword(value.trim());
                    setPage(1);
                }}
            />
            <Spin spinning={loading}>
                <FavoriteGrid items={items} gridClass={gridClass} onOpen={setDetail} />
            </Spin>
            <Pagination size="small" align="center" current={page} pageSize={pageSize} total={total} showSizeChanger={false} onChange={setPage} />
            <FavoriteDetailModal item={detail} canApply={Boolean(onApply)} onClose={() => setDetail(null)} onApply={applyFavorite} onRemove={removeFavorite} onCopy={(text) => copyText(text, "提示词已复制")} />
        </div>
    );
}

function FavoriteGrid({ items, gridClass, onOpen }: { items: PromptFavorite[]; gridClass: string; onOpen: (item: PromptFavorite) => void }) {
    if (!items.length) {
        return <Empty description="还没有收藏。在画布上觉得某次生成效果好，点节点工具栏的「收藏」即可。" />;
    }
    return (
        <div className={gridClass}>
            {items.map((item) => (
                <FavoriteCard key={item.id} item={item} onOpen={onOpen} />
            ))}
        </div>
    );
}

function FavoriteCard({ item, onOpen }: { item: PromptFavorite; onOpen: (item: PromptFavorite) => void }) {
    const refs = parsePromptFavoriteRefs(item.references);
    const summary = favoriteSummary(item);
    const isVideo = item.kind === "video";
    let kindIcon = <ImageIcon className="size-3" />;
    if (isVideo) kindIcon = <VideoIcon className="size-3" />;
    return (
        <button type="button" className="group flex flex-col gap-1.5 rounded-xl border border-black/5 p-1.5 text-left transition hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5" onClick={() => onOpen(item)} title={summary}>
            <div className="aspect-square w-full overflow-hidden rounded-lg">
                <FavoriteMedia favoriteId={item.id} fileKey={item.resultFileKey} mimeType={item.resultMimeType} kind="image" />
            </div>
            <span className="line-clamp-2 text-[11px] leading-snug opacity-80">{summary || "（无提示词）"}</span>
            <span className="flex items-center gap-1 text-[10px] opacity-50">
                {kindIcon}
                {refs.length > 0 ? <span>{refs.length} 项参考</span> : <span>无参考</span>}
            </span>
        </button>
    );
}

function FavoriteDetailModal({ item, canApply, onClose, onApply, onRemove, onCopy }: { item: PromptFavorite | null; canApply: boolean; onClose: () => void; onApply: (item: PromptFavorite) => void; onRemove: (item: PromptFavorite) => void; onCopy: (text: string) => void }) {
    if (!item) return null;
    const refs = parsePromptFavoriteRefs(item.references);
    const config = parsePromptFavoriteJSON<FavoriteConfig>(item.config);
    const promptText = item.prompt || item.promptDraft || "";
    const showDraft = Boolean(item.promptDraft) && item.promptDraft !== item.prompt;
    const footer = buildDetailFooter(item, canApply, onApply, onRemove, onCopy, promptText);
    return (
        <Modal open width={720} title="收藏详情" onCancel={onClose} footer={footer}>
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Tag>{item.kind === "video" ? "视频" : "图片"}</Tag>
                    {config?.model ? <Tag>{config.model}</Tag> : null}
                    {config?.size ? <Tag>{config.size}</Tag> : null}
                    {config?.quality ? <Tag>{config.quality}</Tag> : null}
                    {config?.seconds ? <Tag>{config.seconds} 秒</Tag> : null}
                    <span className="opacity-50">{item.canvasTitle || "未命名画布"}</span>
                    <span className="opacity-50">{formatFavoriteTime(item.createdAt)}</span>
                </div>

                <div className="max-h-64 overflow-hidden rounded-lg">
                    <FavoriteMedia favoriteId={item.id} fileKey={item.resultFileKey} mimeType={item.resultMimeType} kind={item.kind} className="max-h-64 w-full" />
                </div>

                <section className="flex flex-col gap-1">
                    <span className="text-xs font-medium opacity-70">提示词</span>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/5 p-2 text-xs leading-relaxed dark:bg-white/10">{promptText || "（无）"}</pre>
                </section>

                {showDraft ? (
                    <section className="flex flex-col gap-1">
                        <span className="text-xs font-medium opacity-70">
                            原始输入（含 @引用，回填画布用这份）
                        </span>
                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-black/5 p-2 text-xs leading-relaxed dark:bg-white/10">{item.promptDraft}</pre>
                    </section>
                ) : null}

                <FavoriteRefList favoriteId={item.id} refs={refs} />
            </div>
        </Modal>
    );
}

// 页脚按钮单独算好再传给 Modal：JSX 属性里不写三元/短路是本项目规避 bun SSG 段错误的既有约定。
function buildDetailFooter(item: PromptFavorite, canApply: boolean, onApply: (item: PromptFavorite) => void, onRemove: (item: PromptFavorite) => void, onCopy: (text: string) => void, promptText: string) {
    const buttons = [
        <Button key="delete" danger icon={<Trash2 className="size-3.5" />} onClick={() => onRemove(item)}>
            删除
        </Button>,
        <Button key="copy" onClick={() => onCopy(promptText)}>
            复制提示词
        </Button>,
    ];
    if (canApply) {
        buttons.push(
            <Button key="apply" type="primary" icon={<Star className="size-3.5" />} onClick={() => onApply(item)}>
                填入画布
            </Button>,
        );
    }
    return buttons;
}

function FavoriteRefList({ favoriteId, refs }: { favoriteId: string; refs: PromptFavoriteRef[] }) {
    if (!refs.length) {
        return <span className="text-xs opacity-50">这次生成没有用参考素材。</span>;
    }
    return (
        <section className="flex flex-col gap-1.5">
            <span className="text-xs font-medium opacity-70">参考素材（{refs.length} 项，编号与提示词里的引用一致）</span>
            <div className="grid grid-cols-4 gap-2">
                {refs.map((item, index) => (
                    <FavoriteRefCard key={`${item.label}-${index}`} favoriteId={favoriteId} refItem={item} />
                ))}
            </div>
        </section>
    );
}

// 参数名用 refItem 而不是 ref：ref 是 React 的保留 prop，会被当成元素引用处理、拿不到值。
function FavoriteRefCard({ favoriteId, refItem }: { favoriteId: string; refItem: PromptFavoriteRef }) {
    const label = refItem.label || refKindLabel(refItem.kind);
    if (refItem.kind === "text") {
        return (
            <div className="flex flex-col gap-1 rounded-lg border border-black/5 p-1.5 dark:border-white/10">
                <span className="text-[10px] font-medium opacity-60">{label}</span>
                <span className="line-clamp-4 text-[11px] leading-snug opacity-80">{refItem.text}</span>
            </div>
        );
    }
    if (refItem.missing) {
        return (
            <div className="flex flex-col gap-1 rounded-lg border border-black/5 p-1.5 dark:border-white/10">
                <span className="text-[10px] font-medium opacity-60">{label}</span>
                <span className="text-[10px] leading-snug text-[#DC2626] dark:text-[#EF4444]">未能保存副本</span>
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-1 rounded-lg border border-black/5 p-1.5 dark:border-white/10">
            <span className="text-[10px] font-medium opacity-60">{label}</span>
            <div className="aspect-square w-full overflow-hidden rounded">
                <FavoriteMedia favoriteId={favoriteId} fileKey={refItem.fileKey} mimeType={refItem.mimeType} kind={refItem.kind} />
            </div>
        </div>
    );
}
