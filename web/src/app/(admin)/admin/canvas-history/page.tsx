"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Card, Empty, Flex, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { HistoryOutlined } from "@/components/icons";

import { fetchAdminUsers, getCanvasSnapshot, listCanvasSnapshots, restoreCanvasSnapshot, type AdminCanvasSnapshot } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

// bytes 友好显示：B / KB / MB
function formatBytes(bytes: number): string {
    if (!bytes || bytes < 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// 预览用：从 manifest JSON 文本里解析出画布标题/节点数列表（解析失败给空）。
type PreviewProject = { id: string; title: string; nodes: number };
function parseManifestProjects(dataText: string): PreviewProject[] {
    try {
        // 同步清单结构为 { app, version, domain, data: { projects: [...] }, files }，画布在 data.projects；
        // 兼容极少数顶层直挂 projects 的旧形态。与后端 countManifestProjects 的取值路径保持一致。
        type ManifestProject = { id?: string; title?: string; nodes?: unknown[] };
        const manifest = JSON.parse(dataText) as { data?: { projects?: ManifestProject[] }; projects?: ManifestProject[] };
        const projects = Array.isArray(manifest?.data?.projects) ? manifest.data!.projects! : Array.isArray(manifest?.projects) ? manifest.projects : [];
        return projects.map((project, index) => ({
            id: project?.id || String(index),
            title: project?.title || "（未命名画布）",
            nodes: Array.isArray(project?.nodes) ? project.nodes.length : 0,
        }));
    } catch {
        return [];
    }
}

export default function AdminCanvasHistoryPage() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);

    const [userOptions, setUserOptions] = useState<{ label: string; value: string }[]>([]);
    const [selectedUserId, setSelectedUserId] = useState<string | undefined>(undefined);
    const [snapshots, setSnapshots] = useState<AdminCanvasSnapshot[]>([]);
    const [loading, setLoading] = useState(false);

    // 预览弹窗
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewSnapId, setPreviewSnapId] = useState<string | null>(null);
    const [previewProjects, setPreviewProjects] = useState<PreviewProject[]>([]);

    const [restoringId, setRestoringId] = useState<string | null>(null);

    // 用户候选：复用 /api/admin/users（后端按角色隔离）；显示 username。
    useEffect(() => {
        if (!token) return;
        void fetchAdminUsers(token, { pageSize: 1000 })
            .then((res) => setUserOptions(res.items.map((user) => ({ label: user.username, value: user.id }))))
            .catch((error) => message.error(error instanceof Error ? error.message : "加载用户列表失败"));
    }, [token, message]);

    const refresh = useCallback(
        async (userId: string) => {
            if (!token || !userId) return;
            setLoading(true);
            try {
                setSnapshots(await listCanvasSnapshots(token, userId));
            } catch (error) {
                setSnapshots([]);
                message.error(error instanceof Error ? error.message : "加载画布历史失败");
            } finally {
                setLoading(false);
            }
        },
        [token, message],
    );

    useEffect(() => {
        if (selectedUserId) void refresh(selectedUserId);
        else setSnapshots([]);
    }, [selectedUserId, refresh]);

    const selectedUsername = useMemo(() => userOptions.find((option) => option.value === selectedUserId)?.label ?? "", [userOptions, selectedUserId]);

    const openPreview = async (snapId: string) => {
        setPreviewSnapId(snapId);
        setPreviewProjects([]);
        setPreviewOpen(true);
        setPreviewLoading(true);
        try {
            const detail = await getCanvasSnapshot(token, snapId);
            setPreviewProjects(parseManifestProjects(detail.data));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载快照预览失败");
            setPreviewOpen(false);
        } finally {
            setPreviewLoading(false);
        }
    };

    const confirmRestore = (snapshot: AdminCanvasSnapshot) => {
        if (!selectedUserId) return;
        Modal.confirm({
            title: "恢复到此版本？",
            content: (
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    将用该快照（{new Date(snapshot.createdAt).toLocaleString()}）覆盖用户「{selectedUsername || selectedUserId}」当前的云端画布。
                    当前版本会自动备份为一个新快照，如需撤销可再恢复到该备份。是否继续？
                </Typography.Paragraph>
            ),
            okText: "确认恢复",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                setRestoringId(snapshot.id);
                try {
                    const result = await restoreCanvasSnapshot(token, selectedUserId, snapshot.id);
                    message.success(`已恢复，当前版本已备份为快照 ${result.backupSnapshotId}`);
                    await refresh(selectedUserId);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "恢复失败");
                    throw error; // 让 Modal 保持打开，提示失败
                } finally {
                    setRestoringId(null);
                }
            },
        });
    };

    return (
        <main className="anim-fade" style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <div className="mb-4 flex items-center justify-between">
                        <div>
                            <Typography.Title level={5} className="!mb-1">
                                <Space size={8}>
                                    <HistoryOutlined />
                                    服务端画布历史
                                </Space>
                            </Typography.Title>
                            <Typography.Text type="secondary">查看任意用户的云端画布快照（最多 30 个版本），可预览版本内容，或将其恢复覆盖该用户当前云端画布（恢复前会自动备份当前版本）。</Typography.Text>
                        </div>
                        <Select
                            showSearch
                            allowClear
                            optionFilterProp="label"
                            placeholder="选择用户"
                            style={{ width: 260 }}
                            value={selectedUserId}
                            options={userOptions}
                            onChange={(value) => setSelectedUserId(value)}
                        />
                    </div>
                    {selectedUserId ? (
                        <Table
                            rowKey="id"
                            loading={loading}
                            dataSource={snapshots}
                            pagination={false}
                            locale={{ emptyText: <Empty description="该用户暂无画布快照" /> }}
                            columns={[
                                {
                                    title: "创建时间",
                                    dataIndex: "createdAt",
                                    render: (value: string) => new Date(value).toLocaleString(),
                                },
                                {
                                    title: "画布数",
                                    dataIndex: "projects",
                                    width: 100,
                                    render: (value: number) => <Tag color="blue">{value}</Tag>,
                                },
                                {
                                    title: "大小",
                                    dataIndex: "bytes",
                                    width: 120,
                                    render: (value: number) => formatBytes(value),
                                },
                                {
                                    title: "操作",
                                    width: 220,
                                    render: (_, snapshot: AdminCanvasSnapshot) => (
                                        <Space>
                                            <Button size="small" onClick={() => void openPreview(snapshot.id)}>
                                                预览
                                            </Button>
                                            <Button size="small" danger loading={restoringId === snapshot.id} onClick={() => confirmRestore(snapshot)}>
                                                恢复到此版本
                                            </Button>
                                        </Space>
                                    ),
                                },
                            ]}
                        />
                    ) : (
                        <Empty description="请先在右上角选择一个用户" />
                    )}
                </Card>
            </Flex>

            <Modal
                title="快照预览（只读）"
                open={previewOpen}
                onCancel={() => setPreviewOpen(false)}
                footer={null}
                width={560}
                destroyOnHidden
            >
                <Flex vertical gap={12} className="pt-2">
                    <Typography.Text type="secondary">
                        快照 ID：{previewSnapId} · 共 {previewProjects.length} 个画布
                    </Typography.Text>
                    <Table
                        rowKey="id"
                        size="small"
                        loading={previewLoading}
                        pagination={false}
                        dataSource={previewProjects}
                        locale={{ emptyText: previewLoading ? "加载中…" : "该快照无画布或解析失败" }}
                        columns={[
                            { title: "画布标题", dataIndex: "title", render: (value: string) => value || "（未命名画布）" },
                            { title: "节点数", dataIndex: "nodes", width: 100, render: (value: number) => value ?? 0 },
                        ]}
                    />
                </Flex>
            </Modal>
        </main>
    );
}
