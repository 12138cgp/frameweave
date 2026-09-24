"use client";

import { useEffect, useMemo, useState } from "react";
import { App, Button, Modal, Tag } from "antd";
import { Keyboard, RotateCcw } from "@/components/icons";

import { useShortcutStore } from "@/stores/use-shortcut-store";
import { PAN_CANVAS_COMMAND_ID, SHORTCUT_COMMANDS, SHORTCUT_GROUP_LABELS, eventToChord, findChordConflict, formatChord, isMacPlatform, isValidChord, isValidPanChord, resolveShortcutChords, type ShortcutCommand, type ShortcutCommandId } from "@/constant/shortcuts";

// 快捷键设置。既是说明书也是编辑器——三份互相矛盾的手写说明就是被这个页面取代的。
//
// 录制的实现要点：录制期间必须**吃掉**所有按键（preventDefault + stopPropagation），
// 否则用户为了绑「⌘S」按下去，浏览器会弹出保存对话框；按「⌘A」会全选整个页面。

type RecordingState = { commandId: ShortcutCommandId; index: number } | null;

// 鼠标操作是写死在交互里的，不做自定义，但用户需要知道。
//
// ⚠️ 这份列表是照着实现逐条核对过的。被取代的三份手写说明里至少有两处是错的：
// 写着「Ctrl / Cmd + 拖动 → 框选」，而实际上**框选不需要任何修饰键**（左键拖空白即框选），
// Cmd/Ctrl + 点击节点是「追加/取消选中」；另有一份标着「⌘ + / ⌘ −」缩放，而那两个键从未实现过。
const MOUSE_ACTIONS = [
    { label: "左键拖动空白处", value: "框选节点" },
    { label: "Shift + 框选 / 点击", value: "追加选择" },
    { label: "⌘ / Ctrl + 点击节点", value: "切换该节点的选中" },
    { label: "Alt + 拖动节点", value: "临时关闭对齐吸附" },
    { label: "中键拖动", value: "平移视图" },
    { label: "滚轮 / 触摸板捏合", value: "缩放画布" },
    { label: "拖入图片 / 视频 / 音频", value: "上传到画布" },
];

export function ShortcutSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const bindings = useShortcutStore((state) => state.bindings);
    const setChords = useShortcutStore((state) => state.setChords);
    const resetCommand = useShortcutStore((state) => state.resetCommand);
    const resetAll = useShortcutStore((state) => state.resetAll);
    const [recording, setRecording] = useState<RecordingState>(null);
    const [mac, setMac] = useState(false);

    // 平台判断放进 effect：服务端渲染时没有 navigator，直接在渲染期读会导致首屏与客户端不一致。
    useEffect(() => setMac(isMacPlatform()), []);

    const chords = useMemo(() => resolveShortcutChords(bindings), [bindings]);

    // 关闭弹窗时一定要退出录制态，否则下次打开还挂在上一次那条上。
    useEffect(() => {
        if (!open) setRecording(null);
    }, [open]);

    useEffect(() => {
        if (!recording) return;
        const handler = (event: KeyboardEvent) => {
            // 录制期间独占键盘：不吃掉的话 ⌘S 会触发浏览器保存、⌘A 会全选页面。
            event.preventDefault();
            event.stopPropagation();

            if (event.key === "Escape") {
                setRecording(null);
                return;
            }

            const chord = eventToChord(event);
            // 只按住修饰键时 eventToChord 返回空串——继续等真正的主键，不要判错。
            if (!chord) return;

            const isPan = recording.commandId === PAN_CANVAS_COMMAND_ID;
            const check = isPan ? isValidPanChord(chord) : isValidChord(chord);
            if (!check.ok) {
                message.warning(check.reason);
                return;
            }

            const conflict = findChordConflict(chords, chord, recording.commandId);
            if (conflict) {
                // 说清楚跟谁撞了。只说「快捷键冲突」的话用户得自己一条条找。
                message.warning(`${formatChord(chord, mac)} 已经被「${conflict.label}」占用了`);
                return;
            }

            const current = chords[recording.commandId] || [];
            const next = [...current];
            next[recording.index] = chord;
            setChords(recording.commandId, next);
            setRecording(null);
            message.success(`已设为 ${formatChord(chord, mac)}`);
        };
        // 捕获阶段：要抢在 antd Modal 自己的 Esc 处理和画布监听之前拿到按键。
        window.addEventListener("keydown", handler, true);
        return () => window.removeEventListener("keydown", handler, true);
    }, [recording, chords, mac, setChords, message]);

    const removeChord = (command: ShortcutCommand, index: number) => {
        const current = chords[command.id] || [];
        const next = current.filter((_, i) => i !== index);
        setChords(command.id, next);
    };

    const addChord = (command: ShortcutCommand) => {
        const current = chords[command.id] || [];
        setRecording({ commandId: command.id, index: current.length });
    };

    const grouped = useMemo(() => {
        const groups: { group: ShortcutCommand["group"]; commands: ShortcutCommand[] }[] = [];
        for (const command of SHORTCUT_COMMANDS) {
            const existing = groups.find((item) => item.group === command.group);
            if (existing) existing.commands.push(command);
            else groups.push({ group: command.group, commands: [command] });
        }
        return groups;
    }, []);

    const modifierHint = mac ? "⌘ / ⌥ / ⇧" : "Ctrl / Alt / Shift";

    return (
        <Modal
            open={open}
            onCancel={onClose}
            title={
                <span className="flex items-center gap-2">
                    <Keyboard className="size-4" />
                    快捷键
                </span>
            }
            width={620}
            footer={[
                <Button key="reset" icon={<RotateCcw className="size-3.5" />} onClick={() => {
                    resetAll();
                    message.success("已全部恢复默认");
                }}>
                    全部恢复默认
                </Button>,
                <Button key="close" type="primary" onClick={onClose}>
                    完成
                </Button>,
            ]}
        >
            <div className="flex flex-col gap-4">
                <p className="text-xs opacity-60">点击键位即可重新录制，按 Esc 取消录制。设置会跟着账号同步到你的其它设备。</p>
                {grouped.map((section) => (
                    <section key={section.group} className="flex flex-col gap-2">
                        <span className="text-xs font-medium opacity-70">{SHORTCUT_GROUP_LABELS[section.group]}</span>
                        {section.commands.map((command) => (
                            <CommandRow
                                key={command.id}
                                command={command}
                                chords={chords[command.id] || []}
                                mac={mac}
                                recording={recording}
                                onRecord={(index) => setRecording({ commandId: command.id, index })}
                                onAdd={() => addChord(command)}
                                onRemove={(index) => removeChord(command, index)}
                                onReset={() => {
                                    resetCommand(command.id);
                                    message.success(`「${command.label}」已恢复默认`);
                                }}
                            />
                        ))}
                    </section>
                ))}
                <section className="flex flex-col gap-2">
                    <span className="text-xs font-medium opacity-70">鼠标操作（固定）</span>
                    <div className="flex flex-col gap-1 rounded-lg border border-black/5 px-3 py-2 text-xs dark:border-white/10">
                        {MOUSE_ACTIONS.map((action) => (
                            <div key={action.label} className="flex items-center justify-between gap-4">
                                <span className="opacity-80">{action.label}</span>
                                <span className="flex-none opacity-50">{action.value}</span>
                            </div>
                        ))}
                    </div>
                </section>

                <p className="text-xs opacity-50">
                    Esc（取消 / 关闭浮层）是固定的，不能修改——画布里的弹窗也认这个键，改掉会出现两套行为。
                    自定义键位请至少配合 {modifierHint} 使用，否则在画布上打字时会误触发。
                </p>
            </div>
        </Modal>
    );
}

function CommandRow({
    command,
    chords,
    mac,
    recording,
    onRecord,
    onAdd,
    onRemove,
    onReset,
}: {
    command: ShortcutCommand;
    chords: string[];
    mac: boolean;
    recording: RecordingState;
    onRecord: (index: number) => void;
    onAdd: () => void;
    onRemove: (index: number) => void;
    onReset: () => void;
}) {
    const isDefault = chords.length === command.defaultChords.length && chords.every((chord, index) => chord === command.defaultChords[index]);
    // 平移是按住生效的，只能有一个键；其余命令允许绑多个（重做历来就有两种习惯键位）。
    const allowMultiple = command.id !== PAN_CANVAS_COMMAND_ID;
    const canAdd = allowMultiple && chords.length < 3;

    return (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-black/5 px-3 py-2 dark:border-white/10">
            <div className="flex min-w-0 flex-col">
                <span className="text-sm">{command.label}</span>
                <span className="truncate text-xs opacity-50">{command.hint}</span>
            </div>
            <div className="flex flex-none items-center gap-1.5">
                {chords.map((chord, index) => {
                    const isRecording = recording?.commandId === command.id && recording.index === index;
                    return <ChordButton key={`${chord}-${index}`} chord={chord} mac={mac} recording={isRecording} onClick={() => onRecord(index)} onRemove={() => onRemove(index)} removable={chords.length > 1} />;
                })}
                {chords.length === 0 ? <ChordButton chord="" mac={mac} recording={recording?.commandId === command.id} onClick={() => onRecord(0)} onRemove={() => undefined} removable={false} /> : null}
                {canAdd ? (
                    <Button size="small" type="text" onClick={onAdd}>
                        + 备用键
                    </Button>
                ) : null}
                {isDefault ? null : (
                    <Button size="small" type="text" title="恢复这一条的默认键位" onClick={onReset}>
                        重置
                    </Button>
                )}
            </div>
        </div>
    );
}

function ChordButton({ chord, mac, recording, onClick, onRemove, removable }: { chord: string; mac: boolean; recording: boolean; onClick: () => void; onRemove: () => void; removable: boolean }) {
    let label = formatChord(chord, mac);
    if (!label) label = "未设置";
    if (recording) label = "按下新的组合…";
    // 录制态用蓝色边框，未设置用虚线，区分开
    let className = "cursor-pointer select-none font-mono text-xs";
    if (recording) className += " border-[#3B82F6] text-[#3B82F6]";
    return (
        <Tag className={className} onClick={onClick} closable={removable && !recording} onClose={(event) => {
            event.preventDefault();
            onRemove();
        }}>
            {label}
        </Tag>
    );
}
