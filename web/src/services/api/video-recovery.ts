import { useUserStore } from "@/stores/use-user-store";

import { apiGet } from "./request";

// 「这块画布上还有哪些视频任务在等着交付」——画布载入时问服务端一次。
//
// 前端判「页面刷新后生成已中断」只看本地节点有没有 videoTaskId，而任务号会丢：
// 持久化被吞（skipNextPersist 盲吞下一拍）、或用户在提交返回前就刷新了。
// 一丢就把还在正常生成的任务判死，用户以为白扣钱、又重生成一遍。
// 服务端在提交那一刻就记下了 canvasId + nodeId，这里直接问它要回来。

export type PendingVideoTask = {
    nodeId: string;
    taskId: string;
    model: string;
    createdAt: string;
};

type PendingVideoTasksResponse = { items?: PendingVideoTask[] };

// 查本画布未结案的视频任务。后端按登录态锁死本人，这里不传也不能传 userId。
//
// ⚠️ token 必须显式传：apiRequest 不会自动带 Authorization，
// 本项目每个 /api/my/* 的调用方都得自己传（见 services/api/my-logs.ts）。
// 漏传的后果不是「这个请求失败」那么简单——服务端回 401 会触发
// request.ts 里的 notifySessionExpired()，广播「会话失效」把用户踢去登录页；
// 而且调用处的 .catch 挡不住，因为 notifySessionExpired 在 throw 之前就执行了。
// 漏传的症状是「一打开画布就要重新登录」，而且它看起来完全不像是新加的那个功能引起的；
// 本地开发通常带着长期有效的登录态，撞不上，往往要到真实环境才暴露。务必别漏。
export async function fetchPendingVideoTasks(canvasId: string) {
    const id = (canvasId || "").trim();
    if (!id) return [] as PendingVideoTask[];
    const token = useUserStore.getState().token;
    // 没登录态时直接返回空：这是兜底路径，不该在未登录时打请求、更不该因此触发登出。
    if (!token) return [] as PendingVideoTask[];
    const data = await apiGet<PendingVideoTasksResponse>("/api/my/pending-video-tasks", { canvasId: id }, token);
    return (data?.items || []).filter((item) => item && item.nodeId && item.taskId);
}
