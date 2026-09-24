"use client";

import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@/components/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { App, Avatar, Button, Card, Col, Divider, Flex, Form, Input, InputNumber, Modal, Row, Select, Space, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";

import { assignUserCreator, fetchAdminGroups, getManagers, type AdminGroup, type AdminUser } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";
import { useAdminUsers } from "./use-admin-users";

type UserFormValues = Partial<AdminUser> & { password?: string };

// 角色文案映射：admin_l2 = 二级管理员
const roleLabels: Record<string, string> = {
    admin: "管理员",
    admin_l2: "二级管理员",
    user: "用户",
};

// 超管可铸造的角色：含二级管理员（admin_l2）
const superAdminRoleOptions = [
    { label: "普通用户", value: "user" },
    { label: "管理员", value: "admin" },
    { label: "二级管理员", value: "admin_l2" },
];

// 二级管理员只能创建普通用户
const adminL2RoleOptions = [{ label: "普通用户", value: "user" }];

const statusOptions = [
    { label: "正常", value: "active" },
    { label: "禁用", value: "ban" },
];

// 从分组的 channels JSON 里取出渠道名列表（用于渲染「用户级 apiKey 覆盖」的逐渠道输入框）。
function parseChannelNames(channelsRaw?: string): string[] {
    if (!channelsRaw?.trim()) return [];
    try {
        const arr = JSON.parse(channelsRaw) as Array<{ name?: string }>;
        return Array.isArray(arr) ? arr.map((c) => (c.name || "").trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

// 解析用户已存的渠道 key 覆盖（JSON map 渠道名→key）。
function parseChannelKeyMap(raw?: string): Record<string, string> {
    if (!raw?.trim()) return {};
    try {
        const obj = JSON.parse(raw) as Record<string, string>;
        return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
    } catch {
        return {};
    }
}

export default function AdminUsersPage() {
    const { message } = App.useApp();
    const { users, keyword, page, pageSize, total, isLoading, searchUsers, changePage, changePageSize, resetFilters, refreshUsers, saveUser: saveAdminUser, adjustCredits, deleteUser } = useAdminUsers();
    const [form] = Form.useForm<UserFormValues>();
    const [keywordText, setKeywordText] = useState(keyword);
    const [editingUser, setEditingUser] = useState<Partial<AdminUser> | null>(null);
    // 用户级渠道 apiKey 覆盖草稿（渠道名→key），与表单分开维护
    const [channelKeyDraft, setChannelKeyDraft] = useState<Record<string, string>>({});
    const watchedGroupId = Form.useWatch("groupId", form);
    const token = useUserStore((state) => state.token);
    const currentRole = useUserStore((state) => state.user?.role);
    const isSuperAdmin = currentRole === "admin";
    const isAdminL2 = currentRole === "admin_l2";
    const currentUserId = useUserStore((state) => state.user?.id);
    const currentUserCredits = useUserStore((state) => state.user?.credits);
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const roleOptions = isSuperAdmin ? superAdminRoleOptions : adminL2RoleOptions;
    const [groups, setGroups] = useState<AdminGroup[]>([]);
    const [managers, setManagers] = useState<{ id: string; username: string }[]>([]);
    useEffect(() => {
        if (token) void fetchAdminGroups(token).then(setGroups).catch(() => {});
    }, [token]);
    // 超管：拉二级管理员列表，供「归属/创建者」列内联分配
    useEffect(() => {
        if (token && isSuperAdmin) void getManagers(token).then(setManagers).catch(() => {});
    }, [token, isSuperAdmin]);
    const groupOptions = [{ label: "未分组（无法调用 AI）", value: "" }, ...groups.map((group) => ({ label: group.name, value: group.id }))];
    // 选项：空=收回到超管/未分配，其余为各二级管理员
    const creatorOptions = [{ label: "超管 / 未分配", value: "" }, ...managers.map((manager) => ({ label: manager.username, value: manager.id }))];

    const changeUserCreator = async (user: AdminUser, creatorId: string) => {
        try {
            await assignUserCreator(token, user.id, creatorId);
            await refreshUsers();
            message.success("已分配");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "分配失败");
        }
    };
    const groupNameById = new Map(groups.map((group) => [group.id, group.name]));
    const [deletingUser, setDeletingUser] = useState<AdminUser | null>(null);
    const [myCreditsOpen, setMyCreditsOpen] = useState(false);
    const [myCreditsValue, setMyCreditsValue] = useState<number | null>(null);

    useEffect(() => setKeywordText(keyword), [keyword]);

    useEffect(() => {
        if (editingUser) {
            form.setFieldsValue({ role: "user", status: "active", groupId: "", ...editingUser, password: "" });
            setChannelKeyDraft(parseChannelKeyMap(editingUser.channelKeys));
        }
    }, [editingUser, form]);

    const saveUser = async () => {
        const value = await form.validateFields();
        const userValue = { ...value };
        delete userValue.credits;
        // 二级管理员只能创建/管理普通用户，角色强制锁死为 user
        if (isAdminL2) userValue.role = "user";
        // 组装用户级渠道 key 覆盖（去空；只保留当前分组实际存在的渠道，避免残留已删渠道的 key）
        const gid = (userValue.groupId ?? editingUser?.groupId ?? "") as string;
        const validNames = new Set(parseChannelNames(groups.find((g) => g.id === gid)?.channels));
        const compact: Record<string, string> = {};
        for (const [name, key] of Object.entries(channelKeyDraft)) {
            if (validNames.has(name) && (key || "").trim()) compact[name] = key.trim();
        }
        const channelKeys = Object.keys(compact).length ? JSON.stringify(compact) : "";
        await saveAdminUser({ ...editingUser, ...userValue, channelKeys, password: value.password || undefined });
        setEditingUser(null);
    };

    const saveCredits = async () => {
        if (!editingUser?.id) return;
        // 用调整接口返回的权威用户回填编辑态，使输入框同步到最新余额；
        // 否则 editingUser 仍是打开弹窗时的旧快照，连续点「调整」会用陈旧绝对值覆盖期间发生的扣费/退款。
        const updated = await adjustCredits(editingUser.id, form.getFieldValue("credits") || 0);
        if (updated?.id) setEditingUser(updated);
    };

    // 二级管理员调整自己账号的积分（后端按 id==自己 放行）；超管不需要此入口（可直接在列表里改任何人）。
    const saveMyCredits = async () => {
        if (!currentUserId) return;
        try {
            await adjustCredits(currentUserId, myCreditsValue ?? 0);
            await hydrateUser();
            await refreshUsers();
            setMyCreditsOpen(false);
            message.success("已调整我的积分");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "调整失败");
        }
    };

    const columns: ProColumns<AdminUser>[] = [
        {
            title: "用户",
            dataIndex: "username",
            width: 260,
            render: (_, item) => (
                <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                    <Avatar src={item.avatarUrl || undefined}>{(item.displayName || item.username || "U").slice(0, 1).toUpperCase()}</Avatar>
                    <Flex vertical style={{ minWidth: 0 }}>
                        <Typography.Text strong ellipsis>
                            {item.displayName || item.username}
                        </Typography.Text>
                        <Typography.Text type="secondary" ellipsis>
                            {item.username}
                        </Typography.Text>
                    </Flex>
                </Flex>
            ),
        },
        {
            title: "用户 ID",
            dataIndex: "id",
            width: 200,
            render: (_, item) => (
                <Typography.Text type="secondary" copyable={{ text: item.id }} ellipsis style={{ maxWidth: 180 }}>
                    {item.id}
                </Typography.Text>
            ),
        },
        {
            title: "分组",
            dataIndex: "groupId",
            width: 120,
            render: (_, item) => (item.groupId ? <Tag color="blue">{groupNameById.get(item.groupId) || item.groupId}</Tag> : <Tag color="orange">未分组</Tag>),
        },
        {
            title: "角色",
            dataIndex: "role",
            width: 100,
            render: (_, item) => <Tag color={item.role === "admin" ? "gold" : item.role === "admin_l2" ? "purple" : "default"}>{roleLabels[item.role] || "用户"}</Tag>,
        },
        // 归属列只给超管看：显示该用户由哪个二级管理员创建（超管自己创建的显示「超管」）
        ...(isSuperAdmin
            ? [
                  {
                      title: "归属",
                      dataIndex: "creatorName",
                      width: 180,
                      // 仅 role==user 可被分配；admin/admin_l2 显示纯文本「-」
                      render: (_, item) =>
                          item.role === "user" ? (
                              <Select
                                  size="small"
                                  style={{ width: "100%" }}
                                  value={item.creatorId ?? ""}
                                  options={creatorOptions}
                                  onChange={(value) => void changeUserCreator(item, value)}
                              />
                          ) : (
                              <Typography.Text type="secondary">-</Typography.Text>
                          ),
                  } as ProColumns<AdminUser>,
              ]
            : []),
        {
            title: "状态",
            dataIndex: "status",
            width: 90,
            render: (_, item) => <Tag color={item.status === "ban" ? "red" : "green"}>{item.status === "ban" ? "禁用" : "正常"}</Tag>,
        },
        {
            title: "点数",
            dataIndex: "credits",
            width: 100,
            render: (_, item) => <Typography.Text>{item.credits}</Typography.Text>,
        },
        {
            title: "最近登录",
            dataIndex: "lastLoginAt",
            width: 180,
            render: (_, item) => <Typography.Text type="secondary">{item.lastLoginAt ? dayjs(item.lastLoginAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Typography.Text>,
        },
        {
            title: "操作",
            key: "actions",
            width: 96,
            align: "right",
            render: (_, item) => (
                <Space size={4}>
                    <Tooltip title="编辑">
                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditingUser(item)} />
                    </Tooltip>
                    <Tooltip title="删除">
                        <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => setDeletingUser(item)} />
                    </Tooltip>
                </Space>
            ),
        },
    ];

    return (
        <main className="anim-fade" style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <Form layout="vertical">
                        <Row gutter={16} align="bottom">
                            <Col flex="360px">
                                <Form.Item label="关键词">
                                    <Input.Search
                                        value={keywordText}
                                        placeholder="搜索用户名、昵称或邮箱"
                                        allowClear
                                        enterButton={<SearchOutlined />}
                                        onSearch={() => searchUsers(keywordText)}
                                        onChange={(event) => setKeywordText(event.target.value)}
                                    />
                                </Form.Item>
                            </Col>
                            <Col flex="none">
                                <Form.Item>
                                    <Space>
                                        <Button
                                            onClick={() => {
                                                setKeywordText("");
                                                resetFilters();
                                            }}
                                        >
                                            重置
                                        </Button>
                                        <Button type="primary" icon={<ReloadOutlined />} onClick={() => searchUsers(keywordText)}>
                                            查询
                                        </Button>
                                    </Space>
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Card>
                <ProTable<AdminUser>
                    rowKey="id"
                    columns={columns}
                    dataSource={users}
                    loading={isLoading}
                    search={false}
                    defaultSize="middle"
                    tableLayout="fixed"
                    scroll={{ x: 1100 }}
                    cardProps={{ variant: "borderless" }}
                    headerTitle={
                        <Space>
                            <Typography.Text strong>用户列表</Typography.Text>
                            <Tag>{total} 人</Tag>
                        </Space>
                    }
                    options={{ density: true, setting: true, reload: () => void refreshUsers() }}
                    toolBarRender={() => [
                        ...(isAdminL2
                            ? [
                                  <Button key="my-credits" onClick={() => { setMyCreditsValue(currentUserCredits ?? 0); setMyCreditsOpen(true); }}>
                                      调整我的积分
                                  </Button>,
                              ]
                            : []),
                        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => setEditingUser({ role: "user", status: "active" })}>
                            新增
                        </Button>,
                    ]}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showSizeChanger: true,
                        pageSizeOptions: [10, 20, 50, 100],
                        showTotal: (value) => `共 ${value} 人`,
                        onChange: (nextPage, nextPageSize) => (nextPageSize !== pageSize ? changePageSize(nextPageSize) : changePage(nextPage)),
                    }}
                />
            </Flex>

            <Modal title="调整我的积分" open={myCreditsOpen} onCancel={() => setMyCreditsOpen(false)} onOk={() => void saveMyCredits()} okText="保存" cancelText="取消" destroyOnHidden>
                <Typography.Paragraph type="secondary">设置你自己账号的积分总额（绝对值，非增量）。当前：{currentUserCredits ?? 0}</Typography.Paragraph>
                <InputNumber style={{ width: "100%" }} min={0} value={myCreditsValue} onChange={(value) => setMyCreditsValue(typeof value === "number" ? value : 0)} />
            </Modal>

            <Modal title={editingUser?.id ? "编辑用户" : "新增用户"} open={Boolean(editingUser)} width={680} onCancel={() => setEditingUser(null)} onOk={() => void saveUser()} okText="保存" cancelText="取消" destroyOnHidden>
                <Form form={form} layout="vertical" requiredMark={false}>
                    <Typography.Text strong>基础信息</Typography.Text>
                    <Row gutter={14}>
                        <Col span={12}>
                            <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="password" label={editingUser?.id ? "新密码" : "密码"} rules={editingUser?.id ? [] : [{ required: true, message: "请输入密码" }]}>
                                <Input.Password autoComplete="new-password" />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="displayName" label="昵称">
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="email" label="邮箱">
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]} extra={isAdminL2 ? "二级管理员只能创建普通用户" : undefined}>
                                <Select options={roleOptions} disabled={isAdminL2} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="status" label="状态" rules={[{ required: true, message: "请选择状态" }]}>
                                <Select options={statusOptions} />
                            </Form.Item>
                        </Col>
                        <Col span={24}>
                            <Form.Item name="groupId" label="所属分组" extra="决定该用户调用 AI / 人像资产所用的凭证；未分组用户无法使用相关能力">
                                <Select options={groupOptions} placeholder="选择分组" />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Divider style={{ margin: "4px 0 12px" }} />
                    <Typography.Text strong>渠道 API Key 覆盖（选填）</Typography.Text>
                    <Typography.Paragraph type="secondary" className="!mb-3 !mt-1" style={{ fontSize: 12 }}>
                        为该用户单独指定某渠道的上游 API Key：填了就用用户自己的、留空则用团队该渠道自带的 key。仅替换 key，渠道地址/协议/模型路由与点数计费均不变。
                    </Typography.Paragraph>
                    {(() => {
                        const gid = (watchedGroupId ?? editingUser?.groupId ?? "") as string;
                        const chNames = parseChannelNames(groups.find((g) => g.id === gid)?.channels);
                        if (!gid) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>请先选择「所属分组」，再为该用户覆盖各渠道的 API Key。</Typography.Text>;
                        if (!chNames.length) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>该分组还没有配置模型渠道，无可覆盖项。</Typography.Text>;
                        return (
                            <Row gutter={14}>
                                {chNames.map((name) => (
                                    <Col span={12} key={name}>
                                        <Form.Item label={name} className="!mb-2" extra="留空=用团队该渠道的 key">
                                            <Input.Password
                                                value={channelKeyDraft[name] || ""}
                                                placeholder="用户自有 apiKey"
                                                autoComplete="new-password"
                                                onChange={(e) => setChannelKeyDraft((prev) => ({ ...prev, [name]: e.target.value }))}
                                            />
                                        </Form.Item>
                                    </Col>
                                ))}
                            </Row>
                        );
                    })()}
                    {editingUser?.id ? (
                        <>
                            <Divider style={{ margin: "4px 0 16px" }} />
                            <Typography.Text strong>点数调整</Typography.Text>
                            <Row gutter={14}>
                                <Col span={12}>
                                    <Form.Item label="点数">
                                        <Space.Compact style={{ width: "100%" }}>
                                            <Form.Item name="credits" noStyle>
                                                <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                                            </Form.Item>
                                            <Button onClick={() => void saveCredits()}>调整</Button>
                                        </Space.Compact>
                                    </Form.Item>
                                </Col>
                            </Row>
                        </>
                    ) : null}
                </Form>
            </Modal>

            <Modal
                title="删除用户"
                open={Boolean(deletingUser)}
                onCancel={() => setDeletingUser(null)}
                onOk={async () => {
                    if (!deletingUser) return;
                    await deleteUser(deletingUser.id);
                    setDeletingUser(null);
                }}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                确定删除「{deletingUser?.displayName || deletingUser?.username}」吗？删除后该账号将无法继续登录。
            </Modal>
        </main>
    );
}
