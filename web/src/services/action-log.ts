"use client";

import localforage from "localforage";

import { APP_VERSION, LOCAL_DB_NAME } from "@/constant/env";

// 用户操作日志（环形缓冲）。
//
// 为什么要有它：用户报「我的画布内容不见了 / 视频没了 / 一直提示同步失败」时，我们手上除了云端那份
// 最终状态之外一无所有——没有任何记录能说明中间发生了什么。视频丢失就是典型：
// 全链路（转存进桶 → 写回画布 → 同步上云）一条日志都没留，只能靠事后翻数据库反推，
// 而反推不出「用户当时在做什么、哪一步断的」。
//
// 三条设计红线：
//  1. **必须跨会话存活**。用户几乎不会在出事当下就来报，往往是第二天打开发现没了才说。
//     日志只留在内存里等于没有，所以要落 IndexedDB。
//  2. **它自己绝不能成为故障源**。所有读写一律吞异常：日志系统把主流程搞挂是最愚蠢的失败。
//  3. **绝不记录内容本身**。提示词正文、图片/视频字节、token、密钥一律不进日志；
//     只记元信息（长度、数量、id、耗时、状态）。日志是要发给管理员看的，等同于对外披露。
//
// 存储：localforage 同库新 store。刻意【不】加进 cache-isolation 的「切账号清空」列表——
// 那会让「换个账号登一下」就把出事现场清掉，正是最需要日志的时候。改为每条带 userId，
// 读取时按当前用户过滤，隐私上等价、可用性上强得多（同款权衡见 cache-isolation.ts 对媒体字节的注释）。

export type ActionLogEntry = {
    /** 时间戳（毫秒） */
    t: number;
    /** 单调递增序号：同毫秒内也能保住顺序 */
    s: number;
    /** 事件名，小写下划线 */
    e: string;
    /** 所属用户；未登录时为空串 */
    u: string;
    /** 结构化字段，只放元信息 */
    d?: Record<string, unknown>;
};

const store = localforage.createInstance({ name: LOCAL_DB_NAME, storeName: "action_logs" });

/** 段前缀：一段一个 key，写入代价小、淘汰也只是删 key */
const SEGMENT_PREFIX = "seg:";
/** 每段最多多少条（攒够就落盘） */
const SEGMENT_SIZE = 200;
/** 最多保留多少段 —— 200×24 = 4800 条，够覆盖好几天的正常使用 */
const MAX_SEGMENTS = 24;
/** 定时落盘间隔：有脏数据才写 */
const FLUSH_INTERVAL_MS = 20_000;
/** 单个字段值转成字符串后的长度上限，防止某个 reason 特别长把日志撑爆 */
const MAX_FIELD_LEN = 300;

let seq = 0;
let pending: ActionLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

/** 高频事件聚合窗口：key -> {首条时间, 计数, 待写字段} */
const aggregates = new Map<string, { first: number; count: number; data: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }>();

// 当前用户由外部注入，而不是 import useUserStore。
//
// 原因是循环依赖：use-user-store 要调 logAction（记登录/登出），若这里再反过来 import 它就成环。
// ESM 对环的处理依赖求值顺序，在打包器手里可能变成 undefined，
// 而这种坏法只会在特定构建配置下冒出来——日志系统绝不该有这种脆弱面。
// 由 ClientRootInit 在启动时注入一个 getter，注入前记的条目 userId 为空（那时也还没登录）。
let userIdGetter: (() => string) | null = null;

/** 注入「当前登录用户」的读取方式。幂等，重复调用只是覆盖。 */
export function bindActionLogUser(getter: () => string): void {
    userIdGetter = getter;
}

function currentUserId(): string {
    try {
        return userIdGetter?.() || "";
    } catch {
        return "";
    }
}

// 字段裁剪：只留能安全外发的元信息。
// 长字符串截断并标注，对象/数组只留长度——绝不把提示词正文或 base64 带出去。
function sanitize(data?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!data) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) continue;
        if (typeof value === "number" || typeof value === "boolean") {
            out[key] = value;
            continue;
        }
        if (typeof value === "string") {
            // data:/blob: 开头的一律不留内容，只留类型和长度：这类值动辄几 MB
            if (value.startsWith("data:") || value.startsWith("blob:")) {
                out[key] = `${value.slice(0, value.indexOf(":") + 1)}<${value.length}字节>`;
                continue;
            }
            out[key] = value.length > MAX_FIELD_LEN ? `${value.slice(0, MAX_FIELD_LEN)}…(共${value.length})` : value;
            continue;
        }
        if (Array.isArray(value)) {
            out[key] = `[${value.length}项]`;
            continue;
        }
        // 其余对象：只记键名，不记值
        try {
            out[key] = `{${Object.keys(value as object).slice(0, 8).join(",")}}`;
        } catch {
            out[key] = "{?}";
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 记一条操作日志。永不抛异常、永不阻塞调用方。
 *
 * 事件名用小写下划线（canvas_open / sync_failed / video_persist_failed …）；
 * data 里只放元信息，正文类内容会被上面的 sanitize 拦掉。
 */
export function logAction(event: string, data?: Record<string, unknown>): void {
    try {
        seq += 1;
        pending.push({ t: Date.now(), s: seq, e: event, u: currentUserId(), d: sanitize(data) });
        if (pending.length >= SEGMENT_SIZE) {
            void flushActionLog();
        } else {
            scheduleFlush();
        }
    } catch {
        // 日志失败就算了，绝不影响主流程
    }
}

/**
 * 高频事件聚合版：窗口内只落一条，附带发生次数。
 *
 * 用于拖动节点、视口平移这类一秒能触发几十次的操作——逐条记会把真正重要的
 * 同步/删除/生成事件挤出环形缓冲，那就本末倒置了。
 */
export function logActionAggregated(event: string, data?: Record<string, unknown>, windowMs = 3000): void {
    try {
        const existing = aggregates.get(event);
        if (existing) {
            existing.count += 1;
            Object.assign(existing.data, data || {});
            return;
        }
        const entry = {
            first: Date.now(),
            count: 1,
            data: { ...(data || {}) },
            timer: setTimeout(() => {
                const agg = aggregates.get(event);
                aggregates.delete(event);
                if (agg) logAction(event, { ...agg.data, n: agg.count, spanMs: Date.now() - agg.first });
            }, windowMs),
        };
        aggregates.set(event, entry);
    } catch {
        /* 同上 */
    }
}

function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushActionLog();
    }, FLUSH_INTERVAL_MS);
}

/** 把内存里攒的条目落盘为一段，并淘汰最旧的段。异常一律吞掉。 */
export async function flushActionLog(): Promise<void> {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
        // key 用「时间戳-序号」保证字典序 == 时间序，读取和淘汰都靠排序，不需要额外索引
        await store.setItem(`${SEGMENT_PREFIX}${String(batch[0].t).padStart(14, "0")}-${String(batch[0].s).padStart(8, "0")}`, batch);
        const keys = (await store.keys()).filter((k) => k.startsWith(SEGMENT_PREFIX)).sort();
        for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_SEGMENTS))) {
            await store.removeItem(stale);
        }
    } catch {
        // 写不进去（配额满/隐私模式/IndexedDB 被禁）就放弃这一批。
        // 刻意不把 batch 塞回 pending：那会在配额满时无限堆积内存，比丢日志严重得多。
    }
}

/**
 * 读出全部日志（含尚未落盘的），按时间排序。
 * userId 非空时只返回该用户的条目 + 无主条目（登录前的环境类事件）。
 */
export async function readActionLog(userId?: string): Promise<ActionLogEntry[]> {
    let stored: ActionLogEntry[] = [];
    try {
        const keys = (await store.keys()).filter((k) => k.startsWith(SEGMENT_PREFIX)).sort();
        for (const key of keys) {
            const segment = await store.getItem<ActionLogEntry[]>(key);
            if (Array.isArray(segment)) stored = stored.concat(segment);
        }
    } catch {
        // 读不出来就只用内存里的，有多少给多少
    }
    const all = stored.concat(pending);
    const filtered = userId ? all.filter((entry) => !entry.u || entry.u === userId) : all;
    return filtered.sort((a, b) => a.t - b.t || a.s - b.s);
}

/**
 * 安装全局钩子：全局错误、未处理的 Promise 拒绝、页面生命周期、网络状态。
 *
 * 这些是「用户那边到底出了什么事」最重要的来源，而且现在【完全没有】被记录：
 * 页面崩了、Promise 炸了、断网了，我们一无所知。
 * 幂等，重复调用只装一次。
 */
export function installActionLogHooks(): void {
    if (installed || typeof window === "undefined") return;
    installed = true;
    try {
        window.addEventListener("error", (event) => {
            // 资源加载失败（img/script）也会走到这里，target 不是 window 就说明是资源错误
            if (event.target && event.target !== window) {
                const el = event.target as HTMLElement;
                logActionAggregated("resource_error", { tag: el.tagName, src: (el as HTMLImageElement).src || "" }, 5000);
                return;
            }
            logAction("js_error", {
                msg: event.message,
                file: event.filename,
                line: event.lineno,
                col: event.colno,
                stack: event.error instanceof Error ? (event.error.stack || "").slice(0, 600) : "",
            });
        }, true);

        window.addEventListener("unhandledrejection", (event) => {
            const reason = event.reason;
            logAction("unhandled_rejection", {
                msg: reason instanceof Error ? reason.message : String(reason ?? ""),
                stack: reason instanceof Error ? (reason.stack || "").slice(0, 600) : "",
            });
        });

        document.addEventListener("visibilitychange", () => {
            logAction("page_visibility", { state: document.visibilityState });
            // 切走时必须立刻落盘：移动端切后台后可能再也不回来
            if (document.visibilityState === "hidden") void flushActionLog();
        });

        window.addEventListener("pagehide", () => {
            logAction("page_hide", {});
            void flushActionLog();
        });

        window.addEventListener("online", () => logAction("network_online", {}));
        window.addEventListener("offline", () => logAction("network_offline", {}));

        logAction("app_start", {
            version: APP_VERSION,
            url: window.location.origin + window.location.pathname,
            ua: navigator.userAgent,
        });
    } catch {
        /* 装不上就算了 */
    }
}
