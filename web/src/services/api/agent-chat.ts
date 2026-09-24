import axios from "axios";

import { attachTraceId, readResponseTraceId } from "@/services/api/trace";
import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

// 画布助手专用的流式 chat 客户端。
//
// 为什么不复用 services/api/image.ts 的 requestImageQuestion：
// 它的 parseStreamChunk(:251) 只取 choices[0].delta.content，
// **tool_calls 的增量分片会被整个丢掉** —— 而助手全靠这个分片过日子。
//
// tool_calls 的分片形状（对 deepseek-v4-flash-260425 实测）：
//   第 1 片： [{index:0, id:"call_xxx", type:"function", function:{name:"canvas_move_nodes", arguments:""}}]
//   后续片： [{index:0, id:"",          function:{name:"", arguments:"{\"moves\": [{"}}]
// 即：name 和 id 只在第一片给，之后每片只带 arguments 的一小段字符串，
// 必须**按 index 累加拼接**，全部收完才是一个合法 JSON。中途解析必然失败。
//
// 全文写平铺 if/return，不用嵌套三元、不在模板串里调函数
//（本项目 bun 1.3.13 在这两种写法上有构建期 SIGILL 前科）。

export type AgentChatMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    // assistant 轮次里模型要求调用的工具
    tool_calls?: AgentToolCall[];
    // role=tool 时，这条结果对应哪次调用
    tool_call_id?: string;
};

export type AgentToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

export type AgentChatResult = {
    content: string;
    toolCalls: AgentToolCall[];
    finishReason: string;
    traceId: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type ToolCallSlot = { id: string; name: string; args: string };

function aiApiUrl(config: AiConfig, path: string) {
    if (config.channelMode === "remote") return "/api/v1" + path;
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.channelMode === "remote") {
        const token = useUserStore.getState().token;
        if (token) headers.Authorization = "Bearer " + token;
        return headers;
    }
    if (config.apiKey) headers.Authorization = "Bearer " + config.apiKey;
    return headers;
}

// 把一段 SSE 文本喂进累加器。返回是否已收到 [DONE]。
function consumeChunk(
    chunk: string,
    slots: Map<number, ToolCallSlot>,
    state: { content: string; finishReason: string; usage?: AgentChatResult["usage"] },
    onDelta?: (text: string) => void,
) {
    let done = false;
    for (const block of chunk.split("\n\n")) {
        let data = "";
        for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) data = line.slice(6);
            else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (!data) continue;
        if (data === "[DONE]") {
            done = true;
            continue;
        }
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
            continue;
        }
        const usage = parsed.usage as AgentChatResult["usage"] | undefined;
        if (usage) state.usage = usage;
        const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
        if (!choices || !choices.length) continue;
        const choice = choices[0];
        const finish = choice.finish_reason;
        if (typeof finish === "string" && finish) state.finishReason = finish;
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        const text = delta.content;
        if (typeof text === "string" && text) {
            state.content += text;
            if (onDelta) onDelta(text);
        }

        const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (!tcs) continue;
        for (const tc of tcs) {
            const index = typeof tc.index === "number" ? tc.index : 0;
            let slot = slots.get(index);
            if (!slot) {
                slot = { id: "", name: "", args: "" };
                slots.set(index, slot);
            }
            if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
            const fn = tc.function as Record<string, unknown> | undefined;
            if (!fn) continue;
            if (typeof fn.name === "string" && fn.name) slot.name = fn.name;
            if (typeof fn.arguments === "string" && fn.arguments) slot.args += fn.arguments;
        }
    }
    return done;
}

/**
 * 发一轮带工具的对话。
 * onDelta 只回调正文增量（给面板做打字机效果）；工具调用要等整轮结束才完整。
 */
export type AgentTurnGate = { turnId: string; round: number };

export async function requestAgentTurn(
    config: AiConfig,
    messages: AgentChatMessage[],
    tools: unknown[],
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
    gate?: AgentTurnGate,
): Promise<AgentChatResult> {
    const model = (config.textModel || config.model || "").trim();
    const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        // 让上游把用量回传，用于后端计费与面板显示（与 image.ts 同一做法）
        stream_options: { include_usage: true },
    };
    if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
    }

    const slots = new Map<number, ToolCallSlot>();
    const state = { content: "", finishReason: "", usage: undefined as AgentChatResult["usage"] };
    let traceId = "";
    let buffer = "";
    let processed = 0;

    try {
        // 闸门头：后端据 turnId 数这一个回合已经问了几轮、花了多少，超了直接拒。
        // 前端 agent-loop 里那道轮次上限只是 UX——用户改改前端就没了，真正的闸在服务端。
        const headers = aiHeaders(config);
        if (gate) {
            headers["X-Agent-Turn-Id"] = gate.turnId;
            headers["X-Agent-Round"] = String(gate.round);
        }
        const response = await axios.post(aiApiUrl(config, "/chat/completions"), body, {
            headers,
            responseType: "text",
            signal,
            onDownloadProgress: (event) => {
                const target = event.event?.target as { responseText?: string } | undefined;
                const full = target?.responseText || "";
                if (full.length <= processed) return;
                buffer += full.slice(processed);
                processed = full.length;
                // 只处理完整的事件块，残段留在 buffer 里等下一次
                const lastBreak = buffer.lastIndexOf("\n\n");
                if (lastBreak < 0) return;
                const ready = buffer.slice(0, lastBreak + 2);
                buffer = buffer.slice(lastBreak + 2);
                consumeChunk(ready, slots, state, onDelta);
            },
        });
        traceId = readResponseTraceId(response.headers);
        // 收尾：把 buffer 里剩下的残段也过一遍
        if (buffer) consumeChunk(buffer, slots, state, onDelta);
        // 某些渠道不走 onDownloadProgress（一次性返回），这里兜一遍全文
        if (!state.content && !slots.size && typeof response.data === "string") {
            consumeChunk(response.data, slots, state, onDelta);
        }
        // ⚠️ 到这里还是空的，八成不是「模型没话说」，而是后端用 Fail() 拒了。
        // 这个项目的 Fail() 返回 **HTTP 200 + {code:1, message}**，不是 4xx，
        // axios 不会抛、SSE 里也没有 data: 行，一路静默到底 —— 用户看到的就是「点了没反应」。
        // 所以这里必须把响应体当业务错误信封解一遍。
        if (!state.content && !slots.size && typeof response.data === "string") {
            const raw = response.data.trim();
            if (raw.startsWith("{")) {
                let envelope: { code?: number; message?: string; msg?: string } | null = null;
                try {
                    envelope = JSON.parse(raw) as { code?: number; message?: string; msg?: string };
                } catch {
                    envelope = null;
                }
                if (envelope && typeof envelope.code === "number" && envelope.code !== 0) {
                    throw new Error(envelope.message || envelope.msg || "助手请求被拒绝");
                }
            }
        }
    } catch (error) {
        throw attachTraceId(error, "助手请求失败");
    }

    const toolCalls: AgentToolCall[] = [];
    const indexes = Array.from(slots.keys()).sort((a, b) => a - b);
    for (const i of indexes) {
        const slot = slots.get(i);
        if (!slot || !slot.name) continue;
        toolCalls.push({
            id: slot.id || "call_" + String(i),
            type: "function",
            function: { name: slot.name, arguments: slot.args || "{}" },
        });
    }

    return {
        content: state.content,
        toolCalls,
        finishReason: state.finishReason || (toolCalls.length ? "tool_calls" : "stop"),
        traceId,
        usage: state.usage,
    };
}

/** 把模型给的 arguments 字符串解析成对象；解析不了就返回 null，由调用方回报错给模型重试。 */
export function parseToolArguments(raw: string): Record<string, unknown> | null {
    if (!raw) return {};
    try {
        const value = JSON.parse(raw) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
        return null;
    } catch {
        return null;
    }
}
