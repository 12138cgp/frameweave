"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Alert, Button, Collapse, Empty, Form, Input, Modal, Radio, Select, Spin, Table, Tag, Typography } from "antd";
import { FileSearch } from "@/components/icons";

import { flushActionLog, logAction } from "@/services/action-log";
import { collectDiagnostics, type DiagnosticsBundle } from "@/services/diagnostics";
import {
    feedbackCategoryLabels,
    feedbackCategoryOptions,
    feedbackStatusColors,
    feedbackStatusLabels,
    fetchMyFeedbacks,
    submitFeedback,
    type FeedbackCategory,
    type MyFeedbackItem,
} from "@/services/api/feedback";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

const { Paragraph, Text } = Typography;

type FormValues = {
    category: FeedbackCategory;
    description: string;
    canvasId?: string;
    contact?: string;
};

// 「反馈问题」弹窗。
//
// 设计上只坚持两件事：
//  1. **提交前先把日志落盘**。用户往往是遇到问题的当下来提，此刻内存里那批还没写进 IndexedDB
//     的条目恰恰是最关键的几条；不 flush 就会正好把它们漏掉。
//  2. **让用户看得见要发什么**。日志里有他的画布名、操作时间这些，得给他一个「看看要发送的内容」
//     的入口，而不是背着他打包上传。
export function FeedbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [form] = Form.useForm<FormValues>();
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const projects = useCanvasStore((state) => state.projects);

    const [diagnostics, setDiagnostics] = useState<DiagnosticsBundle | null>(null);
    const [collecting, setCollecting] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [history, setHistory] = useState<MyFeedbackItem[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    // 打开弹窗就开始抓现场：抓完再点提交就是即时的，用户不用干等。
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setCollecting(true);
        void (async () => {
            // 先落盘，再读——否则内存里最新的那几条（往往正是出问题的那几条）读不到
            await flushActionLog().catch(() => {});
            const bundle = await collectDiagnostics().catch(() => null);
            if (!cancelled) {
                setDiagnostics(bundle);
                setCollecting(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open]);

    const loadHistory = useCallback(async () => {
        if (!token) return;
        setHistoryLoading(true);
        try {
            const result = await fetchMyFeedbacks(token, { page: 1, pageSize: 20 });
            setHistory(result.items || []);
        } catch {
            // 历史拉不到不影响提交新的，静默即可
        } finally {
            setHistoryLoading(false);
        }
    }, [token]);

    useEffect(() => {
        if (open) void loadHistory();
    }, [open, loadHistory]);

    const canvasOptions = useMemo(
        () =>
            projects.map((project) => ({
                value: project.id,
                label: `${project.title || "未命名画布"}（${project.nodes?.length || 0} 个节点）`,
            })),
        [projects],
    );

    const handleSubmit = async () => {
        let values: FormValues;
        try {
            values = await form.validateFields();
        } catch {
            return; // 校验没过，antd 自己会标红
        }
        if (!token) {
            message.error("登录状态已失效，请重新登录后再提交");
            return;
        }
        setSubmitting(true);
        try {
            // 提交这个动作本身也记一条：后续排查时能知道用户是在哪一刻按下的
            logAction("feedback_submitted", { category: values.category, canvasId: values.canvasId || "" });
            await flushActionLog().catch(() => {});
            const bundle = diagnostics ?? (await collectDiagnostics().catch(() => null));
            const canvas = projects.find((project) => project.id === values.canvasId);
            await submitFeedback(token, {
                category: values.category,
                description: values.description,
                contact: values.contact,
                canvasId: values.canvasId,
                canvasTitle: canvas?.title || "",
                happenedAt: new Date().toISOString(),
                env: bundle?.env,
                local: bundle?.local,
                media: bundle?.media,
                log: bundle?.log,
            });
            message.success("已收到，我们会尽快查看");
            form.resetFields();
            void loadHistory();
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "提交失败，请稍后再试");
        } finally {
            setSubmitting(false);
        }
    };

    const logCount = diagnostics?.log.length ?? 0;

    return (
        <Modal
            open={open}
            onCancel={onClose}
            onOk={handleSubmit}
            confirmLoading={submitting}
            okText="提交反馈"
            cancelText="取消"
            width={640}
            title="反馈问题"
            destroyOnHidden
        >
            <Form form={form} layout="vertical" requiredMark={false} initialValues={{ category: "canvas_lost" }}>
                <Form.Item name="category" label="遇到的是什么问题" rules={[{ required: true, message: "请选一个类型" }]}>
                    <Radio.Group className="flex flex-col gap-1.5">
                        {feedbackCategoryOptions.map((option) => (
                            <Radio key={option.value} value={option.value}>
                                <span>{option.label}</span>
                                {option.hint ? <span className="ml-1.5 text-xs text-muted-foreground">{option.hint}</span> : null}
                            </Radio>
                        ))}
                    </Radio.Group>
                </Form.Item>

                <Form.Item
                    name="description"
                    label="具体说说"
                    rules={[{ required: true, message: "写一句也行，越具体越好查" }]}
                    extra="说清楚「什么时候、在哪个画布、本来有什么、现在变成什么样」，最有助于定位。"
                >
                    <Input.TextArea rows={4} maxLength={2000} showCount placeholder="例：昨天下午在「分镜03」里做了十几张图，今天早上打开只剩三张。" />
                </Form.Item>

                {canvasOptions.length > 0 ? (
                    <Form.Item name="canvasId" label="出问题的画布（可选）">
                        <Select allowClear showSearch optionFilterProp="label" options={canvasOptions} placeholder="选一个能更快定位" />
                    </Form.Item>
                ) : null}

                <Form.Item name="contact" label="联系方式（可选）">
                    <Input maxLength={100} placeholder="微信/手机号，方便需要时找你确认" />
                </Form.Item>
            </Form>

            <Alert
                type="info"
                showIcon
                icon={<FileSearch className="size-4" />}
                message={
                    collecting ? (
                        <span>
                            <Spin size="small" className="mr-2" />
                            正在收集诊断信息…
                        </span>
                    ) : (
                        <span>
                            将随反馈附带 <Text strong>{logCount}</Text> 条操作记录和一份运行环境快照，用于定位问题。
                        </span>
                    )
                }
                description={
                    <span className="text-xs text-muted-foreground">
                        只包含操作类型、时间、数量、错误信息等诊断元信息；<Text strong>不包含</Text>你的提示词内容、图片和视频。
                    </span>
                }
                className="mb-3"
            />

            <Collapse
                size="small"
                ghost
                items={[
                    {
                        key: "preview",
                        label: <span className="text-xs">看看将要发送的内容</span>,
                        children: <DiagnosticsPreview bundle={diagnostics} loading={collecting} />,
                    },
                    {
                        key: "history",
                        label: <span className="text-xs">我提过的反馈（{history.length}）</span>,
                        children: <HistoryList items={history} loading={historyLoading} />,
                    },
                ]}
            />
        </Modal>
    );
}

function DiagnosticsPreview({ bundle, loading }: { bundle: DiagnosticsBundle | null; loading: boolean }) {
    if (loading) return <Spin size="small" />;
    if (!bundle) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没能收集到诊断信息（不影响提交）" />;
    const recent = bundle.log.slice(-40).reverse();
    return (
        <div className="max-h-72 overflow-auto text-xs">
            <Paragraph className="!mb-2">
                本机 {bundle.local.projectCount} 个画布 / {bundle.local.nodeCount} 个节点
                {bundle.media ? `，素材 ${bundle.media.total} 个（云端已有 ${bundle.media.uploaded}，待上传 ${bundle.media.pending}）` : ""}
                <br />
                {bundle.env.userAgent.slice(0, 90)}
            </Paragraph>
            <div className="font-mono leading-5">
                {recent.map((entry) => (
                    <div key={`${entry.t}-${entry.s}`} className="truncate text-muted-foreground">
                        <span className="text-foreground/70">{new Date(entry.t).toLocaleTimeString()}</span>{" "}
                        <span className="text-foreground">{entry.e}</span>{" "}
                        {entry.d ? JSON.stringify(entry.d) : ""}
                    </div>
                ))}
                {recent.length === 0 ? <div className="text-muted-foreground">（暂无操作记录）</div> : null}
            </div>
        </div>
    );
}

function HistoryList({ items, loading }: { items: MyFeedbackItem[]; loading: boolean }) {
    return (
        <Table<MyFeedbackItem>
            size="small"
            loading={loading}
            dataSource={items}
            rowKey="id"
            pagination={false}
            locale={{ emptyText: "还没有提过反馈" }}
            columns={[
                { title: "时间", dataIndex: "createdAt", width: 130, render: (v: string) => new Date(v).toLocaleString() },
                { title: "类型", dataIndex: "category", width: 130, render: (v: string) => feedbackCategoryLabels[v] || v },
                { title: "问题", dataIndex: "description", ellipsis: true },
                {
                    title: "状态",
                    dataIndex: "status",
                    width: 80,
                    render: (v: string) => <Tag color={feedbackStatusColors[v]}>{feedbackStatusLabels[v] || v}</Tag>,
                },
                {
                    title: "处理结论",
                    dataIndex: "adminNote",
                    ellipsis: true,
                    render: (v: string) => v || <span className="text-muted-foreground">—</span>,
                },
            ]}
        />
    );
}

export default FeedbackModal;
