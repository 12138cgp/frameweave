"use client";

import { DownloadOutlined, EyeOutlined, SearchOutlined } from "@/components/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { App, Button, Card, Col, DatePicker, Descriptions, Form, Input, Modal, Row, Select, Space, Statistic, Tag, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";

import { smsLogStatusColors, smsLogStatusLabels, smsLogStatusOptions, type SmsLog, type SmsLogStatus } from "@/services/api/sms-logs";
import { useAdminSmsLogs } from "./use-admin-sms-logs";

const emptyDraft = { keyword: "", status: "", start: "", end: "", ip: "" };

function fmtTime(v: string) {
    if (!v) return "";
    const d = dayjs(v);
    if (!d.isValid()) return "";
    return d.format("YYYY-MM-DD HH:mm:ss");
}

// JSON 字符串美化：失败时原样返回。
function prettyJson(s: string): string {
    if (!s) return "";
    try {
        return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
        return s;
    }
}

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

function renderStatus(status: SmsLogStatus) {
    return <Tag color={smsLogStatusColors[status]}>{smsLogStatusLabels[status]}</Tag>;
}

export default function AdminSmsLogsPage() {
    const { items, total, summary, page, pageSize, isLoading, applyFilters, resetAll, changePage, changePageSize, refresh, fetchAllForExport } = useAdminSmsLogs();
    const { message } = App.useApp();
    const [draft, setDraft] = useState(emptyDraft);
    const [exporting, setExporting] = useState(false);
    const [detail, setDetail] = useState<SmsLog | null>(null);

    const handleSearch = () => {
        applyFilters({
            keyword: draft.keyword.trim(),
            ip: draft.ip.trim(),
            status: draft.status,
            start: draft.start,
            end: draft.end,
        });
    };

    const handleReset = () => {
        setDraft(emptyDraft);
        resetAll();
    };

    const onDateRange = (range: [Dayjs | null, Dayjs | null] | null) => {
        let start = "";
        let end = "";
        if (range?.[0] && range?.[1]) {
            start = range[0].startOf("day").toISOString();
            end = range[1].endOf("day").toISOString();
        }
        setDraft((prev) => ({ ...prev, start, end }));
    };

    const dateValue = draft.start && draft.end ? ([dayjs(draft.start), dayjs(draft.end)] as [Dayjs, Dayjs]) : null;
    const sumSuccess = summary?.successCount ?? 0;
    const sumFailed = summary?.failedCount ?? 0;
    const sumTotal = summary?.totalCount ?? 0;
    const sumIP = summary?.ipCount ?? 0;

    const handleExport = async () => {
        setExporting(true);
        try {
            const exportItems = await fetchAllForExport();
            const header = ["时间", "手机号", "IP", "模板 ID", "签名", "状态", "耗时(ms)", "错误码", "失败原因", "RequestId", "MessageId"];
            const body = exportItems.map((it) => [
                it.createdAt ? dayjs(it.createdAt).format("YYYY-MM-DD HH:mm:ss") : "",
                it.phone,
                it.ip,
                it.templateId,
                it.sign,
                smsLogStatusLabels[it.status] || it.status,
                it.durationMs,
                it.errorCode,
                it.errorMessage,
                it.requestId,
                it.messageId,
            ]);
            downloadCsv(`短信发送记录_${dayjs().format("YYYYMMDD_HHmmss")}.csv`, [header, ...body]);
            message.success(`已导出 ${exportItems.length} 条`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出失败");
        } finally {
            setExporting(false);
        }
    };

    const columns: ProColumns<SmsLog>[] = [
        { title: "时间", dataIndex: "createdAt", width: 150, render: (_, item) => <Typography.Text style={{ fontSize: 12 }}>{fmtTime(item.createdAt)}</Typography.Text> },
        { title: "手机号", dataIndex: "phone", width: 130, render: (_, item) => <Typography.Text copyable style={{ fontSize: 12 }}>{item.phone}</Typography.Text> },
        { title: "IP", dataIndex: "ip", width: 130, render: (_, item) => (item.ip ? <Typography.Text copyable style={{ fontSize: 12 }}>{item.ip}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>) },
        { title: "模板 ID", dataIndex: "templateId", width: 160, render: (_, item) => <Typography.Text style={{ fontSize: 12 }}>{item.templateId || "-"}</Typography.Text> },
        { title: "状态", dataIndex: "status", width: 80, render: (_, item) => renderStatus(item.status) },
        { title: "耗时", dataIndex: "durationMs", width: 90, align: "right", render: (_, item) => <Typography.Text type="secondary">{item.durationMs ? `${item.durationMs}ms` : "-"}</Typography.Text> },
        { title: "错误码", dataIndex: "errorCode", width: 120, render: (_, item) => (item.errorCode ? <Typography.Text type="danger" style={{ fontSize: 12 }}>{item.errorCode}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>) },
        {
            title: "操作",
            key: "actions",
            width: 80,
            align: "center",
            render: (_, item) => (
                <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail(item)}>
                    查看
                </Button>
            ),
        },
    ];

    return (
        <main className="anim-fade" style={{ padding: 24 }}>
            <Space orientation="vertical" size={16} style={{ width: "100%" }}>
                <Card variant="borderless">
                    <Form layout="vertical">
                        <Row gutter={16} align="bottom">
                            <Col flex="220px">
                                <Form.Item label="手机号 / 模板 ID" style={{ marginBottom: 0 }}>
                                    <Input value={draft.keyword} placeholder="支持模糊搜索" allowClear onChange={(e) => setDraft((prev) => ({ ...prev, keyword: e.target.value }))} onPressEnter={handleSearch} />
                                </Form.Item>
                            </Col>
                            <Col flex="160px">
                                <Form.Item label="发送状态" style={{ marginBottom: 0 }}>
                                    <Select value={draft.status} options={smsLogStatusOptions} style={{ width: "100%" }} onChange={(value) => setDraft((prev) => ({ ...prev, status: value }))} />
                                </Form.Item>
                            </Col>
                            <Col flex="180px">
                                <Form.Item label="IP" style={{ marginBottom: 0 }}>
                                    <Input value={draft.ip} placeholder="精确匹配客户端 IP" allowClear onChange={(e) => setDraft((prev) => ({ ...prev, ip: e.target.value }))} onPressEnter={handleSearch} />
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
                            <Statistic title="成功条数" value={sumSuccess} loading={isLoading} styles={{ content: { color: "#3f8600" } }} />
                        </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                        <Card variant="borderless">
                            <Statistic title="失败条数" value={sumFailed} loading={isLoading} styles={{ content: { color: "#cf1322" } }} />
                        </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                        <Card variant="borderless">
                            <Statistic title="不同 IP 数量" value={sumIP} loading={isLoading} />
                        </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                        <Card variant="borderless">
                            <Statistic title="查询范围内记录数" value={sumTotal} loading={isLoading} />
                        </Card>
                    </Col>
                </Row>

                <ProTable<SmsLog>
                    rowKey="id"
                    columns={columns}
                    dataSource={items}
                    loading={isLoading}
                    search={false}
                    defaultSize="middle"
                    tableLayout="fixed"
                    scroll={{ x: 1100 }}
                    cardProps={{ variant: "borderless" }}
                    headerTitle={
                        <Space>
                            <Typography.Text strong>短信发送记录</Typography.Text>
                            <Tag>{total} 条</Tag>
                        </Space>
                    }
                    options={{ density: true, setting: true, reload: () => void refresh() }}
                    toolBarRender={() => [
                        <Button key="export" icon={<DownloadOutlined />} loading={exporting} onClick={() => void handleExport()}>
                            导出明细
                        </Button>,
                    ]}
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

            <Modal
                title="短信发送详情"
                open={detail !== null}
                width={720}
                onCancel={() => setDetail(null)}
                footer={<Button onClick={() => setDetail(null)}>关闭</Button>}
                destroyOnHidden
            >
                {detail && (
                    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                        <Descriptions size="small" column={2} bordered>
                            <Descriptions.Item label="状态">{renderStatus(detail.status)}</Descriptions.Item>
                            <Descriptions.Item label="耗时">{detail.durationMs ? `${detail.durationMs}ms` : "-"}</Descriptions.Item>
                            <Descriptions.Item label="手机号">{detail.phone}</Descriptions.Item>
                            <Descriptions.Item label="IP">{detail.ip || "-"}</Descriptions.Item>
                            <Descriptions.Item label="模板 ID">{detail.templateId || "-"}</Descriptions.Item>
                            <Descriptions.Item label="签名">{detail.sign || "-"}</Descriptions.Item>
                            <Descriptions.Item label="时间" span={2}>{fmtTime(detail.createdAt)}</Descriptions.Item>
                            <Descriptions.Item label="错误码" span={2}>
                                {detail.errorCode ? <Typography.Text type="danger">{detail.errorCode}</Typography.Text> : "-"}
                            </Descriptions.Item>
                            <Descriptions.Item label="失败原因" span={2}>
                                {detail.errorMessage ? <Typography.Text type="danger">{detail.errorMessage}</Typography.Text> : "-"}
                            </Descriptions.Item>
                            <Descriptions.Item label="RequestId" span={2}>
                                {detail.requestId ? <Typography.Text copyable style={{ fontSize: 12 }}>{detail.requestId}</Typography.Text> : "-"}
                            </Descriptions.Item>
                            <Descriptions.Item label="MessageId" span={2}>
                                {detail.messageId ? <Typography.Text copyable style={{ fontSize: 12 }}>{detail.messageId}</Typography.Text> : "-"}
                            </Descriptions.Item>
                        </Descriptions>
                        <div>
                            <Typography.Text type="secondary" strong>
                                请求内容
                            </Typography.Text>
                            <pre style={{ background: "var(--ant-color-fill-quaternary)", padding: 12, borderRadius: 8, marginTop: 6, maxHeight: 200, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                                {prettyJson(detail.requestPayload) || "-"}
                            </pre>
                        </div>
                        <div>
                            <Typography.Text type="secondary" strong>
                                返回内容
                            </Typography.Text>
                            <pre style={{ background: "var(--ant-color-fill-quaternary)", padding: 12, borderRadius: 8, marginTop: 6, maxHeight: 240, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                                {prettyJson(detail.responsePayload) || "-"}
                            </pre>
                        </div>
                    </Space>
                )}
            </Modal>
        </main>
    );
}
