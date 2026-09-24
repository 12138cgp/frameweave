// 视频节点的「首帧封面」。
//
// 背景：画布上的视频节点直接挂 <video controls>、没写 preload，浏览器一挂载就要建播放器、取数据、
// 解出首帧画出来（这正是今天用户能在画布上看到首帧、转圈会消失的原因）。一个节点如此，几百个就是灾难。
// 实测（真实 Chromium，同一条 15 秒成片）：
//   同时挂 100 个 → 100 个全部加载成功、0 报错；
//   同时挂 300 个 → 渲染进程直接卡死，标签页失去响应，只能关掉重开。
// 一个有两三百个视频节点的画布，缩小看全局时一次就挂载几百个，正好落在这个区间。
//
// 改成 preload="none" 就一个播放器都不建，代价是画面变黑框——封面补的就是这个。
// 火山 TOS 支持服务端截帧，一个 query 参数就有，实测各桶均可用、无需额外开通：
//   1080×1882 的片子：原分辨率 135KB / w_480 24.6KB / w_320 22.3KB（0.44s）
// 存量视频立即生效，不需要 ffmpeg、不占额外存储、不写 sync_files。
//
// ⚠️ 参数按对象类型区分：同一个视频对象加 image/resize 会 400。绝不能把图片那套 tosDisplayThumbUrl
//    接到视频上，反之亦然。两者共用的只有 tosProcessableUrl 那两条判据。
// ⚠️ 只能用于【显示】。生成、下载、导出、抓帧读的都是 node.metadata.content，别接过去。
import { LOD_FULL_QUALITY_ZOOM, tosProcessableUrl } from "./canvas-image-lod";

// 截帧时间点。取 1 秒而不是 0：不少成片开头是黑场/淡入，t_0 抓出来是一张纯黑图，和黑框没区别。
// ⚠️ m_fast = 取该时间点【之前最近的关键帧】，GOP 很长的片子实际可能仍退回第 0 帧。
//    若发现大量黑封面，第一步是去掉 m_fast（精确模式，贵一些），第二步才是加大 t。
const SNAPSHOT_MS = 1000;

// 封面档位。理由与 canvas-image-lod 的 LOD_LADDER 一致：每个不同的 URL 都是一次独立的 TOS 处理
// 请求 + 一条独立缓存，档位无限多会把缓存打散、把处理次数（与计费）放大。
//
// ⚠️ 绝不能用 w_0,h_0（原分辨率）。1080×1882 的封面解码后是 8.1MB 位图，几百个同屏比现在还糟——
//    这正是 canvas-image-lod 里白纸黑字记着的教训：位图面积才是卡顿的直接原因，不是文件体积。
// 比图片少两档：封面只是占位，点下去就被真画面替换，不值得为清晰度多切几档缓存。
// 封面只有两个固定档，且【不跟缩放走】。
//
// 起初照搬图片 LOD 那套「按显示尺寸取档」，结果一条视频最多产生 5 个不同 URL——
// 而每个不同 URL 都是对象存储上一次独立的服务端转码 + 一条独立缓存。用户在画布上来回缩放，
// 同一条视频被反复转码，白花钱也白等。
//
// 实测（同一条视频，真实浏览器）：某档首次 804ms，同地址第二/第三次 0ms（命中缓存），
// 换一个档首次 282ms。也就是说【URL 保持不变才是省钱省时的关键】，档位分得细反而有害。
//
// 所以固定两档，与图片高清阈值同一个开关：
//   远景/常规（缩放 < LOD_FULL_QUALITY_ZOOM）→ 512，一条约 10~30KB，占位足够；
//   放大之后（≥ 阈值）→ 1024，这时同屏节点没几个，多拉一档很划算。
// 一条视频最多两个 URL，各转码一次、缓存一年（响应头是 immutable）。
const POSTER_TIER_FAR = 512;
const POSTER_TIER_NEAR = 1024;

/**
 * 返回该视频的首帧封面地址；不适用（blob:/data:/非 TOS 域名/已带查询串）时返回空串。
 *
 * @param rawUrl 必须传【原始 node.metadata.content】，不要传节点里那个可能带 ?_retry=N 的 src——
 *               tosProcessableUrl 第一条判据就是「已有查询串的一律不动」，从 src 拼会让任何
 *               重试过一次的视频永久失去封面。
 * @param zoomBucket 量化后的画布缩放（zoomBucketOf 的返回值）。只用来在远/近两档之间选，
 *                   刻意不按显示像素取档——那会让每个缩放档都产生一个新 URL、各转码一遍。
 * @param naturalWidth/naturalHeight 已知时用于决定约束哪一条边，让封面与 object-contain 落在同一画框
 */
export function tosVideoPosterUrl(rawUrl: string | undefined, zoomBucket: number, naturalWidth?: number, naturalHeight?: number): string {
    const url = tosProcessableUrl(rawUrl);
    if (!url) return "";
    let tier = POSTER_TIER_FAR;
    if (zoomBucket >= LOD_FULL_QUALITY_ZOOM) tier = POSTER_TIER_NEAR;
    // 约束长边那一侧、另一侧按原比例自适应；竖片约束高、横片（含未知）约束宽。
    let size = `w_${tier},h_0`;
    if ((naturalHeight || 0) > (naturalWidth || 0)) size = `w_0,h_${tier}`;
    return `${url}?x-tos-process=video/snapshot,t_${SNAPSHOT_MS},f_jpg,${size},m_fast`;
}

// ── 封面可用性探测：每个桶只探一次 ────────────────────────────────────────
//
// 第一版是【每个节点各探一次】+ 并发闸 12。那是设计过度，而且在真实画布上适得其反：
// 261 个视频 = 261 次探测，每次都是一次服务端转码（0.3~0.8 秒），光排队就十几秒；
// 排队期间节点既没有封面、还有一部分退回去加载视频——用户看到的就是「满屏灰块 + 还在转圈」。
//
// 探测要回答的其实是【这个桶开没开媒体处理】，那是**桶级**属性，不是对象级的。
// 所以现在每个 host 只探一次，结果记在内存 + localStorage：
//   · 首次进画布：1 次探测请求，之后所有节点直接把封面挂上去，交给浏览器自己并发（HTTP/2 多路复用）；
//   · 以后每次进画布：localStorage 里已有结论，0 次探测。
// 代价是「个别对象坏掉」（已删/太短）探不出来——那种节点会显示黑框而不是退回加载视频。
// 这类是个案，而且点一下照样能播，不值得为它给每个节点都加一次转码。
// 键里带版本号：判据变了（换截帧参数、换判定方式）只要 bump 一位，所有旧结论自然作废，
// 不必依赖用户手动清缓存。
const POSTER_HOST_CACHE_PREFIX = "ic:poster-host:v2:";
// ⭐失败结论只缓存 24 小时，成功结论才永久。
// 第一版把失败也永久写进 localStorage，于是一次网络抖动 / 一次对象存储偶发 5xx，就能让那台浏览器
// 【永久】失去封面——而且回滚代码也清不掉它（结论在用户本地）。这类"负缓存无过期"是很难被发现的坑：
// 现象是少数用户莫名其妙没有封面，日志里什么都看不到。
const POSTER_HOST_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const hostSupport = new Map<string, Promise<boolean>>();

function readHostCache(host: string): boolean | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(POSTER_HOST_CACHE_PREFIX + host);
        if (raw === "1") return true;
        // 失败结论形如 "0:<写入时刻>"，过了 TTL 就当没缓存、重新探一次。
        if (raw && raw.startsWith("0:")) {
            const at = Number(raw.slice(2));
            if (Number.isFinite(at) && Date.now() - at < POSTER_HOST_NEGATIVE_TTL_MS) return false;
            window.localStorage.removeItem(POSTER_HOST_CACHE_PREFIX + host);
        }
    } catch {
        // 隐私模式下读 localStorage 可能直接抛：当作没缓存，探一次就是了。
    }
    return null;
}

function writeHostCache(host: string, ok: boolean) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(POSTER_HOST_CACHE_PREFIX + host, ok ? "1" : "0:" + Date.now());
    } catch {
        // 存不下就算了，绝不能因为记不住而报错。
    }
}

/**
 * 这个封面地址所在的桶支不支持截帧。同一 host 全局只探一次（跨会话记在 localStorage）。
 * 探测用的就是传进来的那个真实封面地址——探通了它本身也被 HTTP 缓存住，节点挂 poster 时不再请求。
 */
export function posterHostSupported(posterUrl: string): Promise<boolean> {
    if (!posterUrl) return Promise.resolve(false);
    let host = "";
    try {
        host = new URL(posterUrl).host;
    } catch {
        return Promise.resolve(false);
    }
    const inMemory = hostSupport.get(host);
    if (inMemory) return inMemory;
    const cached = readHostCache(host);
    if (cached !== null) {
        const settled = Promise.resolve(cached);
        hostSupport.set(host, settled);
        return settled;
    }
    const task = new Promise<boolean>((resolve) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => {
            writeHostCache(host, true);
            resolve(true);
        };
        image.onerror = () => {
            writeHostCache(host, false);
            // 失败结论不留在内存表里：同一次会话里换个画布、或者网络恢复之后，
            // 下一个节点还能再探一次，而不是一次抖动就把整个会话的封面判死。
            hostSupport.delete(host);
            resolve(false);
        };
        image.src = posterUrl;
    });
    hostSupport.set(host, task);
    return task;
}
