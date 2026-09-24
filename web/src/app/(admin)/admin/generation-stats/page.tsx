"use client";

import { ReloadOutlined } from "@/components/icons";
import { App, Button, Card, DatePicker, Flex, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useState } from "react";

import { fetchGenerationStats, getManagers, type GenerationStatMember, type GenStatBreakdownRow, type GenerationStatResult } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const { RangePicker } = DatePicker;

// 秒 → 「x分」文案（≥10 分取整、否则一位小数）
function fmtMinutes(seconds: number): string {
    if (!seconds) return "0";
    const m = seconds / 60;
    return m >= 10 ? m.toFixed(0) : m.toFixed(1);
}

const rangePresets: { label: string; value: [Dayjs, Dayjs] }[] = [
    { label: "今天", value: [dayjs(), dayjs()] },
    { label: "昨天", value: [dayjs().subtract(1, "day"), dayjs().subtract(1, "day")] },
    { label: "近 7 天", value: [dayjs().subtract(6, "day"), dayjs()] },
];

const KIND_LABEL: Record<string, string> = { video: "视频", image: "图片", audio: "音频" };

// 展开某用户行时渲染其「类型+模型+分辨率」明细小表。
function renderMemberBreakdown(rows: GenStatBreakdownRow[] | null) {
    if (!rows || !rows.length) return <Typography.Text type="secondary">当期无生成明细</Typography.Text>;
    return (
        <Table<GenStatBreakdownRow>
            rowKey={(r) => `${r.kind}|${r.model}|${r.spec}`}
            size="small"
            pagination={false}
            dataSource={rows}
            columns={[
                { title: "类型", dataIndex: "kind", width: 70, render: (v: string) => KIND_LABEL[v] ?? v },
                { title: "模型", dataIndex: "model", render: (v: string) => v || <Typography.Text type="secondary">-</Typography.Text> },
                { title: "分辨率 / 尺寸", dataIndex: "spec", width: 150, render: (v: string) => v || <Typography.Text type="secondary">-</Typography.Text> },
                { title: "成功次数", dataIndex: "count", align: "right" as const, width: 90 },
                { title: "失败", dataIndex: "fail", align: "right" as const, width: 70, render: (v: number) => (v ? <Typography.Text type="danger">{v}</Typography.Text> : 0) },
                { title: "时长", dataIndex: "seconds", align: "right" as const, width: 120, render: (v: number, r: GenStatBreakdownRow) => (r.kind === "video" ? `${v} 秒 · ${fmtMinutes(v)} 分` : "-") },
            ]}
        />
    );
}

export default function AdminGenerationStatsPage() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const role = useUserStore((state) => state.user?.role);
    const isSuperAdmin = role === "admin";

    const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs(), dayjs()]);
    const [managers, setManagers] = useState<{ id: string; username: string }[]>([]);
    const [ownerId, setOwnerId] = useState<string>("");
    const [data, setData] = useState<GenerationStatResult | null>(null);
    const [loading, setLoading] = useState(false);

    // 超管：拉二级管理员列表，默认选第一个
    useEffect(() => {
        if (token && isSuperAdmin) {
            void getManagers(token)
                .then((list) => {
                    setManagers(list);
                    setOwnerId((prev) => prev || list[0]?.id || "");
                })
                .catch(() => {});
        }
    }, [token, isSuperAdmin]);

    const load = useCallback(async () => {
        if (!token) return;
        if (isSuperAdmin && !ownerId) {
            setData(null);
            return;
        }
        setLoading(true);
        try {
            const res = await fetchGenerationStats(token, {
                start: range[0].format("YYYY-MM-DD"),
                end: range[1].format("YYYY-MM-DD"),
                ownerId: isSuperAdmin ? ownerId : undefined,
            });
            setData(res);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "查询失败");
        } finally {
            setLoading(false);
        }
    }, [token, range, ownerId, isSuperAdmin, message]);

    useEffect(() => {
        void load();
    }, [load]);

    const columns: ColumnsType<GenerationStatMember> = [
        { title: "用户", dataIndex: "userName", fixed: "left", width: 120 },
        { title: "分组", dataIndex: "groupName", width: 110, render: (v: string) => v || <Typography.Text type="secondary">-</Typography.Text> },
        { title: "成功视频", dataIndex: "videoOk", align: "right", width: 90 },
        { title: "成功时长", dataIndex: "videoOkSeconds", align: "right", width: 130, render: (v: number) => `${v} 秒 · ${fmtMinutes(v)} 分` },
        { title: "失败视频", dataIndex: "videoFail", align: "right", width: 90, render: (v: number) => (v ? <Typography.Text type="danger">{v}</Typography.Text> : 0) },
        { title: "失败时长", dataIndex: "videoFailSeconds", align: "right", width: 90, render: (v: number) => (v ? `${v} 秒` : 0) },
        { title: "图片", dataIndex: "imageCount", align: "right", width: 80 },
        { title: "音频", dataIndex: "audioCount", align: "right", width: 80 },
        { title: "消耗点数", dataIndex: "creditsUsed", align: "right", width: 110, render: (v: number) => v.toLocaleString() },
    ];

    const total = data?.total;

    return (
        <main className="anim-fade" style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <div className="mb-3">
                        <Typography.Title level={5} className="!mb-1">
                            生成统计
                        </Typography.Title>
                        <Typography.Text type="secondary">
                            {isSuperAdmin ? "选择二级管理员，查看其下辖用户在所选日期内的生成情况。" : "查看你名下用户在所选日期内的生成情况。"}
                            口径：视频=提交成功且未退款计成功、已退款计失败，时长取请求 duration；图片/音频=成功生成数；点数=净消耗。时间按北京时间。
                        </Typography.Text>
                    </div>
                    <Space wrap>
                        {isSuperAdmin ? (
                            <Select
                                style={{ width: 200 }}
                                placeholder="选择二级管理员"
                                value={ownerId || undefined}
                                onChange={setOwnerId}
                                options={managers.map((m) => ({ label: m.username, value: m.id }))}
                                showSearch
                                optionFilterProp="label"
                            />
                        ) : null}
                        <RangePicker
                            value={range}
                            allowClear={false}
                            presets={rangePresets}
                            onChange={(v) => {
                                if (v && v[0] && v[1]) setRange([v[0], v[1]]);
                            }}
                        />
                        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
                            刷新
                        </Button>
                    </Space>
                </Card>

                <Card variant="borderless">
                    <Table<GenerationStatMember>
                        rowKey="userId"
                        size="middle"
                        loading={loading}
                        dataSource={data?.members ?? []}
                        columns={columns}
                        pagination={false}
                        scroll={{ x: 900 }}
                        expandable={{
                            rowExpandable: (record) => Boolean(record.breakdown && record.breakdown.length),
                            expandedRowRender: (record) => renderMemberBreakdown(record.breakdown),
                        }}
                        summary={() =>
                            total ? (
                                <Table.Summary fixed>
                                    <Table.Summary.Row>
                                        <Table.Summary.Cell index={0} colSpan={2}>
                                            <Typography.Text strong>合计</Typography.Text>
                                        </Table.Summary.Cell>
                                        <Table.Summary.Cell index={2} align="right">
                                            <Typography.Text strong>{total.videoOk}</Typography.Text>
                                        </Table.Summary.Cell>
                                        <Table.Summary.Cell index={3} align="right">
                                            <Typography.Text strong>
                                                {total.videoOkSeconds} 秒 · {fmtMinutes(total.videoOkSeconds)} 分
                                            </Typography.Text>
                                        </Table.Summary.Cell>
                                        <Table.Summary.Cell index={4} align="right">
                                            <Typography.Text strong>{total.videoFail}</Typography.Text>
                                        </Table.Summary.Cell>
                                        <Table.Summary.Cell index={5} align="right">
                                            <Typography.Text strong>{total.videoFailSeconds ? `${total.videoFailSeconds} 秒` : 0}</Typography.Text>
                                        </Table.Summary.Cell>
                                        <Table.Summary.Cell index={6} align="right">
                                            <Typography.Text strong>{total.imageCount}</Typography.Text>
                                        </Table.Summary.Cell>
                                        <Table.Summary.Cell index={7} align="right">
                                            <Typography.Text strong>{total.audioCount}</Typography.Text>
                                        </Table.Summary.Cell>
                                        <Table.Summary.Cell index={8} align="right">
                                            <Typography.Text strong>{total.creditsUsed.toLocaleString()}</Typography.Text>
                                        </Table.Summary.Cell>
                                    </Table.Summary.Row>
                                </Table.Summary>
                            ) : null
                        }
                    />
                    {data && data.idleUsers.length > 0 ? (
                        <div className="mt-3">
                            <Typography.Text type="secondary">当期无任何生成的下辖成员（{data.idleUsers.length}）：</Typography.Text>
                            <Space size={4} wrap className="ml-2">
                                {data.idleUsers.map((name) => (
                                    <Tag key={name} color="default">
                                        {name}
                                    </Tag>
                                ))}
                            </Space>
                        </div>
                    ) : null}
                </Card>
            </Flex>
        </main>
    );
}
