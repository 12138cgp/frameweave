import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "../types";

export const ConnectionPath = memo(function ConnectionPath({
    connection,
    from,
    to,
    active,
    onSelect,
    onDelete,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    onSelect: (id: string) => void;
    onDelete?: (id: string) => void;
    onContextMenu?: (id: string, event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [hovered, setHovered] = useState(false);
    // 离开延迟：曲线命中区窄，从线移向中点叉号时短暂滑出不立刻隐藏，便于点击
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);
    const handleEnter = () => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = null;
        setHovered(true);
    };
    const handleLeave = () => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setHovered(false), 200);
    };
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);
    const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
    // 三次贝塞尔在 t=0.5 处的点恰为首尾中点（控制点与首尾同 y、对称）
    const midX = (startX + endX) / 2;
    const midY = (startY + endY) / 2;
    const showDelete = Boolean(onDelete) && hovered;
    // 固定世界坐标尺寸：随画布缩放一起放大/缩小
    const radius = 13;
    const arm = 5;

    return (
        <g onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect(connection.id);
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(connection.id, event);
                }}
            />
            <path
                d={pathD}
                stroke={active ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={active ? 3 : 2}
                strokeOpacity={active ? 1 : 0.82}
                fill="none"
                style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none", transition: "stroke .2s ease, stroke-width .2s ease, stroke-opacity .2s ease" }}
            />
            {showDelete ? (
                // data-connection-id 必须有：画布 handlePointerDown 用它判定「非空白」，否则会当成点空白而开始平移并吞掉点击
                <g data-connection-id={connection.id} transform={`translate(${midX} ${midY})`} style={{ cursor: "pointer" }} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
                    {/* 透明命中圈在最底，pointerEvents:all 提供稳定可点区域 */}
                    <circle
                        r={radius + 6}
                        fill="transparent"
                        style={{ pointerEvents: "all", cursor: "pointer" }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            onDelete?.(connection.id);
                        }}
                    />
                    <circle r={radius} fill={theme.toolbar.panel} stroke={theme.node.activeStroke} strokeWidth={1.6} style={{ pointerEvents: "none" }} />
                    <line x1={-arm} y1={-arm} x2={arm} y2={arm} stroke={theme.node.activeStroke} strokeWidth={2} strokeLinecap="round" style={{ pointerEvents: "none" }} />
                    <line x1={-arm} y1={arm} x2={arm} y2={-arm} stroke={theme.node.activeStroke} strokeWidth={2} strokeLinecap="round" style={{ pointerEvents: "none" }} />
                </g>
            ) : null}
        </g>
    );
});

export function ActiveConnectionPath({ node, handle, mouseWorld, target }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
    const distance = Math.abs(snappedEndX - snappedStartX);
    const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

    return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" />;
}
