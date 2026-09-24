// 快捷键注册表 —— 全站快捷键的**单一数据源**。
//
// 在这之前，快捷键散在三个地方各写各的：canvas-client-page 的一条 if 链、画布组件里
// 单独监听的空格、以及三份手写的「快捷键说明」面板。三份说明和实现对不上（工具栏标着
// ⌘+/⌘− 缩放但根本没实现、说明里写「Ctrl+拖动=框选」而实际框选不需要修饰键），
// 因为它们本来就没有共同的来源。
//
// 所以做「自定义快捷键」的第一步不是加设置界面，而是把「有哪些命令、默认绑什么键」
// 收成这一张表：键盘监听按它分发、说明面板按它渲染、设置界面按它编辑。
// 加一个命令只改这里，三处自动跟上。

export type ShortcutCommandId = "undo" | "redo" | "selectAll" | "copy" | "paste" | "delete" | "panCanvas";

export type ShortcutCommand = {
    id: ShortcutCommandId;
    label: string;
    // hint 在设置界面里作为副标题，说明这个命令到底干什么。
    hint: string;
    // defaultChords 默认键位。允许多个：重做历来就有 ⌘⇧Z 和 ⌘Y 两种习惯，删除有 Delete 和 Backspace。
    defaultChords: string[];
    group: "edit" | "canvas";
};

// SHORTCUT_COMMANDS 可自定义的命令全集。
//
// ⚠️ Escape 刻意不在这张表里。它同时被 antd 的 Modal 消费（全站没有一处传 keyboard={false}），
// 用户如果把「取消」改成别的键，画布里的裁剪/蒙版/标注等弹窗仍然只认 Escape，
// 两套行为会不一致，严重时用户会遇到「浮层关不掉」。所以它保持固定。
export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
    { id: "undo", label: "撤销", hint: "撤回上一步画布操作", defaultChords: ["mod+z"], group: "edit" },
    { id: "redo", label: "重做", hint: "恢复被撤销的操作", defaultChords: ["mod+shift+z", "mod+y"], group: "edit" },
    { id: "selectAll", label: "全选节点", hint: "选中当前画布的全部节点", defaultChords: ["mod+a"], group: "edit" },
    { id: "copy", label: "复制", hint: "复制选中的节点", defaultChords: ["mod+c"], group: "edit" },
    { id: "paste", label: "粘贴", hint: "粘贴节点，或粘贴系统剪贴板里的图片和文字", defaultChords: ["mod+v"], group: "edit" },
    { id: "delete", label: "删除", hint: "删除选中的节点；没有选中节点时删除选中的连线", defaultChords: ["delete", "backspace"], group: "edit" },
    { id: "panCanvas", label: "平移画布（按住）", hint: "按住这个键再拖动鼠标左键即可平移画布", defaultChords: ["space"], group: "canvas" },
];

// PAN_CANVAS_COMMAND_ID 平移是唯一一个「按住生效」的命令：它要同时监听按下和抬起，
// 且只能绑单个不带修饰键的键。设置界面和监听器都要特殊对待，抽成常量避免各处写字符串。
export const PAN_CANVAS_COMMAND_ID: ShortcutCommandId = "panCanvas";

export const SHORTCUT_GROUP_LABELS: Record<ShortcutCommand["group"], string> = {
    edit: "编辑",
    canvas: "画布",
};

export type ShortcutBinding = {
    // id 与 ShortcutCommandId 相同。叫 id 是因为同步用的 mergeById 靠这个字段索引，
    // 没有 id 的条目会被直接丢弃。
    id: string;
    chords: string[];
    // updatedAt 跨设备合并的依据（后写的赢）。改动时必须显式刷新，别指望它自己更新。
    updatedAt: string;
};

// isMacPlatform 判断是否 Mac。
//
// 之前全项目没有这个判断：键位提示一律硬写成「⌘ Z」，Windows 用户看到的也是 ⌘。
// 做自定义之后这个问题会放大——用户按下 Ctrl+Z 录进去，界面却显示 ⌘Z，没法确认自己按对了。
//
// userAgentData.platform 是新标准，navigator.platform 已废弃但覆盖面更广，两个都试。
// 服务端渲染时没有 navigator，返回 false（非 Mac）作为安全默认。
export function isMacPlatform() {
    if (typeof navigator === "undefined") return false;
    const data = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = data.userAgentData?.platform || navigator.platform || "";
    return /mac/i.test(platform);
}

// —— 键位表示 ——
//
// 内部一律用规范化的小写字符串，如 "mod+shift+z"、"delete"、"space"。
// 其中 **mod** 是跨平台抽象：Mac 上是 ⌘、Windows/Linux 上是 Ctrl。
// 这与既有实现一致——原来的判断就是 `event.metaKey || event.ctrlKey`，两个键一视同仁。
// 存进云端的也是 mod 形式，所以同一个账号在 Mac 和 Windows 之间同步不会串键。

const MODIFIER_ORDER = ["mod", "alt", "shift"];

// normalizeKeyName 把 KeyboardEvent.key 归一成表里用的名字。
function normalizeKeyName(rawKey: string) {
    const key = (rawKey || "").toLowerCase();
    if (key === " " || key === "spacebar") return "space";
    if (key === "esc") return "escape";
    if (key === "del") return "delete";
    if (key === "arrowup") return "up";
    if (key === "arrowdown") return "down";
    if (key === "arrowleft") return "left";
    if (key === "arrowright") return "right";
    return key;
}

// eventToChord 把一次按键转成规范化字符串；只按下修饰键本身时返回空串。
export function eventToChord(event: KeyboardEvent): string {
    const key = normalizeKeyName(event.key);
    // 只按住修饰键不构成一个键位，否则用户刚按下 ⌘ 就会被录进去。
    if (key === "meta" || key === "control" || key === "shift" || key === "alt") return "";
    const parts: string[] = [];
    if (event.metaKey || event.ctrlKey) parts.push("mod");
    if (event.altKey) parts.push("alt");
    if (event.shiftKey) parts.push("shift");
    parts.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
    parts.push(key);
    return parts.join("+");
}

// parseChord 拆出修饰键与主键，供显示与校验使用。
export function parseChord(chord: string) {
    const parts = (chord || "").toLowerCase().split("+").filter(Boolean);
    const key = parts[parts.length - 1] || "";
    return {
        mod: parts.includes("mod"),
        alt: parts.includes("alt"),
        shift: parts.includes("shift"),
        key,
    };
}

const KEY_DISPLAY_NAMES: Record<string, string> = {
    space: "空格",
    delete: "Delete",
    backspace: "Backspace",
    escape: "Esc",
    enter: "Enter",
    tab: "Tab",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
};

// formatChord 把键位渲染成给人看的样子，按平台区分。
// Mac：「⌘ ⇧ Z」；Windows/Linux：「Ctrl + Shift + Z」。
export function formatChord(chord: string, mac: boolean) {
    if (!chord) return "";
    const parsed = parseChord(chord);
    const parts: string[] = [];
    if (parsed.mod) parts.push(mac ? "⌘" : "Ctrl");
    if (parsed.alt) parts.push(mac ? "⌥" : "Alt");
    if (parsed.shift) parts.push(mac ? "⇧" : "Shift");
    const display = KEY_DISPLAY_NAMES[parsed.key] || parsed.key.toUpperCase();
    parts.push(display);
    if (mac) return parts.join(" ");
    return parts.join(" + ");
}

export function formatChords(chords: string[], mac: boolean) {
    return chords.map((chord) => formatChord(chord, mac)).join(" 或 ");
}

// isValidChord 校验一个键位能不能用。
//
// 拒绝三类：空的；单独一个普通字母/数字（没有修饰键的 A、1 这种——用户在画布上打字时
// 会误触发，而画布上确实有不少可输入的地方）；以及 Escape（保持固定，见 SHORTCUT_COMMANDS 的说明）。
// 功能键与 Delete/Backspace/空格这类非字符键允许单独使用。
const STANDALONE_ALLOWED = new Set(["delete", "backspace", "space", "tab", "up", "down", "left", "right"]);

export function isValidChord(chord: string): { ok: boolean; reason: string } {
    if (!chord) return { ok: false, reason: "没有识别到按键" };
    const parsed = parseChord(chord);
    if (!parsed.key) return { ok: false, reason: "没有识别到按键" };
    if (parsed.key === "escape") return { ok: false, reason: "Esc 是固定的取消键，不能改" };
    const hasModifier = parsed.mod || parsed.alt;
    if (hasModifier) return { ok: true, reason: "" };
    if (STANDALONE_ALLOWED.has(parsed.key)) return { ok: true, reason: "" };
    if (/^f\d{1,2}$/.test(parsed.key)) return { ok: true, reason: "" };
    return { ok: false, reason: "请至少配合 ⌘ / Ctrl / Alt 使用，否则在画布上打字时会误触发" };
}

// isValidPanChord 平移是按住生效的，只能绑单个不带修饰键的键。
// 带修饰键的话，用户松开修饰键但没松主键时状态会卡住（keyup 收不到对应的键）。
export function isValidPanChord(chord: string): { ok: boolean; reason: string } {
    const parsed = parseChord(chord);
    if (!parsed.key) return { ok: false, reason: "没有识别到按键" };
    if (parsed.mod || parsed.alt || parsed.shift) return { ok: false, reason: "平移画布是按住生效的，只能用单个键（不能带 ⌘ / Ctrl / Alt / Shift）" };
    if (parsed.key === "escape") return { ok: false, reason: "Esc 是固定的取消键，不能改" };
    return { ok: true, reason: "" };
}

export function defaultShortcutChords(): Record<ShortcutCommandId, string[]> {
    const result = {} as Record<ShortcutCommandId, string[]>;
    for (const command of SHORTCUT_COMMANDS) {
        result[command.id] = [...command.defaultChords];
    }
    return result;
}

// resolveShortcutChords 把用户的自定义覆盖到默认之上，得到当前生效的完整键位表。
//
// 只认注册表里存在的命令 id：云端可能存着旧版本留下的、或以后被删掉的命令，
// 直接展开会让界面上冒出一条谁也不认识的绑定。
export function resolveShortcutChords(bindings: ShortcutBinding[]): Record<ShortcutCommandId, string[]> {
    const resolved = defaultShortcutChords();
    const known = new Set(SHORTCUT_COMMANDS.map((command) => command.id));
    for (const binding of bindings || []) {
        if (!binding) continue;
        if (!known.has(binding.id as ShortcutCommandId)) continue;
        if (!Array.isArray(binding.chords)) continue;
        const chords = binding.chords.filter((chord) => typeof chord === "string" && chord.length > 0);
        // 空数组＝用户把这个命令的键全删了，视为「不绑定」，是合法状态。
        resolved[binding.id as ShortcutCommandId] = chords;
    }
    return resolved;
}

// findChordConflict 找出某个键位是否已经被别的命令占用。
// 返回占用它的命令，没有冲突则返回 null。
export function findChordConflict(chords: Record<ShortcutCommandId, string[]>, chord: string, selfId: ShortcutCommandId) {
    for (const command of SHORTCUT_COMMANDS) {
        if (command.id === selfId) continue;
        if ((chords[command.id] || []).includes(chord)) return command;
    }
    return null;
}

// matchCommand 根据当前生效的键位表，判断这次按键触发了哪个命令。
export function matchCommand(chords: Record<ShortcutCommandId, string[]>, chord: string): ShortcutCommandId | null {
    if (!chord) return null;
    for (const command of SHORTCUT_COMMANDS) {
        if (command.id === PAN_CANVAS_COMMAND_ID) continue;
        if ((chords[command.id] || []).includes(chord)) return command.id;
    }
    return null;
}

// shouldSkipShortcut 焦点在可输入元素里时不触发快捷键。
//
// 这份判断原先只存在于 canvas-client-page，而 画布组件里监听空格的那份是弱化版
// （只查 input/textarea，漏了 select 和 contenteditable）。两处各写各的，改一处必然忘另一处，
// 所以收到这里由两边共用。
//
// 刻意**不**用 [data-canvas-no-zoom] 之类的容器来拦：那样会让用户选中视频节点时 ⌘C/⌘V 失效。
export function shouldSkipShortcut(event: KeyboardEvent) {
    const target = event.target;
    if (target instanceof HTMLInputElement) return true;
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLSelectElement) return true;
    if (target instanceof HTMLElement && target.closest("[contenteditable='true']")) return true;
    return false;
}
