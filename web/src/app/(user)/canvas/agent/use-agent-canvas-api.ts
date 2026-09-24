"use client";

import { useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import type { AgentCanvasApi } from "./agent-ops";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "../types";

// 把画布页的状态包成助手能用的 API。
//
// 读一律走 ref（拿到的是此刻的真值，不是这次渲染闭包里的旧值）——
// 助手的一个回合可能跨好几秒、好几轮，期间用户还在操作画布，读闭包里的旧数组会算错坐标。
//
// 写一律传 updater 函数给 setState，绝不传新数组：
// stores/use-canvas-store.ts:68 stampNodes 会把「旧有新无」的节点落墓碑（跨设备真删），
// 所以助手只能 map 既有数组。这条在 agent-ops.ts 里也写了一遍，两边都要守。

export type AgentCanvasApiDeps = {
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    sizeRef: MutableRefObject<{ width: number; height: number }>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    /** 画布页自己的 createCanvasNode，保证新节点带上 nameSeq 等约定字段 */
    makeTextNode: (text: string, position: { x: number; y: number }, title?: string) => CanvasNodeData;
    /** 建一个待生成的图片/视频节点（不出图、不花钱） */
    makeGenerationNode: (type: "image" | "video", prompt: string, position: { x: number; y: number }, config?: { size?: string; quality?: string }) => CanvasNodeData;
    /** 跑生成：转调 handleGenerateNode */
    runGenerate: (nodeId: string, prompt?: string) => Promise<{ ok: boolean; message: string }>;
};

export function useAgentCanvasApi(deps: AgentCanvasApiDeps): AgentCanvasApi {
    const {
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        sizeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setViewport,
        makeTextNode,
        makeGenerationNode,
        runGenerate,
    } = deps;

    return useMemo<AgentCanvasApi>(
        () => ({
            getNodes: () => nodesRef.current,
            getConnections: () => connectionsRef.current,
            getSelectedNodeIds: () => selectedNodeIdsRef.current,
            getViewport: () => viewportRef.current,
            getViewportSize: () => sizeRef.current,
            setNodes: (updater) => setNodes((prev) => updater(prev)),
            setConnections: (updater) => setConnections((prev) => updater(prev)),
            setSelectedNodeIds: (ids) => setSelectedNodeIds(new Set(ids)),
            setViewport: (viewport) => setViewport(viewport),
            createTextNode: (text, position, title) => {
                const node = makeTextNode(text, position, title);
                setNodes((prev) => [...prev, node]);
                return node;
            },
            createGenerationNode: (type, prompt, position, config) => {
                const node = makeGenerationNode(type, prompt, position, config);
                setNodes((prev) => [...prev, node]);
                return node;
            },
            generateNode: (nodeId, prompt) => runGenerate(nodeId, prompt),
        }),
        [
            connectionsRef,
            makeGenerationNode,
            makeTextNode,
            nodesRef,
            runGenerate,
            selectedNodeIdsRef,
            setConnections,
            setNodes,
            setSelectedNodeIds,
            setViewport,
            sizeRef,
            viewportRef,
        ],
    );
}
