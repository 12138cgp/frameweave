"use client";

import { useCallback, useEffect, useState } from "react";
import { App, DatePicker, Drawer, Modal, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Zap } from "@/components/icons";

import { fetchMyCreditLogs, fetchMyTaskLogs, type MyCreditLog, type MyCreditLogSummary, type MyTaskLog } from "@/services/api/my-logs";
import { getMyProjects, type MyProject } from "@/services/api/projects";
import { useUserStore } from "@/stores/use-user-store";

const { Text } = Typography;

const PAGE_SIZE = 20;

// 全部条件/短路搬进 if/return 纯助手;JSX 里只出现字面量、助手调用或变量。
// 规避 bun 1.3.13 在 SSG 阶段的 SIGILL(exit 132):不写 JSX 内三元/||短路/泛型 JSX,语句级也不写三元。

const kindOptions = [
    { value: "", label: "全部类型" },
    { value: "image", label: "图片" },
    { value: "video", label: "视频" },
    { value: "audio", label: "音频" },
    { value: "text", label: "文本" },
];

const creditTypeOptions = [
    { value: "", label: "全部类型" },
    { value: "ai_consume", label: "模型消费" },
    { value: "ai_refund", label: "失败返还" },
    { value: "admin_adjust", label: "后台调整" },
];

const kindLabels: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };
const creditTypeLabels: Record<string, string> = { ai_consume: "模型消费", ai_refund: "失败返还", admin_adjust: "后台调整" };

function buildSourceOptions(projects: MyProject[]) {
    const options = [
        { value: "", label: "全部来源" },
        { value: "__personal__", label: "个人积分" },
    ];
    for (const p of projects) {
        options.push({ value: p.id, label: "项目：" + p.name });
    }
    return options;
}

function kindLabel(kind: string) {
    if (kindLabels[kind]) return kindLabels[kind];
    if (kind) return kind;
    return "-";
}

function fmtTime(v: string) {
    if (!v) return "-";
    return dayjs(v).format("YYYY-MM-DD HH:mm:ss");
}

function fmtDuration(ms: number) {
    if (!ms || ms <= 0) return "-";
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "秒";
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return m + "分" + rem + "秒";
}

function prettyRequest(raw: string) {
    if (!raw) return "";
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

function errorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

function renderTime(v: string) {
    return <Text style={{ fontSize: 12 }}>{fmtTime(v)}</Text>;
}

function renderKind(v: string) {
    return <Tag>{kindLabel(v)}</Tag>;
}

function renderModelText(v: string) {
    if (v) return <Text style={{ fontSize: 12 }}>{v}</Text>;
    return <Text type="secondary">-</Text>;
}

function renderTaskStatus(row: MyTaskLog) {
    if (row.refunded) {
        return (
            <Tooltip title="视频生成失败,该笔点数已自动退还">
                <Tag color="red">失败(已退还)</Tag>
            </Tooltip>
        );
    }
    if (row.status === "ok") return <Tag color="green">成功</Tag>;
    if (row.status === "fail") return <Tag color="red">失败</Tag>;
    return <Tag>-</Tag>;
}

function renderDuration(v: number) {
    return <Text style={{ fontSize: 12 }}>{fmtDuration(v)}</Text>;
}

function renderTaskCredits(row: MyTaskLog) {
    if (!row.credits) return <Text type="secondary">-</Text>;
    if (row.refunded) {
        return (
            <Tooltip title="视频生成失败,该笔点数已自动退还">
                <Text delete type="secondary">
                    {row.credits}
                </Text>
            </Tooltip>
        );
    }
    if (row.status === "fail") {
        return (
            <Tooltip title="任务失败;失败任务的点数一般会自动返还,可切到「点数日志」核对返还记录">
                <Text type="secondary">{row.credits}</Text>
            </Tooltip>
        );
    }
    return <Text>{row.credits}</Text>;
}

function renderCreditType(v: string) {
    if (v === "ai_consume") return <Tag>模型消费</Tag>;
    if (v === "ai_refund") return <Tag color="green">失败返还</Tag>;
    if (v === "admin_adjust") return <Tag color="blue">后台调整</Tag>;
    if (creditTypeLabels[v]) return <Tag>{creditTypeLabels[v]}</Tag>;
    return <Tag>{v}</Tag>;
}

function renderCreditSource(row: MyCreditLog) {
    if (row.projectId) {
        let name = row.projectName;
        if (!name) name = row.projectId;
        return <Tag color="purple">项目：{name}</Tag>;
    }
    return <Text type="secondary">个人</Text>;
}

function renderCreditAmount(v: number) {
    if (v > 0) return <Text type="success">+{v}</Text>;
    return <Text>{v}</Text>;
}

function renderCreditBalance(row: MyCreditLog) {
    if (row.projectId) {
        return (
            <Tooltip title="项目积分池余额(非个人余额)">
                <Text>
                    {row.balance}
                    <Text type="secondary"> (池)</Text>
                </Text>
            </Tooltip>
        );
    }
    return <Text>{row.balance}</Text>;
}

function renderRemark(v: string) {
    if (!v) return <Text type="secondary">-</Text>;
    return (
        <Tooltip title={v}>
            <Text style={{ fontSize: 12 }} ellipsis>
                {v}
            </Text>
        </Tooltip>
    );
}

function buildSummaryText(summary: MyCreditLogSummary | null) {
    if (!summary) return "";
    return "总消费 " + summary.consume + " · 失败返还 " + summary.refund + " · 后台调整 " + summary.adjust + " · 净消耗 " + summary.net;
}

function renderTaskAction(row: MyTaskLog, onOpen: (row: MyTaskLog) => void) {
    if (!row.request) return <Text type="secondary">-</Text>;
    return (
        <Typography.Link onClick={() => onOpen(row)} style={{ fontSize: 12 }}>
            查看
        </Typography.Link>
    );
}

export default function MyUsageDrawer({ onClose }: { onClose: () => void }) {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const hydrateUser = useUserStore((state) => state.hydrateUser);

    const [creditItems, setCreditItems] = useState<MyCreditLog[]>([]);
    const [creditTotal, setCreditTotal] = useState(0);
    const [creditSummary, setCreditSummary] = useState<MyCreditLogSummary | null>(null);
    const [creditLoading, setCreditLoading] = useState(false);
    const [creditPage, setCreditPage] = useState(1);
    const [creditType, setCreditType] = useState("");
    const [creditSource, setCreditSource] = useState("");
    // 日期范围:存 UTC 瞬时字符串(本地时区当天零点/末秒经 toISOString 换算,与后台管理页同口径)。
    const [creditStart, setCreditStart] = useState("");
    const [creditEnd, setCreditEnd] = useState("");
    const [myProjects, setMyProjects] = useState<MyProject[]>([]);

    const [taskItems, setTaskItems] = useState<MyTaskLog[]>([]);
    const [taskTotal, setTaskTotal] = useState(0);
    const [taskLoading, setTaskLoading] = useState(false);
    const [taskPage, setTaskPage] = useState(1);
    const [taskKind, setTaskKind] = useState("");
    const [taskStart, setTaskStart] = useState("");
    const [taskEnd, setTaskEnd] = useState("");

    const [requestRow, setRequestRow] = useState<MyTaskLog | null>(null);

    // 打开抽屉时刷新一次余额(user.credits 只在 hydrateUser 时更新,不是实时推送)。
    useEffect(() => {
        void hydrateUser();
    }, [hydrateUser]);

    // 来源筛选下拉:个人 + 我参与的项目。
    useEffect(() => {
        if (!token) return;
        getMyProjects(token)
            .then(setMyProjects)
            .catch(() => {});
    }, [token]);

    const loadCredits = useCallback(async () => {
        if (!token) return;
        setCreditLoading(true);
        try {
            const res = await fetchMyCreditLogs(token, { type: creditType, source: creditSource, start: creditStart, end: creditEnd, page: creditPage, pageSize: PAGE_SIZE });
            setCreditItems(res.items);
            setCreditTotal(res.total);
            setCreditSummary(res.summary);
        } catch (error) {
            message.error(errorMessage(error, "点数日志加载失败"));
        } finally {
            setCreditLoading(false);
        }
    }, [token, creditType, creditSource, creditStart, creditEnd, creditPage, message]);

    useEffect(() => {
        void loadCredits();
    }, [loadCredits]);

    const loadTasks = useCallback(async () => {
        if (!token) return;
        setTaskLoading(true);
        try {
            const res = await fetchMyTaskLogs(token, { type: taskKind, start: taskStart, end: taskEnd, page: taskPage, pageSize: PAGE_SIZE });
            setTaskItems(res.items);
            setTaskTotal(res.total);
        } catch (error) {
            message.error(errorMessage(error, "任务日志加载失败"));
        } finally {
            setTaskLoading(false);
        }
    }, [token, taskKind, taskStart, taskEnd, taskPage, message]);

    useEffect(() => {
        void loadTasks();
    }, [loadTasks]);

    const handleCreditTypeChange = (value: string) => {
        setCreditType(value);
        setCreditPage(1);
    };
    const handleCreditSourceChange = (value: string) => {
        setCreditSource(value);
        setCreditPage(1);
    };
    const handleTaskKindChange = (value: string) => {
        setTaskKind(value);
        setTaskPage(1);
    };
    // 日期范围变更:本地时区当天零点/末秒 → toISOString 换成 UTC 瞬时(与后台管理页同口径,created_at 按 UTC 存)。
    const handleCreditRangeChange = (range: [Dayjs | null, Dayjs | null] | null) => {
        let start = "";
        let end = "";
        const startDay = range?.[0];
        const endDay = range?.[1];
        if (startDay && endDay) {
            start = startDay.startOf("day").toISOString();
            end = endDay.endOf("day").toISOString();
        }
        setCreditStart(start);
        setCreditEnd(end);
        setCreditPage(1);
    };
    const handleTaskRangeChange = (range: [Dayjs | null, Dayjs | null] | null) => {
        let start = "";
        let end = "";
        const startDay = range?.[0];
        const endDay = range?.[1];
        if (startDay && endDay) {
            start = startDay.startOf("day").toISOString();
            end = endDay.endOf("day").toISOString();
        }
        setTaskStart(start);
        setTaskEnd(end);
        setTaskPage(1);
    };
    const openRequest = (row: MyTaskLog) => setRequestRow(row);
    const closeRequest = () => setRequestRow(null);

    const creditColumns: TableColumnsType<MyCreditLog> = [
        { title: "时间", dataIndex: "createdAt", width: 150, render: renderTime },
        { title: "类型", dataIndex: "type", width: 96, render: renderCreditType },
        { title: "模型", dataIndex: "model", ellipsis: true, render: renderModelText },
        { title: "来源", key: "source", width: 130, ellipsis: true, render: (_, row) => renderCreditSource(row) },
        { title: "变动", dataIndex: "amount", width: 76, render: renderCreditAmount },
        { title: "余额", key: "balance", width: 96, render: (_, row) => renderCreditBalance(row) },
        { title: "备注", dataIndex: "remark", width: 140, ellipsis: true, render: renderRemark },
    ];

    const taskColumns: TableColumnsType<MyTaskLog> = [
        { title: "时间", dataIndex: "createdAt", width: 150, render: renderTime },
        { title: "类型", dataIndex: "kind", width: 76, render: renderKind },
        { title: "模型", dataIndex: "model", ellipsis: true, render: renderModelText },
        { title: "状态", key: "status", width: 116, render: (_, row) => renderTaskStatus(row) },
        { title: "用时", dataIndex: "durationMs", width: 88, render: renderDuration },
        { title: "点数", key: "credits", width: 80, render: (_, row) => renderTaskCredits(row) },
        { title: "详情", key: "action", width: 72, render: (_, row) => renderTaskAction(row, openRequest) },
    ];

    let credits = 0;
    if (user) credits = user.credits;
    const summaryText = buildSummaryText(creditSummary);
    let drawerWidth: number | string = 920;
    if (typeof window !== "undefined" && window.innerWidth < 980) drawerWidth = "94vw";
    let requestText = "";
    let requestTaskId = "";
    if (requestRow) {
        requestText = prettyRequest(requestRow.request);
        requestTaskId = requestRow.taskId;
    }
    // RangePicker 受控值(存的是 UTC 瞬时字符串,回显转回 Dayjs)。
    let creditRangeValue: [Dayjs, Dayjs] | null = null;
    if (creditStart && creditEnd) creditRangeValue = [dayjs(creditStart), dayjs(creditEnd)];
    let taskRangeValue: [Dayjs, Dayjs] | null = null;
    if (taskStart && taskEnd) taskRangeValue = [dayjs(taskStart), dayjs(taskEnd)];

    const creditsPane = (
        <div>
            <Space wrap style={{ marginBottom: 12 }}>
                <Select value={creditType} options={creditTypeOptions} style={{ width: 130 }} onChange={handleCreditTypeChange} />
                <Select value={creditSource} options={buildSourceOptions(myProjects)} style={{ width: 170 }} showSearch optionFilterProp="label" onChange={handleCreditSourceChange} />
                <DatePicker.RangePicker value={creditRangeValue} onChange={handleCreditRangeChange} allowClear placeholder={["开始日期", "结束日期"]} />
                {summaryText ? <Text type="secondary" style={{ fontSize: 12 }}>{summaryText}</Text> : null}
            </Space>
            <Table
                rowKey="id"
                size="small"
                columns={creditColumns}
                dataSource={creditItems}
                loading={creditLoading}
                scroll={{ x: 800 }}
                pagination={{ current: creditPage, pageSize: PAGE_SIZE, total: creditTotal, showSizeChanger: false, size: "small", onChange: setCreditPage }}
            />
        </div>
    );

    const tasksPane = (
        <div>
            <Space wrap style={{ marginBottom: 12 }}>
                <Select value={taskKind} options={kindOptions} style={{ width: 130 }} onChange={handleTaskKindChange} />
                <DatePicker.RangePicker value={taskRangeValue} onChange={handleTaskRangeChange} allowClear placeholder={["开始日期", "结束日期"]} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                    失败任务的点数一般会自动返还,以「点数日志」为准
                </Text>
            </Space>
            <Table
                rowKey="id"
                size="small"
                columns={taskColumns}
                dataSource={taskItems}
                loading={taskLoading}
                scroll={{ x: 780 }}
                pagination={{ current: taskPage, pageSize: PAGE_SIZE, total: taskTotal, showSizeChanger: false, size: "small", onChange: setTaskPage }}
            />
        </div>
    );

    const tabItems = [
        { key: "credits", label: "点数日志", children: creditsPane },
        { key: "tasks", label: "任务日志", children: tasksPane },
    ];

    return (
        <Drawer
            open
            title="我的消耗"
            width={drawerWidth}
            onClose={onClose}
            extra={
                <Space size={6}>
                    <Zap className="size-4 text-brand" aria-hidden />
                    <Text strong>{credits.toLocaleString()}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                        个人点数
                    </Text>
                </Space>
            }
        >
            <Tabs defaultActiveKey="credits" items={tabItems} />
            <Modal open={Boolean(requestRow)} title="任务详情" footer={null} width={640} onCancel={closeRequest}>
                {requestTaskId ? (
                    <div style={{ marginBottom: 8 }}>
                        <Text type="secondary">任务号:</Text> <Text copyable={{ text: requestTaskId }}>{requestTaskId}</Text>
                    </div>
                ) : null}
                <pre style={{ maxHeight: 420, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12, margin: 0 }}>{requestText}</pre>
            </Modal>
        </Drawer>
    );
}
