"use client";

import { DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, SearchOutlined } from "@/components/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { App, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Statistic, Table, Tag, Tooltip, Typography, type TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";

import { fetchAdminProjects, type AdminCreditLog, type AdminCreditLogMemberStat, type AdminCreditLogModelStat, type AdminProject } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";
import { useAdminCreditLogs } from "./use-admin-credit-logs";

type CreditLogFormValues = Partial<AdminCreditLog>;

const creditLogTypeLabels: Record<string, string> = {
    admin_adjust: "后台调整",
    ai_consume: "模型消费",
    ai_refund: "失败返还",
};

const typeOptions = [
    { value: "", label: "全部类型" },
    { value: "ai_consume", label: "模型消费" },
    { value: "ai_refund", label: "失败返还" },
    { value: "admin_adjust", label: "后台调整" },
];

const emptyDraft = { keyword: "", type: "", model: "", member: "", start: "", end: "", source: "" };

// CSV 单元格转义：含逗号/引号/换行时用引号包裹并把引号翻倍。
function csvCell(value: string | number | null | undefined): string {
    const s = value === null || value === undefined ? "" : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
    // ﻿ = UTF-8 BOM，让 Excel 正确识别中文不乱码。
    const csv = "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export default function AdminCreditLogsPage() {
    const { message } = App.useApp();
    const { logs, total, overall, byMember, byModel, page, pageSize, isLoading, isSummaryLoading, applyFilters, resetAll, changePage, changePageSize, refreshLogs, fetchAllForExport, saveLog: saveAdminLog, deleteLog } = useAdminCreditLogs();
    const [form] = Form.useForm<CreditLogFormValues>();
    const [draft, setDraft] = useState(emptyDraft);
    const [editingLog, setEditingLog] = useState<Partial<AdminCreditLog> | null>(null);
    const [deletingLog, setDeletingLog] = useState<AdminCreditLog | null>(null);
    const [exporting, setExporting] = useState(false);
    // 二级管理员只读：隐藏新增/编辑/删除流水入口（后端已限自己子用户）
    const canMutate = useUserStore((state) => state.user?.role) === "admin";
    // 来源筛选下拉：个人 + 各项目（项目积分池）。二级管理员拉到的是自己名下项目。
    const token = useUserStore((state) => state.token);
    const [projects, setProjects] = useState<AdminProject[]>([]);
    useEffect(() => {
        if (!token) return;
        void fetchAdminProjects(token).then(setProjects).catch(() => {});
    }, [token]);
    const sourceOptions = [
        { label: "全部来源", value: "" },
        { label: "个人积分", value: "__personal__" },
        ...projects.map((p) => ({ label: `项目：${p.name}`, value: p.id })),
    ];

    useEffect(() => {
        if (editingLog) form.setFieldsValue({ type: "admin_adjust", amount: 0, balance: 0, ...editingLog });
    }, [editingLog, form]);

    const saveLog = async () => {
        const value = await form.validateFields();
        await saveAdminLog({ ...editingLog, ...value });
        setEditingLog(null);
    };

    const handleSearch = () => applyFilters(draft);
    const handleReset = () => {
        setDraft(emptyDraft);
        resetAll();
    };
    const onDateRange = (range: (Dayjs | null)[] | null) => {
        const startDay = range?.[0];
        const endDay = range?.[1];
        if (startDay && endDay) {
            setDraft((prev) => ({ ...prev, start: startDay.startOf("day").toISOString(), end: endDay.endOf("day").toISOString() }));
        } else {
            setDraft((prev) => ({ ...prev, start: "", end: "" }));
        }
    };

    const handleExport = async () => {
        setExporting(true);
        try {
            const items = await fetchAllForExport();
            const header = ["用户名", "用户ID", "类型", "模型", "来源", "变动", "余额", "操作管理员", "备注", "时间"];
            const body = items.map((it) => [
                it.userName || "",
                it.userId,
                creditLogTypeLabels[it.type] || it.type,
                it.model || "",
                it.projectId ? `项目：${it.projectName || it.projectId}` : "个人",
                it.amount,
                it.balance,
                it.operatorName || "",
                it.remark || "",
                it.createdAt ? dayjs(it.createdAt).format("YYYY-MM-DD HH:mm:ss") : "",
            ]);
            downloadCsv(`积分日志_${dayjs().format("YYYYMMDD_HHmmss")}.csv`, [header, ...body]);
            message.success(`已导出 ${items.length} 条`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出失败");
        } finally {
            setExporting(false);
        }
    };

    // 计算值提到 JSX 之前，避免在属性里写三元/空值合并（曾触发 bun 构建 SIGILL）。
    const dateValue = draft.start && draft.end ? ([dayjs(draft.start), dayjs(draft.end)] as [Dayjs, Dayjs]) : null;
    const sumConsume = overall?.consume ?? 0;
    const sumRefund = overall?.refund ?? 0;
    const sumNet = overall?.net ?? 0;
    const sumCount = overall?.count ?? 0;

    const memberColumns: TableColumnsType<AdminCreditLogMemberStat> = [
        { title: "用户名", dataIndex: "userName", render: (_, item) => <Typography.Text>{item.userName || item.userId}</Typography.Text> },
        { title: "总消费", dataIndex: "consume", align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.consume - b.consume, render: (value) => <Typography.Text type="danger">{value}</Typography.Text> },
        { title: "总返还", dataIndex: "refund", align: "right", sorter: (a, b) => a.refund - b.refund, render: (value) => <Typography.Text type="success">{value}</Typography.Text> },
        { title: "净消耗", dataIndex: "net", align: "right", sorter: (a, b) => a.net - b.net, render: (value) => <Typography.Text strong>{value}</Typography.Text> },
        { title: "笔数", dataIndex: "count", align: "right", sorter: (a, b) => a.count - b.count },
    ];

    const modelColumns: TableColumnsType<AdminCreditLogModelStat> = [
        { title: "模型", dataIndex: "model", render: (_, item) => (item.model ? <Typography.Text>{item.model}</Typography.Text> : <Typography.Text type="secondary">（后台调整 / 无模型）</Typography.Text>) },
        { title: "总消费", dataIndex: "consume", align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.consume - b.consume, render: (value) => <Typography.Text type="danger">{value}</Typography.Text> },
        { title: "总返还", dataIndex: "refund", align: "right", sorter: (a, b) => a.refund - b.refund, render: (value) => <Typography.Text type="success">{value}</Typography.Text> },
        { title: "净消耗", dataIndex: "net", align: "right", sorter: (a, b) => a.net - b.net, render: (value) => <Typography.Text strong>{value}</Typography.Text> },
        { title: "笔数", dataIndex: "count", align: "right", sorter: (a, b) => a.count - b.count },
    ];

    const columns: ProColumns<AdminCreditLog>[] = [
        { title: "用户名", dataIndex: "userName", width: 140, render: (_, item) => <Typography.Text>{item.userName || "-"}</Typography.Text> },
        { title: "用户 ID", dataIndex: "userId", width: 220, render: (_, item) => <Typography.Text copyable>{item.userId}</Typography.Text> },
        { title: "类型", dataIndex: "type", width: 110, render: (_, item) => <Tag>{creditLogTypeLabels[item.type] || item.type || "-"}</Tag> },
        { title: "模型", dataIndex: "model", width: 180, ellipsis: true, render: (_, item) => (item.model ? <Typography.Text>{item.model}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>) },
        {
            title: "来源",
            dataIndex: "projectId",
            width: 140,
            ellipsis: true,
            render: (_, item) => (item.projectId ? <Tag color="purple">项目：{item.projectName || item.projectId}</Tag> : <Typography.Text type="secondary">个人</Typography.Text>),
        },
        { title: "变动", dataIndex: "amount", width: 90, render: (_, item) => <Typography.Text type={item.amount >= 0 ? "success" : "danger"}>{item.amount}</Typography.Text> },
        { title: "余额", dataIndex: "balance", width: 90, render: (_, item) => (item.projectId ? <Tooltip title="项目积分池余额（非个人余额）"><Typography.Text>{item.balance}<Typography.Text type="secondary"> (池)</Typography.Text></Typography.Text></Tooltip> : <Typography.Text>{item.balance}</Typography.Text>) },
        {
            title: "操作管理员",
            dataIndex: "operatorName",
            width: 130,
            render: (_, item) => (item.operatorName ? <Tag color="blue">{item.operatorName}</Tag> : <Typography.Text type="secondary">{item.type === "admin_adjust" ? "-" : "系统"}</Typography.Text>),
        },
        { title: "备注", dataIndex: "remark", ellipsis: true, render: (_, item) => <Typography.Text type="secondary">{item.remark || "-"}</Typography.Text> },
        { title: "创建时间", dataIndex: "createdAt", width: 170, render: (_, item) => <Typography.Text type="secondary">{item.createdAt ? dayjs(item.createdAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Typography.Text> },
        ...(canMutate
            ? [
                  {
                      title: "操作",
                      key: "actions",
                      width: 96,
                      align: "right",
                      render: (_, item) => (
                          <Space size={4}>
                              <Tooltip title="编辑">
                                  <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditingLog(item)} />
                              </Tooltip>
                              <Tooltip title="删除">
                                  <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => setDeletingLog(item)} />
                              </Tooltip>
                          </Space>
                      ),
                  } as ProColumns<AdminCreditLog>,
              ]
            : []),
    ];

    return (
        <main className="anim-fade" style={{ padding: 24 }}>
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card variant="borderless">
                    <Form layout="vertical">
                        <Row gutter={16} align="bottom">
                            <Col flex="200px">
                                <Form.Item label="关键词" style={{ marginBottom: 0 }}>
                                    <Input value={draft.keyword} placeholder="备注 / 关联 ID" allowClear onChange={(event) => setDraft((prev) => ({ ...prev, keyword: event.target.value }))} onPressEnter={handleSearch} />
                                </Form.Item>
                            </Col>
                            <Col flex="180px">
                                <Form.Item label="成员" style={{ marginBottom: 0 }}>
                                    <Input value={draft.member} placeholder="用户名或 ID" allowClear onChange={(event) => setDraft((prev) => ({ ...prev, member: event.target.value }))} onPressEnter={handleSearch} />
                                </Form.Item>
                            </Col>
                            <Col flex="150px">
                                <Form.Item label="类型" style={{ marginBottom: 0 }}>
                                    <Select value={draft.type} options={typeOptions} style={{ width: "100%" }} onChange={(value) => setDraft((prev) => ({ ...prev, type: value }))} />
                                </Form.Item>
                            </Col>
                            <Col flex="180px">
                                <Form.Item label="模型" style={{ marginBottom: 0 }}>
                                    <Input value={draft.model} placeholder="如 doubao-seed / gpt-image" allowClear onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))} onPressEnter={handleSearch} />
                                </Form.Item>
                            </Col>
                            <Col flex="180px">
                                <Form.Item label="来源" style={{ marginBottom: 0 }}>
                                    <Select value={draft.source} options={sourceOptions} style={{ width: "100%" }} showSearch optionFilterProp="label" onChange={(value) => setDraft((prev) => ({ ...prev, source: value }))} />
                                </Form.Item>
                            </Col>
                            <Col flex="280px">
                                <Form.Item label="时间范围" style={{ marginBottom: 0 }}>
                                    <DatePicker.RangePicker value={dateValue} style={{ width: "100%" }} onChange={onDateRange} />
                                </Form.Item>
                            </Col>
                            <Col flex="none">
                                <Form.Item style={{ marginBottom: 0 }}>
                                    <Space>
                                        <Button onClick={handleReset}>重置</Button>
                                        <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
                                            查询
                                        </Button>
                                    </Space>
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Card>

                <Row gutter={16}>
                    <Col xs={12} sm={6}>
                        <Card variant="borderless">
                            <Statistic title="总消费（积分）" value={sumConsume} loading={isSummaryLoading} valueStyle={{ color: "#cf1322" }} />
                        </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                        <Card variant="borderless">
                            <Statistic title="总返还" value={sumRefund} loading={isSummaryLoading} valueStyle={{ color: "#3f8600" }} />
                        </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                        <Card variant="borderless">
                            <Statistic title="净消耗" value={sumNet} loading={isSummaryLoading} />
                        </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                        <Card variant="borderless">
                            <Statistic title="笔数" value={sumCount} loading={isSummaryLoading} />
                        </Card>
                    </Col>
                </Row>

                <Card variant="borderless" title="成员用量汇总" extra={<Tag>{byMember.length} 人</Tag>}>
                    <Table<AdminCreditLogMemberStat>
                        rowKey="userId"
                        size="small"
                        columns={memberColumns}
                        dataSource={byMember}
                        loading={isSummaryLoading}
                        pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (value) => `共 ${value} 人` }}
                    />
                </Card>

                <Card variant="borderless" title="按模型用量汇总" extra={<Tag>{byModel.length} 个模型</Tag>}>
                    <Table<AdminCreditLogModelStat>
                        rowKey="model"
                        size="small"
                        columns={modelColumns}
                        dataSource={byModel}
                        loading={isSummaryLoading}
                        pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (value) => `共 ${value} 个模型` }}
                    />
                </Card>

                <ProTable<AdminCreditLog>
                    rowKey="id"
                    columns={columns}
                    dataSource={logs}
                    loading={isLoading}
                    search={false}
                    defaultSize="middle"
                    tableLayout="fixed"
                    scroll={{ x: 1100 }}
                    cardProps={{ variant: "borderless" }}
                    headerTitle={
                        <Space>
                            <Typography.Text strong>明细流水</Typography.Text>
                            <Tag>{total} 条</Tag>
                        </Space>
                    }
                    options={{ density: true, setting: true, reload: () => void refreshLogs() }}
                    toolBarRender={() => {
                        const buttons = [
                            <Button key="export" icon={<DownloadOutlined />} loading={exporting} onClick={() => void handleExport()}>
                                导出明细
                            </Button>,
                        ];
                        if (canMutate) {
                            buttons.unshift(
                                <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => setEditingLog({ type: "admin_adjust", amount: 0, balance: 0 })}>
                                    新增
                                </Button>,
                            );
                        }
                        return buttons;
                    }}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showSizeChanger: true,
                        pageSizeOptions: [10, 20, 50, 100],
                        showTotal: (value) => `共 ${value} 条`,
                        onChange: (nextPage, nextPageSize) => (nextPageSize !== pageSize ? changePageSize(nextPageSize) : changePage(nextPage)),
                    }}
                />
            </Space>

            <Modal title={editingLog?.id ? "编辑日志" : "新增日志"} open={Boolean(editingLog)} width={680} onCancel={() => setEditingLog(null)} onOk={() => void saveLog()} okText="保存" cancelText="取消" destroyOnHidden>
                <Form form={form} layout="vertical" requiredMark={false}>
                    <Row gutter={14}>
                        <Col span={12}>
                            <Form.Item name="userId" label="用户 ID" rules={[{ required: true, message: "请输入用户 ID" }]}>
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="type" label="类型" rules={[{ required: true, message: "请输入类型" }]}>
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="amount" label="变动数量" rules={[{ required: true, message: "请输入变动数量" }]}>
                                <InputNumber precision={0} style={{ width: "100%" }} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="balance" label="变动后余额" rules={[{ required: true, message: "请输入变动后余额" }]}>
                                <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="relatedId" label="关联 ID">
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="createdAt" label="创建时间">
                                <Input placeholder="不填则新增时自动生成" />
                            </Form.Item>
                        </Col>
                        <Col span={24}>
                            <Form.Item name="remark" label="备注">
                                <Input.TextArea rows={3} />
                            </Form.Item>
                        </Col>
                        <Col span={24}>
                            <Form.Item name="extra" label="扩展信息">
                                <Input.TextArea rows={3} />
                            </Form.Item>
                        </Col>
                    </Row>
                </Form>
            </Modal>

            <Modal
                title="删除日志"
                open={Boolean(deletingLog)}
                onCancel={() => setDeletingLog(null)}
                onOk={async () => {
                    if (!deletingLog) return;
                    await deleteLog(deletingLog.id);
                    setDeletingLog(null);
                }}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                确定删除这条点数日志吗？
            </Modal>
        </main>
    );
}
