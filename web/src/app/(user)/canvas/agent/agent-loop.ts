import { parseToolArguments, requestAgentTurn, type AgentChatMessage, type AgentToolCall } from "@/services/api/agent-chat";
import type { AiConfig } from "@/stores/use-config-store";

import { AGENT_SYSTEM_PROMPT, findAgentTool, needsConfirm, toOpenAiTools } from "./agent-tools";
import { runAgentOp, startJournal, type AgentCanvasApi, type AgentJournal } from "./agent-ops";
import { clearCurrentAgentTurn, setCurrentAgentTurn } from "@/services/agent-turn-context";

// 画布助手的对话循环。
//
// 一个「回合」= 用户说一句话，到助手把该做的都做完为止。中间可能来回好几轮：
//   模型说要调工具 → 我们执行 → 把结果塞回 messages → 再问模型 → …… 直到模型不再要求调工具。
//
// 三道闸门，缺一不可：
//  1. 轮次上限（前端 MAX_ROUNDS）——防止模型自己绕圈子把 token 烧光。
//  2. 后端也有一份（X-Agent-Turn-Id / X-Agent-Round 头）——前端这道只是 UX，
//     用户改改前端就没了，真正的闸必须在服务端。
//  3. 写类工具要用户点确认。money 类工具第一阶段不存在，二期加进来时强制确认、不给关闭开关。
//
// 平铺 if/return，不写嵌套三元（bun 1.3.13 构建期 SIGILL 前科）。

const MAX_ROUNDS = 8;

export type AgentEvent =
    | { kind: "assistant-delta"; text: string }
    | { kind: "assistant-done"; text: string }
    | { kind: "tool-start"; callId: string; name: string; label: string; args: Record<string, unknown> }
    | { kind: "tool-done"; callId: string; ok: boolean; summary: string }
    | { kind: "tool-rejected"; callId: string; name: string }
    | { kind: "round"; index: number; max: number }
    | { kind: "error"; message: string };

export type ConfirmRequest = {
    callId: string;
    name: string;
    /** 给用户看的一句话：「将移动 6 个节点」 */
    label: string;
    args: Record<string, unknown>;
};

export type AgentRunOptions = {
    config: AiConfig;
    api: AgentCanvasApi;
    /** 用户这一句 */
    userText: string;
    /** 之前的对话（不含 system，循环自己加） */
    history: AgentChatMessage[];
    /** 写类工具是否需要确认。read 恒不需要，money 恒需要。 */
    confirmWrites: boolean;
    /** 弹确认卡片，返回用户是否批准 */
    onConfirm: (req: ConfirmRequest) => Promise<boolean>;
    onEvent: (event: AgentEvent) => void;
    signal?: AbortSignal;
};

export type AgentRunResult = {
    /** 追加到历史里的消息（含 assistant 与 tool 轮） */
    appended: AgentChatMessage[];
    journal: AgentJournal;
    rounds: number;
    stoppedBy: "done" | "max-rounds" | "aborted" | "error" | "rejected";
    usageTotal: number;
};

function toolLabel(name: string, args: Record<string, unknown>) {
    const tool = findAgentTool(name);
    if (!tool) return name;
    try {
        return tool.describe(args);
    } catch {
        return name;
    }
}

/** 工具结果回给模型时压一压：别把几十个节点的完整 JSON 反复塞进上下文。 */
function compactResult(payload: Record<string, unknown>) {
    const text = JSON.stringify(payload);
    if (text.length <= 6000) return text;
    return text.slice(0, 6000) + '…(结果过长已截断，请用更小的 limit 或更具体的条件重新查询)"}';
}

export async function runAgentTurn(opts: AgentRunOptions): Promise<AgentRunResult> {
    const { config, api, onEvent, signal } = opts;
    const journal = startJournal(api.getNodes());
    const appended: AgentChatMessage[] = [];
    const tools = toOpenAiTools();
    // 同一个回合共用一个 id，后端据它数轮次
    const turnId = "t" + String(Date.now()) + Math.random().toString(36).slice(2, 8);

    const messages: AgentChatMessage[] = [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        ...opts.history,
        { role: "user", content: opts.userText },
    ];
    appended.push({ role: "user", content: opts.userText });

    let rounds = 0;
    let usageTotal = 0;
    let stoppedBy: AgentRunResult["stoppedBy"] = "done";

    // 标记「现在在助手回合里」：这之后所有生成请求的请求头都会带上 turnId，
    // 后端据它做单回合点数预算。⚠️ 必须在 finally 里清，否则回合结束后
    // 用户手动点的生成会被算进助手预算、甚至被闸门拒掉。
    setCurrentAgentTurn(turnId);
    try {
    while (rounds < MAX_ROUNDS) {
        if (signal && signal.aborted) {
            stoppedBy = "aborted";
            break;
        }
        rounds += 1;
        onEvent({ kind: "round", index: rounds, max: MAX_ROUNDS });

        let turn;
        try {
            turn = await requestAgentTurn(
                config,
                messages,
                tools,
                (text) => onEvent({ kind: "assistant-delta", text }),
                signal,
                { turnId, round: rounds },
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : "助手请求失败";
            onEvent({ kind: "error", message });
            stoppedBy = "error";
            break;
        }

        if (turn.usage && typeof turn.usage.total_tokens === "number") usageTotal += turn.usage.total_tokens;

        const assistantMsg: AgentChatMessage = { role: "assistant", content: turn.content };
        if (turn.toolCalls.length) assistantMsg.tool_calls = turn.toolCalls;
        messages.push(assistantMsg);
        appended.push(assistantMsg);

        if (!turn.toolCalls.length) {
            // 空响应也要说一声。模型既没说话也没调工具时，界面上什么气泡都不会出现，
            // 用户只会觉得「点了没反应」——这是最难排查的一种失败。
            if (!turn.content.trim()) {
                onEvent({ kind: "error", message: "模型没有返回任何内容。可能是这个模型不支持工具调用，或者你的分组没开通它。" });
            }
            onEvent({ kind: "assistant-done", text: turn.content });
            stoppedBy = "done";
            break;
        }

        let rejected = false;
        for (const call of turn.toolCalls) {
            const result = await runOneCall(call, opts, journal);
            messages.push(result.message);
            appended.push(result.message);
            if (result.rejected) rejected = true;
        }
        if (rejected) {
            // 用户拒绝了某个操作：不再继续下一轮，避免模型换个说法再来一次
            stoppedBy = "rejected";
            break;
        }
        if (rounds >= MAX_ROUNDS) {
            stoppedBy = "max-rounds";
            onEvent({ kind: "error", message: "本回合已达 " + String(MAX_ROUNDS) + " 轮上限，先停下。你可以让我接着做。" });
        }
    }

    } finally {
        clearCurrentAgentTurn();
    }

    return { appended, journal, rounds, stoppedBy, usageTotal };
}

async function runOneCall(
    call: AgentToolCall,
    opts: AgentRunOptions,
    journal: AgentJournal,
): Promise<{ message: AgentChatMessage; rejected: boolean }> {
    const name = call.function.name;
    const args = parseToolArguments(call.function.arguments);

    if (args === null) {
        opts.onEvent({ kind: "tool-done", callId: call.id, ok: false, summary: "参数不是合法 JSON" });
        return {
            message: { role: "tool", tool_call_id: call.id, content: '{"error":"arguments 不是合法 JSON，请重新生成"}' },
            rejected: false,
        };
    }

    const tool = findAgentTool(name);
    if (!tool) {
        opts.onEvent({ kind: "tool-done", callId: call.id, ok: false, summary: "不认识的工具" });
        return {
            message: { role: "tool", tool_call_id: call.id, content: '{"error":"没有这个工具"}' },
            rejected: false,
        };
    }

    const label = toolLabel(name, args);
    opts.onEvent({ kind: "tool-start", callId: call.id, name, label, args });

    if (needsConfirm(name, opts.confirmWrites)) {
        const approved = await opts.onConfirm({ callId: call.id, name, label, args });
        if (!approved) {
            opts.onEvent({ kind: "tool-rejected", callId: call.id, name });
            return {
                message: { role: "tool", tool_call_id: call.id, content: '{"error":"用户拒绝了这次操作，请停下并询问他想怎么做"}' },
                rejected: true,
            };
        }
    }

    let result;
    try {
        result = await runAgentOp(name, args, opts.api, journal);
    } catch (error) {
        const message = error instanceof Error ? error.message : "执行失败";
        opts.onEvent({ kind: "tool-done", callId: call.id, ok: false, summary: message });
        return {
            message: { role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) },
            rejected: false,
        };
    }

    let summary = "完成";
    if (!result.ok) summary = String(result.payload.error || "失败");
    opts.onEvent({ kind: "tool-done", callId: call.id, ok: result.ok, summary });
    return {
        message: { role: "tool", tool_call_id: call.id, content: compactResult(result.payload) },
        rejected: false,
    };
}

export { MAX_ROUNDS };
