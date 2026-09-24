// 3D 场景台节点的状态与嵌入协议。
//
// 场景台本身是一个独立的 Vite + Three.js 应用（第三方 MIT 组件，声明见 THIRD-PARTY-NOTICES.txt），
// 构建产物放在 web/public/director-desk/，由 Next 静态服务在同源 /director-desk/ 路径。
//
// 为什么走 iframe 而不是把源码合进来：场景台是 React 18 + @react-three/fiber v8，
// 而本项目是 React 19——fiber v8 不支持 React 19，合进来直接编译不过。
// 而且它本来就是按「可嵌入」设计的，有正式的 postMessage 协议（见下方 DIRECTOR_MESSAGE）。
// 走 iframe 还有个好处：Three.js、模型加载、录制这些重东西全留在子应用里，不进主包。
//
// ⚠️ 同源部署带来的一个重要简化：协议里的 hostOrigin 参数是给跨域场景用的，
// 我们同源，所以不传它，并且把 event.origin 严格校验成 window.location.origin。

export type StageNodeState = {
    // instanceId 场景台的工程隔离键。用节点 id，保证一个节点一个独立工程，
    // 且这个 id 随画布数据同步到其它设备。
    //
    // ⚠️ 但工程内容本身**不跟着同步**：场景台把场景数据存在浏览器 localStorage/IndexedDB
    // （上游协议里 assetPersistence 就叫 "browser-local-references"）。
    // 换浏览器或换设备后，同一个节点打开会是空工程，导入的 FBX/GLB 也要重新导入。
    // 这是上游的设计边界，不是这里的 bug——展示层要把这件事说清楚，别让用户以为丢了数据。
    instanceId: string;
    // captureCount 已经从场景台回传过多少张截图，只用于节点上给个反馈。
    captureCount: number;
    // coverStorageKey 节点封面（最近一次回传的截图）。
    //
    // ⚠️ 字段名必须以 storageKey 结尾/命名：画布导出和分享的 collectStorageKeys 是
    // 「递归找名为 storageKey 且含冒号的字符串」，换个名字封面就不会被打进导出包。
    coverStorageKey?: string;
    // coverUrl 运行时可显示地址。可能是失效的 blob:，渲染失败时靠 coverStorageKey 自愈。
    coverUrl?: string;
    updatedAt?: string;
};

export function createStageState(instanceId: string): StageNodeState {
    return { instanceId, captureCount: 0, updatedAt: new Date().toISOString() };
}

// normalizeStageState 清洗来自云端/旧版本的状态。
// 入参可能是任意结构（同步下发的 JSON 不可控），每个字段单独兜底。
export function normalizeStageState(input: unknown, fallbackInstanceId: string): StageNodeState {
    if (!input || typeof input !== "object") return createStageState(fallbackInstanceId);
    const raw = input as Record<string, unknown>;
    const instanceId = typeof raw.instanceId === "string" && raw.instanceId.trim() ? raw.instanceId.trim() : fallbackInstanceId;
    const captureCount = typeof raw.captureCount === "number" && Number.isFinite(raw.captureCount) ? Math.max(0, Math.floor(raw.captureCount)) : 0;
    const state: StageNodeState = { instanceId, captureCount };
    if (typeof raw.coverStorageKey === "string" && raw.coverStorageKey) state.coverStorageKey = raw.coverStorageKey;
    if (typeof raw.coverUrl === "string" && raw.coverUrl) state.coverUrl = raw.coverUrl;
    if (typeof raw.updatedAt === "string" && raw.updatedAt) state.updatedAt = raw.updatedAt;
    return state;
}

// —— 嵌入协议（与上游 docs/embed-contract.md 对齐，protocolVersion = 1）——

// ⚠️ 必须写到 index.html，不能只写目录。
//
// 上游文档给的是 /director-desk/?instanceId=...，那是给普通静态服务器（会自动找 index.html）用的。
// Next 不给 public 下的目录做 index 兜底：实测 /director-desk/ 会 308 跳到 /director-desk，
// 而后者直接 404。写全 index.html 才是 200。
// （index.html 内部的资源引用是 ./assets/... 相对路径，仍解析到 /director-desk/assets/...，正确。）
export const DIRECTOR_DESK_PATH = "/director-desk/index.html";
export const DIRECTOR_PROTOCOL_VERSION = 1;

export const DIRECTOR_MESSAGE = {
    ready: "storyai:director-desk-ready",
    close: "storyai:director-desk-close",
    capturesSent: "storyai:director-desk-captures-sent",
    session: "storyai:director-desk-session",
    request: "storyai:director-desk:request",
    response: "storyai:director-desk:response",
} as const;

export type DirectorCapture = {
    dataUrl: string;
    fileName: string;
};

// —— 二创受控接口 v1（request/response 配对）——
//
// 用它把运镜录成的 MP4 直接要回来，而不是让场景台自己触发浏览器下载。
// 上游对这两条路径的处理是分开的：界面上那个「导出 MP4」按钮走 downloadReferenceVideo()
// （造一个 a[download] 直接下载），而协议请求只把结果返回、**不会自动下载**。
// 所以我们从协议要，就能拿到原始 Blob 自己落成画布节点。

export type DirectorRequestAction = "capabilities.get" | "project.get" | "timeline.get" | "export.frame" | "export.video";

// DirectorVideoResult 对应上游 ReferenceVideoExportResult。
// blob 是真正的 Blob 对象——postMessage 的结构化克隆原生支持 Blob，
// 不需要 base64 中转（几十 MB 的视频转 base64 会膨胀三分之一还卡主线程）。
export type DirectorVideoResult = {
    blob: Blob;
    durationSeconds: number;
    fileName: string;
    width: number;
    height: number;
    mimeType: string;
};

export type DirectorTimeline = {
    durationSeconds: number;
    progress: number;
    playing: boolean;
};

// 导出视频是**实时录制**（MediaRecorder），录 N 秒的运镜就要等 N 秒。
// 上游单段最长 30 秒，留足余量再加上编码和回传时间。
export const DIRECTOR_EXPORT_TIMEOUT_MS = 180_000;
// 其余只读请求（拿时长、拿能力）应当很快，单独给一个短超时，免得界面在那儿干等。
export const DIRECTOR_QUERY_TIMEOUT_MS = 15_000;

// 上游返回的错误码 → 给用户看的中文。
//
// ⚠️ export-failed 这条**故意不透传上游的原文**。上游把五种完全不同的失败塞进了同一句
// 「当前浏览器无法导出参考视频」（见 DirectorCanvas.tsx 里那个 if：录制画布未就绪、
// 编解码不支持、没有活动机位、没有运镜路径、轨迹点少于 2 个）。也就是说，哪怕浏览器
// MediaRecorder 对三种 MP4 格式全都支持，也照样会报这句——直接把它甩给用户，
// 只会让人跑去换浏览器，而真正的原因往往是轨迹点或画面没准备好。
export function directorErrorText(code: string, fallback: string) {
    if (code === "export-busy") return "场景台里已有一个导出任务在跑，等它结束再试";
    if (code === "unsupported-action") return "当前场景台版本不支持这个操作";
    // 只替换那一句误导的，其余原样透传。
    //
    // 上游别的错误消息其实很准确，例如「当前浏览器不支持 MP4 导出，请使用最新版 Chrome 或 Edge」
    // （Safari/Firefox 会命中）、「已有导出任务正在进行」（界面按钮那把锁，注意它报的是
    // export-failed 而不是 export-busy，两把锁互相看不见）——这些照原样给用户更有用。
    if (fallback.includes("当前浏览器无法导出参考视频")) {
        return "导出失败。请确认：镜头轨迹点至少 2 个；导出过程中让场景台一直显示在前台（录制是实时的，切走标签页会被浏览器暂停）";
    }
    if (fallback) return fallback;
    return "导出失败";
}

// buildDirectorSrc 生成 iframe 地址。
// 同源部署，所以不带 hostOrigin——上游只在跨域时要求它。
export function buildDirectorSrc(instanceId: string, theme: "dark" | "light") {
    const params = new URLSearchParams({ instanceId, theme });
    return `${DIRECTOR_DESK_PATH}?${params.toString()}`;
}

// readDirectorCaptures 从 postMessage 事件里提取截图数组。
//
// 消息来自 iframe，内容一律当作不可信输入逐项校验：
// 只接受 data:image/ 开头的 dataUrl，挡掉 javascript: 之类被塞进来的东西。
export function readDirectorCaptures(payload: unknown): DirectorCapture[] {
    if (!payload || typeof payload !== "object") return [];
    const raw = (payload as { captures?: unknown }).captures;
    if (!Array.isArray(raw)) return [];
    const captures: DirectorCapture[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const dataUrl = typeof entry.dataUrl === "string" ? entry.dataUrl : "";
        if (!dataUrl.startsWith("data:image/")) continue;
        const fileName = typeof entry.fileName === "string" && entry.fileName.trim() ? entry.fileName.trim() : `场景台截图${captures.length + 1}.png`;
        captures.push({ dataUrl, fileName });
    }
    return captures;
}
