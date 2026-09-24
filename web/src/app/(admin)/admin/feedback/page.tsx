"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Alert, Badge, Button, Card, Col, DatePicker, Descriptions, Form, Input, Modal, Row, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { Download, RefreshCw } from "@/components/icons";

import {
    adminFeedbackLogURL,
    feedbackCategoryLabels,
    feedbackCategoryOptions,
    feedbackStatusColors,
    feedbackStatusLabels,
    feedbackStatusOptions,
    fetchAdminFeedbackDetail,
    fetchAdminFeedbacks,
    updateAdminFeedback,
    type AdminFeedbackItem,
    type FeedbackLogEntry,
    type FeedbackStatus,
} from "@/services/api/feedback";
import { useUserStore } from "@/stores/use-user-store";

const { Paragraph, Text } = Typography;

// 后台「用户反馈」。
//
// 这一页的设计只围绕一个问题：**用户说他东西没了，到底是不是真的没了、怎么没的。**
// 所以详情里把四份材料并排放：用户的话 / 服务端看到的 / 用户那边看到的 / 操作日志。
// 服务端那份排在最前面，因为它是唯一不受客户端说法影响的证据。

type Filters = { status: string; category: string; keyword: string; range: [Dayjs, Dayjs] | null };

const emptyFilters: Filters = { status: "", category: "", keyword: "", range: null };

export default function AdminFeedbackPage() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const [draft, setDraft] = useState<Filters>(emptyFilters);
    const [filters, setFilters] = useState<Filters>(emptyFilters);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [items, setItems] = useState<AdminFeedbackItem[]>([]);
    const [total, setTotal] = useState(0);
    const [openCount, setOpenCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const [detailId, setDetailId] = useState<number | null>(null);

    const load = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        try {
            const result = await fetchAdminFeedbacks(token, {
                status: filters.status,
                category: filters.category,
                keyword: filters.keyword,
                start: filters.range?.[0]?.startOf("day").toISOString(),
                end: filters.range?.[1]?.endOf("day").toISOString(),
                page,
                pageSize,
            });
            setItems(result.items || []);
            setTotal(result.total || 0);
            setOpenCount(result.openCount || 0);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [token, filters, page, pageSize, message]);

    useEffect(() => {
        void load();
    }, [load]);

    const columns: ColumnsType<AdminFeedbackItem> = useMemo(
        () => [
            {
                title: "提交时间",
                dataIndex: "createdAt",
                width: 150,
                render: (value: string) => dayjs(value).format("MM-DD HH:mm:ss"),
            },
            { title: "用户", dataIndex: "username", width: 130, ellipsis: true },
            {
                title: "类型",
                dataIndex: "category",
                width: 160,
                render: (value: string) => feedbackCategoryLabels[value] || value,
            },
            { title: "问题描述", dataIndex: "description", ellipsis: true },
            {
                title: "画布",
                dataIndex: "canvasTitle",
                width: 140,
                ellipsis: true,
                render: (value: string) => value || <Text type="secondary">—</Text>,
            },
            {
                title: "日志",
                dataIndex: "logCount",
                width: 110,
                render: (value: number, record) => (
                    <Tooltip title={`压缩后 ${(record.logBytes / 1024).toFixed(0)} KB${record.truncated ? "（已截断，保留最近部分）" : ""}`}>
                        <span className="tabular-nums">
                            {value} 条{record.truncated ? " ✂︎" : ""}
                        </span>
                    </Tooltip>
                ),
            },
            {
                title: "状态",
                dataIndex: "status",
                width: 90,
                render: (value: string) => <Tag color={feedbackStatusColors[value]}>{feedbackStatusLabels[value] || value}</Tag>,
            },
            {
                title: "操作",
                width: 90,
                fixed: "right",
                render: (_, record) => (
                    <Button type="link" size="small" onClick={() => setDetailId(record.id)}>
                        查看
                    </Button>
                ),
            },
        ],
        [],
    );

    return (
        <div className="flex flex-col gap-3">
            <Card size="small" variant="borderless">
                <Form layout="vertical" className="!mb-0">
                    <Row gutter={12}>
                        <Col xs={24} sm={12} md={5}>
                            <Form.Item label="状态" className="!mb-2">
                                <Select
                                    allowClear
                                    placeholder="全部"
                                    value={draft.status || undefined}
                                    options={feedbackStatusOptions}
                                    onChange={(value) => setDraft((prev) => ({ ...prev, status: value || "" }))}
                                />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12} md={6}>
                            <Form.Item label="问题类型" className="!mb-2">
                                <Select
                                    allowClear
                                    placeholder="全部"
                                    value={draft.category || undefined}
                                    options={feedbackCategoryOptions.map((option) => ({ value: option.value, label: option.label }))}
                                    onChange={(value) => setDraft((prev) => ({ ...prev, category: value || "" }))}
                                />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12} md={7}>
                            <Form.Item label="提交时间" className="!mb-2">
                                <DatePicker.RangePicker
                                    className="w-full"
                                    value={draft.range}
                                    onChange={(value) => setDraft((prev) => ({ ...prev, range: value as [Dayjs, Dayjs] | null }))}
                                />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12} md={6}>
                            <Form.Item label="关键词（用户名/描述/画布名）" className="!mb-2">
                                <Input
                                    allowClear
                                    placeholder="搜一下"
                                    value={draft.keyword}
                                    onChange={(event) => setDraft((prev) => ({ ...prev, keyword: event.target.value }))}
                                    onPressEnter={() => {
                                        setPage(1);
                                        setFilters(draft);
                                    }}
                                />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Space>
                        <Button
                            type="primary"
                            onClick={() => {
                                setPage(1);
                                setFilters(draft);
                            }}
                        >
                            查询
                        </Button>
                        <Button
                            onClick={() => {
                                setDraft(emptyFilters);
                                setFilters(emptyFilters);
                                setPage(1);
                            }}
                        >
                            重置
                        </Button>
                        <Button icon={<RefreshCw className="size-3.5" />} onClick={() => void load()}>
                            刷新
                        </Button>
                        {openCount > 0 ? (
                            <Badge count={openCount} overflowCount={99}>
                                <span className="pr-2 text-sm text-muted-foreground">待处理</span>
                            </Badge>
                        ) : null}
                    </Space>
                </Form>
            </Card>

            <Card size="small" variant="borderless">
                <Table<AdminFeedbackItem>
                    size="small"
                    rowKey="id"
                    loading={loading}
                    dataSource={items}
                    columns={columns}
                    scroll={{ x: 1100 }}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showSizeChanger: true,
                        showTotal: (value) => `共 ${value} 条`,
                        onChange: (nextPage, nextSize) => {
                            setPage(nextPage);
                            setPageSize(nextSize);
                        },
                    }}
                />
            </Card>

            {detailId ? <FeedbackDetail id={detailId} onClose={() => setDetailId(null)} onSaved={() => void load()} /> : null}
        </div>
    );
}

function FeedbackDetail({ id, onClose, onSaved }: { id: number; onClose: () => void; onSaved: () => void }) {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const [report, setReport] = useState<AdminFeedbackItem | null>(null);
    const [log, setLog] = useState<FeedbackLogEntry[]>([]);
    const [logError, setLogError] = useState("");
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<FeedbackStatus>("handling");
    const [note, setNote] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        setLoading(true);
        void fetchAdminFeedbackDetail(token, id)
            .then((result) => {
                if (cancelled) return;
                setReport(result.report);
                setLog(result.log || []);
                setLogError(result.logError || "");
                setStatus((result.report.status === "open" ? "handling" : result.report.status) as FeedbackStatus);
                setNote(result.report.adminNote || "");
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "加载失败"))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [token, id, message]);

    const handleSave = async () => {
        if (!token) return;
        setSaving(true);
        try {
            await updateAdminFeedback(token, id, { status, adminNote: note });
            message.success("已保存");
            onSaved();
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    const server = useMemo(() => parseJSON(report?.server), [report?.server]);
    const client = useMemo(() => parseJSON(report?.local), [report?.local]);
    const env = useMemo(() => parseJSON(report?.env), [report?.env]);

    return (
        <Modal open width={1080} onCancel={onClose} title={`反馈 #${id}`} footer={null} loading={loading} destroyOnHidden>
            {report ? (
                <div className="flex flex-col gap-3">
                    <Descriptions size="small" bordered column={3}>
                        <Descriptions.Item label="用户">{report.username}</Descriptions.Item>
                        <Descriptions.Item label="类型">{feedbackCategoryLabels[report.category] || report.category}</Descriptions.Item>
                        <Descriptions.Item label="提交时间">{dayjs(report.createdAt).format("YYYY-MM-DD HH:mm:ss")}</Descriptions.Item>
                        <Descriptions.Item label="画布">{report.canvasTitle || "—"}</Descriptions.Item>
                        <Descriptions.Item label="联系方式">{report.contact || "—"}</Descriptions.Item>
                        <Descriptions.Item label="日志">
                            {report.logCount} 条 / {(report.logBytes / 1024).toFixed(0)}KB{report.truncated ? "（已截断）" : ""}
                        </Descriptions.Item>
                        <Descriptions.Item label="用户描述" span={3}>
                            <Paragraph className="!mb-0 whitespace-pre-wrap">{report.description}</Paragraph>
                        </Descriptions.Item>
                    </Descriptions>

                    {/* 服务端自动判读的异常摆在最前面：管理员打开第一眼就看到，不用自己去比对数字 */}
                    {Array.isArray(server?.notes) && server.notes.length > 0 ? (
                        <Alert
                            type="warning"
                            showIcon
                            message="自动判读"
                            description={
                                <ul className="!mb-0 pl-4">
                                    {(server.notes as string[]).map((item) => (
                                        <li key={item}>{item}</li>
                                    ))}
                                </ul>
                            }
                        />
                    ) : null}

                    <Tabs
                        size="small"
                        items={[
                            { key: "server", label: "服务端看到的", children: <ServerView data={server} /> },
                            { key: "client", label: "用户那边看到的", children: <ClientView client={client} env={env} /> },
                            { key: "log", label: `操作日志（${log.length}）`, children: <LogView entries={log} error={logError} /> },
                        ]}
                        tabBarExtraContent={
                            <Button
                                size="small"
                                icon={<Download className="size-3.5" />}
                                href={adminFeedbackLogURL(id)}
                                target="_blank"
                            >
                                下载完整诊断包
                            </Button>
                        }
                    />

                    <Card size="small" title="处理">
                        <Space.Compact className="w-full">
                            <Select
                                value={status}
                                style={{ width: 120 }}
                                options={feedbackStatusOptions}
                                onChange={(value) => setStatus(value as FeedbackStatus)}
                            />
                            <Input
                                value={note}
                                placeholder="处理结论（用户能看到）"
                                onChange={(event) => setNote(event.target.value)}
                                maxLength={500}
                            />
                            <Button type="primary" loading={saving} onClick={handleSave}>
                                保存
                            </Button>
                        </Space.Compact>
                    </Card>
                </div>
            ) : null}
        </Modal>
    );
}

function ServerView({ data }: { data: Record<string, unknown> | null }) {
    if (!data) return <Text type="secondary">没有服务端快照</Text>;
    const domains = (data.domains as Array<{ domain: string; bytes: number; updatedAt: string }>) || [];
    const snapshots = (data.snapshots as Array<{ createdAt: string; bytes: number }>) || [];
    const canvas = data.canvas as { projectCount: number; nodeCount: number; projects: Array<{ title: string; nodes: number }> } | undefined;
    const counts = (data.counts as Record<string, number>) || {};
    const tasks = (data.tasks as Array<{ taskId: string; kind: string; model: string; status: number; hasResult: boolean; createdAt: string }>) || [];
    return (
        <div className="flex flex-col gap-3 text-xs">
            <Descriptions size="small" bordered column={3} title="云端数据">
                {domains.map((item) => (
                    <Descriptions.Item key={item.domain} label={item.domain}>
                        {(item.bytes / 1048576).toFixed(2)} MB
                        <br />
                        <Text type="secondary">{item.updatedAt ? dayjs(item.updatedAt).format("MM-DD HH:mm") : "无"}</Text>
                    </Descriptions.Item>
                ))}
            </Descriptions>
            {canvas ? (
                <div>
                    <Text strong>
                        云端画布：{canvas.projectCount} 个 / {canvas.nodeCount} 个节点
                    </Text>
                    <div className="mt-1 max-h-32 overflow-auto">
                        {canvas.projects?.map((project, index) => (
                            <div key={`${project.title}-${index}`}>
                                · {project.title || "未命名"}（{project.nodes} 节点）
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
            {/* 快照体积走势是「到底丢没丢」最直接的证据，也是恢复点在哪的答案 */}
            <div>
                <Text strong>画布快照体积走势（{snapshots.length} 份）</Text>
                <div className="mt-1 max-h-40 overflow-auto font-mono">
                    {snapshots.map((snapshot) => (
                        <div key={snapshot.createdAt}>
                            {dayjs(snapshot.createdAt).format("MM-DD HH:mm")} {(snapshot.bytes / 1048576).toFixed(2)} MB
                        </div>
                    ))}
                    {snapshots.length === 0 ? <Text type="secondary">无快照（不可恢复）</Text> : null}
                </div>
            </div>
            <Descriptions size="small" bordered column={3} title="关键计数">
                <Descriptions.Item label="素材登记">{counts.syncFiles ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="画布快照">{counts.canvasSnapshots ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="未确认送达的视频">{counts.pendingVideoTasks ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="24h 任务">{counts.tasks24h ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="24h 失败">{counts.failedTasks24h ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="24h 无产物视频">{counts.videosNoResult24h ?? "—"}</Descriptions.Item>
            </Descriptions>
            <div>
                <Text strong>近 48 小时任务（{tasks.length}）</Text>
                <div className="mt-1 max-h-40 overflow-auto font-mono">
                    {tasks.map((task) => (
                        <div key={task.taskId || task.createdAt}>
                            {dayjs(task.createdAt).format("MM-DD HH:mm")} {task.kind} {task.model} HTTP{task.status}{" "}
                            {task.hasResult ? "有产物" : <Text type="danger">无产物</Text>} {task.taskId}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function ClientView({ client, env }: { client: Record<string, unknown> | null; env: Record<string, unknown> | null }) {
    const local = (client?.local as Record<string, unknown>) || null;
    const media = (client?.media as Record<string, unknown>) || null;
    return (
        <div className="flex flex-col gap-3 text-xs">
            {local ? (
                <Descriptions size="small" bordered column={3} title="本机数据">
                    <Descriptions.Item label="已水合">{String(local.hydrated)}</Descriptions.Item>
                    <Descriptions.Item label="画布">{String(local.projectCount)}</Descriptions.Item>
                    <Descriptions.Item label="节点">{String(local.nodeCount)}</Descriptions.Item>
                    <Descriptions.Item label="素材">{String(local.assetCount)}</Descriptions.Item>
                    <Descriptions.Item label="画布墓碑">{String(local.tombstoneCount)}</Descriptions.Item>
                    <Descriptions.Item label="节点墓碑">{String(local.nodeTombstoneCount)}</Descriptions.Item>
                    <Descriptions.Item label="本地数据归属" span={3}>
                        {String(local.localDataOwner || "（空——归属标记丢失，下次同步会清空本地）")}
                    </Descriptions.Item>
                </Descriptions>
            ) : null}
            {media ? (
                <Descriptions size="small" bordered column={4} title="素材对账">
                    <Descriptions.Item label="总数">{String(media.total)}</Descriptions.Item>
                    <Descriptions.Item label="云端已有">{String(media.uploaded)}</Descriptions.Item>
                    <Descriptions.Item label="仅在本机">{String(media.pending)}</Descriptions.Item>
                    <Descriptions.Item label="两边都没有">{String(media.lost)}</Descriptions.Item>
                </Descriptions>
            ) : null}
            {env ? (
                <Descriptions size="small" bordered column={2} title="运行环境">
                    <Descriptions.Item label="版本 / 构建">
                        {String(env.appVersion)} / {String(env.buildId)}
                    </Descriptions.Item>
                    <Descriptions.Item label="页面">{String(env.url)}</Descriptions.Item>
                    <Descriptions.Item label="时区 / 时钟偏差">
                        {String(env.timezone)} / {env.clockSkewMs === null ? "未知" : `${env.clockSkewMs}ms`}
                    </Descriptions.Item>
                    <Descriptions.Item label="存储配额">
                        {env.storageUsage && env.storageQuota
                            ? `${(Number(env.storageUsage) / 1048576).toFixed(0)} / ${(Number(env.storageQuota) / 1048576).toFixed(0)} MB`
                            : "未知"}
                    </Descriptions.Item>
                    <Descriptions.Item label="浏览器" span={2}>
                        {String(env.userAgent)}
                    </Descriptions.Item>
                </Descriptions>
            ) : null}
        </div>
    );
}

function LogView({ entries, error }: { entries: FeedbackLogEntry[]; error: string }) {
    const [keyword, setKeyword] = useState("");
    const filtered = useMemo(() => {
        const list = [...entries].reverse();
        if (!keyword.trim()) return list;
        const needle = keyword.trim().toLowerCase();
        return list.filter((entry) => entry.e.toLowerCase().includes(needle) || JSON.stringify(entry.d || {}).toLowerCase().includes(needle));
    }, [entries, keyword]);

    if (error) return <Alert type="error" message="日志解析失败" description={error} />;
    return (
        <div className="flex flex-col gap-2">
            <Input.Search
                allowClear
                placeholder="按事件名或字段过滤，例如 sync_failed / local_data_wiped / video_persist_failed"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
            />
            <div className="max-h-[420px] overflow-auto rounded border border-border p-2 font-mono text-xs leading-5">
                {filtered.map((entry) => (
                    <div key={`${entry.t}-${entry.s}`} className="whitespace-pre-wrap break-all">
                        <span className="text-muted-foreground">{dayjs(entry.t).format("MM-DD HH:mm:ss.SSS")}</span>{" "}
                        <span className={highlightClass(entry.e)}>{entry.e}</span>{" "}
                        <span className="text-muted-foreground">{entry.d ? JSON.stringify(entry.d) : ""}</span>
                    </div>
                ))}
                {filtered.length === 0 ? <Text type="secondary">没有匹配的记录</Text> : null}
            </div>
        </div>
    );
}

// 把最该被一眼看到的事件标红：清空本地、推送被拒、同步失败、成片转存失败。
// 一份日志几千条，不高亮就等于让人在噪音里大海捞针。
function highlightClass(event: string): string {
    if (/local_data_wiped|manifest_push_rejected|canvas_projects_deleted|video_persist_failed|media_upload_failed|idb_write_fallback/.test(event)) {
        return "font-semibold text-red-500";
    }
    if (/failed|error|rejected|conflict/.test(event)) return "text-orange-500";
    if (/succeeded|pushed|persisted|ready/.test(event)) return "text-green-600";
    return "text-foreground";
}

function parseJSON(raw?: string): Record<string, unknown> | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
}
