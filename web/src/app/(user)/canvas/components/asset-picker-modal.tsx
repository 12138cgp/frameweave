"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Empty, Input, Modal, Pagination, Popconfirm, Spin, Tabs, Tag } from "antd";
import { Search, Trash2 } from "@/components/icons";
import axios from "axios";

import { cn } from "@/lib/utils";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { fetchAssetLibrary, type AssetLibraryItem } from "@/services/api/assets";

// prompt-favorites（收藏提示词）的数据源是服务端 prompt_favorites 表，不是 useAssetStore——
// 它要能被管理员批量提取，所以单独落表。详见 canvas-prompt-favorites-tab.tsx。
export type AssetPickerTab = "my-assets" | "library" | "team-assets" | "prompt-favorites";

export type InsertAssetPayload = { kind: "text"; content: string; title: string } | { kind: "image"; dataUrl: string; title: string; storageKey?: string; portraitAssetId?: string; portraitAssetStatus?: "processing" | "active" | "failed"; portraitAssetUri?: string } | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number } | { kind: "audio"; url: string; title: string; storageKey?: string; durationMs?: number; mimeType?: string; bytes?: number } | { kind: "group"; title: string; nodes: unknown[]; connections: unknown[] };

type Props = {
    open: boolean;
    defaultTab?: AssetPickerTab;
    onInsert: (payload: InsertAssetPayload) => void;
    onClose: () => void;
};

export function AssetPickerModal({ open, defaultTab = "my-assets", onInsert, onClose }: Props) {
    const [activeTab, setActiveTab] = useState<AssetPickerTab>(defaultTab);

    useEffect(() => {
        if (open) setActiveTab(defaultTab);
    }, [open, defaultTab]);

    return (
        <Modal title={<span className="font-heading font-medium tracking-wide">选择素材</span>} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as AssetPickerTab)}
                items={[
                    { key: "my-assets", label: "我的素材", children: <MyAssetsTab onInsert={onInsert} /> },
                    { key: "library", label: "素材库", children: <LibraryTab onInsert={onInsert} /> },
                ]}
            />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
];

export function LibraryTab({ onInsert, columns = 4, pageSize = PAGE_SIZE }: { onInsert: (payload: InsertAssetPayload) => void; columns?: number; pageSize?: number }) {
    const { message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("");
    const [page, setPage] = useState(1);
    const [inserting, setInserting] = useState<string | null>(null);

    const query = useQuery({
        queryKey: ["asset-picker-library", keyword, kindFilter, page, pageSize],
        queryFn: () => fetchAssetLibrary({ keyword, type: kindFilter, page, pageSize }),
        retry: false,
    });

    const items = query.data?.items || [];
    const total = query.data?.total || 0;

    const handleInsert = async (asset: AssetLibraryItem) => {
        try {
            setInserting(asset.id);
            if (asset.type === "text") {
                onInsert({ kind: "text", content: asset.content, title: asset.title });
            } else {
                const dataUrl = await remoteImageToDataUrl(asset.url);
                onInsert({ kind: "image", dataUrl, title: asset.title });
            }
        } catch {
            message.error("插入失败");
        } finally {
            setInserting(null);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder="搜索素材"
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
                    {[
                        { label: "全部", value: "" },
                        { label: "文本", value: "text" },
                        { label: "图片", value: "image" },
                    ].map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value || "all"}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(opt.value);
                            }}
                        >
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            {query.isLoading ? (
                <div className="flex justify-center py-16">
                    <Spin />
                </div>
            ) : items.length ? (
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                    {items.map((asset) => (
                        <PickerCard key={asset.id} title={asset.title} kind={asset.type} cover={asset.coverUrl} loading={inserting === asset.id} onClick={() => void handleInsert(asset)} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有素材" className="py-12" />
            )}

            {total > pageSize && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={pageSize} total={total} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}

function PickerCard({ title, kind, cover, loading, onClick, onDelete }: { title: string; kind: string; cover: string; loading?: boolean; onClick: () => void; onDelete?: () => void }) {
    return (
        <div className="group relative overflow-hidden rounded-xl bg-card ring-1 ring-border transition duration-300 hover:shadow-[0_10px_28px_rgba(15,23,42,.14)] hover:ring-[#2563EB]/40 dark:hover:shadow-[0_10px_28px_rgba(0,0,0,.45)] dark:hover:ring-[#3B82F6]/40">
            <button type="button" className="block w-full cursor-pointer text-left" onClick={onClick} disabled={loading}>
                {cover ? (
                    <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
                ) : (
                    <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{title}</div>
                )}
                <div className="p-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                        <Tag className="m-0 shrink-0 text-[10px]">{kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : kind === "group" ? "组" : "文本"}</Tag>
                    </div>
                </div>
                {loading && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-[#F8FAFC]/60 dark:bg-[#121C30]/60">
                        <Spin size="small" />
                    </div>
                )}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-[#0F172A]/0 text-sm font-medium text-[#FFFFFF] opacity-0 transition duration-300 group-hover:bg-[#0F172A]/70 group-hover:opacity-100">插入</div>
            </button>
            {onDelete ? (
                <Popconfirm title="删除这个素材?" description="从「我的素材」移除" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={onDelete}>
                    <button type="button" className="absolute right-1.5 top-1.5 z-10 flex size-6 items-center justify-center rounded-lg bg-black/55 text-white shadow-sm ring-1 ring-white/15 transition hover:bg-red-600" onClick={(e) => e.stopPropagation()} aria-label="删除素材" title="删除素材">
                        <Trash2 className="size-3.5" />
                    </button>
                </Popconfirm>
            ) : null}
        </div>
    );
}

async function remoteImageToDataUrl(url: string) {
    const response = await axios.get(url, { responseType: "blob" });
    const blob = response.data as Blob;
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}

export function MyAssetsTab({ onInsert, columns = 4, pageSize = PAGE_SIZE }: { onInsert: (payload: InsertAssetPayload) => void; columns?: number; pageSize?: number }) {
    const assets = useAssetStore((state) => state.assets);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [page, setPage] = useState(1);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video" || a.kind === "audio" || a.kind === "group")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length, pageSize]);

    const handleInsert = (asset: Asset) => {
        if (asset.kind === "text") {
            onInsert({ kind: "text", content: asset.data.content, title: asset.title });
        } else if (asset.kind === "audio") {
            onInsert({ kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, durationMs: asset.data.durationMs, mimeType: asset.data.mimeType, bytes: asset.data.bytes });
        } else if (asset.kind === "group") {
            onInsert({ kind: "group", title: asset.data.title, nodes: asset.data.nodes, connections: asset.data.connections });
        } else {
            onInsert(asset.kind === "video" ? { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height } : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, portraitAssetId: asset.metadata?.portraitAssetId as string | undefined, portraitAssetStatus: asset.metadata?.portraitAssetStatus as "processing" | "active" | "failed" | undefined, portraitAssetUri: asset.metadata?.portraitAssetUri as string | undefined });
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder="搜索素材"
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
                    {kindOptions.map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(opt.value);
                            }}
                        >
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            {visible.length ? (
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} title={asset.title} kind={asset.kind} cover={asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "")} onClick={() => handleInsert(asset)} onDelete={() => removeAsset(asset.id)} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有素材" className="py-12" />
            )}

            {filtered.length > pageSize && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={pageSize} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}
