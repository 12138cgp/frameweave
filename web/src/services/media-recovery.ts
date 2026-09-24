import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { collectStorageKeys } from "@/services/app-sync";
import { syncAppDataToCloud } from "@/services/cloud-sync";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { usePresetStore } from "@/stores/use-preset-store";
import { useUserStore } from "@/stores/use-user-store";

// 素材上传状态自查与手动补传。
//
// 为什么单独做这个：同步遇到本地没有字节的素材会静默跳过，上传失败也只是记一笔日志，
// 用户直到换设备看见一片白框才知道出事，而那时本机那份唯一副本往往已经被清掉了。
// 光把状态显示出来还不够——得让用户当场能把「只存在于本机」的那些推上去。

export type MediaStatus = {
    /** 画布引用到的去重素材总数 */
    total: number;
    /** 云端已有登记的 */
    uploaded: number;
    /** 本机有字节、云端没有 —— 还救得回来，正是「立即上传」要推的 */
    pending: number;
    /** 本机和云端都没有 —— 已经丢了，只能重新生成 */
    lost: number;
    pendingKeys: string[];
    lostKeys: string[];
};

/**
 * 收集【所有会被同步上传的】storageKey，覆盖全部 5 个数据域。
 *
 * ⚠️ 必须与同步的收集口径完全一致，所以直接复用同步自己的 collectStorageKeys。
 *
 * 原先这里只遍历画布域、且要求节点 content 非空，比同步的口径窄得多。后果是用户看到互相矛盾的两句话：
 * 进入页面弹「有 3 个素材未能上传到云端…否则会永久丢失」（那是同步按全域统计的 failedFiles），
 * 点「立即上传」却回「已上传 0 个素材」、状态弹窗也显示「待上传 0」——
 * 因为那 3 个失败的文件属于素材库/工作台/预设域，或是 content 为空的画布节点，
 * 这个函数根本看不见它们。告警吓人、补救无效，比不告警还糟。
 */
function collectSyncedStorageKeys(): string[] {
    const keys = new Set<string>();
    // 画布：整棵 projects 交给通用收集器（节点 metadata、参考图、批次等各处的 key 都能收到）
    collectStorageKeys(useCanvasStore.getState().projects, keys);
    // 其余四个域：与 app-sync 里 localData() 取的是同一份数据
    collectStorageKeys(useAssetStore.getState().assets, keys);
    collectStorageKeys(usePresetStore.getState().imageStyles, keys);
    collectStorageKeys(usePresetStore.getState().videoStyles, keys);
    return [...keys];
}

async function remoteKeySet(): Promise<Set<string>> {
    const token = useUserStore.getState().token;
    if (!token) return new Set();
    try {
        const response = await fetch("/api/v1/sync/files", { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) return new Set();
        const payload = (await response.json()) as { data?: Array<{ storageKey?: string }> } | Array<{ storageKey?: string }>;
        const items = Array.isArray(payload) ? payload : payload.data || [];
        return new Set(items.map((item) => (item.storageKey || "").trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

/**
 * 扫描当前画布素材的上传状态。
 * 拿不到云端清单时一律返回空结果（宁可什么都不报，也不要把「网络没通」谎报成「素材丢了」吓人）。
 */
export async function scanMediaStatus(): Promise<MediaStatus> {
    const empty: MediaStatus = { total: 0, uploaded: 0, pending: 0, lost: 0, pendingKeys: [], lostKeys: [] };
    const keys = collectSyncedStorageKeys();
    if (!keys.length) return empty;
    const token = useUserStore.getState().token;
    if (!token) return empty;
    let remote: Set<string>;
    try {
        remote = await remoteKeySet();
    } catch {
        return empty;
    }
    if (!remote.size && keys.length) {
        // 云端清单一条都没有：更可能是接口没取到，而不是几百个素材同时消失。不下结论。
        return empty;
    }
    const pendingKeys: string[] = [];
    const lostKeys: string[] = [];
    let uploaded = 0;
    for (const key of keys) {
        if (remote.has(key)) {
            uploaded += 1;
            continue;
        }
        const blob = key.startsWith("image:") ? await getImageBlob(key) : await getMediaBlob(key);
        if (blob && blob.size) pendingKeys.push(key);
        else lostKeys.push(key);
    }
    return { total: keys.length, uploaded, pending: pendingKeys.length, lost: lostKeys.length, pendingKeys, lostKeys };
}

export type UploadPendingResult = {
    before: MediaStatus;
    after: MediaStatus;
    /** 本次真正补传成功的数量 */
    recovered: number;
};

/**
 * 手动补传：把「本机有、云端没有」的素材推上去。
 *
 * 直接复用整套云端同步，而不是另写一条上传路径——清单(files)、墓碑、收缩护栏这些都必须一起更新，
 * 另起炉灶必然和主链路慢慢跑偏。同步本身就会上传所有「本地有字节但云端缺失」的素材，
 * 这里的价值是给用户一个明确的触发点和前后对比。
 */
export async function uploadPendingMedia(): Promise<UploadPendingResult> {
    const before = await scanMediaStatus();
    if (before.pending > 0) await syncAppDataToCloud();
    const after = await scanMediaStatus();
    return { before, after, recovered: Math.max(0, before.pending - after.pending) };
}
