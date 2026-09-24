"use client";

import localforage from "localforage";
import { LOCAL_DB_NAME } from "@/constant/env";

import { getMediaBlob, resolveMediaUrl, setMediaBlob } from "@/services/file-storage";
import { logAction, logActionAggregated } from "@/services/action-log";
import { getImageBlob, resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { consumeCanvasDeletion, markCanvasDeletion, readCanvasRevTombstones, readSyncTombstones, writeCanvasRevTombstones, writeSyncTombstones, NODE_TOMBSTONE_TTL_MS, TOMBSTONE_TTL_MS, type RevTombstoneMap, type TombstoneMap } from "@/services/sync-tombstones";
import { getItemTime, mergeById, mergeCanvasProjects } from "@/services/sync-merge";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { usePresetStore, type CustomImageStyle, type CustomVideoStyle } from "@/stores/use-preset-store";
import { useShortcutStore } from "@/stores/use-shortcut-store";
import type { ShortcutBinding } from "@/constant/shortcuts";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";

type StoredLog = Record<string, unknown> & { id?: string };
export type AppSyncDomainKey = "canvas" | "assets" | "image-workbench" | "video-workbench" | "presets" | "shortcuts";
type DomainKey = AppSyncDomainKey;
type CanvasDomainData = { projects: CanvasProject[] };
type AssetDomainData = { assets: Asset[] };
type LogDomainData = { logs: StoredLog[] };
type PresetDomainData = { imageStyles: CustomImageStyle[]; videoStyles: CustomVideoStyle[] };
type ShortcutDomainData = { shortcuts: ShortcutBinding[] };

export type AppSyncFile = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

// 同步传输层：自家云端服务器复用同一套合并/扫描逻辑，只替换数据进出口。
export type AppSyncTransport = {
    // 返回数据本身 + 该行当前的 updatedAt（版本号）。版本号必须一路带到 writeManifest 做乐观锁，
    // 否则「T0 读 → 分钟级媒体传输 → T1 写」这段窗口里落到云端的任何写入都会被旧快照整块盖掉。
    readManifest: (domain: AppSyncDomainKey) => Promise<{ data: string; version: string } | null>;
    // 返回 conflict=true 表示云端版本已变、本次未写入；调用方应重新拉取合并后重试（不是错误）。
    writeManifest: (domain: AppSyncDomainKey, json: string, confirmShrink?: boolean, baseVersion?: string) => Promise<{ conflict: boolean }>;
    downloadFile: (file: AppSyncFile) => Promise<Blob | null>;
    uploadFile: (file: AppSyncFile, blob: Blob) => Promise<void>;
};

type DomainManifest<T> = {
    app: "aicanvas";
    version: 1;
    domain: DomainKey;
    exportedAt: string;
    data: T;
    tombstones?: TombstoneMap;
    // canvas 域专用：节点/连线级删除墓碑（带 rev），随清单上云让删除跨设备传播、防深合并并集复活。
    nodeTombstones?: RevTombstoneMap;
    connTombstones?: RevTombstoneMap;
    files: AppSyncFile[];
};

type SyncDomainOptions<T> = {
    key: DomainKey;
    label: string;
    localData: () => Promise<T>;
    emptyData: T;
    mergeData: (local: T, remote: T, tombstones: TombstoneMap, nodeTombstones: RevTombstoneMap, connTombstones: RevTombstoneMap) => T;
    // 注意 applyData 的入参是 localData() 那一刻算出的合并结果，而它被调用时可能已过去几分钟
    // （中间隔着媒体上下载）。需要「只增不减」地落回本地时，用这里带的墓碑再和当前 store 合并一次。
    applyData?: (data: T, tombstones: TombstoneMap, nodeTombstones: RevTombstoneMap, connTombstones: RevTombstoneMap) => Promise<void>;
};

type SyncDomainResult<T> = {
    data: T;
    mergedRemote: boolean;
    files: number;
    manifestBytes: number;
    uploadedFiles: number;
    uploadedBytes: number;
    orphanFiles: number;
    failedFiles: number;
};

export type AppSyncResult = {
    syncedAt: string;
    mergedRemote: boolean;
    projects: number;
    assets: number;
    imageLogs: number;
    videoLogs: number;
    files: number;
    manifestBytes: number;
    uploadedFiles: number;
    uploadedBytes: number;
    // orphanFiles ⚠️【疑似】丢失：本地无字节且不在本域清单中。清单系统性不全，此数会明显虚高，
    // 只可用于「触发一次权威复核」，绝不可直接展示给用户（早期直接展示造成过「450 个素材已丢失」的误报）。
    // 权威判定见 media-recovery.scanMediaStatus（查服务端 sync_files 真实登记）。
    // failedFiles 本次上传确实失败 —— 可靠，字节目前只存在于本机。
    orphanFiles: number;
    failedFiles: number;
};

export type AppSyncProgressEvent = {
    domain?: AppSyncDomainKey;
    label?: string;
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

export type AppSyncProgress = (event: AppSyncProgressEvent) => void;

const FILE_CONCURRENCY = 3;
const imageLogStore = localforage.createInstance({ name: LOCAL_DB_NAME, storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: LOCAL_DB_NAME, storeName: "video_generation_logs" });
type LogStore = typeof imageLogStore;
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;

export async function syncAppData(transport: AppSyncTransport, onProgress?: AppSyncProgress): Promise<AppSyncResult> {
    const syncStartedAt = Date.now();
    emitProgress(onProgress, { stage: "等待本地数据加载" });
    await Promise.all([waitForHydration(useCanvasStore), waitForHydration(useAssetStore), waitForHydration(usePresetStore), waitForHydration(useShortcutStore)]);

    // ⚠️ 用 allSettled 而不是 all：五个域必须彼此隔离。
    //
    // 典型触发条件：某个账号里存着一条早期版本遗留的畸形预设（只有 {id,name,updatedAt}，没有 nameZh），
    // presets 域一抛错，Promise.all 立即整体 reject —— 连带把【画布】这个最重要的域也一起废掉，
    // 而且对用户只显示一句笼统的「云端同步失败」。次要数据的一条脏记录，
    // 不该让用户的画布长期同步不上去。
    // 现在各域独立完成，失败的域单独记录；全部跑完后若有失败仍然抛出（用户要能看见），
    // 但健康的域该存的已经存了。
    const settled = await Promise.allSettled([
        syncDomain<CanvasDomainData>(transport, onProgress, {
            key: "canvas",
            label: "画布",
            emptyData: { projects: [] },
            localData: async () => ({ projects: useCanvasStore.getState().projects }),
            // 画布域：节点/连线级深合并（并集），根治「整项目 LWW 丢内容」。删除靠带 rev 的节点/连线墓碑跨设备传播。
            // anti-resurrection 传 () => true 关闭（绝不丢节点）；复活由 365 天墓碑兜住。
            mergeData: (local, remote, tombstones, nodeTombstones, connTombstones) => ({
                projects: mergeCanvasProjects(local.projects, remote.projects, tombstones, nodeTombstones, connTombstones, () => true),
            }),
            // 【不能盲替换】data 是 localData() 那一刻算出的，到这里可能已过去几分钟（中间是媒体上下载）。
            // 用户在这段窗口里新建/编辑的画布不在 data 里，直接 replaceProjects 会把它从内存连同 IndexedDB
            // 一起抹掉，随后 canvas 页因为找不到该项目把人静默弹回列表——
            // 「新建的画布凭空不见、云端也从没有过」这类报障正是从这条路径来的。
            // 与当前 store 再深合并一次（anti-resurrection 关闭=绝不丢节点），保证只增不减；
            // 真删除仍由墓碑负责传播，不会因此复活。
            applyData: async (data, tombstones, nodeTombstones, connTombstones) => {
                const current = useCanvasStore.getState().projects;
                const merged = mergeCanvasProjects(current, data.projects, tombstones, nodeTombstones, connTombstones, () => true);
                useCanvasStore.getState().replaceProjects(merged);
            },
        }),
        syncDomain<AssetDomainData>(transport, onProgress, {
            key: "assets",
            label: "我的素材",
            emptyData: { assets: [] },
            localData: async () => ({ assets: useAssetStore.getState().assets }),
            mergeData: (local, remote, tombstones) => ({ assets: mergeById(local.assets, remote.assets, "updatedAt", tombstones) }),
            applyData: async (data) => useAssetStore.getState().replaceAssets(await Promise.all(data.assets.map(hydrateAsset))),
        }),
        syncDomain<LogDomainData>(transport, onProgress, {
            key: "image-workbench",
            label: "图片生成",
            emptyData: { logs: [] },
            localData: async () => ({ logs: await readStoredLogs(imageLogStore) }),
            mergeData: (local, remote, tombstones) => ({ logs: mergeById(local.logs, remote.logs, "createdAt", tombstones) }),
            applyData: async (data) => replaceStoredLogs(imageLogStore, data.logs, syncStartedAt),
        }),
        syncDomain<LogDomainData>(transport, onProgress, {
            key: "video-workbench",
            label: "视频生成",
            emptyData: { logs: [] },
            localData: async () => ({ logs: await readStoredLogs(videoLogStore) }),
            mergeData: (local, remote, tombstones) => ({ logs: mergeById(local.logs, remote.logs, "createdAt", tombstones) }),
            applyData: async (data) => replaceStoredLogs(videoLogStore, data.logs, syncStartedAt),
        }),
        syncDomain<PresetDomainData>(transport, onProgress, {
            key: "presets",
            label: "我的预设",
            emptyData: { imageStyles: [], videoStyles: [] },
            localData: async () => ({ imageStyles: usePresetStore.getState().imageStyles, videoStyles: usePresetStore.getState().videoStyles }),
            // 旧远端清单可能没有 videoStyles 键（本次上线前）→ mergeById 直接 forEach 会炸，统一兜底 || []。
            mergeData: (local, remote, tombstones) => ({
                imageStyles: mergeById(local.imageStyles || [], remote.imageStyles || [], "updatedAt", tombstones),
                videoStyles: mergeById(local.videoStyles || [], remote.videoStyles || [], "updatedAt", tombstones),
            }),
            applyData: async (data) => {
                usePresetStore.getState().replaceImageStyles(data.imageStyles || []);
                usePresetStore.getState().replaceVideoStyles(data.videoStyles || []);
            },
        }),
        // ⚠️ 新域一律追加在**末尾**：下面的 settled[N] 与 labels[N] 是两个靠下标对齐的并行数组，
        // 插在中间会让失败信息静默挂到别的域名上。
        syncDomain<ShortcutDomainData>(transport, onProgress, {
            key: "shortcuts",
            label: "快捷键",
            emptyData: { shortcuts: [] },
            localData: async () => ({ shortcuts: useShortcutStore.getState().bindings }),
            // 老清单没有 shortcuts 键（本次上线前的用户都是），|| [] 兜底，否则 mergeById 直接 forEach 会炸。
            mergeData: (local, remote, tombstones) => ({ shortcuts: mergeById(local.shortcuts || [], remote.shortcuts || [], "updatedAt", tombstones) }),
            applyData: async (data) => useShortcutStore.getState().replaceBindings(data.shortcuts || []),
        }),
    ]);

    const labels = ["画布", "我的素材", "图片生成", "视频生成", "我的预设", "快捷键"] as const;
    const failures = settled
        .map((r, i) => (r.status === "rejected" ? `${labels[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}` : ""))
        .filter(Boolean);
    // 失败的域用一个空结果占位，让下面的汇总不至于因为少一项而崩掉
    const empty = { mergedRemote: false, files: 0, manifestBytes: 0, uploadedFiles: 0, uploadedBytes: 0, orphanFiles: 0, failedFiles: 0 };
    const canvas = settled[0].status === "fulfilled" ? settled[0].value : { ...empty, data: { projects: [] as CanvasProject[] } };
    const assets = settled[1].status === "fulfilled" ? settled[1].value : { ...empty, data: { assets: [] as Asset[] } };
    const imageLogs = settled[2].status === "fulfilled" ? settled[2].value : { ...empty, data: { logs: [] as StoredLog[] } };
    const videoLogs = settled[3].status === "fulfilled" ? settled[3].value : { ...empty, data: { logs: [] as StoredLog[] } };
    const presets = settled[4].status === "fulfilled" ? settled[4].value : { ...empty, data: { imageStyles: [], videoStyles: [] } };
    const shortcuts = settled[5].status === "fulfilled" ? settled[5].value : { ...empty, data: { shortcuts: [] as ShortcutBinding[] } };

    const result = {
        syncedAt: new Date().toISOString(),
        mergedRemote: [canvas, assets, imageLogs, videoLogs, presets, shortcuts].some((item) => item.mergedRemote),
        projects: canvas.data.projects.length,
        assets: assets.data.assets.length,
        imageLogs: imageLogs.data.logs.length,
        videoLogs: videoLogs.data.logs.length,
        files: canvas.files + assets.files + imageLogs.files + videoLogs.files + presets.files + shortcuts.files,
        manifestBytes: canvas.manifestBytes + assets.manifestBytes + imageLogs.manifestBytes + videoLogs.manifestBytes + presets.manifestBytes + shortcuts.manifestBytes,
        uploadedFiles: canvas.uploadedFiles + assets.uploadedFiles + imageLogs.uploadedFiles + videoLogs.uploadedFiles + presets.uploadedFiles + shortcuts.uploadedFiles,
        uploadedBytes: canvas.uploadedBytes + assets.uploadedBytes + imageLogs.uploadedBytes + videoLogs.uploadedBytes + presets.uploadedBytes + shortcuts.uploadedBytes,
        orphanFiles: canvas.orphanFiles + assets.orphanFiles + imageLogs.orphanFiles + videoLogs.orphanFiles + presets.orphanFiles + shortcuts.orphanFiles,
        failedFiles: canvas.failedFiles + assets.failedFiles + imageLogs.failedFiles + videoLogs.failedFiles + presets.failedFiles + shortcuts.failedFiles,
    };
    if (failures.length) {
        // 健康的域此时已经各自同步完毕，这里只负责把失败如实报出去，不掩盖。
        emitProgress(onProgress, { stage: `部分数据域同步失败：${failures.length} 个`, status: "exception" });
        throw new Error(failures.join("；"));
    }
    emitProgress(onProgress, { stage: "同步完成", status: "success" });
    return result;
}

// CAS 冲突时重试几次。每次都从头【重新拉取云端 + 重新合并】——这正是乐观锁的意义所在：
// 不是盲目重发同一份载荷，而是把对方刚写进去的内容合并进来之后再推。
const SYNC_CAS_MAX_ATTEMPTS = 3;

async function syncDomain<T>(transport: AppSyncTransport, onProgress: AppSyncProgress | undefined, options: SyncDomainOptions<T>): Promise<SyncDomainResult<T>> {
    for (let attempt = 1; attempt <= SYNC_CAS_MAX_ATTEMPTS; attempt++) {
        const result = await syncDomainOnce(transport, onProgress, options);
        if (result) return result;
        // conflict：云端在本次同步期间被别处写过（另一标签页/另一设备/服务端回写），下一轮会带上新内容重来
        console.info(`[sync] ${options.key} 云端版本已变，重新合并后重试（第 ${attempt}/${SYNC_CAS_MAX_ATTEMPTS} 次）`);
    }
    throw new Error(`${options.label}同步冲突：云端被其它设备频繁修改，本次未保存，稍后会自动重试`);
}

// 返回 null 表示遇到 CAS 冲突、本次未写入，需要重来一轮。
async function syncDomainOnce<T>(transport: AppSyncTransport, onProgress: AppSyncProgress | undefined, options: SyncDomainOptions<T>): Promise<SyncDomainResult<T> | null> {
    try {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取远端清单", status: "active" });
        const [remoteManifest, baseVersion] = await readDomainManifest(transport, options.key, options.emptyData);
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取本地数据", status: "active" });
        const localData = await options.localData();
        const localTombstones = await readSyncTombstones(options.key);
        // 本地与远端墓碑取并集（同 id 取较晚的 deletedAt），过期墓碑在此回收
        const tombstones = mergeTombstones(localTombstones, remoteManifest?.tombstones || {});
        // canvas 域：额外取节点/连线级墓碑（带 rev），本地+远端并集，供深合并防「并集复活已删」。
        const isCanvas = options.key === "canvas";
        const localNodeTomb: RevTombstoneMap = isCanvas ? await readCanvasRevTombstones("node") : {};
        const localConnTomb: RevTombstoneMap = isCanvas ? await readCanvasRevTombstones("conn") : {};
        const nodeTombstones = isCanvas ? mergeRevTombstones(localNodeTomb, remoteManifest?.nodeTombstones || {}) : {};
        const connTombstones = isCanvas ? mergeRevTombstones(localConnTomb, remoteManifest?.connTombstones || {}) : {};
        // mergeData 会原地剔除已失效的墓碑（条目在删除之后又被更新/重建）
        const mergedData = options.mergeData(localData, remoteManifest ? remoteManifest.data : options.emptyData, tombstones, nodeTombstones, connTombstones);

        if (remoteManifest) {
            // 先应用合并结果:画布/素材列表立即可见,不必等全部媒体下载完(大库换设备卡在这里、看门狗超时前画布永不出现的根因)。
            // 媒体随后后台补齐;期间打开画布/播放视频靠 resolve*Url 的按需自愈从服务器拉回,不阻塞列表显示。
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "写入本地合并结果", status: "active" });
            await options.applyData?.(mergedData, tombstones, nodeTombstones, connTombstones);
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "下载缺失媒体", status: "active" });
            await downloadMissingFiles(transport, options.key, mergedData, remoteManifest.files, onProgress);
        }

        // 墓碑落地本地存储：失效的从本地删掉，其余幂等写入（不整域清空，防误删同步期间新增的墓碑）
        await writeSyncTombstones(
            options.key,
            tombstones,
            Object.keys(localTombstones).filter((id) => !(id in tombstones)),
        );
        if (isCanvas) {
            await writeCanvasRevTombstones("node", nodeTombstones, Object.keys(localNodeTomb).filter((id) => !(id in nodeTombstones)));
            await writeCanvasRevTombstones("conn", connTombstones, Object.keys(localConnTomb).filter((id) => !(id in connTombstones)));
        }

        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "上传新增媒体", status: "active" });
        const uploaded = await uploadChangedFiles(transport, options.key, mergedData, remoteManifest?.files || [], onProgress);
        // ── 内容与云端完全一致 → 不推 ────────────────────────────────────────
        // 90 秒心跳会无条件触发同步，而绝大多数时候用户什么都没改。原先每次都把整份清单
        // 原样传回去：心跳一天就能攒出几万次 POST、单份可达几十 MB，是服务器上行带宽的两大来源之一
        // （另一个是 GET，交给反向代理 gzip 解决）。
        //
        // 判据刻意保守，宁可多推一次也不能漏推：
        //   · 只比 data 与三份墓碑——exportedAt 每次都变，带上它就永远不相等
        //   · 本次上传过媒体（uploadedFiles>0）就必须写，否则新文件不会进清单
        //   · 云端本来没有该行（remoteManifest 为空）就必须写，那是首次推送
        //   · 放在清单构建与 consumeCanvasDeletion() 之前——命中时连清单都不用序列化
        //     （大画布一次 pretty 序列化 + Blob 拷贝要几十毫秒，挂着页面每 90 秒白做一次）
        //   · 放在 consumeCanvasDeletion() 之前：跳过时不能把「真实删除」这张通行证消耗掉，
        //     否则下一轮真要删时会被收缩护栏拦下
        const sameAsRemote =
            remoteManifest !== null &&
            uploaded.uploadedFiles === 0 &&
            JSON.stringify(mergedData) === JSON.stringify(remoteManifest.data) &&
            JSON.stringify(tombstones) === JSON.stringify(remoteManifest.tombstones || {}) &&
            (!isCanvas ||
                (JSON.stringify(nodeTombstones) === JSON.stringify(remoteManifest.nodeTombstones || {}) &&
                    JSON.stringify(connTombstones) === JSON.stringify(remoteManifest.connTombstones || {})));
        if (sameAsRemote) {
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "内容无变化，跳过上传", status: "success" });
            logActionAggregated("manifest_unchanged", { domain: options.key }, 60_000);
            return {
                data: mergedData,
                mergedRemote: Boolean(remoteManifest),
                files: uploaded.files.length,
                manifestBytes: 0,
                uploadedFiles: 0,
                uploadedBytes: 0,
                orphanFiles: uploaded.orphanFiles,
                failedFiles: uploaded.failedFiles,
            };
        }

        const manifest: DomainManifest<T> = { app: "aicanvas", version: 1, domain: options.key, exportedAt: new Date().toISOString(), data: mergedData, tombstones, ...(isCanvas ? { nodeTombstones, connTombstones } : {}), files: uploaded.files };
        const manifestJson = JSON.stringify(manifest, null, 2);
        const manifestFile = new Blob([manifestJson], { type: "application/json" });
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: `上传清单 ${formatBytes(manifestFile.size)}`, status: "active" });
        // canvas：本次确有真实删除才置 confirmShrink，放行 P0 服务端收缩护栏；推送失败则恢复标记供下次重试。
        const confirmShrink = isCanvas ? consumeCanvasDeletion() : false;
        let writeResult: { conflict: boolean };
        try {
            writeResult = await transport.writeManifest(options.key, manifestJson, confirmShrink, baseVersion);
        } catch (error) {
            if (confirmShrink) markCanvasDeletion();
            // 服务端拒收（典型：收缩护栏判定内容大幅减少）。这一条必须留：
            // 被拒之后本地那份就是唯一一份，而用户对此毫无察觉，正是丢数据的前一秒。
            logAction("manifest_push_rejected", {
                domain: options.key,
                bytes: manifestFile.size,
                confirmShrink,
                reason: error instanceof Error ? error.message : String(error),
                ...describeManifestShape(mergedData),
            });
            throw error;
        }
        if (writeResult.conflict) {
            // 未写入：把删除标记还回去，否则下一轮就没有通行证、真删除会被收缩护栏拦下
            if (confirmShrink) markCanvasDeletion();
            logAction("manifest_cas_conflict", { domain: options.key, bytes: manifestFile.size, baseVersion, confirmShrink });
            return null;
        }
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "完成", current: 1, total: 1, status: "success" });
        logAction("manifest_pushed", {
            domain: options.key,
            bytes: manifestFile.size,
            confirmShrink,
            uploadedFiles: uploaded.uploadedFiles,
            failedFiles: uploaded.failedFiles,
            ...describeManifestShape(mergedData),
        });

        return {
            data: mergedData,
            mergedRemote: Boolean(remoteManifest),
            files: uploaded.files.length,
            manifestBytes: manifestFile.size,
            uploadedFiles: uploaded.uploadedFiles,
            uploadedBytes: uploaded.uploadedBytes,
            // 数据丢失指标：orphan=本地云端都没有(已丢)，failed=只存在于本机(随时可能丢)。
            orphanFiles: uploaded.orphanFiles,
            failedFiles: uploaded.failedFiles,
        };
    } catch (error) {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: error instanceof Error ? error.message : "同步失败", status: "exception" });
        // 把【是哪个域】带进错误消息再往上抛。
        // 顶层只有一句笼统的「云端同步失败 + error.message」，五个域共用一条通道，
        // 出了 "Cannot read properties of undefined" 这种消息时根本无从判断是画布、素材还是工作台，
        // 只能靠翻代码猜。带上域名后一眼就能定位，用户看到的提示也更具体。
        // 原始堆栈用 cause 保留，控制台仍能展开到真正的出错位置。
        const raw = error instanceof Error ? error.message : String(error);
        logAction("sync_domain_failed", { domain: options.key, reason: raw });
        const tagged = new Error(`[${options.label}] ${raw}`, { cause: error });
        if (error instanceof Error && error.stack) tagged.stack = error.stack;
        throw tagged;
    }
}

// 返回 (清单, 云端版本号)。版本号即该行的 updatedAt，供推送时做 CAS。
// 云端无该行时返回 [null, ""]——首次推送没有基准版本，退化为无条件写入。
async function readDomainManifest<T>(transport: AppSyncTransport, domain: DomainKey, emptyData: T): Promise<[DomainManifest<T> | null, string]> {
    const remote = await transport.readManifest(domain);
    if (!remote || !remote.data) return [null, ""];
    const text = remote.data;
    const data = JSON.parse(text) as DomainManifest<T>;
    if (data.app !== "aicanvas" || data.domain !== domain) throw new Error(`${domain} 同步清单不是当前应用的数据`);
    return [{
        app: "aicanvas",
        version: 1,
        domain,
        exportedAt: data.exportedAt || new Date().toISOString(),
        data: data.data || emptyData,
        tombstones: data.tombstones && typeof data.tombstones === "object" && !Array.isArray(data.tombstones) ? data.tombstones : {},
        nodeTombstones: data.nodeTombstones && typeof data.nodeTombstones === "object" && !Array.isArray(data.nodeTombstones) ? data.nodeTombstones : {},
        connTombstones: data.connTombstones && typeof data.connTombstones === "object" && !Array.isArray(data.connTombstones) ? data.connTombstones : {},
        files: Array.isArray(data.files) ? data.files : [],
    }, remote.version || ""];
}

// 节点/连线 rev 墓碑并集：保留较晚 deletedAt 与较大 rev；过 365 天 TTL 回收。
function mergeRevTombstones(local: RevTombstoneMap, remote: RevTombstoneMap): RevTombstoneMap {
    const merged: RevTombstoneMap = {};
    const expireBefore = Date.now() - NODE_TOMBSTONE_TTL_MS;
    for (const source of [remote, local]) {
        for (const [id, t] of Object.entries(source)) {
            if (!t || typeof t.deletedAt !== "string") continue;
            const time = Date.parse(t.deletedAt) || 0;
            if (time < expireBefore) continue;
            const cur = merged[id];
            const deletedAt = !cur || time >= (Date.parse(cur.deletedAt) || 0) ? t.deletedAt : cur.deletedAt;
            merged[id] = { deletedAt, rev: Math.max(t.rev || 0, cur?.rev || 0) };
        }
    }
    return merged;
}

async function downloadMissingFiles<T>(transport: AppSyncTransport, domain: DomainKey, data: T, remoteFiles: AppSyncFile[], onProgress?: AppSyncProgress) {
    const remoteFileMap = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const tasks: AppSyncFile[] = [];
    const storageKeys = collectStorageKeys(data);
    let scanned = 0;
    for (const storageKey of storageKeys) {
        const localBlob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        scanned += 1;
        if (localBlob) {
            emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查缺失媒体", current: scanned, total: storageKeys.length, status: "active" });
            continue;
        }
        const remoteFile = remoteFileMap.get(storageKey);
        if (remoteFile) tasks.push(remoteFile);
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查缺失媒体", current: scanned, total: storageKeys.length, status: "active" });
    }
    if (!tasks.length) {
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "媒体已齐全", current: 1, total: 1, status: "active" });
        return;
    }
    let downloaded = 0;
    let failed = 0;
    await runWithConcurrency(tasks, FILE_CONCURRENCY, async (remoteFile) => {
        // 单个媒体下载失败（TOS CORS / 网络 / 对象缺失）只跳过该文件，绝不阻断整次同步——
        // 否则一个拉不到的媒体会让整个域 throw、连画布 JSON 都传不上云（丢数据隐患根因之一）。
        // 媒体跳过后画布仍可经 TOS 直链显示，下次同步会再尝试拉取。
        try {
            const blob = await transport.downloadFile(remoteFile);
            if (!blob) return;
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, remoteFile.mimeType);
            await (remoteFile.storageKey.startsWith("image:") ? setImageBlob(remoteFile.storageKey, typedBlob) : setMediaBlob(remoteFile.storageKey, typedBlob));
            downloaded += 1;
            emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "下载媒体", current: downloaded, total: tasks.length, status: "active" });
        } catch (error) {
            failed += 1;
            console.warn(`同步:媒体下载失败已跳过 ${remoteFile.storageKey}`, error);
            logActionAggregated("media_download_failed", {
                storageKey: remoteFile.storageKey,
                reason: error instanceof Error ? error.message : String(error),
            }, 10_000);
        }
    });
    if (failed) emitProgress(onProgress, { domain, label: domainLabel(domain), stage: `${failed} 个媒体暂未拉取(已跳过)`, status: "active" });
}

async function uploadChangedFiles<T>(transport: AppSyncTransport, domain: DomainKey, data: T, remoteFiles: AppSyncFile[], onProgress?: AppSyncProgress) {
    const remoteFileMap = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const files: AppSyncFile[] = [];
    const tasks: Array<{ item: AppSyncFile; blob: Blob }> = [];
    let uploadedFiles = 0;
    let uploadedBytes = 0;

    const storageKeys = collectStorageKeys(data);
    // suspectKeys：本地没有字节，且不在【本域清单 files】里。
    //
    // ⚠️ 只能当「疑似」，绝不能直接说成「已丢失」——清单 files 记的是客户端上次写进去的列表，
    // 系统性地少于服务端 sync_files 的真实登记——清单只在客户端成功写入时才更新，
    // 差上几百条是常态。早期版本拿这个差值直接弹「有 N 个素材已经丢失」，绝大部分是误报，白白吓用户一跳。
    // 真正的丢失判定必须查服务端真实登记（见 media-recovery.scanMediaStatus）。
    const suspectKeys: string[] = [];
    let scanned = 0;
    for (const storageKey of storageKeys) {
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        const remoteFile = remoteFileMap.get(storageKey);
        if (!blob) {
            if (remoteFile) files.push(remoteFile);
            else suspectKeys.push(storageKey);
            scanned += 1;
            emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查本地媒体", current: scanned, total: storageKeys.length, status: "active" });
            continue;
        }
        const item: AppSyncFile = {
            storageKey,
            path: remoteFile?.path || domainPath(domain, `files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`),
            mimeType: blob.type || remoteFile?.mimeType || "application/octet-stream",
            bytes: blob.size,
        };
        files.push(item);
        if (!remoteFile || remoteFile.bytes !== blob.size) tasks.push({ item, blob });
        scanned += 1;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查本地媒体", current: scanned, total: storageKeys.length, status: "active" });
    }

    if (suspectKeys.length) {
        // 只记日志、不下结论：清单不全会让这个数虚高，弹给用户会造成「我的图没了」的误报恐慌。
        console.warn(`同步:${suspectKeys.length} 个素材本地无字节且不在本域清单中（疑似，需以服务端登记为准）`, suspectKeys.slice(0, 20));
    }
    if (!tasks.length) {
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "媒体无需上传", current: 1, total: 1, status: "active" });
        return { files, uploadedFiles, uploadedBytes, orphanFiles: suspectKeys.length, failedFiles: 0 };
    }

    const failedKeys = new Set<string>();
    await runWithConcurrency(tasks, FILE_CONCURRENCY, async ({ item, blob }) => {
        // 单个媒体上传失败不阻断整次同步,保证画布 JSON 能写上云。失败的从清单移除——
        // 不落下"清单声称已存在、实际没传成功"的悬空引用(否则字节数匹配会让下次同步不再重试)。
        try {
            await transport.uploadFile(item, blob);
            uploadedFiles += 1;
            uploadedBytes += blob.size;
            emitProgress(onProgress, { domain, label: domainLabel(domain), stage: `上传媒体 ${formatBytes(blob.size)}`, current: uploadedFiles, total: tasks.length, status: "active" });
        } catch (error) {
            failedKeys.add(item.storageKey);
            // 用 error 级别：上传失败意味着这份字节目前只存在于本机，属于「随时可能永久丢失」的状态，
            // 不该和普通警告混在一起被忽略。
            console.error(`同步:媒体上传失败(该素材目前仅存于本机) ${item.storageKey}`, error);
            logAction("media_upload_failed", {
                storageKey: item.storageKey,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    });

    const finalFiles = failedKeys.size ? files.filter((file) => !failedKeys.has(file.storageKey)) : files;
    if (failedKeys.size) emitProgress(onProgress, { domain, label: domainLabel(domain), stage: `⚠️ ${failedKeys.size} 个媒体未上传成功(仅存于本机,请勿清缓存/换设备)`, status: "active" });
    return { files: finalFiles, uploadedFiles, uploadedBytes, orphanFiles: suspectKeys.length, failedFiles: failedKeys.size };
}

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "image" && asset.data.storageKey) {
        const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl, data: { ...asset.data, dataUrl } };
    }
    // 视频/音频：已经是可用公网地址就原样用，别按 storageKey 去解析。
    // resolveMediaUrl 本地没字节会把整段媒体下载进 IndexedDB 再换成会话级 blob:，
    // 而成片本来就是公共读直链——下一遍纯属浪费，还会把耐用地址换成会话级的死链候选。
    // 与 canvas-client-page 的 hydrateCanvasImages 同一条口径，两处必须一起改。
    if (asset.kind === "video" && asset.data.storageKey && !/^https?:\/\//i.test(asset.data.url || "")) {
        const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "audio" && asset.data.storageKey && !/^https?:\/\//i.test(asset.data.url || "")) {
        const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
        return { ...asset, data: { ...asset.data, url } };
    }
    // 组素材封面是会话级 blob，跨会话/换设备失效 → 按序列化时存的 coverStorageKey 重解析（与 image/video 封面一致）
    if (asset.kind === "group" && asset.coverUrl.startsWith("blob:") && typeof asset.metadata?.coverStorageKey === "string") {
        return { ...asset, coverUrl: await resolveImageUrl(asset.metadata.coverStorageKey, asset.coverUrl) };
    }
    return asset;
}

async function readStoredLogs(store: LogStore) {
    const logs: StoredLog[] = [];
    await store.iterate<StoredLog, void>((value) => {
        if (value && typeof value === "object") logs.push(value);
    });
    return logs;
}

// 合并结果落库。不能 clear+盲写：同步进行中本地可能已更新条目（如断点续传把「进行中」改成「成功」）
// 或新建条目，旧快照的合并结果会把它们回滚/删除——逐条按新鲜度仲裁。
async function replaceStoredLogs(store: LogStore, logs: StoredLog[], syncStartedAt: number) {
    const merged = new Map<string, StoredLog>();
    logs.forEach((log) => {
        const id = getStringField(log, "id");
        if (id) merged.set(id, log);
    });
    const current = new Map<string, StoredLog>();
    await store.iterate<StoredLog, void>((value, key) => {
        if (value && typeof value === "object") current.set(key, value);
    });
    const fresh = (log: StoredLog) => getItemTime(log, "createdAt");
    for (const [key, value] of current) {
        if (merged.has(key)) continue;
        // 合并集中不存在：远端墓碑删除（旧条目，删掉）；同步窗口内本地新建（比同步开始新，保留）
        if (fresh(value) <= syncStartedAt) await store.removeItem(key);
    }
    await runWithConcurrency(Array.from(merged.entries()), FILE_CONCURRENCY, async ([id, log]) => {
        const existing = current.get(id);
        if (existing && fresh(existing) > fresh(log)) return;
        await store.setItem(id, log);
    });
}

function mergeTombstones(local: TombstoneMap, remote: TombstoneMap) {
    const merged: TombstoneMap = {};
    const expireBefore = Date.now() - TOMBSTONE_TTL_MS;
    for (const source of [remote, local]) {
        for (const [id, deletedAt] of Object.entries(source)) {
            const time = Date.parse(deletedAt) || 0;
            if (time < expireBefore) continue;
            if (!merged[id] || time > (Date.parse(merged[id]) || 0)) merged[id] = deletedAt;
        }
    }
    return merged;
}

export function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (storageKeyPattern.test(value)) keys.add(value);
        return [...keys];
    }
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && storageKeyPattern.test(value.storageKey)) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function domainPath(domain: DomainKey, path: string) {
    return `${domain}/${path}`;
}

function domainLabel(domain: DomainKey) {
    if (domain === "canvas") return "画布";
    if (domain === "assets") return "我的素材";
    if (domain === "image-workbench") return "图片生成";
    if (domain === "presets") return "我的预设";
    if (domain === "shortcuts") return "快捷键";
    return "视频生成";
}

function emitProgress(onProgress: AppSyncProgress | undefined, event: AppSyncProgressEvent) {
    onProgress?.(event);
}

function getStringField(item: Record<string, unknown>, key: string) {
    const value = item[key];
    return typeof value === "string" ? value : "";
}


function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    return storageKey.startsWith("image:") ? "png" : "bin";
}

function waitForHydration<T extends { hydrated: boolean }>(store: { getState: () => T; subscribe: (listener: (state: T) => void) => () => void }) {
    if (store.getState().hydrated) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const unsubscribe = store.subscribe((state) => {
            if (!state.hydrated) return;
            unsubscribe();
            resolve();
        });
    });
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index], index);
            }
        }),
    );
    return results;
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// describeManifestShape 只统计清单的「形状」——画布数、节点数、素材数。
// 日志里绝不能出现清单内容本身：那是用户的提示词和媒体地址，而反馈是要发给管理员看的。
function describeManifestShape(data: unknown): Record<string, number> {
    try {
        const root = data as { projects?: Array<{ nodes?: unknown[]; connections?: unknown[] }>; assets?: unknown[]; logs?: unknown[] };
        if (Array.isArray(root?.projects)) {
            return {
                projects: root.projects.length,
                nodes: root.projects.reduce((sum, project) => sum + (project.nodes?.length || 0), 0),
                connections: root.projects.reduce((sum, project) => sum + (project.connections?.length || 0), 0),
            };
        }
        if (Array.isArray(root?.assets)) return { assets: root.assets.length };
        if (Array.isArray(root?.logs)) return { logs: root.logs.length };
    } catch {
        /* 形状算不出来不重要，别因此丢掉整条日志 */
    }
    return {};
}
