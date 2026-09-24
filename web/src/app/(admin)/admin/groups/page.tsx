"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Checkbox, Flex, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { CloudDownloadOutlined, DeleteOutlined, PlusOutlined } from "@/components/icons";

import { assignGroupOwner, deleteAdminGroup, fetchAdminGroups, fetchChannelModels, getManagers, saveAdminGroup, testGroupStorage, type AdminGroup, type GroupStorageTestInput } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

// 渠道在分组下自行维护：每组一份渠道列表（名称/地址/密钥/模型），模型按组内渠道路由
type GroupChannelForm = {
    id?: string; // 稳定渠道 ID（后端生成/保留；按渠道归集用量时用它）
    name: string;
    protocol: string; // openai（OpenAI 兼容）/ volc-audio（火山音频·豆包语音）
    resourceId?: string; // 仅 volc-audio：X-Api-Resource-Id
    baseUrl: string;
    apiKey: string;
    models: string; // 逗号/换行分隔
    enabled: boolean;
    hidden: boolean; // 该渠道对二级管理员隐藏（仅超管可设；后端返回给 L2 时已剥除 hidden 渠道）
};

type GroupFormValues = Pick<
    AdminGroup,
    | "name"
    | "volcAccessKey"
    | "volcSecretKey"
    | "volcAssetProject"
    | "volcRegion"
    | "volcGroupName"
    | "tosBucket"
    | "tosEndpoint"
    | "tosRegion"
    | "tosAccessKey"
    | "tosSecretKey"
    | "tosPublicBase"
> & {
    channelsList?: GroupChannelForm[];
};

type StoredChannel = { id?: string; protocol?: string; resourceId?: string; name?: string; baseUrl?: string; apiKey?: string; models?: string[]; weight?: number; enabled?: boolean; remark?: string; hidden?: boolean; };

function parseGroupChannels(raw: string | undefined): StoredChannel[] {
    if (!raw?.trim()) return [];
    try {
        const parsed = JSON.parse(raw) as StoredChannel[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function toChannelForms(channels: StoredChannel[]): GroupChannelForm[] {
    return channels.map((channel) => ({
        id: channel.id || "",
        name: channel.name || "",
        protocol: channel.protocol || "openai",
        // ⚠️ 逐字段重建时必须带上 resourceId，漏了的话每保存一次分组就把它写空（本项目老坑）。
        resourceId: channel.resourceId || "",
        baseUrl: channel.baseUrl || "",
        apiKey: channel.apiKey || "",
        models: (channel.models || []).join(", "),
        enabled: channel.enabled !== false,
        hidden: channel.hidden === true,
    }));
}

function toStoredChannels(forms: GroupChannelForm[]): StoredChannel[] {
    return forms
        // 火山音频(volc-audio)的 baseUrl 可空(后端默认 openspeech 域名)，故只对它放宽 baseUrl 必填。
        .filter((item) => (item.name || "").trim() && ((item.baseUrl || "").trim() || item.protocol === "volc-audio"))
        .map((item) => ({
            protocol: item.protocol || "openai",
            resourceId: (item.resourceId || "").trim(),
            name: item.name.trim(),
            baseUrl: (item.baseUrl || "").trim(),
            apiKey: (item.apiKey || "").trim(),
            models: (item.models || "")
                .split(/[\n,，]/)
                .map((value) => value.trim())
                .filter(Boolean),
            weight: 1,
            enabled: item.enabled !== false,
            remark: "",
            hidden: item.hidden === true,
            ...(item.id ? { id: item.id } : {}),
        }));
}

export default function AdminGroupsPage() {
    const { message, modal } = App.useApp();
    const token = useUserStore((state) => state.token);
    const isSuperAdmin = useUserStore((state) => state.user?.role) === "admin";
    const [groups, setGroups] = useState<AdminGroup[]>([]);
    const [managers, setManagers] = useState<{ id: string; username: string }[]>([]);
    const [loading, setLoading] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editing, setEditing] = useState<AdminGroup | null>(null);
    const [saving, setSaving] = useState(false);
    const [testingStorage, setTestingStorage] = useState(false);
    const [form] = Form.useForm<GroupFormValues>();

    const [fetchingModelsAt, setFetchingModelsAt] = useState<number | null>(null);
    // 模型选择器：拉取/手动维护候选模型，勾选后写回该渠道的模型框
    const [selectorFieldIndex, setSelectorFieldIndex] = useState<number | null>(null);
    const [selectorCandidates, setSelectorCandidates] = useState<string[]>([]);
    const [selectorChecked, setSelectorChecked] = useState<string[]>([]);
    const [selectorKeyword, setSelectorKeyword] = useState("");
    const [selectorNewModel, setSelectorNewModel] = useState("");

    const refresh = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        try {
            setGroups(await fetchAdminGroups(token));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载分组失败");
        } finally {
            setLoading(false);
        }
    }, [token, message]);

    const splitModels = (value: string | undefined) =>
        (value || "")
            .split(/[\n,，]/)
            .map((item) => item.trim())
            .filter(Boolean);

    // 打开模型选择器：用该渠道填写的 BaseURL + API Key 拉取上游 /models，与已填模型合并成候选列表供勾选
    const openModelSelector = async (fieldIndex: number) => {
        const channel = form.getFieldValue(["channelsList", fieldIndex]) as GroupChannelForm | undefined;
        if (!channel?.baseUrl?.trim() || !channel?.apiKey?.trim()) {
            message.warning("请先填写该渠道的 BaseURL 与 API Key 再拉取");
            return;
        }
        const existing = splitModels(channel.models);
        setFetchingModelsAt(fieldIndex);
        try {
            const fetched = await fetchChannelModels(token, {
                channel: { protocol: (channel.protocol || "openai") as "openai", name: channel.name || "", baseUrl: channel.baseUrl.trim(), apiKey: channel.apiKey.trim(), models: [], weight: 1, enabled: true, remark: "" },
            }).catch((error) => {
                // 上游无 /models 不阻断：仍可在选择器里手动增加模型
                message.info(error instanceof Error ? error.message : "上游未返回模型列表，可在弹窗手动增加");
                return [] as string[];
            });
            const candidates = Array.from(new Set([...existing, ...fetched]));
            setSelectorCandidates(candidates);
            setSelectorChecked(existing); // 已填的默认勾选
            setSelectorKeyword("");
            setSelectorNewModel("");
            setSelectorFieldIndex(fieldIndex);
            if (fetched.length) message.success(`拉取到 ${fetched.length} 个模型，勾选需要的`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "拉取模型失败");
        } finally {
            setFetchingModelsAt(null);
        }
    };

    const addSelectorModel = () => {
        const value = selectorNewModel.trim();
        if (!value) return;
        if (!selectorCandidates.includes(value)) setSelectorCandidates((prev) => [value, ...prev]);
        if (!selectorChecked.includes(value)) setSelectorChecked((prev) => [...prev, value]);
        setSelectorNewModel("");
    };

    const confirmModelSelector = () => {
        if (selectorFieldIndex === null) return;
        const list = form.getFieldValue("channelsList") as GroupChannelForm[];
        const next = [...list];
        next[selectorFieldIndex] = { ...next[selectorFieldIndex], models: selectorChecked.join(", ") };
        form.setFieldValue("channelsList", next);
        setSelectorFieldIndex(null);
    };

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // 超管：拉二级管理员列表，供「归属」列内联分配
    useEffect(() => {
        if (token && isSuperAdmin) void getManagers(token).then(setManagers).catch(() => {});
    }, [token, isSuperAdmin]);

    // 选项：空=收回到超管/全局，其余为各二级管理员
    const ownerOptions = [{ label: "超管 / 未分配", value: "" }, ...managers.map((manager) => ({ label: manager.username, value: manager.id }))];

    const changeGroupOwner = async (group: AdminGroup, ownerId: string) => {
        try {
            const updated = await assignGroupOwner(token, group.id, ownerId);
            // 乐观更新：用后端返回的带 ownerName 的 group 替换该行
            setGroups((prev) => prev.map((item) => (item.id === group.id ? updated : item)));
            message.success("已分配");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "分配失败");
        }
    };



    const openEditor = (group: AdminGroup | null) => {
        setEditing(group);
        form.setFieldsValue(
            group
                ? { ...group, channelsList: toChannelForms(parseGroupChannels(group.channels)) }
                : { name: "", volcAccessKey: "", volcSecretKey: "", volcAssetProject: "", volcRegion: "", volcGroupName: "", tosBucket: "", tosEndpoint: "", tosRegion: "", tosAccessKey: "", tosSecretKey: "", tosPublicBase: "", channelsList: [] },
        );
        setEditorOpen(true);
    };

    const submit = async () => {
        const { channelsList, ...values } = await form.validateFields();
        const channels = toStoredChannels(channelsList || []);
        setSaving(true);
        try {
            await saveAdminGroup(token, { ...(editing ? { id: editing.id } : {}), ...values, channels: channels.length ? JSON.stringify(channels) : "", channelApiKey: "", channelKeys: "", channelBaseUrl: "" });
            message.success("分组已保存");
            setEditorOpen(false);
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    // 连通性自检：用表单当前填写的桶配置（未保存也可测），后端写一个测试对象再从公网读回。
    const testStorage = async () => {
        const v = form.getFieldsValue(["tosBucket", "tosEndpoint", "tosRegion", "tosAccessKey", "tosSecretKey", "tosPublicBase"]) as Partial<GroupStorageTestInput>;
        if (!(v.tosBucket || "").trim()) {
            message.warning("请先填写桶名再测试（留空=用全局默认桶，无需测试）");
            return;
        }
        setTestingStorage(true);
        try {
            const res = await testGroupStorage(token, {
                tosBucket: v.tosBucket || "",
                tosEndpoint: v.tosEndpoint || "",
                tosRegion: v.tosRegion || "",
                tosAccessKey: v.tosAccessKey || "",
                tosSecretKey: v.tosSecretKey || "",
                tosPublicBase: v.tosPublicBase || "",
            });
            message.success(res.message || "连通正常");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "测试失败");
        } finally {
            setTestingStorage(false);
        }
    };

    const remove = async (group: AdminGroup) => {
        try {
            await deleteAdminGroup(token, group.id);
            message.success("分组已删除，组内用户已变为未分组");
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
                                用户分组
                            </Typography.Title>
                            <Typography.Text type="secondary">每个分组自行维护模型渠道（地址/密钥/模型）与火山方舟资产库凭证；组内用户的模型按本组渠道路由。未分组用户无法调用 AI。</Typography.Text>
                        </div>
                        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
                            新建分组
                        </Button>
                    </div>
                    <Table
                        rowKey="id"
                        loading={loading}
                        dataSource={groups}
                        pagination={false}
                        columns={[
                            { title: "分组名称", dataIndex: "name" },
                            {
                                title: "模型渠道",
                                render: (_, group: AdminGroup) => {
                                    const channels = parseGroupChannels(group.channels);
                                    return channels.length ? (
                                        <Space size={4} wrap>
                                            {channels.map((channel) => (
                                                <Tag color={channel.enabled !== false ? "blue" : "default"} key={channel.name}>
                                                    {channel.name}（{(channel.models || []).length} 模型）
                                                </Tag>
                                            ))}
                                        </Space>
                                    ) : (
                                        <Tag color="red">未配置渠道</Tag>
                                    );
                                },
                            },
                            {
                                title: "火山方舟",
                                render: (_, group: AdminGroup) => (
                                    <Space size={4} wrap>
                                        {group.volcAccessKey && group.volcSecretKey ? <Tag color="green">AK/SK 已配置</Tag> : <Tag color="red">未配置 AK/SK</Tag>}
                                        {group.volcAssetProject ? <Tag>{group.volcAssetProject}</Tag> : <Tag color="default">默认项目</Tag>}
                                        {group.volcRegion ? <Tag>{group.volcRegion}</Tag> : null}
                                    </Space>
                                ),
                            },
                            {
                                title: "对象存储",
                                render: (_, group: AdminGroup) =>
                                    group.tosBucket ? (
                                        group.tosAccessKey && group.tosSecretKey && group.tosPublicBase ? (
                                            <Tag color="green">自有桶 {group.tosBucket}</Tag>
                                        ) : (
                                            <Tag color="orange">配置不完整</Tag>
                                        )
                                    ) : (
                                        <Tag color="default">全局默认桶</Tag>
                                    ),
                            },
                            // 归属列只给超管看：分组属于哪个二级管理员（超管自己创建的显示「超管」）
                            ...(isSuperAdmin
                                ? [
                                      {
                                          title: "归属",
                                          width: 180,
                                          render: (_: unknown, group: AdminGroup) => (
                                              <Select
                                                  size="small"
                                                  style={{ width: "100%" }}
                                                  value={group.ownerId ?? ""}
                                                  options={ownerOptions}
                                                  onChange={(value) => void changeGroupOwner(group, value)}
                                              />
                                          ),
                                      },
                                  ]
                                : []),
                            { title: "创建时间", dataIndex: "createdAt", width: 180 },
                            {
                                title: "操作",
                                width: 140,
                                render: (_, group: AdminGroup) => (
                                    <Space>
                                        <Button size="small" onClick={() => openEditor(group)}>
                                            编辑
                                        </Button>
                                        <Popconfirm title="删除分组？" description="组内用户将变为未分组（无法调用 AI）" onConfirm={() => void remove(group)}>
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
                title={editing ? `编辑分组：${editing.name}` : "新建分组"}
                open={editorOpen}
                confirmLoading={saving}
                onOk={() => void submit()}
                onCancel={() => setEditorOpen(false)}
                okText="保存"
                cancelText="取消"
                width={720}
                destroyOnHidden
            >
                <Form form={form} layout="vertical" className="pt-2">
                    <Form.Item name="name" label="分组名称" rules={[{ required: true, message: "请输入分组名称" }]}>
                        <Input placeholder="例如：一组 / 设计部" />
                    </Form.Item>
                    <Typography.Text strong>模型渠道（本组专属）</Typography.Text>
                    <Form.List name="channelsList">
                        {(fields, { add, remove: removeField }) => (
                            <div className="mt-2 flex flex-col gap-3">
                                {fields.map((field) => (
                                    <div key={field.key} className="rounded-xl border border-stone-200 bg-stone-50/60 p-3 dark:border-stone-700 dark:bg-stone-900/30">
                                        {/* ⚠️ 渠道 ID 必须在表单里注册（哪怕是隐藏的）：提交走 form.validateFields()，
                                            而 antd 只回收注册过的字段——没有这一行，toChannelForms 读进来的 id 到了
                                            toStoredChannels 就是 undefined，后端 ensureChannelIDs 于是给每个渠道
                                            重铸一个新 uuid。结果是【每保存一次分组，全组渠道 ID 全换一遍】，
                                            按渠道归集的历史用量当场断掉——而且全程静默，
                                            事后只看得到「按渠道统计的历史用量对不上」，很难倒推回这一行。 */}
                                        <Form.Item name={[field.name, "id"]} hidden noStyle>
                                            <Input type="hidden" />
                                        </Form.Item>
                                        <div className="grid grid-cols-2 gap-2">
                                            <Form.Item name={[field.name, "name"]} label="渠道名称" className="!mb-2" rules={[{ required: true, message: "必填" }]}>
                                                <Input placeholder="渠道名称" />
                                            </Form.Item>
                                            <Form.Item
                                                name={[field.name, "baseUrl"]}
                                                label="BaseURL"
                                                className="!mb-2"
                                                rules={[
                                                    {
                                                        // 火山音频可留空（后端默认 openspeech 域名），其余协议必填。
                                                        validator: async (_rule, value) => {
                                                            const proto = form.getFieldValue(["channelsList", field.name, "protocol"]);
                                                            if (proto === "volc-audio") return;
                                                            if (!String(value || "").trim()) throw new Error("必填");
                                                        },
                                                    },
                                                ]}
                                            >
                                                <Input placeholder="https://ark.cn-beijing.volces.com/api/v3" />
                                            </Form.Item>
                                        </div>
                                        <Form.Item name={[field.name, "protocol"]} label="协议" className="!mb-2" initialValue="openai">
                                            <Select
                                                options={[
                                                    { label: "OpenAI 兼容", value: "openai" },
                                                    { label: "火山音频（豆包语音；BaseURL 填 https://openspeech.bytedance.com、API Key 填语音技术控制台的 X-Api-Key、模型填 seed-audio-1.0 或 doubao-tts）", value: "volc-audio" },
                                                ]}
                                            />
                                        </Form.Item>
                                        {/* Resource-Id 只有火山音频用得上。⚠️ 用 hidden 而不是「不渲染」：
                                            antd 只回收注册过的字段，真把 Form.Item 摘掉，保存时该字段会变成 undefined 被写空。 */}
                                        <Form.Item
                                            noStyle
                                            shouldUpdate={(prev, next) => prev?.channelsList?.[field.name]?.protocol !== next?.channelsList?.[field.name]?.protocol}
                                        >
                                            {() => (
                                                <Form.Item
                                                    hidden={form.getFieldValue(["channelsList", field.name, "protocol"]) !== "volc-audio"}
                                                    name={[field.name, "resourceId"]}
                                                    label="Resource-Id"
                                                    className="!mb-2"
                                                    extra="仅火山音频用：豆包 TTS 的版本，默认 seed-tts-1.0；声音复刻填 seed-icl-2.0。音频生成(seed-audio-1.0)不看这个值，可留空。"
                                                >
                                                    <Input placeholder="seed-tts-1.0" />
                                                </Form.Item>
                                            )}
                                        </Form.Item>
                                        {/* 目前只支持「OpenAI 兼容」一种协议，所以这里不再按协议切换要填的字段：一个渠道只需要一个 API Key。
                                            ⚠️ 新增协议时别把 Form.Item 摘掉改成条件渲染——antd 只回收注册过的字段，摘掉的字段保存时会被写空
                                            （见本文件上方 id 隐藏字段那段注释里的坑）。要隐藏就用 hidden，保留注册与取值。 */}
                                        <Form.Item name={[field.name, "apiKey"]} label="API Key" className="!mb-2">
                                            <Input.Password placeholder="该渠道的密钥" autoComplete="new-password" />
                                        </Form.Item>
                                        <Form.Item
                                            name={[field.name, "models"]}
                                            className="!mb-2"
                                            label={
                                                <div className="flex w-full items-center justify-between gap-2">
                                                    <span>模型列表（逗号或换行分隔）</span>
                                                    <Button
                                                        size="small"
                                                        type="link"
                                                        icon={<CloudDownloadOutlined />}
                                                        loading={fetchingModelsAt === field.name}
                                                        onClick={() => void openModelSelector(field.name)}
                                                        className="!px-0"
                                                    >
                                                        拉取模型
                                                    </Button>
                                                </div>
                                            }
                                        >
                                            <Input.TextArea rows={2} placeholder="doubao-seedream-5-0-260128, gpt-image-2（也可点右上「拉取模型」拉取后勾选）" />
                                        </Form.Item>
                                        <div className="flex items-center justify-between">
                                            <Space size={16}>
                                                <Form.Item name={[field.name, "enabled"]} label={null} valuePropName="checked" initialValue={true} className="!mb-0">
                                                    <Switch checkedChildren="启用" unCheckedChildren="停用" />
                                                </Form.Item>
                                                {/* 渠道级隐藏：仅超管可设。开启后该渠道对二级管理员不可见、不可改（后端返回给 L2 时已剥除）。 */}
                                                {isSuperAdmin ? (
                                                    <Form.Item name={[field.name, "hidden"]} label={null} valuePropName="checked" initialValue={false} className="!mb-0" tooltip="开启后此渠道对二级管理员不可见、不可修改（含密钥）；生成仍正常路由">
                                                        <Switch checkedChildren="对二级管理员隐藏" unCheckedChildren="二级管理员可见" />
                                                    </Form.Item>
                                                ) : null}
                                            </Space>
                                            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeField(field.name)}>
                                                移除渠道
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ name: "", protocol: "openai", baseUrl: "", apiKey: "", models: "", enabled: true, hidden: false })}>
                                    添加渠道
                                </Button>
                            </div>
                        )}
                    </Form.List>
                    <Typography.Text strong className="mt-4 block">
                        火山方舟人像资产凭证
                    </Typography.Text>
                    <Form.Item name="volcAccessKey" label="Access Key" className="!mt-2 !mb-2">
                        <Input.Password placeholder="AK..." autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item name="volcSecretKey" label="Secret Key" className="!mb-2">
                        <Input.Password placeholder="SK..." autoComplete="new-password" />
                    </Form.Item>
                    <div className="grid grid-cols-3 gap-2">
                        <Form.Item name="volcAssetProject" label="项目名" extra="资产入库审核所属项目，留空用 default">
                            <Input placeholder="default" />
                        </Form.Item>
                        <Form.Item name="volcRegion" label="Region" extra="留空用 cn-beijing">
                            <Input placeholder="cn-beijing" />
                        </Form.Item>
                        <Form.Item name="volcGroupName" label="素材组名" extra="留空用默认组名">
                            <Input placeholder="aicanvas-portraits" />
                        </Form.Item>
                    </div>
                    <Typography.Text strong className="mt-4 block">
                        对象存储桶（本组专属，选填）
                    </Typography.Text>
                    <Typography.Paragraph type="secondary" className="!mb-2 !mt-1 text-xs">
                        留空则本组生成的图/视频/素材沿用平台全局默认桶。填写「桶名」即启用本组自有桶（各组各自计费、独立承担存储与流量），此时 AccessKey / SecretKey / 公网访问域名必须一并填写。桶需开启「公共读」，火山方舟/上游模型才能拉取参考图。切换后老数据仍从原桶读取、无需迁移。
                    </Typography.Paragraph>
                    <Form.Item name="tosBucket" label="桶名 Bucket" className="!mb-2" extra="填了即启用本组自有桶；留空=用全局默认桶">
                        <Input placeholder="例如 my-group-assets" />
                    </Form.Item>
                    <div className="grid grid-cols-2 gap-2">
                        <Form.Item name="tosEndpoint" label="Endpoint（S3 端点）" className="!mb-2" extra="留空用 tos-s3-cn-beijing.volces.com；阿里 OSS 形如 oss-cn-hangzhou.aliyuncs.com">
                            <Input placeholder="tos-s3-cn-beijing.volces.com" />
                        </Form.Item>
                        <Form.Item name="tosRegion" label="Region" className="!mb-2" extra="留空用 cn-beijing">
                            <Input placeholder="cn-beijing" />
                        </Form.Item>
                    </div>
                    <Form.Item name="tosAccessKey" label="Access Key" className="!mb-2">
                        <Input.Password placeholder="桶的 AK" autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item name="tosSecretKey" label="Secret Key" className="!mb-2">
                        <Input.Password placeholder="桶的 SK" autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item name="tosPublicBase" label="公网访问域名 Public Base" className="!mb-2" extra="用户读取媒体的公网前缀，如 https://<桶>.tos-cn-beijing.volces.com，或已绑定 CDN 的域名">
                        <Input placeholder="https://<桶>.tos-cn-beijing.volces.com" />
                    </Form.Item>
                    <Form.Item className="!mb-0">
                        <Space size={8}>
                            <Button onClick={() => void testStorage()} loading={testingStorage}>
                                测试连通
                            </Button>
                            <Typography.Text type="secondary" className="text-xs">
                                向桶写入一个极小测试文件并从公网读回，校验密钥/写权限/公共读/公网域名是否正确
                            </Typography.Text>
                        </Space>
                    </Form.Item>
                </Form>
            </Modal>
            <Modal
                title={
                    <Space size={12}>
                        选择渠道模型
                        <Typography.Text type="secondary">已选 {selectorChecked.length} / {selectorCandidates.length}</Typography.Text>
                    </Space>
                }
                open={selectorFieldIndex !== null}
                width={720}
                onCancel={() => setSelectorFieldIndex(null)}
                onOk={confirmModelSelector}
                okText="确定"
                cancelText="取消"
                destroyOnHidden
            >
                <div className="flex flex-col gap-3 pt-2">
                    <div className="flex flex-wrap gap-2">
                        <Input.Search placeholder="搜索模型" allowClear value={selectorKeyword} onChange={(event) => setSelectorKeyword(event.target.value)} style={{ flex: "1 1 220px" }} />
                        <Space.Compact style={{ flex: "1 1 300px" }}>
                            <Input value={selectorNewModel} placeholder="手动输入模型名称" onChange={(event) => setSelectorNewModel(event.target.value)} onPressEnter={addSelectorModel} />
                            <Button onClick={addSelectorModel}>增加</Button>
                        </Space.Compact>
                    </div>
                    <div className="flex items-center justify-between">
                        <Typography.Text type="secondary">上游不提供 /models 时可手动增加；勾选要启用的模型</Typography.Text>
                        <Space size={8}>
                            <Button size="small" onClick={() => setSelectorChecked(Array.from(new Set([...selectorChecked, ...selectorCandidates])))} disabled={!selectorCandidates.length}>
                                全选
                            </Button>
                            <Button size="small" onClick={() => setSelectorChecked([])} disabled={!selectorChecked.length}>
                                清空
                            </Button>
                        </Space>
                    </div>
                    <div className="thin-scrollbar max-h-80 overflow-y-auto border-t border-stone-200 pt-3 dark:border-stone-700">
                        {(() => {
                            const keyword = selectorKeyword.trim().toLowerCase();
                            const visible = keyword ? selectorCandidates.filter((model) => model.toLowerCase().includes(keyword)) : selectorCandidates;
                            if (!visible.length) return <div className="py-10 text-center text-sm text-stone-400">没有匹配的模型</div>;
                            return (
                                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                    {visible.map((model) => (
                                        <Checkbox
                                            key={model}
                                            checked={selectorChecked.includes(model)}
                                            onChange={(event) => setSelectorChecked((prev) => (event.target.checked ? Array.from(new Set([...prev, model])) : prev.filter((item) => item !== model)))}
                                        >
                                            <span className="break-all text-sm">{model}</span>
                                        </Checkbox>
                                    ))}
                                </div>
                            );
                        })()}
                    </div>
                </div>
            </Modal>
        </main>
    );
}
