"use client";

import { useState } from "react";
import { App, Button, Input, Modal, Segmented, Tag } from "antd";
import { Clapperboard, LoaderCircle, RefreshCw, Sparkles } from "@/components/icons";

import { defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { requestImageQuestion } from "@/services/api/image";
import {
    STORYBOARD_DURATIONS,
    buildStoryboardPlannerMessages,
    parseStoryboardPlan,
    type StoryboardDurationKey,
    type StoryboardPlan,
    type StoryboardWizardInput,
} from "../utils/canvas-storyboard";

type CanvasStoryboardWizardProps = {
    open: boolean;
    onClose: () => void;
    onApply: (plan: StoryboardPlan) => void;
};

export function CanvasStoryboardWizard({ open, onClose, onApply }: CanvasStoryboardWizardProps) {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [story, setStory] = useState("");
    const [genre, setGenre] = useState("");
    const [tone, setTone] = useState("");
    const [duration, setDuration] = useState<StoryboardDurationKey>("15s");
    const [characters, setCharacters] = useState("");
    const [extra, setExtra] = useState("");
    const [generating, setGenerating] = useState(false);
    const [streamed, setStreamed] = useState("");
    const [plan, setPlan] = useState<StoryboardPlan | null>(null);

    const generatePlan = async () => {
        if (!story.trim()) {
            message.warning("请先填写故事创意");
            return;
        }
        const textConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.model };
        if (!isAiConfigReady(textConfig, textConfig.model)) {
            openConfigDialog(true);
            return;
        }
        const input: StoryboardWizardInput = { story: story.trim(), genre: genre.trim(), tone: tone.trim(), duration, characters: characters.trim(), extra: extra.trim() };
        setGenerating(true);
        setPlan(null);
        setStreamed("");
        try {
            const answer = await requestImageQuestion(textConfig, buildStoryboardPlannerMessages(input), (text) => setStreamed(text));
            setPlan(parseStoryboardPlan(answer || ""));
        } catch (error) {
            message.error(`分镜方案生成失败：${error instanceof Error ? error.message : "未知错误"}`);
        } finally {
            setGenerating(false);
        }
    };

    const apply = () => {
        if (!plan) return;
        onApply(plan);
        onClose();
    };

    return (
        <Modal
            title={
                <span className="font-heading inline-flex items-center gap-2 font-medium tracking-wide">
                    <Clapperboard className="size-4.5" />
                    分镜故事板
                </span>
            }
            open={open}
            onCancel={onClose}
            footer={null}
            width={720}
            centered
            destroyOnHidden
        >
            <div className="flex flex-col gap-3 pt-2">
                <div>
                    <div className="pb-1.5 text-xs font-medium opacity-60">故事创意（必填）</div>
                    <Input.TextArea value={story} onChange={(event) => setStory(event.target.value)} rows={3} placeholder="一句话或一小段话描述你的故事，例如：数字少女图零零在霓虹城市的地下数据市场，第一次发现自己的身份代码被人篡改" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <div className="pb-1.5 text-xs font-medium opacity-60">题材类型</div>
                        <Input value={genre} onChange={(event) => setGenre(event.target.value)} placeholder="赛博朋克 / 古风武侠 / 都市现实 / 校园青春…" />
                    </div>
                    <div>
                        <div className="pb-1.5 text-xs font-medium opacity-60">风格基调</div>
                        <Input value={tone} onChange={(event) => setTone(event.target.value)} placeholder="轻松 / 严肃 / 商业广告感 / 独立电影感…" />
                    </div>
                </div>
                <div>
                    <div className="pb-1.5 text-xs font-medium opacity-60">目标时长</div>
                    <Segmented block value={duration} onChange={(value) => setDuration(value as StoryboardDurationKey)} options={Object.entries(STORYBOARD_DURATIONS).map(([key, item]) => ({ value: key, label: item.label }))} />
                </div>
                <div>
                    <div className="pb-1.5 text-xs font-medium opacity-60">核心人物（可选，越具体定妆图越稳）</div>
                    <Input.TextArea value={characters} onChange={(event) => setCharacters(event.target.value)} rows={2} placeholder="主角几人、性格特征、关键道具、标志性服装；留空由 AI 设计" />
                </div>
                <div>
                    <div className="pb-1.5 text-xs font-medium opacity-60">补充要求（可选）</div>
                    <Input value={extra} onChange={(event) => setExtra(event.target.value)} placeholder="例如：结尾留悬念 / 不要出现对白 / 参考王家卫色调" />
                </div>

                <div className="flex items-center gap-2">
                    <Button type="primary" loading={generating} icon={<Sparkles className="size-3.5" />} onClick={() => void generatePlan()}>
                        {plan ? "重新生成方案" : "生成分镜方案"}
                    </Button>
                    {plan ? (
                        <Button type="primary" ghost icon={<Clapperboard className="size-3.5" />} onClick={apply}>
                            插入画布
                        </Button>
                    ) : null}
                </div>

                {generating ? (
                    <div className="anim-fade flex max-h-44 flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-[#0F172A]/[0.04] p-3 text-xs opacity-70 dark:bg-[#E2E8F0]/[0.05]">
                        <span className="inline-flex items-center gap-1.5 font-medium">
                            <LoaderCircle className="size-3.5 animate-spin" />
                            正在拆解镜头与定妆提示词…
                        </span>
                        {streamed ? <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-4 opacity-70">{streamed.slice(-600)}</pre> : null}
                    </div>
                ) : null}

                {plan && !generating ? (
                    <div className="anim-rise flex max-h-72 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-[#0F172A]/[0.04] p-3 dark:bg-[#E2E8F0]/[0.05]">
                        <div className="text-sm font-semibold">
                            《{plan.title}》<span className="pl-2 text-xs font-normal opacity-60">{plan.style}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <span className="opacity-60">角色：</span>
                            {plan.characters.map((item) => (
                                <Tag key={item.name} color="volcano">
                                    {item.name}
                                </Tag>
                            ))}
                            <span className="pl-2 opacity-60">场景：</span>
                            {plan.scenes.map((item) => (
                                <Tag key={item.name} color="gold">
                                    {item.name}
                                </Tag>
                            ))}
                        </div>
                        {plan.segments.map((segment, index) => (
                            <div key={index} className="rounded-xl border border-border bg-card/60 p-2.5">
                                <div className="pb-1 text-xs font-semibold">
                                    第{index + 1}段 · {segment.title}
                                    <span className="pl-2 font-normal opacity-55">{segment.shots.length} 镜 · {segment.story}</span>
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
                        <div className="inline-flex items-center gap-1.5 text-[11px] opacity-55">
                            <RefreshCw className="size-3" />
                            插入后将创建：{plan.characters.length} 个人物定妆节点、{plan.scenes.length} 个场景节点、{plan.segments.length} 个故事板节点（已连线垫图）+ 1 个脚本文本节点。先生成定妆图与场景图，再生成故事板。
                        </div>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}
