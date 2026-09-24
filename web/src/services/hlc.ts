"use client";

// 混合逻辑时钟（Hybrid Logical Clock 的简化实现）：单调递增的「修订号 rev」。
// 即使系统墙钟被回拨/跨设备偏移，tick() 也永远 > 自己见过的任何 rev，
// 故用作多设备画布同步的逐节点/逐连线合并仲裁键，取代不可靠的跨设备墙钟比较。
let last = 0;

// seen = 该实体当前已知的最大 rev；返回一个严格大于「墙钟 / 上次发出值 / seen」的新 rev。
export function tick(seen = 0): number {
    const wall = Date.now();
    last = Math.max(wall, last + 1, (seen || 0) + 1);
    return last;
}
