"use client";

import { useEffect, useState } from "react";
import { Input, Modal } from "antd";

// 节点「加入团队」时给素材命名：组内会显示「你·画布名 这个名字」。
export function CanvasGroupAssetNameDialog({ open, defaultName, busy, onClose, onConfirm }: { open: boolean; defaultName: string; busy?: boolean; onClose: () => void; onConfirm: (name: string) => void }) {
    const [name, setName] = useState(defaultName);

    useEffect(() => {
        if (open) setName(defaultName);
    }, [open, defaultName]);

    const submit = () => {
        const trimmed = name.trim();
        if (trimmed) onConfirm(trimmed);
    };

    return (
        <Modal
            title={<span className="font-heading font-medium tracking-wide">加入团队素材</span>}
            open={open}
            onCancel={onClose}
            onOk={submit}
            okText="加入团队"
            cancelText="取消"
            confirmLoading={busy}
            okButtonProps={{ disabled: !name.trim() }}
            width={420}
            centered
            destroyOnHidden
        >
            <div className="space-y-2 py-1">
                <span className="block text-sm opacity-70">给素材起个名字，组内成员会看到「你·画布名 这个名字」，并能取用到自己的画布。</span>
                <Input value={name} maxLength={60} placeholder="素材名称" onChange={(event) => setName(event.target.value)} onPressEnter={submit} autoFocus />
            </div>
        </Modal>
    );
}
