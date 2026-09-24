"use client";

import { AuditOutlined, CheckCircleOutlined, DeleteOutlined, FormatPainterOutlined, LoadingOutlined, MessageOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@/components/icons";
import { json } from "@codemirror/lang-json";
import { App, Button, Card, Checkbox, Col, Drawer, Flex, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Switch, Table, Tabs, Tag, Typography } from "antd";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { EditorView } from "@uiw/react-codemirror";

import { fetchAdminGroups, fetchAdminSettings, fetchChannelModels, saveAdminSettings, testChannelModel, type AdminGroup, type AdminModelChannel, type AdminModelCost, type AdminSettings, type AdminVideoModelCost, type AdminAudioModelCost } from "@/services/api/admin";
import { filterModelsByCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });
const jsonEditorTheme = EditorView.theme({
    "&": { backgroundColor: "var(--ant-color-bg-container)", color: "var(--ant-color-text)" },
    ".cm-content": { caretColor: "var(--ant-color-text)", padding: "12px 0" },
    ".cm-line": { padding: "0 18px" },
    ".cm-gutters": { backgroundColor: "var(--ant-color-fill-quaternary)", borderRight: "1px solid var(--ant-color-border)", color: "var(--ant-color-text-tertiary)" },
    ".cm-activeLine": { backgroundColor: "var(--ant-color-fill-quaternary)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--ant-color-fill-quaternary)", color: "var(--ant-color-text)" },
    ".cm-cursor": { borderLeftColor: "var(--ant-color-text)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--ant-control-item-bg-active)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--ant-color-fill-quaternary)", border: "1px solid var(--ant-color-border)", color: "var(--ant-color-text-tertiary)" },
    "&.cm-focused": { outline: "none" },
});

const emptySettings: AdminSettings = {
    public: {
        modelChannel: {
            availableModels: [],
            modelCosts: [],
            videoModelCosts: [],
            defaultModel: "",
            defaultImageModel: "",
            defaultVideoModel: "",
            defaultTextModel: "",
            systemPrompt: "",
            allowCustomChannel: true,
        },
        auth: { allowRegister: true, smsCode: true },
    },
    private: { channels: [], promptSync: { enabled: false, cron: "*/5 * * * *" }, portraitAsset: { accessKey: "", secretKey: "", projectName: "", region: "cn-beijing", groupName: "aicanvas-portraits" }, sms: { enabled: false, accessKey: "", secretKey: "", region: "cn-north-1", smsAccount: "", sign: "", templateId: "", dailyLimitPerPhone: 20, dailyLimitPerIP: 100, verifyMaxAttempts: 5, verifyLockMinutes: 5, devMode: false } },
};
const emptyChannel: AdminModelChannel = { protocol: "openai", name: "", baseUrl: "", apiKey: "", models: [], weight: 1, enabled: true, remark: "", resourceId: "" };

type SettingsTabKey = "public" | "private";
type EditorMode = "visual" | "json";
type ModelSelectTabKey = "new" | "current";

export default function AdminSettingsPage() {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [form] = Form.useForm<AdminSettings>();
    const [activeTab, setActiveTab] = useState<SettingsTabKey>("public");
    const [editorMode, setEditorMode] = useState<Record<SettingsTabKey, EditorMode>>({ public: "visual", private: "visual" });
    const [jsonText, setJsonText] = useState<Record<SettingsTabKey, string>>({ public: "", private: "" });
    const [channels, setChannels] = useState<AdminModelChannel[]>([]);
    const [channelForm] = Form.useForm<AdminModelChannel>();
    const [editingChannelIndex, setEditingChannelIndex] = useState<number | null>(null);
    const [isChannelDrawerOpen, setIsChannelDrawerOpen] = useState(false);
    const [testChannelIndex, setTestChannelIndex] = useState<number | null>(null);
    const [testKeyword, setTestKeyword] = useState("");
    const [selectedTestModels, setSelectedTestModels] = useState<string[]>([]);
    const [testingModels, setTestingModels] = useState<string[]>([]);
    const [testResults, setTestResults] = useState<Record<string, { status: "success" | "error"; duration?: string; message: string }>>({});
    const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
    const [modelSelectSource, setModelSelectSource] = useState<string[]>([]);
    const [modelSelectExisting, setModelSelectExisting] = useState<string[]>([]);
    const [modelSelectSelected, setModelSelectSelected] = useState<string[]>([]);
    const [modelSelectKeyword, setModelSelectKeyword] = useState("");
    const [modelSelectNewModel, setModelSelectNewModel] = useState("");
    const [modelSelectTab, setModelSelectTab] = useState<ModelSelectTabKey>("new");
    const [isFetchingChannelModels, setIsFetchingChannelModels] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [modelCosts, setModelCosts] = useState<AdminModelCost[]>([]);
    const [videoModelCosts, setVideoModelCosts] = useState<AdminVideoModelCost[]>([]);
    const [knownModels, setKnownModels] = useState<string[]>([]);
    const [groups, setGroups] = useState<AdminGroup[]>([]);
    const publicModels = Form.useWatch(["public", "modelChannel", "availableModels"], form) || [];
    // 扣费配置用：全局渠道 + 所有分组配置过的模型并集（分组自治后，扣费才能列出各组实际在用的模型）
    const billingModels = useMemo(() => uniqueModels([...publicModels, ...collectGroupModels(groups)]), [publicModels, groups]);
    const billingVideoModels = useMemo(() => filterModelsByCapability(billingModels, "video"), [billingModels]);
    const channelModels = useMemo(() => collectChannelModels(channels), [channels]);
    const channelTableData = useMemo(() => channels.map((channel, index) => ({ ...channel, _index: index, _rowKey: `${index}-${channel.name}-${channel.baseUrl}` })), [channels]);
    const activeMode = editorMode[activeTab];
    const activeJsonText = jsonText[activeTab];
    const jsonError = activeMode === "json" ? getJsonError(activeJsonText) : "";
    const modelSelectGroups = useMemo(() => buildModelSelectGroups(modelSelectSource, modelSelectExisting), [modelSelectSource, modelSelectExisting]);
    const activeModelSelectModels = useMemo(() => {
        const keyword = modelSelectKeyword.trim().toLowerCase();
        return modelSelectGroups[modelSelectTab].filter((model) => model.toLowerCase().includes(keyword));
    }, [modelSelectGroups, modelSelectKeyword, modelSelectTab]);
    const activeSelectedCount = activeModelSelectModels.filter((model) => modelSelectSelected.includes(model)).length;

    const loadSettings = async () => {
        if (!token) return;
        setIsLoading(true);
        try {
            const [rawSettings, groupsList] = await Promise.all([fetchAdminSettings(token), fetchAdminGroups(token).catch(() => [] as AdminGroup[])]);
            const data = normalizeSettings(rawSettings);
            setGroups(groupsList);
            form.setFieldsValue(data);
            setChannels(data.private.channels);
            setModelCosts(data.public.modelChannel.modelCosts);
            setVideoModelCosts(data.public.modelChannel.videoModelCosts || []);
            setKnownModels(collectKnownModels(data));
            setJsonText({
                public: JSON.stringify(data.public, null, 2),
                private: JSON.stringify(data.private, null, 2),
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取设置失败");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        void loadSettings();
    }, [token]);

    const changeTab = (nextTab: SettingsTabKey) => {
        setActiveTab(nextTab);
    };

    const saveSettings = async () => {
        if (!token) return;
        const values = await collectSettings(form, editorMode, jsonText, message);
        if (!values) {
            return;
        }
        setIsSaving(true);
        try {
            const saved = normalizeSettings(await saveAdminSettings(token, values));
            const merged = mergeChannelApiKeys(values.private.channels, saved);
            form.setFieldsValue(merged);
            setChannels(merged.private.channels);
            setModelCosts(merged.public.modelChannel.modelCosts);
            setVideoModelCosts(merged.public.modelChannel.videoModelCosts || []);
            rememberKnownModels(merged);
            setJsonText({
                public: JSON.stringify(merged.public, null, 2),
                private: JSON.stringify(merged.private, null, 2),
            });
            message.success("已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setIsSaving(false);
        }
    };

    const toggleMode = (tab: SettingsTabKey, nextMode: EditorMode) => {
        if (nextMode === "json") {
            setJsonText((current) => ({
                ...current,
                [tab]: JSON.stringify(tab === "public" ? normalizePublicSetting(form.getFieldValue(["public"]) as Partial<AdminSettings["public"]>) : normalizePrivateSetting(form.getFieldValue(["private"]) as Partial<AdminSettings["private"]>), null, 2),
            }));
            setEditorMode((current) => ({ ...current, [tab]: nextMode }));
            return;
        }
        const parsed = parseTabJson(tab, jsonText[tab]);
        if (!parsed) {
            message.error("JSON 格式不正确");
            return;
        }
        form.setFieldsValue({ [tab]: parsed } as Partial<AdminSettings>);
        if (tab === "private") setChannels((parsed as AdminSettings["private"]).channels);
        if (tab === "public") {
            setModelCosts((parsed as AdminSettings["public"]).modelChannel.modelCosts);
            setVideoModelCosts((parsed as AdminSettings["public"]).modelChannel.videoModelCosts || []);
        }
        rememberKnownModels({ ...normalizeSettings(form.getFieldsValue(true) as AdminSettings), [tab]: parsed });
        setEditorMode((current) => ({ ...current, [tab]: nextMode }));
    };

    const formatJson = (tab: SettingsTabKey) => {
        const parsed = parseTabJson(tab, jsonText[tab]);
        if (!parsed) {
            message.error("JSON 格式不正确");
            return;
        }
        if (tab === "public") {
            setModelCosts((parsed as AdminSettings["public"]).modelChannel.modelCosts);
            setVideoModelCosts((parsed as AdminSettings["public"]).modelChannel.videoModelCosts || []);
        }
        setJsonText((current) => ({
            ...current,
            [tab]: JSON.stringify(parsed, null, 2),
        }));
    };

    const openChannelDrawer = (index: number | null) => {
        setEditingChannelIndex(index);
        setIsChannelDrawerOpen(true);
        const channel = index === null ? emptyChannel : normalizeChannel(channels[index]);
        channelForm.setFieldsValue(channel);
        rememberModels(channel.models);
    };

    const closeChannelDrawer = () => {
        setIsChannelDrawerOpen(false);
        setEditingChannelIndex(null);
        channelForm.resetFields();
    };

    const saveChannel = async () => {
        const channel = normalizeChannel(await channelForm.validateFields());
        rememberModels(channel.models);
        const nextChannels = [...channels];
        if (editingChannelIndex === null) nextChannels.push(channel);
        else nextChannels[editingChannelIndex] = channel;
        await persistChannels(nextChannels);
        closeChannelDrawer();
    };

    const fetchChannelModelList = async () => {
        if (!token) return;
        const channel = channelForm.getFieldsValue();
        if (!channel?.baseUrl) {
            message.warning("请先填写接口地址");
            return;
        }
        if (editingChannelIndex === null && !channel?.apiKey) {
            message.warning("请先填写 API Key");
            return;
        }
        setIsFetchingChannelModels(true);
        try {
            const channelModels = await fetchChannelModels(token, { index: editingChannelIndex ?? undefined, channel: normalizeChannel(channel) });
            const current = isModelSelectorOpen ? uniqueModels(modelSelectSelected) : uniqueModels(channelForm.getFieldValue("models") || []);
            rememberModels(channelModels);
            if (!channelModels.length) {
                message.warning("上游未返回模型列表，请手动输入模型名称");
                return;
            }
            setModelSelectExisting(current);
            setModelSelectSource(uniqueModels(channelModels));
            setModelSelectSelected(uniqueModels([...current, ...channelModels]));
            setModelSelectKeyword("");
            setModelSelectNewModel("");
            setModelSelectTab("new");
            setIsModelSelectorOpen(true);
            message.success(`已获取 ${channelModels.length} 个模型，请选择后确认`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setIsFetchingChannelModels(false);
        }
    };

    const openChannelModelSelector = (sourceModels?: string[]) => {
        const current = uniqueModels(channelForm.getFieldValue("models") || []);
        const source = uniqueModels(sourceModels !== undefined ? sourceModels : [...knownModels, ...current]);
        setModelSelectExisting(current);
        setModelSelectSource(source);
        setModelSelectSelected(sourceModels ? uniqueModels([...current, ...source]) : current);
        setModelSelectKeyword("");
        setModelSelectNewModel("");
        setModelSelectTab(sourceModels ? "new" : "current");
        setIsModelSelectorOpen(true);
    };

    const closeChannelModelSelector = () => {
        setIsModelSelectorOpen(false);
        setModelSelectKeyword("");
        setModelSelectNewModel("");
    };

    const confirmChannelModelSelector = () => {
        const models = uniqueModels(modelSelectSelected);
        channelForm.setFieldValue("models", models);
        rememberModels(models);
        closeChannelModelSelector();
    };

    const toggleSelectedModel = (model: string, checked: boolean) => {
        setModelSelectSelected((current) => (checked ? uniqueModels([...current, model]) : current.filter((item) => item !== model)));
    };

    const selectActiveModels = () => {
        setModelSelectSelected((current) => uniqueModels([...current, ...activeModelSelectModels]));
    };

    const clearActiveModels = () => {
        const active = new Set(activeModelSelectModels);
        setModelSelectSelected((current) => current.filter((model) => !active.has(model)));
    };

    const addModelInSelector = () => {
        const model = modelSelectNewModel.trim();
        if (!model) return;
        setModelSelectExisting((current) => uniqueModels([...current, model]));
        setModelSelectSelected((current) => uniqueModels([...current, model]));
        setModelSelectNewModel("");
        setModelSelectTab("current");
    };

    function rememberModels(models: string[]) {
        setKnownModels((current) => uniqueModels([...current, ...models]));
    }

    function rememberKnownModels(settings: AdminSettings) {
        rememberModels(collectKnownModels(settings));
    }

    const openTestDialog = (index: number) => {
        const channel = normalizeChannel(channels[index]);
        if (!channel.baseUrl || channel.models.length === 0) {
            message.warning("请先填写接口地址和至少一个模型");
            return;
        }
        setTestChannelIndex(index);
        setTestKeyword("");
        setSelectedTestModels([]);
        setTestingModels([]);
        setTestResults({});
    };

    const closeTestDialog = () => {
        setTestChannelIndex(null);
        setTestKeyword("");
        setSelectedTestModels([]);
        setTestingModels([]);
        setTestResults({});
    };

    const testModelOnline = async (model: string) => {
        if (testChannelIndex === null) return;
        if (!token) return;
        const channel = normalizeChannel(channels[testChannelIndex]);
        setTestingModels((current) => [...current, model]);
        try {
            const startedAt = performance.now();
            const result = await testChannelModel(token, { index: testChannelIndex, channel, model });
            setTestResults((current) => ({ ...current, [model]: { status: "success", duration: `${((performance.now() - startedAt) / 1000).toFixed(2)}s`, message: result } }));
        } catch (error) {
            setTestResults((current) => ({ ...current, [model]: { status: "error", message: error instanceof Error ? error.message : "测试失败" } }));
        } finally {
            setTestingModels((current) => current.filter((item) => item !== model));
        }
    };

    const batchTestModels = async () => {
        for (const model of selectedTestModels) {
            await testModelOnline(model);
        }
    };

    const testChannel = testChannelIndex === null ? null : normalizeChannel(channels[testChannelIndex]);
    const testModels = (testChannel?.models || []).filter((model) => model.toLowerCase().includes(testKeyword.trim().toLowerCase()));

    async function persistChannels(nextChannels: AdminModelChannel[]) {
        if (!token) return;
        const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
        const nextChannelModels = collectChannelModels(nextChannels);
        const nextSettings = normalizeSettings({
            ...values,
            public: { ...values.public, modelChannel: { ...values.public.modelChannel, availableModels: nextChannelModels } },
            private: { ...values.private, channels: nextChannels },
        });
        const saved = normalizeSettings(await saveAdminSettings(token, nextSettings));
        const merged = mergeChannelApiKeys(nextChannels, saved);
        setChannels(merged.private.channels);
        setModelCosts(merged.public.modelChannel.modelCosts);
        setVideoModelCosts(merged.public.modelChannel.videoModelCosts || []);
        rememberKnownModels(merged);
        form.setFieldsValue(merged);
        setJsonText({
            public: JSON.stringify(merged.public, null, 2),
            private: JSON.stringify(merged.private, null, 2),
        });
        message.success("已保存");
    }

    return (
        <main className="anim-fade" style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <Flex justify="space-between" align="center" gap={16} wrap>
                        <Tabs
                            activeKey={activeTab}
                            onChange={(key) => changeTab(key as SettingsTabKey)}
                            items={[
                                { key: "public", label: "公开配置（对外暴露）" },
                                { key: "private", label: "私有配置（不会对外暴露）" },
                            ]}
                        />
                        <Space>
                            <Button icon={<ReloadOutlined />} loading={isLoading} onClick={() => void loadSettings()}>
                                刷新
                            </Button>
                            <Button type="primary" icon={<SaveOutlined />} loading={isSaving} onClick={() => void saveSettings()}>
                                保存设置
                            </Button>
                        </Space>
                    </Flex>
                </Card>

                <Card variant="borderless">
                    <Flex justify="space-between" align="center" gap={16} wrap style={{ marginBottom: 16 }}>
                        <Segmented
                            value={activeMode}
                            onChange={(value) => toggleMode(activeTab, value as EditorMode)}
                            options={[
                                { label: "可视化编辑", value: "visual" },
                                { label: "手动编辑 JSON", value: "json" },
                            ]}
                        />
                        {activeMode === "json" ? (
                            <Space>
                                {jsonError ? (
                                    <Tag color="error">{jsonError}</Tag>
                                ) : (
                                    <Tag color="success" icon={<CheckCircleOutlined />}>
                                        JSON 格式正确
                                    </Tag>
                                )}
                                <Button icon={<FormatPainterOutlined />} onClick={() => formatJson(activeTab)}>
                                    格式化
                                </Button>
                            </Space>
                        ) : (
                            <Typography.Text type="secondary">{activeTab === "public" ? "这些配置会暴露给前端读取" : "这些配置只会在后台保存"}</Typography.Text>
                        )}
                    </Flex>

                    {activeTab === "public" ? (
                        activeMode === "visual" ? (
                            <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                                <Row gutter={16}>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "availableModels"]} label="系统可用模型(请先在私有配置里配置渠道)" extra="保存设置时会自动合并所有已启用私有渠道的模型，前台模型下拉会读取这里的公开列表">
                                            <Select mode="multiple" placeholder="请选择系统可用模型" options={channelModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultModel"]} label="默认模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultImageModel"]} label="默认图片模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultVideoModel"]} label="默认视频模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultTextModel"]} label="默认文本模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "systemPrompt"]} label="系统提示词">
                                            <Input.TextArea rows={4} />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "allowCustomChannel"]} label="是否允许用户自定义渠道" extra="开启后，前端可提供走后端渠道和用户自定义 baseUrl 直连两种模式" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "auth", "allowRegister"]} label="是否允许用户注册" extra="关闭后隐藏注册入口，注册接口也会拒绝新用户创建" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "auth", "smsCode"]} label="开启手机验证码登录注册" extra="关闭后登录页隐藏「手机验证码」入口；需先在私有配置启用短信服务才能真正发送验证码" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Typography.Title level={5}>更新提醒（一次性弹窗）</Typography.Title>
                                        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                                            推送更新前开启并填写提醒，保存后在线用户约 1 分钟内各弹出一次（可关闭、每人每条只弹一次）。部署完成后请关闭。提醒 ID 由系统自动维护：每次「开启」或「修改文案」都会重新对所有用户弹一次；仅改其它设置不会重弹。
                                        </Typography.Paragraph>
                                        <Form.Item name={["public", "announcement", "enabled"]} label="启用更新提醒" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                        <Form.Item name={["public", "announcement", "message"]} label="提醒内容">
                                            <Input.TextArea rows={3} placeholder="例如：系统将在几分钟后更新维护，请及时保存您的画布。" />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                                            模型价格（按次 / 视频按秒）已迁移到左侧「分级定价」页的「默认定价」里统一设置。
                                        </Typography.Paragraph>
                                    </Col>
                                </Row>
                            </Form>
                        ) : (
                            <div style={{ overflow: "hidden", border: "1px solid var(--ant-color-border)", borderRadius: 10 }}>
                                <CodeMirror
                                    value={activeJsonText}
                                    height="520px"
                                    extensions={[json(), jsonEditorTheme]}
                                    basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true }}
                                    theme="none"
                                    onChange={(value) => setJsonText((current) => ({ ...current, public: value }))}
                                    style={{ fontSize: 13 }}
                                />
                            </div>
                        )
                    ) : activeMode === "visual" ? (
                        <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                            <Flex vertical gap={12}>
                                <Card size="small" title="提示词定时同步">
                                    <Row gutter={16} align="middle">
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "promptSync", "enabled"]} label="开启定时同步" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={16}>
                                            <Form.Item name={["private", "promptSync", "cron"]} label="Cron 表达式" extra="默认每 5 分钟同步内置 GitHub 远程提示词源">
                                                <Input placeholder="*/5 * * * *" />
                                            </Form.Item>
                                        </Col>
                                    </Row>
                                </Card>
                                <Card size="small" title="火山方舟人像资产库（Seedance 2.0 真人风格视频）">
                                    <Typography.Text type="secondary">
                                        方舟 AK/SK、项目名、Region 与素材组名已全部迁移到「分组管理」按分组独立配置（用户走所属分组的凭证入库审核）。素材入库需服务端可被火山公网访问（配好 PUBLIC_BASE_URL）。
                                    </Typography.Text>
                                </Card>
                                <Card
                                    size="small"
                                    title={
                                        <Space>
                                            <MessageOutlined />
                                            火山引擎短信服务（登录验证码）
                                        </Space>
                                    }
                                >
                                    <Flex vertical gap={14}>
                                        <Typography.Text type="secondary">
                                            基于 <Typography.Link href="https://www.volcengine.com/docs/6361/66704" target="_blank" rel="noreferrer">火山引擎短信服务</Typography.Link> 发送登录验证码。
                                            短信服务仅在 <Typography.Text code>cn-north-1</Typography.Text> 区域可用，模板变量固定为 <Typography.Text code>{`{"code":"验证码"}`}</Typography.Text>，需与短信模板占位符一致。
                                            未开启时回退开发模式：响应里直接返回验证码，不真正发送短信。
                                        </Typography.Text>
                                        <Row gutter={16}>
                                            <Col xs={24} md={6}>
                                                <Form.Item name={["private", "sms", "enabled"]} label="启用短信服务" valuePropName="checked">
                                                    <Switch />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={6}>
                                                <Form.Item name={["private", "sms", "devMode"]} label="联调模式" valuePropName="checked" extra="开启后真实发送短信并在响应里返回验证码">
                                                    <Switch />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={6}>
                                                <Form.Item name={["private", "sms", "region"]} label="Region">
                                                    <Input placeholder="cn-north-1" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={6}>
                                                <Form.Item name={["private", "sms", "smsAccount"]} label="短信消息组ID">
                                                    <Input placeholder="如：acxxxxxx" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                        <Row gutter={16}>
                                            <Col xs={24} md={8}>
                                                <Form.Item name={["private", "sms", "accessKey"]} label="AccessKey">
                                                    <Input placeholder="火山引擎 AK" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={8}>
                                                <Form.Item name={["private", "sms", "secretKey"]} label="SecretKey" extra="出于安全，读取时会被清空；首次配置或更换密钥时必须填写">
                                                    <Input.Password placeholder="留空则沿用已保存的密钥" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={8}>
                                                <Form.Item name={["private", "sms", "sign"]} label="短信签名">
                                                    <Input placeholder="如：CanvasSurface" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                        <Row gutter={16}>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["private", "sms", "templateId"]} label="短信模板 ID">
                                                    <Input placeholder="如：ST_xxxxxxxx" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                        <Row gutter={16}>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["private", "sms", "dailyLimitPerPhone"]} label="单手机号每日上限" extra="未配置或填 0 时后端默认 20">
                                                    <InputNumber min={1} max={10000} style={{ width: "100%" }} placeholder="20" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["private", "sms", "dailyLimitPerIP"]} label="单 IP 每日上限" extra="未配置或填 0 时后端默认 100">
                                                    <InputNumber min={1} max={100000} style={{ width: "100%" }} placeholder="100" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                        <Row gutter={16}>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["private", "sms", "verifyMaxAttempts"]} label="错误上限（次数）" extra="相同手机号+IP 连续错误次数达上限后锁定，未配置或填 0 时后端默认 5">
                                                    <InputNumber min={1} max={20} style={{ width: "100%" }} placeholder="5" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={12}>
                                                <Form.Item name={["private", "sms", "verifyLockMinutes"]} label="锁定时长（分钟）" extra="超限后锁定验证码发送与验证的时长，未配置或填 0 时后端默认 5">
                                                    <InputNumber min={1} max={1440} style={{ width: "100%" }} placeholder="5" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                    </Flex>
                                </Card>
                            </Flex>
                        </Form>
                    ) : (
                        <div style={{ overflow: "hidden", border: "1px solid var(--ant-color-border)", borderRadius: 6 }}>
                            <CodeMirror
                                value={activeJsonText}
                                height="520px"
                                extensions={[json(), jsonEditorTheme]}
                                basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true }}
                                theme="none"
                                onChange={(value) => setJsonText((current) => ({ ...current, private: value }))}
                                style={{ fontSize: 13 }}
                            />
                        </div>
                    )}
                </Card>
                <Drawer
                    title={editingChannelIndex === null ? "新增渠道" : "编辑渠道"}
                    open={isChannelDrawerOpen}
                    size={560}
                    onClose={closeChannelDrawer}
                    extra={
                        <Space>
                            <Button onClick={closeChannelDrawer}>取消</Button>
                            <Button type="primary" onClick={() => void saveChannel()}>
                                保存
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Form form={channelForm} layout="vertical" requiredMark={false} initialValues={emptyChannel}>
                        <Row gutter={16}>
                            <Col span={12}>
                                <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请输入渠道名称" }]}>
                                    <Input />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item
                                    name="protocol"
                                    label="协议"
                                    extra="这里配置的是全局渠道，作为未单独配置渠道的分组的兜底。建议在「分组管理 → 编辑分组 → 模型渠道（本组专属）」里按分组配置，便于分别计量。"
                                >
                                    <Select
                                        options={[
                                            { label: "OpenAI 兼容", value: "openai" },
                                            { label: "火山音频（豆包语音，openspeech）", value: "volc-audio" },
                                        ]}
                                    />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="weight" label="权重">
                                    <InputNumber min={1} step={1} className="!w-full" />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="enabled" label="启用" valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, message: "请输入接口地址" }]}>
                                    <Input />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="apiKey" label="API Key" rules={editingChannelIndex === null ? [{ required: true, message: "请输入 API Key" }] : []}>
                                    <Input.Password placeholder={editingChannelIndex === null ? "" : "留空则沿用已保存的 API Key"} />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item label="渠道可用模型">
                                    <Space.Compact style={{ width: "100%" }}>
                                        <Form.Item name="models" noStyle>
                                            <Select mode="tags" maxTagCount="responsive" tokenSeparators={[",", "\n"]} options={knownModels.map((model) => ({ label: model, value: model }))} />
                                        </Form.Item>
                                        <Button onClick={() => openChannelModelSelector()}>选择模型</Button>
                                    </Space.Compact>
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="remark" label="备注">
                                    <Input.TextArea rows={3} />
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Drawer>
                <Modal
                    title={
                        <Space size={12}>
                            选择渠道模型
                            <Typography.Text type="secondary">
                                已选择 {modelSelectSelected.length} / {uniqueModels([...modelSelectSource, ...modelSelectExisting]).length}
                            </Typography.Text>
                        </Space>
                    }
                    open={isModelSelectorOpen}
                    width={960}
                    onCancel={closeChannelModelSelector}
                    footer={
                        <Space>
                            <Button onClick={closeChannelModelSelector}>取消</Button>
                            <Button type="primary" onClick={confirmChannelModelSelector}>
                                确定
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Flex vertical gap={14}>
                        <Flex gap={12} wrap>
                            <Input.Search placeholder="搜索模型" allowClear value={modelSelectKeyword} onChange={(event) => setModelSelectKeyword(event.target.value)} style={{ flex: "1 1 260px" }} />
                            <Space.Compact style={{ flex: "1 1 320px" }}>
                                <Input value={modelSelectNewModel} placeholder="输入模型名称" onChange={(event) => setModelSelectNewModel(event.target.value)} onPressEnter={addModelInSelector} />
                                <Button onClick={addModelInSelector}>增加模型</Button>
                                <Button icon={<ReloadOutlined />} loading={isFetchingChannelModels} onClick={() => void fetchChannelModelList()}>
                                    拉取模型列表
                                </Button>
                            </Space.Compact>
                        </Flex>
                        <Typography.Text type="secondary">如果上游不提供 OpenAI /models 模型列表接口，请在这里手动增加模型名称。</Typography.Text>
                        <Tabs
                            activeKey={modelSelectTab}
                            onChange={(key) => setModelSelectTab(key as ModelSelectTabKey)}
                            items={[
                                { key: "new", label: `新获取的模型 (${modelSelectGroups.new.length})` },
                                { key: "current", label: `已有的模型 (${modelSelectGroups.current.length})` },
                            ]}
                        />
                        <Flex justify="space-between" align="center" gap={12} wrap>
                            <Typography.Text type="secondary">
                                当前列表已选择 {activeSelectedCount} / {activeModelSelectModels.length}
                            </Typography.Text>
                            <Space size={8}>
                                <Button size="small" disabled={!activeModelSelectModels.length || activeSelectedCount === activeModelSelectModels.length} onClick={selectActiveModels}>
                                    全选当前列表
                                </Button>
                                <Button size="small" disabled={!activeSelectedCount} onClick={clearActiveModels}>
                                    取消当前列表
                                </Button>
                            </Space>
                        </Flex>
                        <div style={{ maxHeight: 420, overflowY: "auto", borderTop: "1px solid var(--ant-color-border-secondary)", paddingTop: 12 }}>
                            {activeModelSelectModels.length ? (
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 24, rowGap: 12 }}>
                                    {activeModelSelectModels.map((model) => (
                                        <Checkbox key={model} checked={modelSelectSelected.includes(model)} onChange={(event) => toggleSelectedModel(model, event.target.checked)}>
                                            <Typography.Text style={{ wordBreak: "break-all" }}>{model}</Typography.Text>
                                        </Checkbox>
                                    ))}
                                </div>
                            ) : (
                                <div style={{ padding: "48px 0", textAlign: "center" }}>
                                    <Typography.Text type="secondary">没有匹配的模型</Typography.Text>
                                </div>
                            )}
                        </div>
                    </Flex>
                </Modal>
                <Modal
                    title={
                        <Space>
                            {testChannel?.name || "渠道"} 渠道的模型测试<Typography.Text type="secondary">共 {testChannel?.models.length || 0} 个模型</Typography.Text>
                        </Space>
                    }
                    open={testChannelIndex !== null}
                    width={920}
                    onCancel={closeTestDialog}
                    footer={
                        <Space>
                            <Button onClick={closeTestDialog}>取消</Button>
                            <Button type="primary" disabled={!selectedTestModels.length || testingModels.length > 0} onClick={() => void batchTestModels()}>
                                批量测试 {selectedTestModels.length} 个模型
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Flex vertical gap={12}>
                        <Typography.Text type="secondary">普通文本模型会发送一条 hi；Agent Plan / Seedance 视频模型只做配置格式检查，不会发起视频生成，也不代表模型权限已验证。</Typography.Text>
                        <Input.Search placeholder="搜索模型..." allowClear value={testKeyword} onChange={(event) => setTestKeyword(event.target.value)} />
                        <Table
                            rowKey="model"
                            pagination={false}
                            scroll={{ y: 420 }}
                            dataSource={testModels.map((model) => ({ model }))}
                            rowSelection={{
                                selectedRowKeys: selectedTestModels,
                                onChange: (keys) => setSelectedTestModels(keys.map(String)),
                            }}
                            columns={[
                                { title: "模型名称", dataIndex: "model", render: (value) => <Typography.Text strong>{value}</Typography.Text> },
                                {
                                    title: "状态",
                                    dataIndex: "model",
                                    width: 260,
                                    render: (value) => {
                                        if (testingModels.includes(value)) return <Tag icon={<LoadingOutlined className="animate-spin" />}>测试中</Tag>;
                                        const result = testResults[value];
                                        if (!result) return <Tag>未开始</Tag>;
                                        return result.status === "success" ? (
                                            <Space size={6} wrap>
                                                <Tag color="success">成功</Tag>
                                                <Typography.Text type="secondary">请求时长: {result.duration}</Typography.Text>
                                            </Space>
                                        ) : (
                                            <Typography.Text type="danger">{result.message}</Typography.Text>
                                        );
                                    },
                                },
                                {
                                    title: "操作",
                                    key: "actions",
                                    width: 120,
                                    align: "right",
                                    render: (_, item) => (
                                        <Button size="small" loading={testingModels.includes(item.model)} onClick={() => void testModelOnline(item.model)}>
                                            测试
                                        </Button>
                                    ),
                                },
                            ]}
                        />
                    </Flex>
                </Modal>
            </Flex>
        </main>
    );
}

function normalizeSettings(settings: Partial<AdminSettings> = {}): AdminSettings {
    const privateSetting = normalizePrivateSetting(settings.private);
    return {
        public: {
            ...normalizePublicSetting(settings.public),
        },
        private: privateSetting,
    };
}

function normalizePublicSetting(setting: Partial<AdminSettings["public"]> = {}): AdminSettings["public"] {
    return {
        ...emptySettings.public,
        modelChannel: {
            ...emptySettings.public.modelChannel,
            ...(setting.modelChannel || {}),
            availableModels: setting.modelChannel?.availableModels || [],
            modelCosts: normalizeModelCosts(setting.modelChannel?.modelCosts || []),
            videoModelCosts: normalizeVideoModelCosts(setting.modelChannel?.videoModelCosts || []),
            // ⚠️ 显式列出来，理由与上面两条注释完全相同：这个对象是逐字段重建的，
            // 音频按秒价在「分级定价」页配置，一旦这里漏了它，任何人来这页点一次保存就会把它清空、且零报错。
            audioModelCosts: normalizeAudioModelCosts(setting.modelChannel?.audioModelCosts || []),
        },
        auth: {
            allowRegister: setting.auth?.allowRegister !== false,
            smsCode: setting.auth?.smsCode !== false,
        },
        announcement: {
            enabled: setting.announcement?.enabled === true,
            message: setting.announcement?.message || "",
            id: setting.announcement?.id,
        },
    };
}

function normalizeModelCosts(items: Partial<AdminSettings["public"]["modelChannel"]["modelCosts"][number]>[]) {
    return items
        .filter((item) => item.model)
        .map((item) => ({
            model: item.model || "",
            credits: Math.max(0, Number(item.credits) || 0),
            // ⚠️ 与 normalizeVideoModelCosts 那条注释同理：逐字段重建时漏掉 qualityRates，
            // 「分级定价」页配好的图片画质档价，只要有人来这页点一次保存就会被清空、且零报错。
            qualityRates: (item.qualityRates || []).filter((rate) => rate && Number(rate.credits) > 0).map((rate) => ({ quality: rate.quality, credits: Math.max(0, Number(rate.credits) || 0) })),
            label: item.label?.trim() || undefined,
        }))
        .map((item) => ({ ...item, qualityRates: item.qualityRates.length ? item.qualityRates : undefined }));
}

// 音频按秒价：每秒点数 <= 0 且无别名的整条丢掉（=不配按秒价，回退按次），与后端同口径。
function normalizeAudioModelCosts(items: Partial<AdminAudioModelCost>[]) {
    return items
        .filter((item) => item.model)
        .map((item) => ({
            model: item.model || "",
            // ⚠️ 逐字段重建时必须把 creditsPer100Chars 一起带上，否则「分级定价」页配好的
            // 按字数单价，只要有人来这页点一次保存就会被清空、且零报错（本文件已有两条同款注释）。
            creditsPer100Chars: Math.max(0, Number(item.creditsPer100Chars) || 0),
            creditsPerSecond: Math.max(0, Number(item.creditsPerSecond) || 0),
            label: item.label?.trim() || undefined,
        }))
        .filter((item) => item.creditsPer100Chars > 0 || item.creditsPerSecond > 0 || item.label);
}

const VIDEO_BILLING_RESOLUTIONS = ["480p", "720p", "1080p", "2160p"] as const;

function normalizeVideoModelCosts(items: Partial<AdminVideoModelCost>[]) {
    return items
        .filter((item) => item.model)
        .map((item) => ({
            model: item.model || "",
            // ⚠️ 逐字段重建 rate 时必须把每一个字段都带上。creditsPerSecondWithVideo 曾经在这里被漏掉，
            // 导致「分级定价」页配好的带视频输入价，只要有人来「系统设置」页点一次保存就被清零、且零报错。
            rates: (item.rates || [])
                .filter((rate) => rate?.resolution)
                .map((rate) => ({
                    resolution: rate.resolution,
                    creditsPerSecond: Math.max(0, Number(rate.creditsPerSecond) || 0),
                    creditsPerSecondWithVideo: Math.max(0, Number(rate.creditsPerSecondWithVideo) || 0) || undefined,
                })),
            label: item.label?.trim() || undefined,
        }))
        .filter((item) => item.rates.length || item.label);
}

function videoModelRate(items: AdminVideoModelCost[], model: string, resolution: string) {
    return items.find((item) => item.model === model)?.rates.find((rate) => rate.resolution === resolution)?.creditsPerSecond || 0;
}

// 设置某视频模型某分辨率档位的每秒积分；三档全为 0 时移除该模型（回退按次计费）。
function setVideoModelRate(form: any, setVideoModelCosts: (items: AdminVideoModelCost[]) => void, model: string, resolution: string, creditsPerSecond: number) {
    const current = (form.getFieldValue(["public", "modelChannel", "videoModelCosts"]) || []) as AdminVideoModelCost[];
    const existing = current.find((item) => item.model === model);
    const rates = VIDEO_BILLING_RESOLUTIONS.map((item) => ({
        resolution: item,
        creditsPerSecond: item === resolution ? Math.max(0, creditsPerSecond) : existing?.rates.find((rate) => rate.resolution === item)?.creditsPerSecond || 0,
    })).filter((rate) => rate.creditsPerSecond > 0);
    const next = current.filter((item) => item.model !== model);
    if (rates.length || existing?.label) next.push({ model, rates, label: existing?.label });
    form.setFieldValue(["public", "modelChannel", "videoModelCosts"], next);
    setVideoModelCosts(next);
}

function videoModelLabel(items: AdminVideoModelCost[], model: string) {
    return items.find((item) => item.model === model)?.label || "";
}

function setVideoModelLabel(form: any, setVideoModelCosts: (items: AdminVideoModelCost[]) => void, model: string, label: string) {
    const current = (form.getFieldValue(["public", "modelChannel", "videoModelCosts"]) || []) as AdminVideoModelCost[];
    const existing = current.find((item) => item.model === model);
    const trimmed = label.trim();
    const rates = existing?.rates || [];
    const next = current.filter((item) => item.model !== model);
    if (trimmed || rates.length) next.push({ model, rates, label: trimmed || undefined });
    form.setFieldValue(["public", "modelChannel", "videoModelCosts"], next);
    setVideoModelCosts(next);
}

function normalizePrivateSetting(setting: Partial<AdminSettings["private"]> = {}): AdminSettings["private"] {
    return {
        channels: (setting.channels || []).map(normalizeChannel),
        promptSync: {
            // 只有显式 true 才算开。⚠️ 不要写成 !== false ——
            // 那会让「字段缺省/为 null」变成「开」，界面显示开着、后端其实没跑，
            // 而且用户为别的事保存一次设置就把 true 提交上去、静默真开了。
            // 后端出厂默认是关的（见 service/prompt_sync_scheduler.go 的 normalizePromptSyncSetting）。
            enabled: setting.promptSync?.enabled === true,
            cron: setting.promptSync?.cron || "*/5 * * * *",
        },
        portraitAsset: {
            accessKey: setting.portraitAsset?.accessKey || "",
            secretKey: setting.portraitAsset?.secretKey || "",
            projectName: setting.portraitAsset?.projectName || "",
            region: setting.portraitAsset?.region || "cn-beijing",
            groupName: setting.portraitAsset?.groupName || "aicanvas-portraits",
        },
        sms: {
            enabled: setting.sms?.enabled === true,
            accessKey: setting.sms?.accessKey || "",
            secretKey: setting.sms?.secretKey || "",
            region: setting.sms?.region || "cn-north-1",
            smsAccount: setting.sms?.smsAccount || "",
            sign: setting.sms?.sign || "",
            templateId: setting.sms?.templateId || "",
            // 0/未配置/负数 → 默认值，与后端 loadSmsConfig 的兜底逻辑一致
            dailyLimitPerPhone: Number(setting.sms?.dailyLimitPerPhone) > 0 ? Number(setting.sms?.dailyLimitPerPhone) : 20,
            dailyLimitPerIP: Number(setting.sms?.dailyLimitPerIP) > 0 ? Number(setting.sms?.dailyLimitPerIP) : 100,
            verifyMaxAttempts: Number(setting.sms?.verifyMaxAttempts) > 0 ? Number(setting.sms?.verifyMaxAttempts) : 5,
            verifyLockMinutes: Number(setting.sms?.verifyLockMinutes) > 0 ? Number(setting.sms?.verifyLockMinutes) : 5,
            // ⚠️ 只认显式 true。绝不能写成 !== false ——
            // DevMode 的语义是「不真发短信、直接在响应里把验证码返回给调用方」
            //（见 service/volc_sms.go 的 isSmsDevMode）。后端缺省是【关】，
            // 而 !== false 会让缺省/null 在界面上显示成【开】：管理员看到它是开的，
            // 为别的事保存一次设置就把 devMode=true 真写进库。此后只要有人打开
            // 「短信验证码登录」，任何人都能对任意已注册手机号取码登录 = 账号接管。
            devMode: setting.sms?.devMode === true,
        },
    };
}

function normalizeChannel(item: Partial<AdminModelChannel> = {}): AdminModelChannel {
    return {
        protocol: item.protocol || "openai",
        name: item.name || "",
        baseUrl: item.baseUrl || "",
        apiKey: item.apiKey || "",
        models: item.models || [],
        weight: Math.max(1, Number(item.weight) || 1),
        enabled: item.enabled !== false,
        remark: item.remark || "",
        resourceId: item.resourceId || "",
    };
}

function modelCostCredits(items: AdminSettings["public"]["modelChannel"]["modelCosts"], model: string) {
    return items.find((item) => item.model === model)?.credits || 0;
}

function modelCostLabel(items: AdminSettings["public"]["modelChannel"]["modelCosts"], model: string) {
    return items.find((item) => item.model === model)?.label || "";
}

function setModelCost(form: any, setModelCosts: (items: AdminModelCost[]) => void, model: string, credits: number) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCosts"]) || []) as AdminSettings["public"]["modelChannel"]["modelCosts"];
    const existing = current.find((item) => item.model === model);
    const next = current.filter((item) => item.model !== model);
    next.push({ model, credits: Math.max(0, credits), label: existing?.label });
    form.setFieldValue(["public", "modelChannel", "modelCosts"], next);
    setModelCosts(next);
}

// 显示代称：只改 label、保留已设积分；留空清掉 label(前台显示原模型名)。别名纯展示、不参与调用/扣费。
function setModelLabel(form: any, setModelCosts: (items: AdminModelCost[]) => void, model: string, label: string) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCosts"]) || []) as AdminSettings["public"]["modelChannel"]["modelCosts"];
    const existing = current.find((item) => item.model === model);
    const trimmed = label.trim();
    const next = current.filter((item) => item.model !== model);
    next.push({ model, credits: Math.max(0, existing?.credits || 0), label: trimmed || undefined });
    form.setFieldValue(["public", "modelChannel", "modelCosts"], next);
    setModelCosts(next);
}

function mergeChannelApiKeys(currentChannels: AdminModelChannel[], saved: AdminSettings): AdminSettings {
    const channels = saved.private.channels.map((item, index) => ({
        ...item,
        apiKey: currentChannels[index]?.apiKey || item.apiKey,
    }));
    return {
        public: saved.public,
        private: { ...saved.private, channels },
    };
}

function parseGroupChannels(raw: string | undefined): AdminModelChannel[] {
    if (!raw?.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as AdminModelChannel[]) : [];
    } catch {
        return [];
    }
}

// 汇总所有分组里各渠道配置过的模型名（不限启用与否，供扣费配置列出设价）
function collectGroupModels(groups: AdminGroup[]): string[] {
    return uniqueModels(groups.flatMap((group) => parseGroupChannels(group.channels).flatMap((channel) => channel.models || [])));
}

function collectChannelModels(channels: AdminModelChannel[]) {
    return uniqueModels(channels.filter((channel) => channel.enabled).flatMap((channel) => channel.models || []));
}

function collectKnownModels(settings: AdminSettings) {
    return uniqueModels([
        ...(settings.public.modelChannel.availableModels || []),
        ...(settings.public.modelChannel.modelCosts || []).map((item) => item.model),
        ...settings.private.channels.flatMap((channel) => channel.models || []),
    ]);
}

function buildModelSelectGroups(sourceModels: string[], existingModels: string[]): Record<ModelSelectTabKey, string[]> {
    const source = uniqueModels(sourceModels);
    const existing = uniqueModels(existingModels);
    const existingSet = new Set(existing);
    return {
        new: source.filter((model) => !existingSet.has(model)),
        current: existing,
    };
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.filter(Boolean)));
}

function modelSummary(models: string[]) {
    if (!models.length) return "未配置模型";
    const preview = models.slice(0, 3).join(", ");
    return models.length > 3 ? `${models.length} 个模型：${preview}...` : preview;
}

function parseTabJson(tab: "public", value: string): AdminSettings["public"] | null;
function parseTabJson(tab: "private", value: string): AdminSettings["private"] | null;
function parseTabJson(tab: SettingsTabKey, value: string): AdminSettings[SettingsTabKey] | null;
function parseTabJson(tab: SettingsTabKey, value: string): AdminSettings[SettingsTabKey] | null {
    try {
        return tab === "public" ? normalizePublicSetting(JSON.parse(value) as Partial<AdminSettings["public"]>) : normalizePrivateSetting(JSON.parse(value) as Partial<AdminSettings["private"]>);
    } catch {
        return null;
    }
}

async function collectSettings(form: any, editorMode: Record<SettingsTabKey, EditorMode>, jsonText: Record<SettingsTabKey, string>, message: { error: (value: string) => void }) {
    const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
    if (editorMode.public === "json") {
        const publicSetting = parseTabJson("public", jsonText.public);
        if (!publicSetting) {
            message.error("公开配置 JSON 格式不正确");
            return null;
        }
        values.public = publicSetting;
    }
    if (editorMode.private === "json") {
        const privateSetting = parseTabJson("private", jsonText.private);
        if (!privateSetting) {
            message.error("私有配置 JSON 格式不正确");
            return null;
        }
        values.private = privateSetting;
    }
    // ⚠️ 分组自治后 private.channels 通常是空的（模型都配在各分组自己的渠道里）。
    // 这里若无条件重算，等于每保存一次系统设置就把「系统可用模型」清空一批：
    // 存几次就基本清空了，而且全程没有任何提示，事后很难倒推是哪一步弄丢的。
    // 只有当私有渠道里确实收集到模型时才覆盖，否则保留原值。
    const collected = collectChannelModels(values.private.channels);
    if (collected.length) {
        values.public.modelChannel.availableModels = collected;
    }
    return normalizeSettings(values);
}

function getJsonError(value: string) {
    try {
        JSON.parse(value);
        return "";
    } catch (error) {
        return error instanceof Error ? error.message : "JSON 格式不正确";
    }
}
