"use client";

import { type ReactNode } from "react";

import { ImageSettingsTheme, SETTING_SELECT_TRANSITION, settingSelectedFill } from "@/components/image-settings-panel";
import {
    audioFormatOptionsForModel,
    audioSpeedLabel,
    audioVoiceOptionsForModel,
    isDoubaoAudioModel,
    isSeedAudioModel,
    normalizeAudioFormatForModel,
    audioSampleRateLabel,
    normalizeAudioPitchValue,
    normalizeAudioRateValue,
    normalizeAudioSampleRate,
    normalizeAudioSpeedValue,
    normalizeAudioVoiceForModel,
    seedAudioSampleRates,
} from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";

const speedOptions = ["0.75", "1", "1.25", "1.5"];

type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions" | "audioSampleRate" | "audioLoudness" | "audioPitch";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

// deriveCustomVoice 用 if/return(不写三元)派生自定义音色输入框的值：命中公版预设则留空，否则回填 speaker_id。
function deriveCustomVoice(options: { value: string }[], voice: string) {
    for (const item of options) {
        if (item.value === voice) return "";
    }
    return voice;
}

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const audioModel = (config.model || config.audioModel || "").trim();
    const isDoubao = isDoubaoAudioModel(audioModel);
    // seed-audio(音频生成)是另一条路：靠参考音频/参考图片 + 提示词生成，时长写在提示词里。
    // 它不走音色列表——① 上游支持的音色清单与 TTS 不同、我们没法验证；
    // ② 音色(speaker)与参考图片互斥，同时摆出来只会让用户配出一个必被上游拒收的组合。
    // 要指定声音就接一条参考音频，这也是这个模型本来的用法。
    const isSeedAudio = isSeedAudioModel(audioModel);
    const voiceOptions = audioVoiceOptionsForModel(audioModel);
    const voice = normalizeAudioVoiceForModel(audioModel, config.audioVoice);
    // 自定义音色(非公版预设)：把当前 speaker_id 回填进输入框；命中公版预设则输入框留空。
    // 用 if/return 纯函数派生(不写三元),规避 bun 构建「常量折叠+三元」SSG 期 SIGILL。
    const customVoice = deriveCustomVoice(voiceOptions, voice);
    const format = normalizeAudioFormatForModel(audioModel, config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);
    const sampleRate = normalizeAudioSampleRate(config.audioFormat, config.audioSampleRate);
    const loudness = normalizeAudioRateValue(config.audioLoudness);
    const pitch = normalizeAudioPitchValue(config.audioPitch);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
                {isSeedAudio ? null : (
                <SettingGroup title="声音" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {voiceOptions.map((item) => (
                            <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                    {/* 自定义音色（speaker_id）：火山「音色设计 / 声音复刻 ICL2.0」得到的 S_ 开头音色 ID。
                        后端 doubao_tts.go 按前缀(S_/icl_)自动走 seed-icl-2.0 + model_type:4，无需切渠道/模型；填空则用上方公版音色。 */}
                    {isDoubao ? (
                        <div className="space-y-1.5 pt-1">
                            <input
                                type="text"
                                value={customVoice}
                                placeholder="自定义音色 ID（如 S_xxxx，火山设计/复刻得到）"
                                className="h-9 w-full rounded-full border bg-transparent px-3 text-sm outline-none"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                                onChange={(event) => onConfigChange("audioVoice", event.target.value)}
                                onMouseDown={(event) => event.stopPropagation()}
                            />
                            <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                                选上方公版音色，或填火山「音色设计 / 声音复刻」得到的 S_ 开头音色 ID（如 S_xxxx）。
                            </div>
                        </div>
                    ) : null}
                </SettingGroup>
                )}
                <SettingGroup title="格式" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {audioFormatOptionsForModel(audioModel).map((item) => (
                            <OptionPill
                                key={item.value}
                                selected={format === item.value}
                                theme={theme}
                                onClick={() => {
                                    onConfigChange("audioFormat", item.value);
                                    // 各格式可选采样率不同（ogg_opus 只有 48k）。换格式时把采样率一起落到
                                    // 新格式的合法值，否则会带着一个非法值发给上游、被直接拒掉。
                                    onConfigChange("audioSampleRate", String(normalizeAudioSampleRate(item.value, sampleRate)));
                                }}
                            >
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                {isSeedAudio ? (
                    <SettingGroup title="采样率" color={theme.node.muted}>
                        <div className="grid grid-cols-4 gap-2.5">
                            {seedAudioSampleRates(config.audioFormat).map((rate) => (
                                <OptionPill key={rate} selected={sampleRate === rate} theme={theme} onClick={() => onConfigChange("audioSampleRate", String(rate))}>
                                    {audioSampleRateLabel(rate)}
                                </OptionPill>
                            ))}
                        </div>
                        <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                            采样率越高音质越好、文件越大。不同输出格式可选的档位不同（换格式后会自动落到该格式的合法值）。
                        </div>
                    </SettingGroup>
                ) : null}
                <SettingGroup title="语速" color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {speedOptions.map((value) => (
                            <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                {audioSpeedLabel(value)}
                            </OptionPill>
                        ))}
                    </div>
                    <input
                        type="number"
                        min={0.25}
                        max={4}
                        step={0.05}
                        className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                        value={config.audioSpeed || "1"}
                        onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                        onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
                {isSeedAudio ? (
                    <SettingGroup title="音量" color={theme.node.muted}>
                        <RateSlider value={loudness} min={-50} max={100} theme={theme} onChange={(next) => onConfigChange("audioLoudness", String(next))} hint="0 = 不调整；-50 是半音量，100 是双倍音量。" />
                    </SettingGroup>
                ) : null}
                {isSeedAudio ? (
                    <SettingGroup title="音调" color={theme.node.muted}>
                        <RateSlider value={pitch} min={-12} max={12} theme={theme} onChange={(next) => onConfigChange("audioPitch", String(next))} hint="0 = 不调整；数值越大音调越高。" />
                    </SettingGroup>
                ) : null}
                <SettingGroup title="声音指令" color={theme.node.muted}>
                    <textarea
                        value={config.audioInstructions || ""}
                        placeholder="例如：自然、温暖、适合旁白。"
                        className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

// RateSlider 音量/音调这种「有中点、可正可负」的参数。用滑块而不是一排档位：
// 取值范围大（音量 151 个值），摆成 pill 要么档位太粗、要么铺满整个面板。
function RateSlider({ value, min, max, theme, onChange, hint }: { value: number; min: number; max: number; theme: CanvasTheme; onChange: (value: number) => void; hint: string }) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-2.5">
                <input
                    type="range"
                    min={min}
                    max={max}
                    step={1}
                    value={value}
                    className="h-9 w-full cursor-pointer"
                    style={{ accentColor: theme.node.activeStroke }}
                    onChange={(event) => onChange(Number(event.target.value))}
                    onMouseDown={(event) => event.stopPropagation()}
                />
                <span className="w-10 shrink-0 text-center text-sm tabular-nums">{value}</span>
            </div>
            <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                {hint}
            </div>
        </div>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm hover:opacity-80"
            style={{
                background: selected ? settingSelectedFill(theme) : "transparent",
                borderColor: selected ? theme.node.activeStroke : theme.node.stroke,
                color: selected ? theme.node.activeStroke : theme.node.text,
                transition: SETTING_SELECT_TRANSITION,
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
