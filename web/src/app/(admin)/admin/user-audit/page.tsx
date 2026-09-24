"use client";

import { ReloadOutlined, SearchOutlined } from "@/components/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { App, Button, Card, Form, Input, Space, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";

import {
    fetchUserAuditLogs,
    parseUserAuditChanges,
    userAuditFieldLabels,
    userAuditSensitiveFields,
    type UserAuditLog,
} from "@/services/api/user-audit";
import { useUserStore } from "@/stores/use-user-store";

// 「用户操作审计」：谁在什么时候改了哪个用户的什么字段。
//
// ⚠️ 服务端只记「密码/渠道密钥改过」这个事实，不记值。所以这里对这两类字段
// 一律显示「已修改」，不要试图展示任何值或占位密文——那会让人误以为系统存了明文。

function fmtTime(v: string) {
    if (!v) return "";
    const d = dayjs(v);
    return d.isValid() ? d.format("YYYY-MM-DD HH:mm:ss") : v;
}

function renderChanges(raw: string) {
    const changes = parseUserAuditChanges(raw);
    if (!changes.length) return <Typography.Text type="secondary">—</Typography.Text>;
    return (
        <Space size={[4, 4]} wrap>
            {changes.map((ch, index) => {
                const label = userAuditFieldLabels[ch.field] || ch.field;
                if (userAuditSensitiveFields.has(ch.field)) {
                    // 敏感字段：服务端根本没下发值，如实写「已修改」
                    return (
                        <Tag key={`${ch.field}-${index}`} color="red">
                            {label} 已修改
                        </Tag>
                    );
                }
                const from = ch.from || "（空）";
                const to = ch.to || "（空）";
                return (
                    <Tooltip key={`${ch.field}-${index}`} title={`${from} → ${to}`}>
                        <Tag color="blue">
                            {label}: {from.length > 12 ? `${from.slice(0, 12)}…` : from} → {to.length > 12 ? `${to.slice(0, 12)}…` : to}
                        </Tag>
                    </Tooltip>
                );
            })}
        </Space>
    );
}

const emptyDraft = { keyword: "", targetUserId: "", operatorId: "" };

export default function AdminUserAuditPage() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const [draft, setDraft] = useState(emptyDraft);
    const [filters, setFilters] = useState(emptyDraft);
    const [items, setItems] = useState<UserAuditLog[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await fetchUserAuditLogs({ ...filters, page, pageSize }, token || undefined);
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

    const columns: ProColumns<UserAuditLog>[] = [
        { title: "时间", dataIndex: "createdAt", width: 170, render: (_, r) => fmtTime(r.createdAt) },
        {
            title: "操作",
            dataIndex: "action",
            width: 80,
            render: (_, r) => (r.action === "create" ? <Tag color="green">新建</Tag> : <Tag>编辑</Tag>),
        },
        {
            title: "被改用户",
            dataIndex: "targetUsername",
            width: 150,
            render: (_, r) => (
                <Tooltip title={r.targetUserId}>
                    <span>{r.targetUsername || r.targetUserId}</span>
                </Tooltip>
            ),
        },
        {
            title: "操作人",
            dataIndex: "operatorName",
            width: 140,
            render: (_, r) => (
                <Tooltip title={r.operatorId}>
                    <span>{r.operatorName || r.operatorId || "—"}</span>
                </Tooltip>
            ),
        },
        { title: "变更内容", dataIndex: "changes", render: (_, r) => renderChanges(r.changes) },
        { title: "来源 IP", dataIndex: "ip", width: 140, render: (_, r) => r.ip || "—" },
    ];

    return (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Card size="small">
                <Form layout="inline">
                    <Form.Item label="关键词">
                        <Input
                            allowClear
                            placeholder="用户名 / 操作人 / 字段"
                            style={{ width: 220 }}
                            value={draft.keyword}
                            onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
                            onPressEnter={() => {
                                setPage(1);
                                setFilters(draft);
                            }}
                        />
                    </Form.Item>
                    <Form.Item label="被改用户 ID">
                        <Input
                            allowClear
                            placeholder="user-xxxx"
                            style={{ width: 260 }}
                            value={draft.targetUserId}
                            onChange={(e) => setDraft({ ...draft, targetUserId: e.target.value })}
                        />
                    </Form.Item>
                    <Form.Item>
                        <Space>
                            <Button
                                type="primary"
                                icon={<SearchOutlined />}
                                onClick={() => {
                                    setPage(1);
                                    setFilters(draft);
                                }}
                            >
                                查询
                            </Button>
                            <Button
                                onClick={() => {
                                    setDraft(emptyDraft);
                                    setFilters(emptyDraft);
                                    setPage(1);
                                }}
                            >
                                重置
                            </Button>
                            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                                刷新
                            </Button>
                        </Space>
                    </Form.Item>
                </Form>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
                    记录后台「用户管理」里的新建与编辑。<b>密码与渠道密钥只记「已修改」，系统不保存也不显示它们的值。</b>
                    来源 IP 由 nginx 注入；若有人绕过 nginx 直连应用端口，该 IP 不可信。
                </Typography.Paragraph>
            </Card>

            <ProTable<UserAuditLog>
                rowKey="id"
                search={false}
                toolBarRender={false}
                loading={loading}
                dataSource={items}
                columns={columns}
                pagination={{
                    current: page,
                    pageSize,
                    total,
                    showSizeChanger: true,
                    showTotal: (t) => `共 ${t} 条`,
                    onChange: (nextPage, nextSize) => {
                        setPage(nextPage);
                        if (nextSize !== pageSize) setPageSize(nextSize);
                    },
                }}
            />
        </Space>
    );
}
