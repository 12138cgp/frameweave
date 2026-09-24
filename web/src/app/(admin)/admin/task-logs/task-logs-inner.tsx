"use client";

import { ReloadOutlined, SearchOutlined } from "@/components/icons";
import { Button, Card, DatePicker, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";

import type { AdminTaskLog } from "@/services/api/admin";
import { useAdminTaskLogs } from "./use-admin-task-logs";

const { Text } = Typography;

const kindOptions = [
    { value: "", label: "全部类型" },
    { value: "text", label: "文本" },
    { value: "image", label: "图片" },
    { value: "video", label: "视频" },
    { value: "audio", label: "音频" },
];

const kindLabels: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };

// 全部条件/短路搬进 if/return 纯助手或 return 前预算；JSX 里只出现字面量、助手调用或变量。
// 规避 bun 1.3.13 SSG SIGILL：不写 JSX 内三元、不写 JSX 内 || 短路、不写泛型 JSX。
function kindLabel(kind: string) {
    if (kindLabels[kind]) return kindLabels[kind];
    if (kind) return kind;
    return "-";
}

function fmtTime(v: string) {
    if (!v) return "-";
    return dayjs(v).format("YYYY-MM-DD HH:mm:ss");
}

function safeStr(v: string | undefined) {
    if (v) return v;
    return "";
}

function modelText(v: string) {
    if (v) return v;
    return "-";
}

function prettyRequest(raw: string) {
    if (!raw) return "";
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

function renderId(v: string) {
    if (!v) {
        return <Text type="secondary">-</Text>;
    }
    return (
        <Text copyable={{ text: v }} style={{ fontSize: 12 }}>
            {v}
        </Text>
    );
}

function renderUser(row: AdminTaskLog) {
    if (!row.userName) {
        return renderId(row.userId);
    }
    return (
        <Tooltip title={row.userId}>
            <Text style={{ fontSize: 12 }}>{row.userName}</Text>
        </Tooltip>
    );
}

function renderTime(v: string) {
    return <Text style={{ fontSize: 12 }}>{fmtTime(v)}</Text>;
}

function renderKind(v: string) {
    return <Tag>{kindLabel(v)}</Tag>;
}

function renderModel(v: string) {
    return <Text style={{ fontSize: 12 }}>{modelText(v)}</Text>;
}

// 真实结局，而不是 HTTP 码。
//
// upstream_status 只代表【提交被受理】：视频是异步生成的，提交成功之后仍可能因为
// 内容审核不通过等原因失败，此时 result_url 为空、用时为 0，但状态列照样是绿色的 200。
// 运营看到 200 会以为生成成功了，用户来要视频时才发现根本没有成片——这一列必须说实话。
//
// 判据（按优先级）：
//   HTTP 非 2xx        → 提交就失败了
//   已退费             → 生成失败，点数已退还（最确定的失败信号）
//   有 resultUrl       → 成功
//   视频且无结果       → 未拿到成片；5 分钟内算「生成中」，超时则算失败
//   其余（图片/文本）  → 沿用 HTTP 码
// 视频超过这个时长仍无结果，才判定为卡住（依据见 renderOutcome 内注释）。
const VIDEO_STUCK_MINUTES = 15;

function renderOutcome(row: { upstreamStatus: number; resultUrl?: string; kind?: string; refunded?: boolean; createdAt?: string }) {
    const v = row.upstreamStatus;
    if (v >= 400) return <Tag color="red">提交失败 {v}</Tag>;
    if (row.refunded) return <Tag color="red">失败·已退费</Tag>;
    if (row.resultUrl) return <Tag color="green">成功</Tag>;
    if (row.kind === "video") {
        const started = row.createdAt ? Date.parse(row.createdAt) : 0;
        const mins = started ? (Date.now() - started) / 60000 : 999;
        // 阈值必须按真实耗时分布来定，不能拍脑袋：视频生成的耗时中位数在 5 分钟上下，
        // P99 能到 10 分钟以上，长尾还会更久。定成 5 分钟会把约四成【成功】任务标成「未拿到成片」，
        // 运营一看满屏橙色还以为出了大事；取 15 分钟误标率不到 1%，
        // 同时仍能在可接受的时间内把真正卡住的任务暴露出来。
        // ⚠️ 换上游模型或渠道之后，这个阈值要重新按新的耗时分布核一遍。
        if (mins < VIDEO_STUCK_MINUTES) return <Tag color="blue">生成中</Tag>;
        // 超时且没退费：要显眼，这种是「钱可能没退还」的情况，值得运营点进去看
        return <Tag color="orange">未拿到成片</Tag>;
    }
    if (v >= 200 && v < 300) return <Tag color="green">{v}</Tag>;
    if (v > 0) return <Tag color="orange">{v}</Tag>;
    return <Tag>-</Tag>;
}

function fmtDuration(ms: number) {
    if (!ms || ms <= 0) return "-";
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "秒";
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return m + "分" + rem + "秒";
}

function renderDuration(v: number) {
    return <Text style={{ fontSize: 12 }}>{fmtDuration(v)}</Text>;
}

function renderAction(row: AdminTaskLog, onOpen: (row: AdminTaskLog) => void, onVideo: (row: AdminTaskLog) => void) {
    if (row.resultUrl) {
        return (
            <Space size={4}>
                <Button size="small" type="link" onClick={() => onVideo(row)}>
                    看视频
                </Button>
                <Button size="small" onClick={() => onOpen(row)}>
                    请求体
                </Button>
            </Space>
        );
    }
    return (
        <Button size="small" onClick={() => onOpen(row)}>
            请求体
        </Button>
    );
}

// 成片内联播放：只有「上线后新生成」的视频回填了 result_url 才有；destroyOnClose 保证关闭时停止播放。
function renderVideoBody(src: string) {
    if (!src) {
        return <Text type="secondary">没有可播放的视频</Text>;
    }
    return (
        <div>
            <video src={src} controls style={{ width: "100%", maxHeight: 520, borderRadius: 6, background: "#000", display: "block" }} />
            <div style={{ marginTop: 8 }}>
                <a href={src} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                    在新窗口打开 / 下载
                </a>
            </div>
        </div>
    );
}

const emptyDraft = { keyword: "", type: "", model: "", member: "" };

export default function TaskLogsInner() {
    const { logs, total, page, pageSize, isLoading, applyFilters, resetAll, changePage, changePageSize, refreshLogs } = useAdminTaskLogs();
    const [draft, setDraft] = useState(emptyDraft);
    const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
    const [detail, setDetail] = useState<AdminTaskLog | null>(null);
    const [videoRow, setVideoRow] = useState<AdminTaskLog | null>(null);

    const search = () => {
        let start = "";
        let end = "";
        if (range && range[0]) {
            start = range[0].startOf("day").toISOString();
        }
        if (range && range[1]) {
            end = range[1].endOf("day").toISOString();
        }
        applyFilters({ ...draft, start, end });
    };

    const reset = () => {
        setDraft(emptyDraft);
        setRange(null);
        resetAll();
    };

    const openDetail = (row: AdminTaskLog) => {
        setDetail(row);
    };

    const closeDetail = () => {
        setDetail(null);
    };

    const openVideo = (row: AdminTaskLog) => {
        setVideoRow(row);
    };

    const closeVideo = () => {
        setVideoRow(null);
    };

    const showTotal = (t: number) => {
        return `共 ${t} 条`;
    };

    const handlePageChange = (p: number, ps: number) => {
        if (ps !== pageSize) {
            changePageSize(ps);
            return;
        }
        changePage(p);
    };

    const columns: TableColumnsType<AdminTaskLog> = [
        { title: "时间", dataIndex: "createdAt", width: 165, render: (v: string) => renderTime(v) },
        { title: "用户", dataIndex: "userName", width: 150, ellipsis: true, render: (_: unknown, row: AdminTaskLog) => renderUser(row) },
        { title: "类型", dataIndex: "kind", width: 66, render: (v: string) => renderKind(v) },
        { title: "模型", dataIndex: "model", width: 180, ellipsis: true, render: (v: string) => renderModel(v) },
        { title: "任务号 cgt", dataIndex: "taskId", width: 175, ellipsis: true, render: (v: string) => renderId(v) },
        { title: "LogID", dataIndex: "logId", width: 150, ellipsis: true, render: (v: string) => renderId(v) },
        { title: "结局", dataIndex: "upstreamStatus", width: 104, render: (_: number, row: AdminTaskLog) => renderOutcome(row) },
        { title: "用时", dataIndex: "durationMs", width: 88, render: (v: number) => renderDuration(v) },
        { title: "操作", width: 132, fixed: "right", render: (_: unknown, row: AdminTaskLog) => renderAction(row, openDetail, openVideo) },
    ];

    const detailModel = safeStr(detail?.model);
    const detailPath = safeStr(detail?.path);
    const detailKind = kindLabel(safeStr(detail?.kind));
    const detailBody = prettyRequest(safeStr(detail?.request));
    const detailHeader = `${detailModel} · ${detailKind} · ${detailPath}`;
    const modalOpen = Boolean(detail);
    const videoSrc = safeStr(videoRow?.resultUrl);
    const videoOpen = Boolean(videoRow);
    const videoBody = renderVideoBody(videoSrc);

    return (
        <Card>
            <Space wrap style={{ marginBottom: 16 }}>
                <Input allowClear placeholder="搜 用户/cgt/LogID/模型/请求" style={{ width: 240 }} value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} onPressEnter={search} prefix={<SearchOutlined />} />
                <Select style={{ width: 120 }} options={kindOptions} value={draft.type} onChange={(v) => setDraft({ ...draft, type: v })} />
                <Input allowClear placeholder="模型" style={{ width: 160 }} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} onPressEnter={search} />
                <Input allowClear placeholder="成员(用户名/ID)" style={{ width: 170 }} value={draft.member} onChange={(e) => setDraft({ ...draft, member: e.target.value })} onPressEnter={search} />
                <DatePicker.RangePicker value={range} onChange={(v) => setRange(v)} />
                <Button type="primary" icon={<SearchOutlined />} onClick={search}>
                    查询
                </Button>
                <Button onClick={reset}>重置</Button>
                <Button icon={<ReloadOutlined />} onClick={refreshLogs}>
                    刷新
                </Button>
            </Space>
            <Table
                rowKey="id"
                size="small"
                loading={isLoading}
                columns={columns}
                dataSource={logs}
                scroll={{ x: 1050 }}
                pagination={{ current: page, pageSize, total, showSizeChanger: true, showTotal, onChange: handlePageChange }}
            />
            <Modal open={modalOpen} title="请求体" width={720} footer={null} onCancel={closeDetail}>
                <div style={{ marginBottom: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                        {detailHeader}
                    </Text>
                </div>
                <pre style={{ maxHeight: 460, overflow: "auto", background: "rgba(0,0,0,0.03)", padding: 12, borderRadius: 6, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{detailBody}</pre>
            </Modal>
            <Modal open={videoOpen} title="生成的视频" width={560} footer={null} onCancel={closeVideo} destroyOnClose>
                {videoBody}
            </Modal>
        </Card>
    );
}
