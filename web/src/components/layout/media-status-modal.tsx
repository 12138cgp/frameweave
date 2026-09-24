"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Modal } from "antd";
import { CheckCircle2, CloudUpload, LoaderCircle, TriangleAlert } from "@/components/icons";

import { scanMediaStatus, uploadPendingMedia, type MediaStatus } from "@/services/media-recovery";

// 素材上传状态面板 + 手动补传。
//
// 「待上传」= 字节只存在于本机、云端还没有。这类素材一旦用户清了浏览器数据、换了设备，
// 就永久没了——所以要让他当场能一键推上去，而不是只看到一个告警数字。

export function MediaStatusModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [status, setStatus] = useState<MediaStatus | null>(null);
    const [scanning, setScanning] = useState(false);
    const [uploading, setUploading] = useState(false);

    const refresh = useCallback(async () => {
        setScanning(true);
        try {
            setStatus(await scanMediaStatus());
        } catch {
            message.error("检查素材状态失败");
        } finally {
            setScanning(false);
        }
    }, [message]);

    useEffect(() => {
        if (open) void refresh();
    }, [open, refresh]);

    const handleUpload = async () => {
        setUploading(true);
        try {
            const result = await uploadPendingMedia();
            setStatus(result.after);
            if (result.recovered > 0 && result.after.pending === 0) message.success(`已上传 ${result.recovered} 个素材，全部完成`);
            else if (result.recovered > 0) message.warning(`已上传 ${result.recovered} 个，还有 ${result.after.pending} 个未成功，可再试一次`);
            else message.error("本次没有上传成功，请检查网络后重试");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "上传失败");
        } finally {
            setUploading(false);
        }
    };

    const pending = status?.pending ?? 0;

    return (
        <Modal open={open} onCancel={onClose} title="素材上传状态" footer={null} width={520} destroyOnHidden>
            {scanning && !status ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm opacity-70">
                    <LoaderCircle className="size-4 animate-spin" />
                    正在检查…
                </div>
            ) : (
                <div className="flex flex-col gap-4 pt-2">
                    {/* 只展示【已在云端】和【待上传】两项。
                        「已丢失」刻意不显示：那些素材本机和云端都没有了，用户看到也无从补救，
                        只会平白担心一场。需要排查时由超管走 GET /api/admin/media-audit 查。 */}
                    <div className="grid grid-cols-2 gap-3">
                        <StatCard icon={<CheckCircle2 className="size-4 text-[#059669] dark:text-[#34D399]" />} label="已在云端" value={status?.uploaded ?? 0} />
                        <StatCard icon={<CloudUpload className="size-4 text-[#B45309] dark:text-[#FBBF24]" />} label="待上传" value={pending} />
                    </div>

                    {pending > 0 ? (
                        <div className="rounded-lg border border-[#FBBF24]/40 bg-[#B45309]/10 p-3 text-[13px] leading-relaxed">
                            <div className="mb-1 flex items-center gap-1.5 font-medium">
                                <TriangleAlert className="size-4" />
                                有 {pending} 个素材只存在于这台电脑
                            </div>
                            云端还没有它们的副本。在上传成功前，请不要清理浏览器数据、不要换设备打开这个画布，否则会永久丢失。
                        </div>
                    ) : null}

                    {pending === 0 && status && status.total > 0 ? (
                        <div className="rounded-lg border border-[#34D399]/40 bg-[#059669]/10 p-3 text-[13px]">当前画布的素材都已保存到云端，没有需要上传的内容。</div>
                    ) : null}

                    <div className="flex justify-end gap-2">
                        <Button onClick={() => void refresh()} loading={scanning} disabled={uploading}>
                            重新检查
                        </Button>
                        <Button type="primary" icon={<CloudUpload className="size-4" />} onClick={() => void handleUpload()} loading={uploading} disabled={pending === 0}>
                            {pending > 0 ? `立即上传 ${pending} 个` : "无需上传"}
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
    return (
        <div className="rounded-lg border border-border/60 p-3">
            <div className="flex items-center gap-1.5 text-xs opacity-70">
                {icon}
                {label}
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
        </div>
    );
}
