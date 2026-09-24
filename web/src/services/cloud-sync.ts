"use client";

import localforage from "localforage";
import { LOCAL_DB_NAME } from "@/constant/env";

import { apiGet, apiPost, notifySessionExpired } from "@/services/api/request";
import { syncAppData, type AppSyncFile, type AppSyncProgress, type AppSyncResult, type AppSyncTransport } from "@/services/app-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { usePresetStore } from "@/stores/use-preset-store";
import { useShortcutStore } from "@/stores/use-shortcut-store";
import { useUserStore } from "@/stores/use-user-store";
import { logAction } from "@/services/action-log";
import { clearCanvasPersistence, useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { getLocalDataOwner, setLocalDataOwner } from "@/services/cache-isolation";

// 云端同步：登录用户的画布/素材/工作台数据存到自家服务器，多设备 LWW 合并。

type ManifestResponse = { domain: string; data: string; updatedAt: string };

// 同步完成事件：打开中的画布页据此把远端更新回灌编辑器
export const CLOUD_SYNCED_EVENT = "app:cloud-synced";
export const CLOUD_SYNC_FAILED_EVENT = "app:cloud-sync-failed";
// 云端内容已合并进本地 store，但本次推送失败（典型：被收缩护栏拦下）。
//
// 关键点：合并是在推送【之前】完成并落盘的（app-sync 里 applyData 早于 writeManifest），
// 所以此时 store 里已经是正确的合并结果，只是打开着的画布页还拿着旧的编辑器状态。
// 以前只在成功时派发 CLOUD_SYNCED_EVENT，于是画布页永远等不到回灌信号：
// 用户一编辑又把旧状态写回 store → 下次推送继续被拦 → 死循环，只能刷新页面才出得来。
// 而刷新会丢掉整条撤回历史，用户明确反对。这个事件就是为了「不刷新也能恢复」。
export const CLOUD_REMOTE_MERGED_EVENT = "app:cloud-remote-merged";

// 同步链路必须有界：任何一个请求悬挂（合盖休眠/网络切换的半开连接）都不能永久卡死 activeSync，
// 否则同步停摆且「同步失败→复核登录态」的踢出链一并失效，用户完全无感。
const MANIFEST_TIMEOUT_MS = 90_000;
const MEDIA_TIMEOUT_MS = 300_000;
const SYNC_WATCHDOG_MS = 900_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export function cloudTransport(token: string, signal?: AbortSignal): AppSyncTransport {
    // 看门狗超时后必须让僵尸同步在下一步停下，否则它迟到的 applyData/writeManifest 会用旧快照覆盖新数据
    const assertAlive = () => {
        if (signal?.aborted) throw new Error("同步已中止");
    };
    const mediaSignal = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(MEDIA_TIMEOUT_MS)]) : AbortSignal.timeout(MEDIA_TIMEOUT_MS));
    return {
        readManifest: async (domain) => {
            assertAlive();
            const result = await withTimeout(apiGet<ManifestResponse>("/api/v1/sync/manifest", { domain }, token), MANIFEST_TIMEOUT_MS, "拉取清单");
            assertAlive();
            if (!result.data?.trim()) return null;
            // updatedAt 必须带出去：它是推送时做乐观锁的基准版本。以前这里把它丢了，
            // 于是「T0 读 → 分钟级媒体传输 → T1 写」窗口内别处写入的内容会被旧快照整块覆盖。
            return { data: result.data, version: result.updatedAt || "" };
        },
        writeManifest: async (domain, json, confirmShrink, baseVersion) => {
            assertAlive();
            const res = await withTimeout(
                apiPost<{ domain: string; updatedAt?: string; conflict?: boolean }>(
                    "/api/v1/sync/manifest",
                    { domain, data: json, confirmShrink: confirmShrink || false, baseVersion: baseVersion || "" },
                    token,
                ),
                MANIFEST_TIMEOUT_MS,
                "推送清单",
            );
            // 版本冲突走成功响应带 conflict 标志，而不是抛错——它是乐观并发的正常结果，
            // 调用方要据此重新拉取合并再推，不该当成同步失败弹给用户。
            return { conflict: Boolean(res?.conflict) };
        },
        downloadFile: async (file: AppSyncFile) => {
            assertAlive();
            const response = await fetch(`/api/v1/sync/files/${encodeURIComponent(file.storageKey)}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: mediaSignal(),
            });
            if (response.status === 401) {
                notifySessionExpired();
                return null;
            }
            if (!response.ok) return null;
            const blob = await response.blob();
            // 后端 404 走 JSON 响应时 content-type 不是媒体类型，视为缺失
            if (blob.type.includes("application/json")) return null;
            return blob;
        },
        uploadFile: async (file: AppSyncFile, blob: Blob) => {
            assertAlive();
            const form = new FormData();
            form.set("storage_key", file.storageKey);
            form.set("mime_type", file.mimeType);
            form.set("file", blob, "blob");
            const response = await fetch("/api/v1/sync/files", {
                method: "POST",
                body: form,
                headers: { Authorization: `Bearer ${token}` },
                signal: mediaSignal(),
            });
            if (response.status === 401) {
                notifySessionExpired();
                throw new Error("登录已失效");
            }
            const payload = (await response.json()) as { code: number; msg?: string };
            if (payload.code !== 0) throw new Error(payload.msg || "媒体上传失败");
        },
    };
}

let activeSync: Promise<AppSyncResult> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let queuedAgain = false;
let consecutiveSyncFailures = 0;
// 同步序号：日志里靠它把同一次同步的 started / succeeded / failed 串起来
let syncCounter = 0;

export function isCloudSyncAvailable() {
    return Boolean(useUserStore.getState().token);
}

// 画布页用：还有未推送的本地编辑时，避免用远端数据回灌覆盖
export function hasPendingCloudPush() {
    return Boolean(pendingTimer) || Boolean(activeSync);
}

// 本地 IndexedDB 不分账号：同一浏览器切换账号时必须先清空上一个账号留下的本地数据，
// 否则会被首次同步合并进新账号的云端。
// ⚠️ 这里是跨账号串号的根治点。一个很自然的写法是仅 `if (owner)`（owner 非空）时才清 —— 但 owner 为空的情况恰恰会漏：
//   ① 上个账号登录时从未触发过同步（owner 键从没被设过）；② 用户/测试清了 localStorage 但 IndexedDB 仍留着上个账号的画布。
//   这两种情况 owner=空 → 旧代码跳过清理 → 上个账号残留的画布被首次同步合并进新账号云端（多次积累=一个账号吞掉好几个账号的画布）。
//   本地数据归属只有 owner===userId 时才可信；其余一律（含 owner 为空）视为「归属存疑」，绝不合并、无条件先清空本地。
async function ensureLocalDataOwner(userId: string) {
    const owner = getLocalDataOwner();
    if (owner === userId) return; // 本机数据确属当前账号，放行同步
    // owner !== userId（含 owner 为空）→ 清空本地【结构化】数据，防跨账号串号。
    //
    // ⚠️ 刻意【不再】清 image_files / media_files（媒体字节本身）。原因：
    //
    // 归属标记存在 localStorage，而媒体字节存在 IndexedDB——前者脆弱得多（浏览器「清除站点数据」、
    // 隐私清理工具、Safari 的定期清理、换浏览器配置文件都会清掉 localStorage 而 IndexedDB 还在）。
    // 一旦标记丢失就被判为「非本账号」，于是把媒体字节一并清空；而【尚未上传成功】的图，本地这份
    // 是世上唯一一份，清掉即永久销毁——用户可能因此在两台电脑上先后丢光同一批图，且无从恢复。
    //
    // 不清也不会串号：媒体只有被【当前账号的画布数据】引用到才会被上传或显示，而这里已经把画布、
    // 素材、预设等结构化数据清空了，外来 storageKey（随机 nanoid）不可能被引用到。
    // 留下的孤儿字节不占用逻辑正确性，浏览器配额紧张时会自行回收。
    // 清空本地是不可逆的，必须留痕：清了多少、为什么清、清之前有多少。
    // 用户第二天说「我东西全没了」，答案往往就在这一条日志里——
    // 是他自己切了账号（owner 不符），还是 owner 标记莫名丢了（owner 为空）。
    const projectsBefore = useCanvasStore.getState().projects;
    logAction("local_data_wiped", {
        reason: owner ? "owner_mismatch" : "owner_missing",
        ownerBefore: owner || "",
        userId,
        projectsBefore: projectsBefore.length,
        nodesBefore: projectsBefore.reduce((sum, project) => sum + (project.nodes?.length || 0), 0),
        assetsBefore: useAssetStore.getState().assets.length,
    });
    const stores = ["image_generation_logs", "video_generation_logs", "sync_tombstones", "workbench_drafts"];
    await Promise.all(stores.map((storeName) => localforage.createInstance({ name: LOCAL_DB_NAME, storeName }).clear()));
    useCanvasStore.getState().replaceProjects([]);
    // 画布持久化有「空不覆盖非空」护栏，单靠 replaceProjects([]) 落盘清不掉旧账号画布，须显式清盘
    await clearCanvasPersistence();
    useAssetStore.getState().replaceAssets([]);
    // 自定义预设也按账号隔离,切账号清空防串号(图片风格 + 视频风格)
    usePresetStore.getState().replaceImageStyles([]);
    usePresetStore.getState().replaceVideoStyles([]);
    // 自定义快捷键同样按账号走,不清会让上个账号的键位留在下一个账号手里
    useShortcutStore.getState().replaceBindings([]);
    setLocalDataOwner(userId);
}

// 全量同步（四个数据域并发，复用 app-sync 的合并逻辑）；并发调用会复用进行中的同步。
export function syncAppDataToCloud(onProgress?: AppSyncProgress): Promise<AppSyncResult> {
    const { token, user } = useUserStore.getState();
    if (!token || !user) return Promise.reject(new Error("未登录，无法同步"));
    if (activeSync) {
        queuedAgain = true;
        return activeSync;
    }
    const controller = new AbortController();
    const syncSeq = (syncCounter += 1);
    const syncStartedAt = Date.now();
    logAction("sync_started", {
        seq: syncSeq,
        projects: useCanvasStore.getState().projects.length,
        pendingMs: firstPendingAt ? syncStartedAt - firstPendingAt : 0,
    });
    const run = ensureLocalDataOwner(user.id)
        .then(() => syncAppData(cloudTransport(token, controller.signal), onProgress))
        .catch(async (error) => {
            // 同步失败时复核登录态：若是被新设备顶号（token 失效），hydrateUser 会清掉会话并触发跳转登录
            void useUserStore
                .getState()
                .hydrateUser()
                .catch(() => {});
            throw error;
        });
    // 看门狗：兜底保证 activeSync 一定会被释放，并中止僵尸同步，杜绝停摆与并发双同步互踩
    const guarded = new Promise<AppSyncResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            controller.abort();
            reject(new Error("云端同步超时"));
        }, SYNC_WATCHDOG_MS);
        run.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    }).finally(() => {
        if (activeSync === guarded) activeSync = null;
        if (queuedAgain) {
            queuedAgain = false;
            scheduleCloudSync(2000);
        }
    });
    activeSync = guarded;
    // 同步完成事件必须在 activeSync 释放之后派发（finally 先注册先执行），否则画布页回灌守卫恒为真、功能死码
    void guarded
        .then((result) => {
            consecutiveSyncFailures = 0;
            // 成功也要记：诊断「东西怎么没的」时，「上一次成功同步是什么时候、推了多少上去」
            // 和失败信息一样关键——只记失败会看到一片空白，误以为什么都没发生。
            logAction("sync_succeeded", {
                seq: syncSeq,
                ms: Date.now() - syncStartedAt,
                projects: result.projects,
                assets: result.assets,
                files: result.files,
                manifestBytes: result.manifestBytes,
                uploadedFiles: result.uploadedFiles,
                uploadedBytes: result.uploadedBytes,
                failedFiles: result.failedFiles,
                mergedRemote: result.mergedRemote,
            });
            if (!controller.signal.aborted && typeof window !== "undefined") window.dispatchEvent(new Event(CLOUD_SYNCED_EVENT));
        })
        .catch((error) => {
            consecutiveSyncFailures += 1;
            // 连续失败 ≥2 次才提示用户，避免偶发网络抖动打扰；成功一次即清零。
            // ⚠️ 必须把真实原因带出去：服务端对「收缩护栏拦截」这类情况给的是很具体的处置建议
            //（如「画布内容大幅减少…请刷新页面让云端最新内容合并后再编辑」），
            // 以前统一吞掉、只弹写死的「请检查网络」，等于把用户往错误方向引——网络根本没问题。
            const reason = error instanceof Error ? error.message : "";
            logAction("sync_failed", {
                seq: syncSeq,
                ms: Date.now() - syncStartedAt,
                reason,
                consecutive: consecutiveSyncFailures,
                aborted: controller.signal.aborted,
                online: typeof navigator !== "undefined" ? navigator.onLine : true,
            });
            if (typeof window !== "undefined") {
                // 合并已落地、只是推送被拒 → 让画布页把 store 里的合并结果接过去，
                // 这样下一次推送就不再是「缩水」，无需刷新即可自行恢复。
                window.dispatchEvent(new CustomEvent(CLOUD_REMOTE_MERGED_EVENT, { detail: { reason } }));
            }
            // 后端短暂不可达（部署重启、网络抖动）不该弹窗吓人：同步本身会自动重试，
            // 一两分钟内自己就好了，而用户看到的是「接口连接失败，请确认后端服务已启动」
            // 五个数据域各来一遍，像出了大事——一次普通的后端滚动重启就足以触发，
            // 用户以为数据没了，实际上重试后一切正常。
            // 连接类失败改为：连续失败 4 次（约 1 分钟以上仍不通）才提示，且换成人话。
            const connectionIssue = /接口连接失败|Failed to fetch|NetworkError|502|504/.test(reason);
            const threshold = connectionIssue ? 4 : 2;
            if (consecutiveSyncFailures >= threshold && typeof window !== "undefined") {
                const shownReason = connectionIssue
                    ? "暂时连不上服务器，你的修改已保存在本机，恢复连接后会自动同步。若持续如此请检查网络。"
                    : reason;
                window.dispatchEvent(new CustomEvent(CLOUD_SYNC_FAILED_EVENT, { detail: { reason: shownReason } }));
            }
        });
    return guarded;
}

// 防抖触发：编辑画布等本地变更后调用，安静地把数据推上云（失败静默，下次再试）。
// 默认 3s（原 8s）：缩短「编辑完到上云」的可丢窗口。
// 防抖的最大等待上限：从「第一笔未推送的编辑」算起，最多拖这么久就必须推一次。
//
// 纯防抖有个要命的性质——每次编辑都重新计时，用户只要一直在操作画布（拖节点、改参数、连续出图），
// 这 3 秒就永远到不了，实际只能靠 90 秒的兜底定时器兜住。加上限后，连续操作时也能保证 15 秒内推一次。
const SYNC_MAX_WAIT_MS = 15_000;
let firstPendingAt = 0;

export function scheduleCloudSync(delayMs = 3000) {
    if (!isCloudSyncAvailable()) return;
    const now = Date.now();
    if (!firstPendingAt) firstPendingAt = now;
    if (pendingTimer) clearTimeout(pendingTimer);
    // 已经拖够久了就别再让防抖往后推，立刻发车
    const waited = now - firstPendingAt;
    const wait = waited >= SYNC_MAX_WAIT_MS ? 0 : Math.min(delayMs, SYNC_MAX_WAIT_MS - waited);
    pendingTimer = setTimeout(() => {
        pendingTimer = null;
        firstPendingAt = 0;
        // timer 触发时再次校验登录态：scheduleCloudSync 排队时用户可能还登录，
        // 但登出/切账号后 token 已清空，此时同步必然失败（syncAppDataToCloud 会 reject「未登录」），
        // 静默跳过即可，避免控制台噪音与无谓的 reject。
        // 注意顺序：firstPendingAt 必须先清零——否则登出时提前 return 会把累计起点一直留着，
        // 下次登录首次 scheduleCloudSync 会因 waited 已超上限而立刻发车。
        if (!isCloudSyncAvailable()) return;
        void syncAppDataToCloud().catch((error) => {
            console.warn("云端同步失败（稍后会重试）", error);
        });
    }, wait);
}

// 退出登录/切账号/离页前：把待推送的编辑立即推上云并「等到推完」（可 await）。
// 反复推直到没有 pending / active / 排队，确保最新一笔编辑一定上云（防抖窗内的 + in-flight 后又排队的都兜住）。
// 失败静默、绝不卡住退出流程（极端网络下宁可放行也不困住用户；调用方另加超时上限兜底）。
export async function flushCloudSync() {
    if (!isCloudSyncAvailable()) return;
    if (!pendingTimer && !activeSync) return; // 无待推送、无进行中同步 = 已是最新
    for (let attempt = 0; attempt < 4; attempt++) {
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        try {
            await syncAppDataToCloud();
        } catch {
            return;
        }
        if (!pendingTimer && !queuedAgain && !activeSync) return;
    }
}

if (typeof window !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void flushCloudSync();
    });
    window.addEventListener("pagehide", () => {
        void flushCloudSync();
    });
    // 关页/刷新前还有没推上云的编辑 → 弹浏览器原生「离开?未保存」提示，防手滑在保存前关掉。
    // （画布数据包 MB 级、超过 beacon/keepalive 的 64KB 限额，关闭瞬间发不出去，只能靠此拦一下 + 缩短防抖尽快推。）
    window.addEventListener("beforeunload", (event) => {
        if (hasPendingCloudPush()) {
            event.preventDefault();
            event.returnValue = "";
        }
    });

    // 素材库增删改没有页面级推送触发点，订阅 store 变化兜底（同步自身造成的 replaceAssets 在 activeSync 期间，跳过）
    let lastAssets = useAssetStore.getState().assets;
    useAssetStore.subscribe((state) => {
        if (state.assets === lastAssets) return;
        lastAssets = state.assets;
        if (activeSync) return;
        if (!isCloudSyncAvailable()) return;
        scheduleCloudSync(5000);
    });

    // 自定义预设增删改同样无页面级触发点，订阅兜底（图片风格 + 视频风格任一变化都推；同步自身的 replace* 在 activeSync 期间跳过）
    let lastImageStyles = usePresetStore.getState().imageStyles;
    let lastVideoStyles = usePresetStore.getState().videoStyles;
    usePresetStore.subscribe((state) => {
        if (state.imageStyles === lastImageStyles && state.videoStyles === lastVideoStyles) return;
        lastImageStyles = state.imageStyles;
        lastVideoStyles = state.videoStyles;
        if (activeSync) return;
        if (!isCloudSyncAvailable()) return;
        scheduleCloudSync(5000);
    });

    // 自定义快捷键同理：设置界面改完就写 store，没有页面级的推送触发点，靠订阅兜底。
    // 漏了这一段的后果不是报错，而是「本地改了、云端永远没有」——换台设备就变回默认键。
    let lastBindings = useShortcutStore.getState().bindings;
    useShortcutStore.subscribe((state) => {
        if (state.bindings === lastBindings) return;
        lastBindings = state.bindings;
        if (activeSync) return;
        if (!isCloudSyncAvailable()) return;
        scheduleCloudSync(5000);
    });
}
