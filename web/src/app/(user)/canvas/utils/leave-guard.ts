"use client";

// 视频生成中「离开画布」的确认闸。
//
// 背景：视频的轮询是浏览器在画布页里做的——页面一走就没人接收结果，
// 上游照常出片、点数照扣，片子却认领不回来（孤儿任务，上游约 24h 后删除）。
// 关标签页/刷新由 beforeunload 拦（浏览器原生弹窗、文案不可改）；
// 站内跳转（切子画布/回项目列表/回首页）beforeunload 不触发，只能自己拦——好处是文案可自定义。
//
// 只拦视频：图片走后端 job，关页面可续查、完全安全，拦它只会平白骚扰用户。
//
// 用法：画布页挂载时 registerLeaveGuard 注册「探针 + 确认弹窗」，
// 各跳转点用 guardedNavigate(() => router.push(...)) 包一层即可。

type Probe = () => number; // 返回正在生成的视频数量
type Confirm = (count: number, onConfirm: () => void) => void;

let probe: Probe | null = null;
let confirmLeave: Confirm | null = null;

// registerLeaveGuard 由画布页调用（它才拿得到节点状态与 antd Modal 实例）。返回注销函数。
export function registerLeaveGuard(nextProbe: Probe, nextConfirm: Confirm): () => void {
    probe = nextProbe;
    confirmLeave = nextConfirm;
    return () => {
        if (probe === nextProbe) probe = null;
        if (confirmLeave === nextConfirm) confirmLeave = null;
    };
}

// generatingVideoCount 当前画布正在生成的视频数（无探针=0，例如不在画布页）。
export function generatingVideoCount(): number {
    if (!probe) return 0;
    try {
        return probe();
    } catch {
        return 0;
    }
}

// guardedNavigate 有视频在生成就先确认，否则直接跳。
// 未注册确认弹窗时一律放行——绝不能因为闸门自身异常而卡死用户的导航。
export function guardedNavigate(action: () => void): void {
    const count = generatingVideoCount();
    if (count <= 0 || !confirmLeave) {
        action();
        return;
    }
    confirmLeave(count, action);
}
