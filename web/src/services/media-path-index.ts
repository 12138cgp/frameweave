import { useUserStore } from "@/stores/use-user-store";

// storageKey → 该文件的公网地址(TOS 公共读)索引。
//
// 为什么需要它：画布上绝大多数图片节点的 metadata.content 是会话级 blob:（跨会话即失效，
// 靠 storageKey 从 IndexedDB / 服务端自愈），只有少数直接存着 TOS 地址。图片按显示尺寸取小图
// （canvas-image-lod）需要一个可加 x-tos-process 参数的公网地址，blob: 给不了，得靠 storageKey 反查。
//
// 数据来源是既有接口 GET /api/v1/sync/files —— 它返回的每条记录本来就带 path（绝大多数是
// 对象存储的公网地址，少数是本地磁盘路径；反查不到就回退原图，不影响正确性）。
//
// ⚠️ 刻意【不】接进 cloud-sync：同步链路是整个前端数据安全风险最高的地方（陈旧快照回滚、
// 误删、跨账号串号这几类问题都出在这条链上）。这里改成首次用到时自己拉一次清单，与同步逻辑完全解耦，
// 出问题最坏的后果只是「取不到小图、继续用原图」。

const pathByKey = new Map<string, string>();
let loading: Promise<void> | null = null;
let loadedForToken = "";

type SyncFileRecord = { storageKey?: string; path?: string };

function unwrapItems(payload: unknown): SyncFileRecord[] {
    if (Array.isArray(payload)) return payload as SyncFileRecord[];
    if (payload && typeof payload === "object") {
        const data = (payload as { data?: unknown }).data;
        if (Array.isArray(data)) return data as SyncFileRecord[];
    }
    return [];
}

/** 用已有的文件清单填充索引（无需再发请求时可直接喂进来）。 */
export function primeMediaPathIndex(items: SyncFileRecord[]) {
    for (const item of items) {
        const key = (item.storageKey || "").trim();
        const path = (item.path || "").trim();
        // 只收公网地址；本地磁盘路径对浏览器没意义，收进来只会让下游误判为「可用地址」。
        if (key && /^https?:\/\//i.test(path)) pathByKey.set(key, path);
    }
}

/**
 * 同步查一条；未加载、账号已变、或查不到时返回空串（调用方回退原图）。
 *
 * 必须校验 token 归属：同一页面切账号后，新账号的 ensureMediaPathIndex 还没跑完时，
 * 这里若照旧返回上个账号的地址，就等于把别人的图显示给当前用户。storageKey 是随机串、
 * 撞车概率极低，但跨账号串号一旦发生就很难收拾，这种地方一律按最坏情况防。
 */
export function getPublicMediaPath(storageKey?: string): string {
    if (!storageKey) return "";
    const token = useUserStore.getState().token || "";
    if (!token || token !== loadedForToken) return "";
    return pathByKey.get(storageKey) || "";
}

/**
 * 确保索引已加载。整个会话只拉一次；换账号（token 变化）会重新拉并清空旧账号的索引
 * ——避免切号后拿着上个账号的地址（本项目踩过跨账号串号的坑）。
 * 任何失败都静默返回：拿不到索引只是用不上小图，绝不能影响画布显示。
 */
export function ensureMediaPathIndex(): Promise<void> {
    const token = useUserStore.getState().token || "";
    if (!token) return Promise.resolve();
    if (loadedForToken === token && !loading) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
        try {
            const response = await fetch("/api/v1/sync/files", { headers: { Authorization: `Bearer ${token}` } });
            if (!response.ok) return;
            const items = unwrapItems(await response.json());
            if (loadedForToken !== token) pathByKey.clear(); // 换账号 → 丢弃上个账号的索引
            primeMediaPathIndex(items);
            loadedForToken = token;
        } catch {
            // 忽略：没有索引就退回原图
        } finally {
            loading = null;
        }
    })();
    return loading;
}
