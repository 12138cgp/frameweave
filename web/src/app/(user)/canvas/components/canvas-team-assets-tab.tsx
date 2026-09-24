"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Empty, Input, Popconfirm, Select, Spin, Tag, Tooltip } from "antd";
import { LoaderCircle, Music2, Search, Trash2, Upload, Video as VideoIcon } from "@/components/icons";

import { cn } from "@/lib/utils";
import { useUserStore } from "@/stores/use-user-store";
import { deleteGroupAsset, groupAssetDisplayName, groupAssetSourceLabel, listGroupAssets, uploadGroupAsset, type GroupAsset, type GroupAssetKind } from "@/services/api/group-assets";

export const GROUP_ASSETS_QUERY_KEY = ["group-assets"];

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

export function TeamAssetsTab({ onInsert, currentCanvasName, currentProjectId, columns = 4, pageSize = 24 }: { onInsert: (asset: GroupAsset) => void; currentCanvasName?: string; currentProjectId?: string; columns?: number; pageSize?: number }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const currentUser = useUserStore((state) => state.user);
    const fileRef = useRef<HTMLInputElement>(null);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [projectFilter, setProjectFilter] = useState("all");
    const [pending, setPending] = useState<{ file: File; name: string } | null>(null);
    const [uploading, setUploading] = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);

    const query = useQuery({ queryKey: GROUP_ASSETS_QUERY_KEY, queryFn: listGroupAssets, retry: false });
    // 项目筛选选项：按已加载素材的来源项目分桶（全部 / 各项目 / 未分类）；≥2 个桶才值得显示筛选控件。
    const { projectOptions, projectBuckets } = useMemo(() => {
        const map = new Map<string, string>();
        let hasUnassigned = false;
        (query.data || []).forEach((item) => {
            if (item.projectId) {
                if (!map.has(item.projectId)) map.set(item.projectId, item.projectName || item.projectId);
            } else {
                hasUnassigned = true;
            }
        });
        const options: { label: string; value: string }[] = [{ label: "全部项目", value: "all" }];
        map.forEach((name, id) => options.push({ label: name, value: id }));
        if (hasUnassigned) options.push({ label: "未分类", value: "__none__" });
        return { projectOptions: options, projectBuckets: map.size + (hasUnassigned ? 1 : 0) };
    }, [query.data]);
    const filtered = useMemo(() => {
        const text = keyword.trim().toLowerCase();
        const matchProject = (item: GroupAsset) => {
            if (projectFilter === "all") return true;
            if (projectFilter === "__none__") return !item.projectId;
            return item.projectId === projectFilter;
        };
        return (query.data || [])
            .filter((item) => kindFilter === "all" || item.kind === kindFilter)
            .filter(matchProject)
            // 搜索同时匹配「自定义名 + 上传者 + 来源画布」——名字不再拼上传者了，
            // 但按人名找素材是常用操作，不能因为改了展示就搜不到。
            .filter((item) => !text || `${groupAssetDisplayName(item)} ${item.ownerName || ""} ${item.sourceCanvasName || ""}`.toLowerCase().includes(text));
    }, [query.data, keyword, kindFilter, projectFilter]);
    // 素材已全部在客户端，默认显示一页；滚到底部哨兵进入视口就多显示一页（修「只卡前 24 个、之前的看不见、下滑不加载」）。
    const [visibleCount, setVisibleCount] = useState(pageSize);
    useEffect(() => {
        setVisibleCount(pageSize);
    }, [keyword, kindFilter, projectFilter, pageSize]);
    const items = filtered.slice(0, visibleCount);
    const hasMore = items.length < filtered.length;
    // callback ref 挂/卸观察器：筛选变化哨兵重挂时自动换到新节点，避免观察到旧节点失效。
    const observerRef = useRef<IntersectionObserver | null>(null);
    const sentinelRef = useCallback(
        (node: HTMLDivElement | null) => {
            observerRef.current?.disconnect();
            if (!node) return;
            observerRef.current = new IntersectionObserver(
                (entries) => {
                    if (entries[0]?.isIntersecting) setVisibleCount((count) => count + pageSize);
                },
                { rootMargin: "300px" },
            );
            observerRef.current.observe(node);
        },
        [pageSize],
    );

    const onPickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        if (!detectKind(file.type)) {
            message.warning("仅支持图片 / 视频 / 音频");
            return;
        }
        setPending({ file, name: file.name.replace(/\.[^.]+$/, "") });
    };

    const confirmUpload = async () => {
        if (!pending) return;
        const kind = detectKind(pending.file.type);
        if (!kind) return;
        setUploading(true);
        try {
            const dims = await readMediaDims(pending.file, kind);
            await uploadGroupAsset({
                blob: pending.file,
                kind,
                customName: pending.name.trim() || pending.file.name,
                sourceCanvasName: currentCanvasName || "",
                projectId: currentProjectId,
                mimeType: pending.file.type,
                fileName: pending.file.name,
                ...dims,
            });
            await queryClient.invalidateQueries({ queryKey: GROUP_ASSETS_QUERY_KEY });
            setPending(null);
            message.success("已上传到团队素材");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "上传失败");
        } finally {
            setUploading(false);
        }
    };

    const remove = async (asset: GroupAsset) => {
        setRemoving(asset.id);
        try {
            await deleteGroupAsset(asset.id);
            await queryClient.invalidateQueries({ queryKey: GROUP_ASSETS_QUERY_KEY });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        } finally {
            setRemoving(null);
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input className="w-44" size="small" prefix={<Search className="size-3.5 text-stone-400" />} placeholder="搜索团队素材" value={keyword} allowClear onChange={(event) => setKeyword(event.target.value)} />
                <div className="flex gap-1.5">
                    {kindOptions.map((opt) => (
                        <Tag.CheckableTag key={opt.value} checked={kindFilter === opt.value} className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")} onChange={() => setKindFilter(opt.value)}>
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
                {projectBuckets >= 2 ? (
                    <Select size="small" className="w-32" value={projectFilter} onChange={setProjectFilter} options={projectOptions} title="按项目筛选" />
                ) : null}
                <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>
                    上传
                </Button>
                <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" className="hidden" onChange={onPickFile} />
            </div>

            {pending ? (
                <div className="flex items-center gap-2 rounded-xl border px-3 py-2">
                    <span className="max-w-[40%] shrink-0 truncate text-xs opacity-60">{pending.file.name}</span>
                    <Input size="small" value={pending.name} maxLength={60} placeholder="给素材起个名字" onChange={(event) => setPending((prev) => (prev ? { ...prev, name: event.target.value } : prev))} onPressEnter={() => void confirmUpload()} />
                    <Button size="small" type="primary" loading={uploading} onClick={() => void confirmUpload()}>
                        确认
                    </Button>
                    <Button size="small" onClick={() => setPending(null)}>
                        取消
                    </Button>
                </div>
            ) : null}

            {query.isLoading ? (
                <div className="flex justify-center py-16">
                    <Spin />
                </div>
            ) : items.length ? (
                <>
                    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                        {items.map((asset) => {
                            const canDelete = currentUser?.id === asset.ownerUserId || currentUser?.role === "admin";
                            return <TeamAssetCard key={asset.id} asset={asset} canDelete={canDelete} removing={removing === asset.id} onInsert={() => onInsert(asset)} onRemove={() => void remove(asset)} />;
                        })}
                    </div>
                    {hasMore ? (
                        <div ref={sentinelRef} className="flex justify-center py-3">
                            <Spin size="small" />
                        </div>
                    ) : null}
                </>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="团队还没有共享素材" className="py-12" />
            )}
        </div>
    );
}

function TeamAssetCard({ asset, canDelete, removing, onInsert, onRemove }: { asset: GroupAsset; canDelete: boolean; removing: boolean; onInsert: () => void; onRemove: () => void }) {
    const title = groupAssetDisplayName(asset);
    // 卡片上只显示自定义名（短、扫一眼就知道是什么）；上传者/来源画布/时间移到 hover 浮窗，
    // 需要追溯「这是谁传的」时才看，平时不占版面。
    const hoverInfo = (
        <div className="whitespace-pre-line text-[12px] leading-relaxed">
            <div className="mb-1 font-medium">{title}</div>
            {groupAssetSourceLabel(asset)}
        </div>
    );
    return (
        <Tooltip title={hoverInfo} mouseEnterDelay={0.35} placement="top">
            <div className="group/asset relative overflow-hidden rounded-xl bg-card ring-1 ring-border transition hover:ring-[#2563EB]/40">
            <button type="button" className="block w-full cursor-pointer text-left" onClick={onInsert}>
                {asset.kind === "image" ? (
                    <img src={asset.url} alt={title} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                ) : asset.kind === "video" ? (
                    <video src={asset.url} className="aspect-[4/3] w-full bg-black object-cover" muted preload="metadata" />
                ) : (
                    <div className="flex aspect-[4/3] w-full items-center justify-center bg-stone-100 dark:bg-stone-800">
                        <Music2 className="size-7 opacity-40" />
                    </div>
                )}
                <div className="flex items-center gap-1 p-2">
                    {asset.kind === "video" ? <VideoIcon className="size-3 shrink-0 opacity-50" /> : asset.kind === "audio" ? <Music2 className="size-3 shrink-0 opacity-50" /> : null}
                    <span className="line-clamp-1 text-[11px] font-medium text-stone-700 dark:text-stone-200">{title}</span>
                </div>
                <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[60%] items-center justify-center bg-[#0F172A]/0 text-sm font-medium text-[#FFFFFF] opacity-0 transition group-hover/asset:bg-[#0F172A]/55 group-hover/asset:opacity-100">取用到画布</div>
            </button>
            {canDelete ? (
                <Popconfirm
                    title="删除这个团队素材?"
                    description="删除后组内成员将无法再取用"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={onRemove}
                >
                    <button
                        type="button"
                        className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-lg bg-black/55 text-white shadow-sm ring-1 ring-white/15 transition hover:bg-red-600 group-hover/asset:bg-red-600/90"
                        onClick={(event) => event.stopPropagation()}
                        aria-label="删除素材"
                        title="删除素材"
                    >
                        {removing ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    </button>
                </Popconfirm>
            ) : null}
            </div>
        </Tooltip>
    );
}

function detectKind(mime: string): GroupAssetKind | null {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return null;
}

// 读图片/视频固有宽高，让取用到画布的节点比例正确；音频无需。
function readMediaDims(file: File, kind: GroupAssetKind): Promise<{ width?: number; height?: number }> {
    if (kind === "audio") return Promise.resolve({});
    const url = URL.createObjectURL(file);
    return new Promise((resolve) => {
        const done = (width?: number, height?: number) => {
            URL.revokeObjectURL(url);
            resolve(width && height ? { width, height } : {});
        };
        if (kind === "image") {
            const img = new Image();
            img.onload = () => done(img.naturalWidth, img.naturalHeight);
            img.onerror = () => done();
            img.src = url;
        } else {
            const video = document.createElement("video");
            video.preload = "metadata";
            video.onloadedmetadata = () => done(video.videoWidth, video.videoHeight);
            video.onerror = () => done();
            video.src = url;
        }
    });
}
