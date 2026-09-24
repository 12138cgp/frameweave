"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Form, Input, Modal, Select, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { DownloadOutlined, ReloadOutlined } from "@/components/icons";
import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { useUserStore } from "@/stores/use-user-store";
import { adminPromptFavoriteFileURL, fetchAdminPromptFavorites, fetchPromptFavoriteBlob, parsePromptFavoriteJSON, parsePromptFavoriteRefs, type PromptFavorite, type PromptFavoriteRef } from "@/services/api/prompt-favorite";

// 后台「收藏提示词」：看全站用户收藏了哪些提示词，并连同参考素材批量导出。
//
// 仅超管。后端也挂在超管专用组（admin 而不是 anyAdmin）——这两个接口能读到全平台任意用户的
// 提示词原文和素材副本，二级管理员没有跨组查看别人创作的业务理由。
//
// ⚠️ 本文件的写法约定（沿用 task-logs-inner 的规避方案）：
// 条件判断一律搬进 if / 提前算好的变量，JSX 属性里不写三元、不写 || 短路、不用泛型 JSX。
// 这是为了规避 bun 1.3.13 在 SSG「Collecting page data」阶段对复杂模块的段错误（exit132）。
// 本页通过 content hub 的 ssr:false 外壳加载，但直接访问 /admin/prompt-favorites 时仍会被评估。

const kindFilterOptions = [
    { label: "全部类型", value: "" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
];

type FavoriteConfig = {
    model?: string;
    size?: string;
    quality?: string;
    seconds?: number;
};

const emptyFilters = { keyword: "", userId: "", kind: "" };

function formatTime(value: string) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
}

function kindText(kind: string) {
    if (kind === "video") return "视频";
    if (kind === "image") return "图片";
    return kind;
}

// 文件名安全化：用户名、画布名都可能带斜杠、引号、换行，直接拼进 zip 路径会生成坏包。
function safeName(value: string, fallback: string) {
    const cleaned = (value || "").replace(/[^\w一-龥-]+/g, "_").replace(/^_+|_+$/g, "");
    if (!cleaned) return fallback;
    return cleaned.slice(0, 40);
}

function extFromMime(mimeType: string) {
    const mt = (mimeType || "").toLowerCase();
    if (mt.includes("png")) return "png";
    if (mt.includes("webp")) return "webp";
    if (mt.includes("gif")) return "gif";
    if (mt.includes("jpeg")) return "jpg";
    if (mt.includes("jpg")) return "jpg";
    if (mt.includes("mp4")) return "mp4";
    if (mt.includes("webm")) return "webm";
    if (mt.includes("mpeg")) return "mp3";
    if (mt.includes("wav")) return "wav";
    if (mt.includes("aac")) return "aac";
    if (mt.includes("ogg")) return "ogg";
    return "bin";
}

// CSV 单元格转义：含逗号/引号/换行时用引号包裹并把引号翻倍（与后台其它导出同一套）。
function csvCell(value: string | number | null | undefined): string {
    const s = value === null || value === undefined ? "" : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function buildCsv(rows: (string | number)[][]) {
    // ﻿ = UTF-8 BOM，让 Excel 正确识别中文不乱码。
    return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export default function Inner() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const [draft, setDraft] = useState(emptyFilters);
    const [filters, setFilters] = useState(emptyFilters);
    const [items, setItems] = useState<PromptFavorite[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [loading, setLoading] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [detail, setDetail] = useState<PromptFavorite | null>(null);

    const load = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        try {
            const data = await fetchAdminPromptFavorites({ ...filters, page, pageSize }, token);
            setItems(data?.items || []);
            setTotal(data?.total || 0);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [filters, page, pageSize, token, message]);

    useEffect(() => {
        void load();
    }, [load]);

    // 拉取要导出的全部记录。
    //
    // 单页上限 500（model.MaxPageSize），全站收藏可能远多于此，所以必须按 total 循环翻页——
    // 只拉第一页就当全量，会导出一个「看起来成功、其实少了一大半」的包，这种错最难发现。
    const fetchAllForExport = useCallback(
        async (scopeIds: string[]) => {
            const collected: PromptFavorite[] = [];
            let current = 1;
            for (;;) {
                const data = await fetchAdminPromptFavorites({ ...filters, page: current, all: "1" }, token || undefined);
                const batch = data?.items || [];
                collected.push(...batch);
                const grandTotal = data?.total || 0;
                if (batch.length === 0) break;
                if (collected.length >= grandTotal) break;
                current += 1;
                // 硬上限，防止后端 total 与实际不一致时打死循环。
                if (current > 200) break;
            }
            if (scopeIds.length === 0) return collected;
            const wanted = new Set(scopeIds);
            return collected.filter((item) => wanted.has(item.id));
        },
        [filters, token],
    );

    const exportZip = async () => {
        setExporting(true);
        try {
            const records = await fetchAllForExport(selectedIds);
            if (records.length === 0) {
                message.warning("没有可导出的记录");
                return;
            }
            const csvRows: (string | number)[][] = [["序号", "用户", "分组", "画布", "类型", "模型", "提示词(烘焙版)", "原始输入", "参考素材数", "未能保存的素材数", "收藏时间"]];
            // createZip 的 data 是 BlobPart，字符串和 Blob 都能直接塞，不必自己编码。
            const files: { name: string; data: BlobPart }[] = [];
            let failedFiles = 0;

            for (let index = 0; index < records.length; index += 1) {
                const item = records[index];
                const refs = parsePromptFavoriteRefs(item.references);
                const config = parsePromptFavoriteJSON<FavoriteConfig>(item.config);
                const missingCount = refs.filter((ref) => ref.missing).length;
                const seq = index + 1;
                csvRows.push([seq, item.username || item.userId, item.groupName || "", item.canvasTitle || "", kindText(item.kind), config?.model || "", item.prompt || "", item.promptDraft || "", refs.length, missingCount, formatTime(item.createdAt)]);

                const dirName = `${String(seq).padStart(4, "0")}-${safeName(item.username, "用户")}`;
                // 提示词也单独落一个文本文件：导出包最常见的用法是「把好提示词发给别人」，
                // 让人从 CSV 单元格里复制多行文本是很难用的。
                const promptText = `【提示词（烘焙版）】\n${item.prompt || ""}\n\n【原始输入】\n${item.promptDraft || ""}\n\n【画布】${item.canvasTitle || ""}\n【用户】${item.username || item.userId}\n【时间】${formatTime(item.createdAt)}\n`;
                files.push({ name: `${dirName}/提示词.txt`, data: promptText });

                if (item.resultFileKey) {
                    const blob = await fetchPromptFavoriteBlob(adminPromptFavoriteFileURL(item.id, item.resultFileKey), token || undefined).catch(() => null);
                    if (blob) files.push({ name: `${dirName}/成品.${extFromMime(item.resultMimeType)}`, data: blob });
                    else failedFiles += 1;
                }
                for (let refIndex = 0; refIndex < refs.length; refIndex += 1) {
                    const ref = refs[refIndex];
                    if (ref.kind === "text") {
                        files.push({ name: `${dirName}/参考-${safeName(ref.label, `文本${refIndex + 1}`)}.txt`, data: ref.text || "" });
                        continue;
                    }
                    if (!ref.fileKey) continue;
                    const blob = await fetchPromptFavoriteBlob(adminPromptFavoriteFileURL(item.id, ref.fileKey), token || undefined).catch(() => null);
                    if (!blob) {
                        failedFiles += 1;
                        continue;
                    }
                    files.push({ name: `${dirName}/参考-${safeName(ref.label, `素材${refIndex + 1}`)}.${extFromMime(ref.mimeType || "")}`, data: blob });
                }
            }

            files.unshift({ name: "清单.csv", data: buildCsv(csvRows) });
            files.unshift({ name: "favorites.json", data: JSON.stringify(records, null, 2) });
            const zip = await createZip(files);
            saveAs(zip, `收藏提示词-${records.length}条.zip`);
            if (failedFiles > 0) {
                // 如实报告。少了几个文件却说「导出成功」，等于把问题藏起来留给以后。
                message.warning(`已导出 ${records.length} 条，但有 ${failedFiles} 个素材文件取不到（源已丢失）`);
                return;
            }
            message.success(`已导出 ${records.length} 条`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出失败");
        } finally {
            setExporting(false);
        }
    };

    const columns: TableColumnsType<PromptFavorite> = [
        { title: "用户", dataIndex: "username", width: 120, render: (_, row) => row.username || row.userId },
        { title: "分组", dataIndex: "groupName", width: 110 },
        { title: "类型", dataIndex: "kind", width: 70, render: (value: string) => <Tag>{kindText(value)}</Tag> },
        {
            title: "提示词",
            dataIndex: "prompt",
            render: (_, row) => {
                const text = row.prompt || row.promptDraft || "";
                return <span className="line-clamp-2 text-xs leading-snug">{text}</span>;
            },
        },
        {
            title: "参考",
            width: 90,
            render: (_, row) => {
                const refs = parsePromptFavoriteRefs(row.references);
                const missing = refs.filter((ref) => ref.missing).length;
                if (missing > 0) return <Tag color="warning">{`${refs.length} (缺${missing})`}</Tag>;
                return <span>{refs.length}</span>;
            },
        },
        { title: "画布", dataIndex: "canvasTitle", width: 130 },
        { title: "收藏时间", dataIndex: "createdAt", width: 160, render: (value: string) => formatTime(value) },
        {
            title: "操作",
            width: 80,
            render: (_, row) => (
                <Button size="small" type="link" onClick={() => setDetail(row)}>
                    详情
                </Button>
            ),
        },
    ];

    let exportLabel = "导出全部（ZIP）";
    if (selectedIds.length > 0) exportLabel = `导出选中 ${selectedIds.length} 条（ZIP）`;

    return (
        <div className="flex flex-col gap-3">
            <Card size="small">
                <Form layout="inline" className="gap-y-2">
                    <Form.Item label="关键词">
                        <Input allowClear placeholder="提示词 / 用户名 / 画布名" value={draft.keyword} onChange={(event) => setDraft({ ...draft, keyword: event.target.value })} style={{ width: 240 }} />
                    </Form.Item>
                    <Form.Item label="用户 ID">
                        <Input allowClear placeholder="精确匹配" value={draft.userId} onChange={(event) => setDraft({ ...draft, userId: event.target.value })} style={{ width: 200 }} />
                    </Form.Item>
                    <Form.Item label="类型">
                        <Select options={kindFilterOptions} value={draft.kind} onChange={(value) => setDraft({ ...draft, kind: value })} style={{ width: 120 }} />
                    </Form.Item>
                    <Form.Item>
                        <Button
                            type="primary"
                            onClick={() => {
                                setFilters(draft);
                                setPage(1);
                            }}
                        >
                            查询
                        </Button>
                    </Form.Item>
                    <Form.Item>
                        <Button
                            onClick={() => {
                                setDraft(emptyFilters);
                                setFilters(emptyFilters);
                                setPage(1);
                            }}
                        >
                            重置
                        </Button>
                    </Form.Item>
                    <Form.Item>
                        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                            刷新
                        </Button>
                    </Form.Item>
                    <Form.Item>
                        <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportZip()}>
                            {exportLabel}
                        </Button>
                    </Form.Item>
                </Form>
            </Card>

            <Table
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={items}
                columns={columns}
                rowSelection={{ selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys.map(String)) }}
                pagination={{
                    current: page,
                    pageSize,
                    total,
                    showSizeChanger: true,
                    pageSizeOptions: [10, 20, 50, 100],
                    showTotal: (count) => `共 ${count} 条`,
                    onChange: (nextPage, nextSize) => {
                        setPage(nextPage);
                        if (nextSize !== pageSize) setPageSize(nextSize);
                    },
                }}
            />

            <AdminFavoriteDetail item={detail} onClose={() => setDetail(null)} />
        </div>
    );
}

function AdminFavoriteDetail({ item, onClose }: { item: PromptFavorite | null; onClose: () => void }) {
    if (!item) return null;
    const refs = parsePromptFavoriteRefs(item.references);
    const config = parsePromptFavoriteJSON<FavoriteConfig>(item.config);
    return (
        <Modal open width={760} title="收藏详情" onCancel={onClose} footer={null}>
            <div className="flex flex-col gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                    <Tag>{kindText(item.kind)}</Tag>
                    {config?.model ? <Tag>{config.model}</Tag> : null}
                    {config?.size ? <Tag>{config.size}</Tag> : null}
                    <span className="opacity-60">
                        {item.username} · {item.groupName} · {item.canvasTitle} · {formatTime(item.createdAt)}
                    </span>
                </div>
                <section className="flex flex-col gap-1">
                    <span className="text-xs font-medium opacity-70">提示词（烘焙版，编号与参考素材对应）</span>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 text-xs dark:bg-white/10">{item.prompt || "（无）"}</pre>
                </section>
                <section className="flex flex-col gap-1">
                    <span className="text-xs font-medium opacity-70">原始输入（含 @引用 token）</span>
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 text-xs dark:bg-white/10">{item.promptDraft || "（无）"}</pre>
                </section>
                <AdminRefTable refs={refs} />
            </div>
        </Modal>
    );
}

function AdminRefTable({ refs }: { refs: PromptFavoriteRef[] }) {
    if (!refs.length) return <span className="text-xs opacity-60">这次生成没有用参考素材。</span>;
    return (
        <section className="flex flex-col gap-1">
            <span className="text-xs font-medium opacity-70">参考素材（{refs.length} 项）</span>
            <ul className="flex flex-col gap-1 text-xs">
                {refs.map((ref, index) => (
                    <li key={`${ref.label}-${index}`} className="flex items-center gap-2">
                        <Tag>{ref.label || kindText(ref.kind)}</Tag>
                        <span className="opacity-60">{ref.kind}</span>
                        {ref.missing ? <span className="text-[#DC2626]">未能保存副本</span> : <span className="opacity-50">已保存</span>}
                        {ref.text ? <span className="line-clamp-1 opacity-70">{ref.text}</span> : null}
                    </li>
                ))}
            </ul>
        </section>
    );
}
