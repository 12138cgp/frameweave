// 当前正在跑的助手回合。
//
// 为什么需要它：助手要调「生图/生视频」时，走的是 handleGenerateNode → requestGeneration
// 这条**和用户手动点生成完全相同**的路径（这是刻意的，见 agent-ops 的注释）。
// 但正因为完全相同，后端就分不出这一单是人点的还是助手点的，
// 也就没法给助手单独设「一个回合最多花多少点数」的闸。
//
// 所以在这里放一个模块级的"当前回合"，由 agent-loop 在回合开始/结束时设置，
// 由 services/api/* 的请求头构建函数读取。一个标签页同一时刻只可能有一个助手回合在跑
// （面板在回合结束前不让再发），所以不会串。
//
// ⚠️ 必须在 finally 里清掉，否则回合结束后用户手动点的生成会被算进助手预算、
// 甚至被闸门拒掉。

let currentTurnId = "";

export function setCurrentAgentTurn(turnId: string) {
    currentTurnId = turnId || "";
}

export function clearCurrentAgentTurn() {
    currentTurnId = "";
}

/** 给请求头加上助手回合标记。不在助手回合里时返回空对象，普通请求一个字节都不变。 */
export function agentTurnHeader(): Record<string, string> {
    if (!currentTurnId) return {};
    return { "X-Agent-Turn-Id": currentTurnId };
}
