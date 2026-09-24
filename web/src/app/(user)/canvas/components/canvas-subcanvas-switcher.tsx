"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { guardedNavigate } from "../utils/leave-guard";
import { App, Dropdown, Input, Modal, type MenuProps } from "antd";
import { ChevronDown, Copy, Layers, Pencil, Plus, Trash2 } from "@/components/icons";

import { useCanvasStore, canvasGroupIdOf, canvasGroupTitleOf } from "../stores/use-canvas-store";

// 编辑器左上角「子画布」下拉：同一画布项目下的子画布切换 / 新建 / 从其它子画布复制节点 / 重命名项目。
// 自读画布 store（不经父组件 prop 透传），挂在顶栏标题下方。
export function CanvasSubCanvasSwitcher({ currentId, onOpenCopyDialog }: { currentId: string; onOpenCopyDialog: () => void }) {
    const router = useRouter();
    const { modal } = App.useApp();
    const projects = useCanvasStore((state) => state.projects);
    const createSubCanvas = useCanvasStore((state) => state.createSubCanvas);
    const renameGroup = useCanvasStore((state) => state.renameGroup);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);

    const current = projects.find((project) => project.id === currentId);
    const groupId = current ? canvasGroupIdOf(current) : "";
    const groupTitle = current ? canvasGroupTitleOf(current) : "";
    const siblings = useMemo(
        () => projects.filter((project) => canvasGroupIdOf(project) === groupId).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")),
        [projects, groupId],
    );

    const [renameOpen, setRenameOpen] = useState(false);
    const [renameValue, setRenameValue] = useState("");
    const [menuOpen, setMenuOpen] = useState(false);
    const switcherRef = useRef<HTMLDivElement>(null);
    // antd 的「点外部关闭」被画布 pointerdown 的 preventDefault 挡住 → 用 capture 阶段 pointerdown 补齐(点画布/别处即关)。
    useEffect(() => {
        if (!menuOpen) return;
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (switcherRef.current?.contains(target as Node)) return;
            if (target instanceof Element && target.closest(".ant-dropdown")) return;
            setMenuOpen(false);
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [menuOpen]);

    if (!current) return null;

    // 切/建子画布也是「离开当前画布」：视频生成中要先确认，否则轮询中断、片子认领不回来
    const createAndOpen = () => guardedNavigate(() => router.push(`/canvas/${createSubCanvas(groupId)}`));
    const openRename = () => {
        setRenameValue(groupTitle);
        setRenameOpen(true);
    };
    const doRename = () => {
        renameGroup(groupId, renameValue);
        setRenameOpen(false);
    };
    // 删除当前子画布(二级确认):复用 deleteProjects(自动写画布墓碑防远端复活 + 放行收缩护栏),
    // 删完跳到同项目里最近更新的兄弟子画布。项目只剩最后一个子画布时不在这里删(删整个项目走列表页项目卡)。
    const confirmDeleteCurrent = () => {
        setMenuOpen(false);
        if (siblings.length < 2) {
            modal.info({
                title: "无法删除",
                content: "这是项目里最后一个子画布。要删除整个项目,请回「我的画布」列表,在项目卡上删除。",
                okText: "知道了",
            });
            return;
        }
        let name = current.title;
        if (!name) name = "未命名子画布";
        const nodeCount = (current.nodes || []).length;
        modal.confirm({
            title: "删除当前子画布？",
            content: "「" + name + "」及其 " + nodeCount + " 个节点将被删除，删除后不可恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => {
                // 先算好去处再删:跳到剩余兄弟里最近更新的那个(与列表页「点开进最近更新子画布」同口径)。
                const rest = siblings.filter((sib) => sib.id !== currentId);
                let next = rest[0];
                for (const sib of rest) {
                    if ((sib.updatedAt || "") > (next.updatedAt || "")) next = sib;
                }
                deleteProjects([currentId]);
                router.replace(`/canvas/${next.id}`);
            },
        });
    };

    const siblingItems: MenuProps["items"] = siblings.map((sib) => {
        const isCurrent = sib.id === currentId;
        const iconClass = isCurrent ? "size-4" : "size-4 opacity-40";
        const labelClass = isCurrent ? "font-medium" : "";
        return {
            key: sib.id,
            icon: <Layers className={iconClass} />,
            label: <span className={labelClass}>{sib.title || "未命名子画布"}</span>,
            onClick: () => {
                if (sib.id !== currentId) guardedNavigate(() => router.push(`/canvas/${sib.id}`));
            },
        };
    });

    const items: MenuProps["items"] = [
        ...siblingItems,
        { type: "divider" },
        { key: "__new", icon: <Plus className="size-4" />, label: "新建子画布", onClick: createAndOpen },
        { key: "__copy", icon: <Copy className="size-4" />, label: "从其它子画布复制…", disabled: siblings.length < 2, onClick: onOpenCopyDialog },
        { key: "__rename", icon: <Pencil className="size-4" />, label: "重命名项目", onClick: openRename },
        { key: "__delete", icon: <Trash2 className="size-4" />, label: "删除当前子画布", danger: true, onClick: confirmDeleteCurrent },
    ];

    const showSubName = siblings.length > 1;

    return (
        <>
            <div ref={switcherRef} className="pointer-events-auto absolute left-4 top-[4.75rem] z-40">
                <Dropdown open={menuOpen} onOpenChange={setMenuOpen} trigger={["click"]} menu={{ items }}>
                    <button
                        type="button"
                        className="flex max-w-[300px] items-center gap-1.5 rounded-full border bg-background/85 py-1 pl-3 pr-2 text-sm shadow-sm backdrop-blur transition hover:bg-background"
                        style={{ borderColor: "var(--border)" }}
                        aria-label="子画布切换"
                    >
                        <Layers className="size-3.5 shrink-0 opacity-60" />
                        <span className="truncate font-medium">{groupTitle}</span>
                        {showSubName ? <span className="shrink-0 whitespace-nowrap text-xs opacity-50">· {current.title || "子画布"}</span> : null}
                        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                    </button>
                </Dropdown>
            </div>
            <Modal open={renameOpen} title="重命名画布项目" onOk={doRename} onCancel={() => setRenameOpen(false)} okText="保存" cancelText="取消" destroyOnHidden>
                <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onPressEnter={doRename} placeholder="项目名称" maxLength={60} autoFocus />
            </Modal>
        </>
    );
}
