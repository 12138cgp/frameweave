"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button, Modal, Spin } from "antd";
import { FolderKanban, Zap } from "@/components/icons";

import { useUserStore } from "@/stores/use-user-store";
import { useMyProjectsStore } from "../stores/use-my-projects-store";

// 新建画布前弹出：选择该画布的积分来源（个人积分 / 参与的某个项目池）。
// 选定后以 projectId（""=个人积分）回调创建，建后即锁不可改。
export function CanvasCreditSourceDialog({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: (projectId: string) => void }) {
    const token = useUserStore((state) => state.token);
    const personalCredits = useUserStore((state) => state.user?.credits ?? 0);
    const projects = useMyProjectsStore((state) => state.projects);
    const loading = useMyProjectsStore((state) => state.loading);
    const refresh = useMyProjectsStore((state) => state.refresh);
    // 选中项：""=个人积分，其余=项目 id；默认高亮个人积分
    const [selected, setSelected] = useState("");

    useEffect(() => {
        if (!open) return;
        setSelected("");
        void refresh(token);
    }, [open, refresh, token]);

    const optionBase = "flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors";
    const renderOption = (value: string, active: boolean, icon: ReactNode, title: string, sub: string) => (
        <button
            key={value}
            type="button"
            onClick={() => setSelected(value)}
            className={`${optionBase} ${active ? "border-brand bg-brand/10" : "border-border hover:bg-accent"}`}
        >
            <span className={`grid size-9 shrink-0 place-items-center rounded-full ${active ? "bg-brand/20 text-brand" : "bg-muted text-muted-foreground"}`}>{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{title}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{sub}</span>
            </span>
            <span className={`size-4 shrink-0 rounded-full border-2 ${active ? "border-brand bg-brand" : "border-border"}`} aria-hidden />
        </button>
    );

    return (
        <Modal
            title="选择该画布的积分来源"
            open={open}
            centered
            width={460}
            onCancel={onCancel}
            destroyOnHidden
            footer={
                <>
                    <Button onClick={onCancel}>取消</Button>
                    <Button type="primary" onClick={() => onConfirm(selected)}>
                        创建画布
                    </Button>
                </>
            }
        >
            <p className="mb-3 text-xs text-muted-foreground">本画布的生成消耗将从所选来源扣除，创建后不可更改。</p>
            <div className="flex flex-col gap-2.5">
                {renderOption("", selected === "", <Zap className="size-4" />, "个人积分", `当前余额 ${personalCredits.toLocaleString()}`)}
                {loading && projects.length === 0 ? (
                    <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                        <Spin size="small" className="mr-2" />
                        加载项目中…
                    </div>
                ) : (
                    projects.map((item) => renderOption(item.id, selected === item.id, <FolderKanban className="size-4" />, item.name, `剩余 ${item.credits} / 总 ${item.creditsTotal}`))
                )}
            </div>
            {!loading && projects.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">你暂未参与任何项目，将使用个人积分。</p> : null}
        </Modal>
    );
}
