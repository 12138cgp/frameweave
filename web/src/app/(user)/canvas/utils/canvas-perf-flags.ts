// 画布性能诊断开关（临时排查用，通过 URL 查询串启用，不影响正常访问）。
//
// 为什么需要它：画布卡顿有两个完全不同的可能来源——
//   ① 图片本身太重（解码 + 合成大位图）
//   ② DOM 元素数量本身（几百个节点子树的样式计算、布局、栅格化）
// 两者的解法天差地别：①靠降采样就能治，②只能减少元素数量（乃至换成 Canvas 绘制）。
// 而这两者在体感上完全一样，猜不出来。不先定性就动手很容易白做一轮：
// 瓶颈其实在①的时候去给节点做 memo 化，做完实测会是「毫无区别」。
// 先用下面的开关把两者分开，再决定往哪边投入。
//
// 用法：在画布地址后加 ?perf=noimg
//   noimg  —— 图片节点不渲染 <img>，只画一个纯色块。节点数量、连线、布局全部保持不变。
//            → 若仍然卡：瓶颈是 DOM 元素数量，图片侧再优化也没用
//            → 若立刻变顺：瓶颈是图片，继续在降采样这条线上做
//
// 只读一次 location，之后走缓存——每个节点都读一次 URL 是没必要的开销。

let cached: string | null = null;

function currentFlags(): string {
    if (cached !== null) return cached;
    if (typeof window === "undefined") {
        cached = "";
        return cached;
    }
    try {
        cached = new URLSearchParams(window.location.search).get("perf") || "";
    } catch {
        cached = "";
    }
    return cached;
}

/** 判断某个诊断开关是否开启。支持逗号分隔多个，如 ?perf=noimg,noconn */
export function canvasPerfFlag(name: string): boolean {
    const flags = currentFlags();
    if (!flags) return false;
    return flags
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .includes(name.toLowerCase());
}
