"use client";

import { useState } from "react";
import { Button, Checkbox, Modal } from "antd";
import { storageKey } from "@/constant/env";

// 3D 场景台使用说明（二级弹窗，打开场景台时自动显示一次）。
//
// 这份说明原本在场景台自己的「首页」里。但首页在嵌入场景下被整个隐藏了——它带着
// 实例的新建/切换/删除入口，而那些操作都会跟画布节点对不上（详见 canvas-stage-dialog 的注释）。
// 说明本身是有用的，所以搬到宿主侧来。
//
// ⚠️ 文案是从上游 src/App.tsx 的首页抄下来后**按本产品的用法改写**的，不是原样照搬：
// 上游第一步是「选场景台」，在这里不存在（每个画布节点就是一个固定的场景台）；
// 上游最后一步是「导出 MP4」，而在这里更常用的是把机位截图发回画布。
// 上游改版后这份文案不会自动跟着变，需要人工同步。

const GUIDE_DISMISS_KEY = storageKey("director-guide-dismissed-v1");

export function isStageGuideDismissed() {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(GUIDE_DISMISS_KEY) === "1";
    } catch {
        // 隐私模式下 localStorage 可能直接抛错。读不到就当没关过，大不了多显示一次。
        return false;
    }
}

function rememberStageGuideDismissed() {
    try {
        window.localStorage.setItem(GUIDE_DISMISS_KEY, "1");
    } catch {
        // 存不下就算了，不能因为记不住偏好而报错打断用户。
    }
}

const STEPS = [
    { no: "1", title: "摆人物和道具", desc: "从工具栏添加模型，选中后用 XYZ 三轴移动、旋转和缩放。" },
    { no: "2", title: "记录镜头", desc: "点「运镜 → 开始掌镜」，用 WASD 走位，每到一个满意的机位按 Enter 记一个轨迹点。" },
    { no: "3", title: "预演并取图", desc: "先用「看路线」检查轨迹，再用「看成片」预演；满意后把机位截图发回画布，会自动落成图片节点。" },
];

const PILOT_KEYS = [
    { key: "W A S D", action: "前进 / 左移 / 后退 / 右移" },
    { key: "Q / E", action: "镜头下降 / 上升" },
    { key: "移动鼠标", action: "转动镜头方向" },
    { key: "Enter", action: "保存或更新当前轨迹点" },
    { key: "Space", action: "播放 / 暂停" },
    { key: "Esc", action: "退出掌镜" },
];

const VIEW_KEYS = [
    { key: "鼠标左键拖动", action: "环绕观察场景" },
    { key: "鼠标右键拖动", action: "平移观察中心" },
    { key: "滚轮", action: "靠近 / 远离场景" },
];

export function CanvasStageGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [dontShowAgain, setDontShowAgain] = useState(false);

    const handleClose = () => {
        if (dontShowAgain) rememberStageGuideDismissed();
        onClose();
    };

    return (
        <Modal
            open={open}
            onCancel={handleClose}
            width={640}
            centered
            title="3D 场景台 · 怎么用"
            footer={
                <div className="flex items-center justify-between">
                    <Checkbox checked={dontShowAgain} onChange={(event) => setDontShowAgain(event.target.checked)}>
                        以后不再显示
                    </Checkbox>
                    <Button type="primary" onClick={handleClose}>
                        开始使用
                    </Button>
                </div>
            }
        >
            <div className="flex flex-col gap-4">
                <p className="text-xs opacity-60">不用先学复杂的 3D 软件，按下面三步走就行。这个场景台绑定当前画布节点，改动会自动保存。</p>

                <section className="flex flex-col gap-2">
                    {STEPS.map((step) => (
                        <div key={step.no} className="flex gap-2.5 rounded-lg border border-black/5 px-3 py-2 dark:border-white/10">
                            <span className="flex size-5 flex-none items-center justify-center rounded-full bg-black/5 text-[11px] font-medium dark:bg-white/10">{step.no}</span>
                            <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-sm font-medium">{step.title}</span>
                                <span className="text-xs leading-relaxed opacity-65">{step.desc}</span>
                            </div>
                        </div>
                    ))}
                </section>

                <KeyTable title="掌镜模式（录镜头时）" rows={PILOT_KEYS} />
                <KeyTable title="普通导演视角（摆场景时）" rows={VIEW_KEYS} />

                <p className="rounded-lg bg-black/5 px-3 py-2 text-xs leading-relaxed opacity-70 dark:bg-white/10">
                    提示：机位的「视野角度 (FOV)」只有切到「第一视角」或「看成片」才看得出变化——导演视角用的是自由观察相机，在那儿拖 FOV 画面不会有任何反应。
                </p>
            </div>
        </Modal>
    );
}

function KeyTable({ title, rows }: { title: string; rows: { key: string; action: string }[] }) {
    return (
        <section className="flex flex-col gap-1.5">
            <span className="text-xs font-medium opacity-70">{title}</span>
            <div className="flex flex-col gap-1">
                {rows.map((row) => (
                    <div key={row.key} className="flex items-center justify-between gap-4 text-xs">
                        <kbd className="rounded border border-[#CBD5E1] bg-[#F8FAFC] px-2 py-1 font-mono text-[11px] leading-none text-[#3B4A63] dark:border-[#2B3854] dark:bg-[#1C2742] dark:text-[#CBD5E1]">{row.key}</kbd>
                        <span className="flex-1 text-right opacity-65">{row.action}</span>
                    </div>
                ))}
            </div>
        </section>
    );
}
