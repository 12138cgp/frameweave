"use client";

import { APP_VERSION, storageKey } from "@/constant/env";
import { readActionLog, type ActionLogEntry } from "@/services/action-log";
import { scanMediaStatus } from "@/services/media-recovery";
import { readCanvasRevTombstones, readSyncTombstones } from "@/services/sync-tombstones";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { usePresetStore } from "@/stores/use-preset-store";
import { useUserStore } from "@/stores/use-user-store";

// 提交问题反馈时抓取的「现场快照」。
//
// 和操作日志（发生了什么）互补：日志是过程，快照是此刻的状态。
// 诊断「内容丢失」时两者缺一不可——只有日志不知道现在到底还剩多少，
// 只有快照不知道是怎么变成这样的。
//
// 快照分三部分：
//   env    浏览器/设备/存储配额  —— 复现问题、判断是不是隐私模式/配额满/旧浏览器
//   local  本机数据规模          —— 和云端一比就知道是「没同步上去」还是「云端被覆盖了」
//   media  素材上传对账          —— 直接复用「素材上传状态」那套口径，不另起炉灶
//
// 云端那一半由服务端在收到反馈时自己抓（见 service/user_report.go），
// 客户端说什么都不算数——恰恰是「客户端以为自己传上去了」这类问题最需要两边对照。

export type DiagnosticsEnv = {
    appVersion: string;
    buildId: string;
    url: string;
    referrer: string;
    userAgent: string;
    language: string;
    platform: string;
    timezone: string;
    timezoneOffsetMin: number;
    /** 本机时钟与服务端的偏差（毫秒），时钟不准会直接导致 LWW 合并取错边 */
    clockSkewMs: number | null;
    screen: string;
    viewport: string;
    devicePixelRatio: number;
    deviceMemoryGB: number | null;
    hardwareConcurrency: number | null;
    online: boolean;
    cookieEnabled: boolean;
    /** 存储配额与已用（字节）；配额满是 IndexedDB 静默写失败的头号原因 */
    storageQuota: number | null;
    storageUsage: number | null;
    /** 存储是否已被浏览器标记为持久（非持久时可能被系统自动清理） */
    storagePersisted: boolean | null;
};

export type DiagnosticsLocal = {
    hydrated: boolean;
    projectCount: number;
    nodeCount: number;
    connectionCount: number;
    projects: Array<{ id: string; title: string; groupId: string; nodes: number; connections: number; updatedAt: string }>;
    assetCount: number;
    imageStyleCount: number;
    videoStyleCount: number;
    /** 画布级删除墓碑数（整个画布被删过多少个） */
    tombstoneCount: number;
    /** 节点级删除墓碑数 —— 「节点凭空少了」时先看这里：是被删的，还是被合并弄丢的 */
    nodeTombstoneCount: number;
    connTombstoneCount: number;
    /** 本地数据归属的 userId（与当前登录者不一致就是隔离出了问题） */
    localDataOwner: string;
};

export type DiagnosticsMedia = {
    total: number;
    uploaded: number;
    pending: number;
    lost: number;
    /** 只带前若干个 key 便于排查，不全带（可能上千个） */
    sampledPendingKeys: string[];
    sampledLostKeys: string[];
};

export type DiagnosticsBundle = {
    env: DiagnosticsEnv;
    local: DiagnosticsLocal;
    media: DiagnosticsMedia | null;
    log: ActionLogEntry[];
};

const LOCAL_DATA_OWNER_KEY = storageKey("local_data_owner");

async function collectEnv(): Promise<DiagnosticsEnv> {
    let quota: number | null = null;
    let usage: number | null = null;
    let persisted: boolean | null = null;
    try {
        if (navigator.storage?.estimate) {
            const est = await navigator.storage.estimate();
            quota = typeof est.quota === "number" ? est.quota : null;
            usage = typeof est.usage === "number" ? est.usage : null;
        }
        if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    } catch {
        /* 拿不到就留空 */
    }

    // 一次请求同时拿到两件事：
    //   buildId      —— 用户当时跑的是哪个前端构建（部署切换期间的问题全靠它区分）
    //   clockSkewMs  —— 本机时钟与服务端的偏差
    // 时钟偏差在诊断「我的修改被回退了」时非常关键：合并仲裁在 rev 相等时会退化成比 updatedAt，
    // 本机时钟偏几分钟就足以让旧内容盖掉新内容。
    let clockSkewMs: number | null = null;
    let buildId = "";
    try {
        const started = Date.now();
        const response = await fetch("/api/version", { cache: "no-store" });
        const serverDate = response.headers.get("date");
        if (serverDate) {
            const rtt = Date.now() - started;
            clockSkewMs = Math.round(started + rtt / 2 - new Date(serverDate).getTime());
        }
        const payload = (await response.json()) as { data?: { buildId?: string }; buildId?: string };
        buildId = payload?.data?.buildId || payload?.buildId || "";
    } catch {
        /* 网络不通就留空 */
    }

    return {
        appVersion: APP_VERSION,
        buildId,
        url: `${window.location.origin}${window.location.pathname}`,
        referrer: document.referrer || "",
        userAgent: navigator.userAgent,
        language: navigator.language,
        platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        timezoneOffsetMin: new Date().getTimezoneOffset(),
        clockSkewMs,
        screen: `${window.screen.width}x${window.screen.height}`,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        devicePixelRatio: window.devicePixelRatio,
        deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        online: navigator.onLine,
        cookieEnabled: navigator.cookieEnabled,
        storageQuota: quota,
        storageUsage: usage,
        storagePersisted: persisted,
    };
}

function collectLocal(): DiagnosticsLocal {
    const canvas = useCanvasStore.getState();
    const projects = canvas.projects || [];
    let owner = "";
    try {
        owner = window.localStorage.getItem(LOCAL_DATA_OWNER_KEY) || "";
    } catch {
        /* 隐私模式下读不到 */
    }
    return {
        // 水合没完成时本地看着就是空的——这时用户报「我画布空了」多半是虚惊，必须能一眼分辨
        hydrated: canvas.hydrated,
        projectCount: projects.length,
        nodeCount: projects.reduce((sum, project) => sum + (project.nodes?.length || 0), 0),
        connectionCount: projects.reduce((sum, project) => sum + (project.connections?.length || 0), 0),
        projects: projects.map((project) => ({
            id: project.id,
            title: project.title || "",
            groupId: project.canvasGroupId || "",
            nodes: project.nodes?.length || 0,
            connections: project.connections?.length || 0,
            updatedAt: project.updatedAt || "",
        })),
        assetCount: (useAssetStore.getState().assets || []).length,
        imageStyleCount: (usePresetStore.getState().imageStyles || []).length,
        videoStyleCount: (usePresetStore.getState().videoStyles || []).length,
        tombstoneCount: 0, // 下面异步补
        nodeTombstoneCount: 0,
        connTombstoneCount: 0,
        localDataOwner: owner,
    };
}

/**
 * 抓一份完整现场快照。
 *
 * 每一块都独立 try/catch：任何一块抓不到都不能让整个反馈提交不了——
 * 用户已经遇到问题了，再让他连反馈都发不出去是最坏的结果。
 */
export async function collectDiagnostics(): Promise<DiagnosticsBundle> {
    const userId = useUserStore.getState().user?.id || "";

    let env: DiagnosticsEnv;
    try {
        env = await collectEnv();
    } catch {
        env = {
            appVersion: APP_VERSION, buildId: "", url: "", referrer: "", userAgent: "", language: "", platform: "",
            timezone: "", timezoneOffsetMin: 0, clockSkewMs: null, screen: "", viewport: "", devicePixelRatio: 1,
            deviceMemoryGB: null, hardwareConcurrency: null, online: true, cookieEnabled: true,
            storageQuota: null, storageUsage: null, storagePersisted: null,
        };
    }

    let local: DiagnosticsLocal;
    try {
        local = collectLocal();
        try {
            local.tombstoneCount = Object.keys((await readSyncTombstones("canvas")) || {}).length;
            local.nodeTombstoneCount = Object.keys((await readCanvasRevTombstones("node")) || {}).length;
            local.connTombstoneCount = Object.keys((await readCanvasRevTombstones("conn")) || {}).length;
        } catch {
            /* 墓碑读不到不影响其余 */
        }
    } catch {
        local = {
            hydrated: false, projectCount: 0, nodeCount: 0, connectionCount: 0, projects: [],
            assetCount: 0, imageStyleCount: 0, videoStyleCount: 0,
            tombstoneCount: 0, nodeTombstoneCount: 0, connTombstoneCount: 0, localDataOwner: "",
        };
    }

    let media: DiagnosticsMedia | null = null;
    try {
        const status = await scanMediaStatus();
        media = {
            total: status.total,
            uploaded: status.uploaded,
            pending: status.pending,
            lost: status.lost,
            sampledPendingKeys: status.pendingKeys.slice(0, 30),
            sampledLostKeys: status.lostKeys.slice(0, 30),
        };
    } catch {
        /* 素材对账失败不影响提交 */
    }

    let log: ActionLogEntry[] = [];
    try {
        log = await readActionLog(userId);
    } catch {
        /* 同上 */
    }

    return { env, local, media, log };
}
