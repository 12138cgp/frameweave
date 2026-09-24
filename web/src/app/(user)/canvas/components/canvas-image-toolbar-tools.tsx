"use client";

import type { ReactNode } from "react";
import { Brush, Camera, Copy, FileText, Grid2x2, Grid3x3, Lock, LockOpen, Scissors, Sparkles, Type, Upload } from "@/components/icons";

import type { CanvasNodeData } from "../types";

export type ImageNodeActionToolId = "copyPrompt" | "reversePrompt" | "replace" | "resize" | "maskEdit" | "crop" | "split" | "superResolve" | "angle" | "nineGrid" | "denoiseRepaint" | "annotate";
// favorite（收藏提示词）不在 imageToolDefinitions 里：它要同时出现在图片和视频节点上，
// 而 imageToolDefinitions 的工具被 hover-toolbar 用 hasImage 锁死在图片节点。它定义在
// hover-toolbar 的 nodeToolbarTools 中，这里只需登记 id，让图片节点的白名单过滤认得它。
export type ImageQuickToolId = "info" | "saveAsset" | "download" | "edit" | "favorite" | ImageNodeActionToolId;

// 去噪重绘分两步，各用一个模型：第 1 步出灰模，第 2 步按灰模重绘。
// 灰模之所以用 Seedream：它图生图的输出比例跟随参考图，而重绘那个模型会把比例贴到 10 个离散档位，
// 白模一旦跑偏比例，第 2 步以它当几何基底就整套失效（且全程不报错）。
//
// ⚠️ 这个函数是挑模型的【唯一】判据。执行侧(canvas-client-page)和按钮上的预估积分角标
//    (canvas-node-hover-toolbar)都必须走它——两边各写一套的话会出现「标价和实扣不一致」。
//
// 判据是【模型名里的子串】，不是渠道品牌：只要在后台「分组管理 → 渠道 → 模型列表」里配了名字含
// seedream / gemini 的模型就算数，走 OpenAI 兼容方言的中转站同样能提供这两个系列，所以别把判据删了。
// 反过来说，没配这两类模型的部署里：「去噪重绘」点了会提示缺模型并中止，「九宫格机位」会退回当前
// 图片模型、多半拼不出 3×3。这件事在两个按钮的 title 里已经对用户直说了，改判据记得一并改文案。
export function pickDenoiseModels(imageModels: string[] | undefined) {
    const list = imageModels || [];
    const pick = (test: (name: string) => boolean) => list.find((name) => test(name.toLowerCase()));
    const white = pick((name) => /seedream[^a-z0-9]*5/.test(name)) || pick((name) => name.includes("seedream"));
    const repaint = pick((name) => name.includes("gemini"));
    return { white, repaint };
}

// 去噪重绘的两个变体：人物走皮肤/毛孔/发丝那套要求，场景道具走材质/磨损/接触阴影那套。
export type DenoiseVariant = "character" | "scene";

export type ImageToolHandlers = {
    onUpload: (node: CanvasNodeData) => void;
    onToggleFreeResize: (node: CanvasNodeData) => void;
    onMaskEdit: (node: CanvasNodeData) => void;
    onDenoiseRepaint: (node: CanvasNodeData, variant: DenoiseVariant) => void;
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onSuperResolve: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onNineGrid: (node: CanvasNodeData) => void;
    onAnnotate: (node: CanvasNodeData) => void;
    onCopyPrompt: (node: CanvasNodeData) => void;
    onReversePrompt: (node: CanvasNodeData) => void;
};

export type ImageToolDefinition = {
    id: ImageNodeActionToolId;
    defaultVisible: boolean;
    panelLabel: string;
    label: string | ((node: CanvasNodeData) => string);
    title: string | ((node: CanvasNodeData) => string);
    icon: (node: CanvasNodeData) => ReactNode;
    active?: (node: CanvasNodeData) => boolean;
    // run 与 menu 二选一：给了 menu 的工具在工具栏里渲染成下拉，按钮本身不触发动作。
    run?: (node: CanvasNodeData, handlers: ImageToolHandlers) => void;
    menu?: { key: string; label: string; run: (node: CanvasNodeData, handlers: ImageToolHandlers) => void }[];
};

export type ImageQuickToolsConfig = {
    ids: ImageQuickToolId[];
    showLabels: boolean;
    // migrations 已应用过的一次性迁移标记，见 migrateImageQuickToolsConfig。
    migrations?: string[];
};

export const IMAGE_QUICK_TOOLS_STORAGE_KEY = "canvas-image-quick-tools-v8";

// 全部合法的「基础工具」id（用于校验/自定义面板的可选项全集）。
const allBaseToolIds: ImageQuickToolId[] = ["info", "saveAsset", "download"];
// 默认可见的基础工具（精简后默认只显示信息/下载，其余基础工具默认隐藏，仍可在自定义面板勾选）。
// favorite（收藏）也放这里：它不属于 imageToolDefinitions，但必须进新用户的默认白名单，
// 否则图片节点上的过滤（见 hover-toolbar 的 toolbarTools）会把它挡掉。
const defaultVisibleBaseToolIds: ImageQuickToolId[] = ["info", "download", "favorite"];

// IMAGE_QUICK_TOOLS_MIGRATIONS 每一项＝一次「给老用户补上新增按钮」的迁移。
//
// 为什么需要这套东西：图片节点上显示哪些按钮，取决于存在 localStorage 里的白名单，
// 而这份白名单是用户上次保存自定义设置时写下的。新增按钮的 id 不在里面，
// 于是**老用户永远看不到新按钮，而且没有任何报错**——这是本项目加按钮时唯一
// 无法被 TypeScript 捕获的静默失效点。
//
// 直接提 STORAGE_KEY 版本号也能解决，代价是把用户全部工具栏自定义重置一遍。
// 这里改成按标记补差：只补一次，补过就记下来，用户之后主动关掉也不会被反复塞回去。
const IMAGE_QUICK_TOOLS_MIGRATIONS: { id: string; add: ImageQuickToolId[] }[] = [
    { id: "favorite-v1", add: ["favorite"] },
    { id: "denoise-repaint-v1", add: ["denoiseRepaint"] },
];

export const imageToolDefinitions: ImageToolDefinition[] = [
    {
        id: "copyPrompt",
        defaultVisible: false,
        panelLabel: "复制提示词",
        label: "复制提示词",
        title: "复制生成该图片的提示词",
        icon: () => <Copy className="size-4" />,
        run: (node, handlers) => handlers.onCopyPrompt(node),
    },
    {
        id: "reversePrompt",
        defaultVisible: true,
        panelLabel: "反推提示词",
        label: "反推提示词",
        title: "创建反推提示词的文本和配置节点",
        icon: () => <FileText className="size-4" />,
        run: (node, handlers) => handlers.onReversePrompt(node),
    },
    {
        id: "replace",
        defaultVisible: false,
        panelLabel: "替换图片",
        label: "替换图片",
        title: "替换图片",
        icon: () => <Upload className="size-4" />,
        run: (node, handlers) => handlers.onUpload(node),
    },
    {
        id: "resize",
        defaultVisible: false,
        panelLabel: "锁比例",
        label: (node) => (node.metadata?.freeResize ? "自由比例" : "锁比例"),
        title: (node) => (node.metadata?.freeResize ? "切换为等比缩放" : "切换为自由比例"),
        icon: (node) => (node.metadata?.freeResize ? <LockOpen className="size-4" /> : <Lock className="size-4" />),
        active: (node) => Boolean(node.metadata?.freeResize),
        run: (node, handlers) => handlers.onToggleFreeResize(node),
    },
    {
        id: "maskEdit",
        defaultVisible: false,
        panelLabel: "局部编辑",
        label: "局部编辑",
        title: "添加蒙版遮罩后局部修改",
        icon: () => <Brush className="size-4" />,
        run: (node, handlers) => handlers.onMaskEdit(node),
    },
    {
        id: "crop",
        defaultVisible: false,
        panelLabel: "裁剪",
        label: "裁剪",
        title: "裁剪并生成新节点",
        icon: () => <Scissors className="size-4" />,
        run: (node, handlers) => handlers.onCrop(node),
    },
    {
        id: "split",
        defaultVisible: false,
        panelLabel: "切图",
        label: "切图",
        title: "按行列切分图片",
        icon: () => <Grid2x2 className="size-4" />,
        run: (node, handlers) => handlers.onSplit(node),
    },
    {
        id: "angle",
        defaultVisible: false,
        panelLabel: "多角度",
        label: "多角度",
        title: "生成角度",
        icon: () => <Camera className="size-4" />,
        run: (node, handlers) => handlers.onAngle(node),
    },
    {
        id: "nineGrid",
        defaultVisible: true,
        panelLabel: "九宫格机位",
        label: "九宫格机位",
        title: "一键生成九宫格多机位：同一主体的 9 个机位/景别合成一张 3×3 图。【本功能需要一个能把多个机位拼进同一张图的图片编辑模型】按模型名里是否含 gemini 来挑；只看模型名，任何 OpenAI 兼容渠道提供的 gemini 系图片模型都可以。没有这类模型时会退回当前图片模型，多半拼不出 3×3——请让管理员在后台「分组管理 → 渠道 → 模型列表」里加一个。",
        icon: () => <Grid3x3 className="size-4" />,
        run: (node, handlers) => handlers.onNineGrid(node),
    },
    {
        id: "denoiseRepaint",
        defaultVisible: true,
        panelLabel: "去噪重绘",
        label: "去噪重绘",
        title: "去掉出图噪点：先把原图转成只保留结构的灰模，再以灰模为几何基底、以原图为外观依据重画一遍。点开选「人物」还是「场景道具」——两者重绘时强调的细节不同。产生「灰模」「重绘」两个节点，分两步各计一次费。【本功能需要两个图片模型】出灰模用模型名里含 seedream 的模型，重绘用模型名里含 gemini 的模型；只看模型名，任何 OpenAI 兼容渠道提供的这两个系列都可以。缺其中任何一个，点击后会提示缺模型并中止——请让管理员在后台「分组管理 → 渠道 → 模型列表」里补上。",
        icon: () => <Sparkles className="size-4" />,
        menu: [
            { key: "character", label: "人物（皮肤毛孔 / 次表面散射 / 发丝）", run: (node, handlers) => handlers.onDenoiseRepaint(node, "character") },
            { key: "scene", label: "场景道具（材质区分 / 磨损 / 接触阴影）", run: (node, handlers) => handlers.onDenoiseRepaint(node, "scene") },
        ],
    },
    {
        id: "annotate",
        defaultVisible: true,
        panelLabel: "文字标注",
        label: "文字标注",
        title: "在图片上添加文字、方框、圆圈、箭头等标注，合成为新的图片节点（本地处理，不消耗点数）",
        icon: () => <Type className="size-4" />,
        run: (node, handlers) => handlers.onAnnotate(node),
    },
];

export const defaultImageQuickToolIds: ImageQuickToolId[] = [...defaultVisibleBaseToolIds, ...imageToolDefinitions.filter((tool) => tool.defaultVisible).map((tool) => tool.id)];

export function buildImageToolbarTools(node: CanvasNodeData, handlers: ImageToolHandlers) {
    return imageToolDefinitions.map((tool) => ({
        id: tool.id,
        label: resolveToolText(tool.label, node),
        title: resolveToolText(tool.title, node),
        icon: tool.icon(node),
        active: tool.active?.(node),
        onClick: () => tool.run?.(node, handlers),
        menu: tool.menu?.map((item) => ({ key: item.key, label: item.label, onClick: () => item.run(node, handlers) })),
    }));
}

export function normalizeImageQuickToolIds(value: unknown[]) {
    // 保留所有已存的有效 id（去重、保序）。不再用过小的白名单过滤——否则 addToGroup 等不在
    // imageToolDefinitions 里的可勾选工具会被静默丢弃（刷新后消失，是「刷新就丢」的元凶之一）；
    // 实际显示由 hover-toolbar 渲染时按节点类型过滤，存多余 id 无害。
    const seen = new Set<string>();
    const result: ImageQuickToolId[] = [];
    for (const id of value) {
        if (typeof id !== "string") continue;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(id as ImageQuickToolId);
    }
    return result;
}

export function readImageQuickToolsConfig(value: unknown): ImageQuickToolsConfig {
    if (Array.isArray(value)) return { ids: normalizeImageQuickToolIds(value), showLabels: true };
    if (!value || typeof value !== "object") return { ids: defaultImageQuickToolIds, showLabels: true };
    const data = value as Partial<ImageQuickToolsConfig>;
    const migrations: string[] = [];
    if (Array.isArray(data.migrations)) {
        for (const id of data.migrations) {
            if (typeof id === "string") migrations.push(id);
        }
    }
    return {
        ids: Array.isArray(data.ids) ? normalizeImageQuickToolIds(data.ids) : defaultImageQuickToolIds,
        showLabels: data.showLabels !== false,
        migrations,
    };
}

// migrateImageQuickToolsConfig 给老配置补上新增按钮，只补一次。
//
// 返回 changed=true 时调用方需要把新配置写回 localStorage，否则下次进来还要再补一遍。
// 注意「补」只发生在该迁移从未应用过的时候：用户主动关掉新按钮之后不会被强行塞回来。
export function migrateImageQuickToolsConfig(config: ImageQuickToolsConfig): { config: ImageQuickToolsConfig; changed: boolean } {
    const applied = new Set(config.migrations || []);
    const ids = [...config.ids];
    let changed = false;
    for (const migration of IMAGE_QUICK_TOOLS_MIGRATIONS) {
        if (applied.has(migration.id)) continue;
        applied.add(migration.id);
        changed = true;
        for (const id of migration.add) {
            if (!ids.includes(id)) ids.push(id);
        }
    }
    if (!changed) return { config, changed: false };
    return { config: { ids, showLabels: config.showLabels, migrations: [...applied] }, changed: true };
}

function resolveToolText(value: string | ((node: CanvasNodeData) => string), node: CanvasNodeData) {
    return typeof value === "function" ? value(node) : value;
}
