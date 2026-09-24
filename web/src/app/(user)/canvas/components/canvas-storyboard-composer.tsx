"use client";

import { useEffect, useState } from "react";
import { App, Button, Input, Segmented, Tag, Upload } from "antd";
import { Clapperboard, ImagePlus, LoaderCircle, Sparkles, X } from "@/components/icons";

import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { ModelPicker } from "@/components/model-picker";
import type { AiConfig } from "@/stores/use-config-store";
import { STORYBOARD_DURATIONS, type StoryboardDurationKey, type StoryboardNodeState } from "../utils/canvas-storyboard";

type CanvasStoryboardComposerProps = {
    state: StoryboardNodeState;
    parsing: boolean;
    textModelConfig: AiConfig;
    onChange: (patch: Partial<StoryboardNodeState>) => void;
    onParse: () => void;
    onExpand: () => void;
    onClose: () => void;
};

function AssetThumb({ storageKey }: { storageKey: string }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let alive = true;
        void resolveImageUrl(storageKey).then((resolved) => {
            if (alive) setUrl(resolved);
        });
        return () => {
            alive = false;
        };
    }, [storageKey]);
    return url ? <img src={url} alt="" className="size-9 rounded-md object-cover" /> : <div className="size-9 rounded-md bg-black/5 dark:bg-white/10" />;
}

// 纯展示：解析请求与「解析中」状态都在父组件（canvas page）跑，点别处关掉浮层/刷新都不中断；这里只读 props.state + props.parsing 渲染。
export function CanvasStoryboardComposer({ state, parsing, textModelConfig, onChange, onParse, onExpand, onClose }: CanvasStoryboardComposerProps) {
    const { message } = App.useApp();
    const [uploadingAsset, setUploadingAsset] = useState<string | null>(null);

    const mode = state.mode ?? "auto";
    const plan = state.plan;
    const parseError = state.parseError;
    const assetMode = state.assetMode ?? {};
    const assets = state.assets ?? {};

    const setAssetChoice = (name: string, choice: "ai" | "upload") => {
        const nextMode = { ...assetMode, [name]: choice };
        if (choice === "ai") {
            const nextAssets = { ...assets };
            delete nextAssets[name];
            onChange({ assetMode: nextMode, assets: nextAssets });
        } else {
            onChange({ assetMode: nextMode });
        }
    };

    const handleAssetUpload = async (name: string, file: File) => {
        setUploadingAsset(name);
        try {
            const uploaded = await uploadImage(file);
            onChange({ assets: { ...assets, [name]: { storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType } } });
        } catch (error) {
            message.error(`上传失败：${error instanceof Error ? error.message : "未知错误"}`);
        } finally {
            setUploadingAsset(null);
        }
    };

    const assetList = plan ? [...plan.characters.map((item) => ({ name: item.name, kind: "人物" as const })), ...plan.scenes.map((item) => ({ name: item.name, kind: "场景" as const }))] : [];

    return (
        <div className="anim-rise max-h-[70vh] cursor-default overflow-y-auto rounded-2xl border border-border bg-card p-3 shadow-xl" onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <span className="font-heading inline-flex items-center gap-2 text-sm font-medium tracking-wide">
                        <Clapperboard className="size-4" />
                        分镜故事板
                    </span>
                    <button type="button" className="rounded-md p-1 opacity-60 transition hover:opacity-100" onClick={onClose}>
                        <X className="size-4" />
                    </button>
                </div>

                <Segmented
                    block
                    value={mode}
                    onChange={(value) => onChange({ mode: value as "auto" | "custom" })}
                    options={[
                        { value: "auto", label: "✨ AI 自动成片" },
                        { value: "custom", label: "📝 我的分镜脚本" },
                    ]}
                />

                {mode === "auto" ? (
                    <>
                        <div>
                            <div className="pb-1.5 text-xs font-medium opacity-60">故事创意（必填）</div>
                            <Input.TextArea value={state.story ?? ""} onChange={(event) => onChange({ story: event.target.value })} rows={3} placeholder="一句话或一小段话描述你的故事，例如：数字少女图零零在霓虹城市的地下数据市场，第一次发现自己的身份代码被人篡改" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <div className="pb-1.5 text-xs font-medium opacity-60">题材类型</div>
                                <Input value={state.genre ?? ""} onChange={(event) => onChange({ genre: event.target.value })} placeholder="赛博朋克 / 古风武侠 / 都市现实…" />
                            </div>
                            <div>
                                <div className="pb-1.5 text-xs font-medium opacity-60">风格基调</div>
                                <Input value={state.tone ?? ""} onChange={(event) => onChange({ tone: event.target.value })} placeholder="轻松 / 严肃 / 独立电影感…" />
                            </div>
                        </div>
                        <div>
                            <div className="pb-1.5 text-xs font-medium opacity-60">目标时长</div>
                            <Segmented block value={state.duration ?? "15s"} onChange={(value) => onChange({ duration: value as StoryboardDurationKey })} options={Object.entries(STORYBOARD_DURATIONS).map(([key, item]) => ({ value: key, label: item.label }))} />
                        </div>
                        <div>
                            <div className="pb-1.5 text-xs font-medium opacity-60">核心人物（可选）</div>
                            <Input.TextArea value={state.characters ?? ""} onChange={(event) => onChange({ characters: event.target.value })} rows={2} placeholder="主角几人、性格特征、关键道具、标志性服装；留空由 AI 设计" />
                        </div>
                        <div>
                            <div className="pb-1.5 text-xs font-medium opacity-60">补充要求（可选）</div>
                            <Input value={state.extra ?? ""} onChange={(event) => onChange({ extra: event.target.value })} placeholder="例如：结尾留悬念 / 不要出现对白 / 参考王家卫色调" />
                        </div>
                    </>
                ) : (
                    <>
                        <div>
                            <div className="pb-1.5 text-xs font-medium opacity-60">分镜脚本（必填）</div>
                            <Input.TextArea
                                value={state.script ?? ""}
                                onChange={(event) => onChange({ script: event.target.value })}
                                rows={8}
                                placeholder={"粘贴你写好的分镜脚本，一镜一段，可包含景别 / 运镜 / 画面内容 / 对白。例如：\n镜头1 中景 推进 少女站在霓虹街口回头，神情警觉\n镜头2 特写 固定 她手中的数据卡闪烁红光"}
                            />
                        </div>
                        <div>
                            <div className="pb-1.5 text-xs font-medium opacity-60">风格基调（可选）</div>
                            <Input value={state.style ?? ""} onChange={(event) => onChange({ style: event.target.value })} placeholder="赛博朋克霓虹 / 王家卫色调 / 古风水墨…（留空由 AI 据脚本判断）" />
                        </div>
                    </>
                )}

                <div>
                    <div className="pb-1.5 text-xs font-medium opacity-60">解析用文本模型（留空用全局默认）</div>
                    <ModelPicker config={textModelConfig} value={state.model || textModelConfig.textModel} capability="text" onChange={(model) => onChange({ model })} fullWidth />
                </div>

                <div className="flex items-center gap-2">
                    <Button type="primary" loading={parsing} icon={<Sparkles className="size-3.5" />} onClick={onParse}>
                        {plan ? (mode === "auto" ? "重新生成方案" : "重新解析") : mode === "auto" ? "生成分镜方案" : "解析镜头与资产"}
                    </Button>
                    {plan ? (
                        <Button type="primary" ghost icon={<Clapperboard className="size-3.5" />} onClick={onExpand}>
                            展开到画布
                        </Button>
                    ) : null}
                </div>

                {parsing ? (
                    <div className="anim-fade flex items-center gap-1.5 rounded-xl border border-border bg-[#0F172A]/[0.04] p-3 text-xs opacity-70 dark:bg-[#E2E8F0]/[0.05]">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        {mode === "auto" ? "正在拆解镜头与定妆提示词…" : "正在解析你的分镜脚本…"}（约 15 秒，期间可切去别处或关掉面板，回来仍在进行）
                    </div>
                ) : null}

                {parseError && !parsing ? <div className="anim-fade max-h-40 overflow-y-auto rounded-xl border border-red-500/40 bg-red-500/[0.06] p-3 text-xs leading-5 whitespace-pre-wrap break-all text-red-600 dark:text-red-400">{parseError}</div> : null}

                {plan && !parsing ? (
                    <div className="anim-rise flex flex-col gap-3 rounded-xl border border-border bg-[#0F172A]/[0.04] p-3 dark:bg-[#E2E8F0]/[0.05]">
                        <div className="text-sm font-semibold">
                            《{plan.title}》<span className="pl-2 text-xs font-normal opacity-60">{plan.style}</span>
                        </div>

                        {assetList.length ? (
                            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card/60 p-2.5">
                                <div className="text-xs font-semibold">资产配置 · 每个人物/场景可由 AI 生成提示词，或自己上传图片</div>
                                {assetList.map((asset) => {
                                    const choice = assetMode[asset.name] ?? "ai";
                                    const uploaded = assets[asset.name];
                                    return (
                                        <div key={`${asset.kind}-${asset.name}`} className="flex items-center gap-2 text-xs">
                                            <Tag color={asset.kind === "人物" ? "volcano" : "gold"}>{asset.kind}</Tag>
                                            <span className="flex-1 truncate font-medium">{asset.name}</span>
                                            {uploaded ? <AssetThumb storageKey={uploaded.storageKey} /> : null}
                                            <Segmented
                                                size="small"
                                                value={choice}
                                                onChange={(value) => setAssetChoice(asset.name, value as "ai" | "upload")}
                                                options={[
                                                    { value: "ai", label: "AI 生成" },
                                                    { value: "upload", label: "我上传" },
                                                ]}
                                            />
                                            {choice === "upload" ? (
                                                <Upload
                                                    accept="image/*"
                                                    showUploadList={false}
                                                    beforeUpload={(file) => {
                                                        void handleAssetUpload(asset.name, file);
                                                        return false;
                                                    }}
                                                >
                                                    <Button size="small" loading={uploadingAsset === asset.name} icon={<ImagePlus className="size-3.5" />}>
                                                        {uploaded ? "换图" : "选图"}
                                                    </Button>
                                                </Upload>
                                            ) : null}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : null}

                        <div className="flex max-h-60 flex-col gap-3 overflow-y-auto">
                            {plan.segments.map((segment, index) => (
                                <div key={index} className="rounded-xl border border-border bg-card/60 p-2.5">
                                    <div className="pb-1 text-xs font-semibold">
                                        第{index + 1}段 · {segment.title}
                                        <span className="pl-2 font-normal opacity-55">
                                            {segment.shots.length} 镜 · {segment.story}
                                        </span>
                                    </div>
                                    <div className="flex flex-col gap-0.5 text-[11px] leading-4 opacity-70">
                                        {segment.shots.map((shot) => (
                                            <div key={shot.no}>
                                                镜头{shot.no}：{shot.shotSize}，{shot.camera}，{shot.desc}
                                                {shot.dialogue ? `，"${shot.dialogue}"` : ""}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
