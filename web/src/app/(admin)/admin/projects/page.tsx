"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Flex, Form, Input, InputNumber, Modal, Popconfirm, Progress, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import { PlusOutlined, QuestionCircleOutlined } from "@/components/icons";

import { adjustProjectCredits, assignProjectOwner, deleteAdminProject, fetchAdminProjects, fetchAdminUsers, getManagers, saveAdminProject, type AdminProject } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

type ProjectFormValues = {
    name: string;
    credits?: number;
    memberUserIds: string[];
    status: "active" | "disabled";
};

export default function AdminProjectsPage() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const isSuperAdmin = useUserStore((state) => state.user?.role) === "admin";
    const [projects, setProjects] = useState<AdminProject[]>([]);
    const [memberOptions, setMemberOptions] = useState<{ label: string; value: string }[]>([]);
    const [managers, setManagers] = useState<{ id: string; username: string }[]>([]);
    // 使用详情（成员积分用量）弹窗目标
    const [usageTarget, setUsageTarget] = useState<AdminProject | null>(null);
    const [loading, setLoading] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editing, setEditing] = useState<AdminProject | null>(null);
    const [saving, setSaving] = useState(false);
    const [form] = Form.useForm<ProjectFormValues>();

    // 加减积分弹窗
    const [creditTarget, setCreditTarget] = useState<AdminProject | null>(null);
    const [creditDelta, setCreditDelta] = useState<number>(0);
    const [adjusting, setAdjusting] = useState(false);

    const refresh = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        try {
            setProjects(await fetchAdminProjects(token));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载项目失败");
        } finally {
            setLoading(false);
        }
    }, [token, message]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // 成员候选：复用 /api/admin/users（后端已隔离：admin_l2 只拿自己子用户，super 拿全部）
    useEffect(() => {
        if (!token) return;
        void fetchAdminUsers(token, { pageSize: 1000 })
            .then((res) => setMemberOptions(res.items.map((user) => ({ label: user.username, value: user.id }))))
            .catch(() => {});
    }, [token]);

    // 超管：拉二级管理员列表，供「归属」列内联分配
    useEffect(() => {
        if (token && isSuperAdmin) void getManagers(token).then(setManagers).catch(() => {});
    }, [token, isSuperAdmin]);

    // 选项：空=收回到超管/全局，其余为各二级管理员
    const ownerOptions = [{ label: "超管 / 未分配", value: "" }, ...managers.map((manager) => ({ label: manager.username, value: manager.id }))];

    const changeProjectOwner = async (project: AdminProject, ownerId: string) => {
        try {
            const updated = await assignProjectOwner(token, project.id, ownerId);
            setProjects((prev) => prev.map((item) => (item.id === project.id ? updated : item)));
            message.success("已分配");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "分配失败");
        }
    };

    const openEditor = (project: AdminProject | null) => {
        setEditing(project);
        form.setFieldsValue(
            project
                ? { name: project.name, memberUserIds: project.memberUserIds || [], status: project.status }
                : { name: "", credits: 0, memberUserIds: [], status: "active" },
        );
        setEditorOpen(true);
    };

    const submit = async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            await saveAdminProject(token, {
                ...(editing ? { id: editing.id } : { credits: values.credits ?? 0 }),
                name: values.name,
                memberUserIds: values.memberUserIds || [],
                status: values.status,
            });
            message.success("项目已保存");
            setEditorOpen(false);
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    const openCredit = (project: AdminProject) => {
        setCreditTarget(project);
        setCreditDelta(0);
    };

    const submitCredit = async () => {
        if (!creditTarget || !creditDelta) {
            setCreditTarget(null);
            return;
        }
        setAdjusting(true);
        try {
            await adjustProjectCredits(token, creditTarget.id, creditDelta);
            message.success(creditDelta > 0 ? `已为「${creditTarget.name}」增加 ${creditDelta} 积分` : `已为「${creditTarget.name}」扣减 ${-creditDelta} 积分`);
            setCreditTarget(null);
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "调整失败");
        } finally {
            setAdjusting(false);
        }
    };

    const remove = async (project: AdminProject) => {
        try {
            await deleteAdminProject(token, project.id);
            message.success("项目已删除");
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    return (
        <main className="anim-fade" style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <div className="mb-4 flex items-center justify-between">
                        <div>
                            <Typography.Title level={5} className="!mb-1">
                                项目积分池
                            </Typography.Title>
                            <Typography.Text type="secondary">每个项目自带一个积分池；项目成员在画布选定该项目后，其生成消耗统一从项目池中扣除（而非个人积分）。</Typography.Text>
                        </div>
                        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
                            新建项目
                        </Button>
                    </div>
                    <Table
                        rowKey="id"
                        loading={loading}
                        dataSource={projects}
                        pagination={false}
                        columns={[
                            { title: "项目名称", dataIndex: "name" },
                            // 归属列只给超管看：项目属于哪个二级管理员（超管自己创建的显示「超管」）
                            ...(isSuperAdmin
                                ? [
                                      {
                                          title: "归属",
                                          width: 180,
                                          render: (_: unknown, project: AdminProject) => (
                                              <Select
                                                  size="small"
                                                  style={{ width: "100%" }}
                                                  value={project.ownerId ?? ""}
                                                  options={ownerOptions}
                                                  onChange={(value) => void changeProjectOwner(project, value)}
                                              />
                                          ),
                                      },
                                  ]
                                : []),
                            {
                                title: "积分（剩余 / 总额）",
                                width: 200,
                                render: (_, project: AdminProject) => (
                                    <Space size={6}>
                                        <Typography.Text strong>{project.credits}</Typography.Text>
                                        <Typography.Text type="secondary">/ {project.creditsTotal}</Typography.Text>
                                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                            （已用 {Math.max(0, project.creditsTotal - project.credits)}）
                                        </Typography.Text>
                                    </Space>
                                ),
                            },
                            { title: "成员数", width: 90, render: (_, project: AdminProject) => project.memberCount ?? project.members?.length ?? project.memberUserIds?.length ?? 0 },
                            {
                                title: (
                                    <Space size={4}>
                                        画布数
                                        <Tooltip title="有生成记录的画布数">
                                            <QuestionCircleOutlined style={{ color: "#9ca3af" }} />
                                        </Tooltip>
                                    </Space>
                                ),
                                width: 100,
                                render: (_, project: AdminProject) => project.canvasCount ?? 0,
                            },
                            {
                                title: "状态",
                                width: 90,
                                render: (_, project: AdminProject) => (project.status === "active" ? <Tag color="green">启用</Tag> : <Tag color="default">停用</Tag>),
                            },
                            {
                                title: "操作",
                                width: 300,
                                render: (_, project: AdminProject) => (
                                    <Space>
                                        <Button size="small" onClick={() => setUsageTarget(project)}>
                                            使用详情
                                        </Button>
                                        <Button size="small" onClick={() => openEditor(project)}>
                                            编辑
                                        </Button>
                                        <Button size="small" onClick={() => openCredit(project)}>
                                            加减积分
                                        </Button>
                                        <Popconfirm title="删除项目？" description="项目池积分将一并清除" onConfirm={() => void remove(project)}>
                                            <Button size="small" danger>
                                                删除
                                            </Button>
                                        </Popconfirm>
                                    </Space>
                                ),
                            },
                        ]}
                    />
                </Card>
            </Flex>

            <Modal
                title={editing ? `编辑项目：${editing.name}` : "新建项目"}
                open={editorOpen}
                confirmLoading={saving}
                onOk={() => void submit()}
                onCancel={() => setEditorOpen(false)}
                okText="保存"
                cancelText="取消"
                width={560}
                destroyOnHidden
            >
                <Form form={form} layout="vertical" className="pt-2">
                    <Form.Item name="name" label="项目名称" rules={[{ required: true, message: "请输入项目名称" }]}>
                        <Input placeholder="例如：618 大促 / 客户A交付" />
                    </Form.Item>
                    {!editing ? (
                        <Form.Item name="credits" label="初始积分池" extra="项目池初始额度，创建后可在「加减积分」中调整">
                            <InputNumber min={0} style={{ width: "100%" }} placeholder="0" />
                        </Form.Item>
                    ) : null}
                    <Form.Item name="memberUserIds" label="项目成员" extra="成员在画布选定本项目后，生成消耗从项目池扣除">
                        <Select mode="multiple" allowClear showSearch optionFilterProp="label" placeholder="选择成员用户" options={memberOptions} />
                    </Form.Item>
                    <Form.Item name="status" label="启用" valuePropName="checked" getValueProps={(value) => ({ checked: value === "active" })} getValueFromEvent={(checked) => (checked ? "active" : "disabled")}>
                        <Switch checkedChildren="启用" unCheckedChildren="停用" />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                title={creditTarget ? `加减积分：${creditTarget.name}` : "加减积分"}
                open={creditTarget !== null}
                confirmLoading={adjusting}
                onOk={() => void submitCredit()}
                onCancel={() => setCreditTarget(null)}
                okText="确定"
                cancelText="取消"
                width={420}
                destroyOnHidden
            >
                <Flex vertical gap={10} className="pt-2">
                    <Typography.Text type="secondary">
                        当前剩余 {creditTarget?.credits ?? 0} / 总额 {creditTarget?.creditsTotal ?? 0}。正数为增加，负数为扣减。
                    </Typography.Text>
                    <InputNumber autoFocus value={creditDelta} onChange={(value) => setCreditDelta(Number(value) || 0)} style={{ width: "100%" }} placeholder="如 100 或 -50" />
                </Flex>
            </Modal>

            <Modal
                title={usageTarget ? `使用详情：${usageTarget.name}` : "使用详情"}
                open={usageTarget !== null}
                onCancel={() => setUsageTarget(null)}
                footer={null}
                width={560}
                destroyOnHidden
            >
                {usageTarget ? (
                    <Flex vertical gap={12} className="pt-2">
                        <Space size={6} wrap>
                            <Typography.Text type="secondary">积分用量：</Typography.Text>
                            <Typography.Text strong>已用 {Math.max(0, usageTarget.creditsTotal - usageTarget.credits)}</Typography.Text>
                            <Typography.Text type="secondary">/ 总 {usageTarget.creditsTotal}（剩 {usageTarget.credits}）</Typography.Text>
                            <Typography.Text type="secondary">· 画布数 {usageTarget.canvasCount ?? 0}</Typography.Text>
                        </Space>
                        <Table
                            rowKey="userId"
                            size="small"
                            pagination={false}
                            // 空用量成员也列出（used=0）
                            dataSource={usageTarget.members ?? []}
                            locale={{ emptyText: "暂无成员用量数据" }}
                            columns={(() => {
                                const totalUsed = (usageTarget.members ?? []).reduce((sum, member) => sum + (member.used || 0), 0);
                                return [
                                    { title: "成员", dataIndex: "username", render: (value: string, member: { userId: string }) => value || member.userId },
                                    { title: "已用积分", dataIndex: "used", width: 110, render: (value: number) => value ?? 0 },
                                    {
                                        title: "占比",
                                        width: 160,
                                        render: (_: unknown, member: { used: number }) => {
                                            const percent = totalUsed > 0 ? Math.round(((member.used || 0) / totalUsed) * 100) : 0;
                                            return <Progress percent={percent} size="small" />;
                                        },
                                    },
                                ];
                            })()}
                        />
                    </Flex>
                ) : null}
            </Modal>
        </main>
    );
}
