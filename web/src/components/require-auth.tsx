"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { App, Button } from "antd";
import { APP_NAME } from "@/constant/env";
import { LoaderCircle } from "@/components/icons";

import { CLOUD_SYNC_FAILED_EVENT, CLOUD_SYNCED_EVENT, flushCloudSync, scheduleCloudSync, syncAppDataToCloud } from "@/services/cloud-sync";
import { uploadPendingMedia } from "@/services/media-recovery";
import { useUserStore } from "@/stores/use-user-store";

// 画布/素材/工作台等云端数据页面的登录守卫：未登录跳转登录页；
// 登录后进入页面先做一次云端同步（拉取合并其他设备的数据），并周期性兜底推送。
export function RequireAuth({ children }: { children: ReactNode }) {
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const router = useRouter();
    const pathname = usePathname();
    const syncedRef = useRef(false);
    const { notification, message } = App.useApp();

    useEffect(() => {
        if (isReady && !user) router.replace(`/login?redirect=${encodeURIComponent(pathname || "/")}`);
    }, [isReady, user, router, pathname]);

    useEffect(() => {
        if (!user) {
            syncedRef.current = false;
            return;
        }
        if (syncedRef.current) return;
        syncedRef.current = true;
        void syncAppDataToCloud()
            .then((result) => {
                // 素材丢失/未上传以前是完全无声的：同步遇到「本地没有、云端也没有」的素材直接跳过，
                // 用户要等换设备时看到一片白框才发现，那时往往已经无法挽回。这里必须当场说出来。
                if (result.failedFiles > 0) {
                    notification.warning({
                        key: "sync-media-risk",
                        message: `有 ${result.failedFiles} 个素材未能上传到云端`,
                        description: "这些素材目前只存在于本机。在上传成功前请不要清理浏览器数据、不要换设备打开，否则会永久丢失。",
                        // 光告警没用，得让用户当场就能补传：直接给一个按钮跑一次补传并反馈结果。
                        btn: (
                            <Button
                                type="primary"
                                size="small"
                                onClick={async () => {
                                    const hide = message.loading("正在上传…", 0);
                                    try {
                                        const outcome = await uploadPendingMedia();
                                        notification.destroy("sync-media-risk");
                                        // 三种结果说三句话。以前一律回「已上传 N 个」，N=0 时还配成功图标——
                                        // 用户刚被告知「有 3 个素材未上传，否则永久丢失」，点完却看到绿色的
                                        // 「已上传 0 个素材」，完全不知道到底传没传、还要不要管。
                                        if (outcome.recovered > 0 && outcome.after.pending === 0) {
                                            message.success(`已上传 ${outcome.recovered} 个素材`);
                                        } else if (outcome.after.pending > 0) {
                                            message.warning(`已上传 ${outcome.recovered} 个，还有 ${outcome.after.pending} 个没成功，请检查网络后重试`);
                                        } else if (outcome.after.lost > 0) {
                                            // 本机字节也没有了：告警之后到点按钮之间被清掉了，补传无能为力，不能假装成功
                                            message.warning(`没有可上传的素材：有 ${outcome.after.lost} 个本机已找不到文件，需要重新生成`);
                                        } else {
                                            message.success("没有需要上传的素材，都已在云端");
                                        }
                                    } catch (error) {
                                        message.error(error instanceof Error ? error.message : "上传失败");
                                    } finally {
                                        hide();
                                    }
                                }}
                            >
                                立即上传
                            </Button>
                        ),
                        duration: 0,
                    });
                }
                // 刻意【不】向用户提示「已丢失」：那些素材本机和云端都没有了，用户看到也无从补救，
                // 只会平白担心一场（何况早期用不可靠的判据还报出过「450 个素材已经丢失」的误报）。
                // 这类信息留给运营侧：超管可用 GET /api/admin/media-audit 按用户查。
                // 用户侧只提示【还能救】的那一类——即上面「未能上传、仅存于本机」。
            })
            .catch((error) => console.warn("进入页面时云端同步失败", error));
    }, [user, notification, message]);

    useEffect(() => {
        if (!user) return;
        const timer = window.setInterval(() => scheduleCloudSync(1000), 90_000);
        // 切走标签页 / 切到别的应用 / 合上笔记本时立刻把待推送的编辑推完。
        // 这是最常见的丢失口：用户做完就切走，防抖那几秒根本没到；而 beforeunload 只能弹确认框、
        // 弹窗期间浏览器不保证请求发得出去。visibilitychange→hidden 是移动端和桌面端都可靠的时机。
        const onHidden = () => {
            if (document.visibilityState === "hidden") void flushCloudSync().catch(() => {});
        };
        document.addEventListener("visibilitychange", onHidden);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onHidden);
        };
    }, [user]);

    // 云端同步连续失败时给用户明显提示（避免静默丢数据）；同步成功即自动消除
    useEffect(() => {
        if (!user) return;
        const onFailed = (event: Event) => {
            // 服务端往往已经给出了具体原因和处置办法（典型：收缩护栏拦截——说明是另一台设备/标签页
            // 有更新的版本，该做的是刷新而不是查网络）。有具体原因就优先显示它，
            // 只有真的什么都没拿到才回退到通用文案。
            const reason = ((event as CustomEvent<{ reason?: string }>).detail?.reason || "").trim();
            const generic = "你的最新修改可能还没保存到云端。请检查网络后刷新页面；在恢复同步前，请勿清除浏览器缓存或更换设备。";
            notification.warning({
                key: "cloud-sync-failed",
                message: "云端同步失败",
                description: reason || generic,
                duration: 0,
            });
        };
        const onSynced = () => notification.destroy("cloud-sync-failed");
        window.addEventListener(CLOUD_SYNC_FAILED_EVENT, onFailed);
        window.addEventListener(CLOUD_SYNCED_EVENT, onSynced);
        return () => {
            window.removeEventListener(CLOUD_SYNC_FAILED_EVENT, onFailed);
            window.removeEventListener(CLOUD_SYNCED_EVENT, onSynced);
        };
    }, [user, notification]);

    if (!isReady) {
        return (
            <div className="anim-fade flex h-full min-h-[50vh] flex-col items-center justify-center gap-4">
                <span className="font-heading text-lg font-medium tracking-wide text-foreground/80 select-none">{APP_NAME}</span>
                <LoaderCircle className="size-5 animate-spin text-muted-foreground/70" strokeWidth={1.5} aria-hidden />
            </div>
        );
    }
    if (!user) return null;
    return <>{children}</>;
}
