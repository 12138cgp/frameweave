"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Slider, Switch, Tooltip } from "antd";

import { ImageSettingsTheme, SETTING_SELECT_TRANSITION, settingSelectedFill } from "@/components/image-settings-panel";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceOutputFormat, normalizeSeedanceResolution, seedanceCapability, videoSecondsCap, seedancePixelLabel, seedanceRatioOptions, seedanceResolutionOptions, videoSizePixels, VIDEO_MODES_SELECTABLE, resolveVideoModeForCounts, videoModeAvailable, videoModeLabel, videoModeNotice, videoModeRequirement, videoModeSupportedBy, type VideoModeCounts, type VideoModeNotice } from "@/lib/seedance-video";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { modelKindFromConfig, modelMaxSecondsFromConfig, modelResolutionsFromConfig, type AiConfig } from "@/stores/use-config-store";

// 该模型允许的分辨率档：后台配了就以后台为准，没配回落到调用方给的默认档（Seedance 能力表 / 通用两档）。
// 返回空数组表示不限制。
// 取"这次要用的视频模型名"。
//
// ⚠️ 不能简单写 config.model || config.videoModel：视频生成页里 config.model 存的是【图片】模型
// （实测是 gpt-image-2），先取它就永远查不到视频档位，灰选静默失效。也不能反过来固定用 videoModel，
// 画布视频节点上 model 才是该节点选中的模型。所以按"谁被标成 video 就用谁"来挑，
// 两个都没标（后台还没配）时才退回原来的顺序，保持既有行为不变。
function videoModelName(config: Pick<AiConfig, "model" | "videoModel">): string {
    // ⚠️ 顺序必须是 [model, videoModel]：model 是「此刻这个节点/上下文选的模型」，
    // videoModel 是全局默认。反过来写的话，画布上明明选了 Seedance 2.5，
    // 却会先命中全局默认的 2.0 —— 于是按 2.0 的 maxSeconds(15) 限制时长，
    // 用户在后台把 2.5 改成 30 秒也毫无反应（代码压根没在读那一行）。
    const candidates = [config.model, config.videoModel].filter(Boolean) as string[];
    const typed = candidates.find((name) => modelKindFromConfig(name) === "video");
    return typed || config.model || config.videoModel || "";
}

// 该模型的最长秒数：后台配了就用后台的，没配回落调用方的默认上限。
function allowedMaxSeconds(config: Pick<AiConfig, "model" | "videoModel">, fallback: number): number {
    const configured = modelMaxSecondsFromConfig(videoModelName(config));
    return configured > 0 ? configured : fallback;
}

function allowedVideoResolutions(config: Pick<AiConfig, "model" | "videoModel">, fallback: readonly string[]): string[] {
    const configured = modelResolutionsFromConfig(videoModelName(config));
    return configured.length ? configured : [...fallback];
}

export const resolutionOptions = [
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
];

const sizeOptions = [
    { value: "1280x720", label: "16:9", width: 1280, height: 720 },
    { value: "720x1280", label: "9:16", width: 720, height: 1280 },
    { value: "1024x1024", label: "1:1", width: 1024, height: 1024 },
    { value: "1792x1024", label: "7:4", width: 1792, height: 1024 },
    { value: "1024x1792", label: "4:7", width: 1024, height: 1792 },
    { value: "auto", label: "自适应", width: 0, height: 0 },
];

export type VideoSection = "mode" | "resolution" | "ratio" | "seconds" | "output";
const ALL_VIDEO_SECTIONS: VideoSection[] = ["mode", "resolution", "ratio", "seconds", "output"];

type VideoSettingsPanelProps = {
    config: AiConfig;
    // ⚠️ 这个白名单联合类型就是「面板能改哪些配置」的唯一声明，新增一项必须加进来，
    // 否则调用方 onConfigChange("videoMode", ...) 直接 TS 报错。
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoOutputFormat" | "videoMode", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    // 只渲染指定分段（供画布把分辨率/比例/时长拆成独立按钮用）；默认全渲染（独立页/旧调用不变）。
    sections?: VideoSection[];
    // 参考素材数量：只有画布知道这个节点连了什么，所以由调用方传进来。
    // ⚠️ 不传 = 只按「模型支持哪些模式」灰选，不按素材条件灰选。视频生成页那条路拿不到连线信息，
    // 硬按素材条件灰的话那边会只剩「自动 / 文生视频」两个能点 —— 宁可不灰，也不能把原有功能灰死。
    referenceCounts?: VideoModeCounts;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", sections = ALL_VIDEO_SECTIONS, referenceCounts }: VideoSettingsPanelProps) {
    if (isSeedanceVideoConfig(config)) {
        return <SeedanceVideoSettingsPanel config={config} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} sections={sections} referenceCounts={referenceCounts} />;
    }

    const show = (section: VideoSection) => sections.includes(section);
    const notice = videoModeNoticeOf(config);
    const seconds = config.videoSeconds || "6";
    const size = normalizeVideoSizeValue(config.size);
    const dimensions = readSizeDimensions(size);
    const resolution = normalizeVideoResolutionValue(config.vquality);
    // 后台给这个模型配了可用档位就按它渲染四档并灰掉未勾选的；没配则维持原来的两档 + 自由输入。
    // ⚠️ 有配置时必须把自由输入框收掉，否则灰了胶囊、用户照样能在输入框里敲一个不支持的值。
    const genericAllowed = allowedVideoResolutions(config, []);
    const genericResolutionPills = genericAllowed.length
        ? ["480p", "720p", "1080p", "2160p"].map((tier) => ({
              value: tier.replace("p", ""),
              label: tier === "2160p" ? "4K" : tier,
              disabled: !genericAllowed.includes(tier),
          }))
        : resolutionOptions.map((item) => ({ value: item.value, label: item.label, disabled: false }));
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
        onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
                {show("mode") ? <VideoModeSection config={config} theme={theme} referenceCounts={referenceCounts} onConfigChange={onConfigChange} /> : null}
                {show("resolution") ? <SettingGroup title="清晰度" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {genericResolutionPills.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} disabled={item.disabled} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                        {genericAllowed.length ? null : <ResolutionInput value={resolution} theme={theme} onChange={(value) => onConfigChange("vquality", value)} />}
                    </div>
                    {genericAllowed.length ? <div className="mt-1.5 text-[11px] leading-4 opacity-55">该模型仅支持 {genericAllowed.map((item) => (item === "2160p" ? "4K" : item)).join(" / ")}。</div> : null}
                </SettingGroup> : null}
                {show("ratio") ? <SettingGroup title="尺寸" color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={size === "auto"} theme={theme} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={size === "auto"} theme={theme} onChange={(value) => updateDimension("height", value)} />
                    </div>
                    <div className="grid grid-cols-3 gap-2.5">
                        {sizeOptions.map((item) => {
                            const itemSelected = size === item.value;
                            return (
                                <button
                                    key={item.value}
                                    type="button"
                                    className="flex h-[78px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border text-sm hover:opacity-80"
                                    style={{
                                        borderColor: itemSelected ? theme.node.activeStroke : theme.node.stroke,
                                        background: itemSelected ? settingSelectedFill(theme) : "transparent",
                                        color: itemSelected ? theme.node.activeStroke : theme.node.text,
                                        transition: SETTING_SELECT_TRANSITION,
                                    }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => onConfigChange("size", item.value)}
                                >
                                    <SizePreview width={item.width} height={item.height} color={itemSelected ? theme.node.activeStroke : theme.node.text} />
                                    <span>{item.label}</span>
                                    {item.value === "auto" ? null : (
                                        <span className="text-[11px] leading-none opacity-55">
                                            {item.value}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                    <RatioNotice notice={notice} />
                </SettingGroup> : null}
                {show("seconds") ? <SettingGroup title="秒数" color={theme.node.muted}>
                    {/* 非 Seedance 的通用面板：沿用原来的 15 秒上限，Seedance 那边才按模型能力表走 */}
                    <DurationControl value={seconds} max={allowedMaxSeconds(config, 15)} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} />
                    {/* 时长说明也挂在这里：目前只有 Seedance 2.5 的「视频编辑」会落到 forced_smart，
                        理论上走不到这个通用面板。但 isSeedanceVideoConfig 是按 config.model 判的，
                        而视频生成页里 config.model 存的是【图片】模型（见 videoModelName 的注释）——
                        真选了 Seedance 也可能落到这里来，少这一行就等于在那条路上把说明吞了。 */}
                    <DurationNotice notice={notice} />
                </SettingGroup> : null}
            </div>
        </ImageSettingsTheme>
    );
}

function SeedanceVideoSettingsPanel({ config, onConfigChange, theme, showTitle, className, sections = ALL_VIDEO_SECTIONS, referenceCounts }: VideoSettingsPanelProps) {
    const show = (section: VideoSection) => sections.includes(section);
    const notice = videoModeNoticeOf(config);
    const model = config.model || config.videoModel;
    const resolution = normalizeSeedanceResolution(config.vquality, model);
    const ratio = normalizeSeedanceRatio(config.size);
    const duration = normalizeSeedanceDuration(config.videoSeconds, model);
    const capability = seedanceCapability(model);
    // 后台配了可用档位就以它为准，没配才用内置的 Seedance 能力表——这样新的 Seedance 变体
    // 不用等代码更新能力表，管理员在后台勾一下就生效。
    const seedanceAllowed = allowedVideoResolutions(config, capability.resolutions);
    const outputFormat = normalizeSeedanceOutputFormat(config.videoOutputFormat, model);
    const generateAudio = boolConfig(config.videoGenerateAudio, true);
    const watermark = boolConfig(config.videoWatermark, false);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
                {show("mode") ? <VideoModeSection config={config} theme={theme} referenceCounts={referenceCounts} onConfigChange={onConfigChange} /> : null}
                {show("resolution") ? <SettingGroup title="分辨率" color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {seedanceResolutionOptions.map((item) => {
                            // 按模型能力表禁用，不再逐个模型写 if —— 加新模型只改 seedance-video.ts 那张表
                            const disabled = !seedanceAllowed.includes(item.value);
                            return (
                                <OptionPill key={item.value} selected={resolution === item.value} disabled={disabled} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                    {item.label}
                                </OptionPill>
                            );
                        })}
                    </div>
                    {seedanceAllowed.length < seedanceResolutionOptions.length ? (
                        <div className="text-[11px] leading-4 opacity-55">该模型仅支持 {seedanceAllowed.map((item) => (item === "2160p" ? "4K" : item)).join(" / ")}，其余档会自动使用 720p。</div>
                    ) : null}
                </SettingGroup> : null}
                {show("ratio") ? <SettingGroup title="比例" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {seedanceRatioOptions.map((item) => {
                            const itemSelected = ratio === item.value;
                            return (
                                <button
                                    key={item.value}
                                    type="button"
                                    className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border px-1 text-sm hover:opacity-80"
                                    style={{
                                        borderColor: itemSelected ? theme.node.activeStroke : theme.node.stroke,
                                        background: itemSelected ? settingSelectedFill(theme) : "transparent",
                                        color: itemSelected ? theme.node.activeStroke : theme.node.text,
                                        transition: SETTING_SELECT_TRANSITION,
                                    }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => onConfigChange("size", item.value)}
                                >
                                    <SizePreview width={ratioPreview(item.value).width} height={ratioPreview(item.value).height} color={itemSelected ? theme.node.activeStroke : theme.node.text} />
                                    <span>{item.label}</span>
                                    <span className="text-[10px] leading-none opacity-55">{item.value === "adaptive" ? "adaptive" : seedancePixelLabel(resolution, item.value)}</span>
                                </button>
                            );
                        })}
                    </div>
                    <RatioNotice notice={notice} />
                </SettingGroup> : null}
                {show("seconds") ? <SettingGroup title="时长" color={theme.node.muted}>
                    <DurationControl value={String(duration)} max={allowedMaxSeconds(config, capability.maxDurationSeconds)} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} />
                    {/* 视频编辑那一档上游硬性要求 duration=-1（输出时长跟着源视频走）。
                        ⚠️ 与比例同理：这里【只说明，不禁用、不改写 config.videoSeconds】——
                        秒数是计费口径本身，动它就是在动钱；覆写只发生在请求层（videoDurationForcedSmart）。 */}
                    <DurationNotice notice={notice} />
                </SettingGroup> : null}
                {show("output") ? <SettingGroup title="输出" color={theme.node.muted}>
                    <div className="grid grid-cols-1 gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                        <SwitchRow label="生成声音" checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                        <SwitchRow label="添加水印" checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} />
                    </div>
                    {/* 只有支持多种封装格式的模型才显示这一行，2.0 系列只有 mp4，摆出来只会让人困惑 */}
                    {capability.outputFormats.length > 1 ? (
                        <div className="space-y-1.5">
                            <div className="grid grid-cols-4 gap-2.5">
                                {capability.outputFormats.map((item) => (
                                    <OptionPill key={item} selected={outputFormat === item} theme={theme} onClick={() => onConfigChange("videoOutputFormat", item)}>
                                        {item.toUpperCase()}
                                    </OptionPill>
                                ))}
                            </div>
                            <div className="text-[11px] leading-4 opacity-55">mov 为 H.264 + yuv444p + PCM，视频编辑与延长场景色彩更保真。</div>
                        </div>
                    ) : null}
                </SettingGroup> : null}
            </div>
        </ImageSettingsTheme>
    );
}

// 模式的中文名由 lib/seedance-video 提供（与 VIDEO_MODES 同源，不在这里再写一份中文名），
// 这里原样转出一份，让画布侧的按钮和 videoResolutionLabel / videoSizeLabel / videoSecondsLabel 同族好找。
export { videoModeLabel } from "@/lib/seedance-video";

export function videoResolutionLabel(value: string) {
    return `${normalizeVideoResolutionValue(value)}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = normalizeSeedanceRatio(value);
    if (value === "adaptive" || value === "auto") return "自适应";
    if (ratio === value) return seedanceRatioOptions.find((item) => item.value === ratio)?.label || ratio;
    const size = normalizeVideoSizeValue(value);
    return sizeOptions.find((item) => item.value === size)?.label || size;
}

// 标签也要按模型钳：画布上那个「时长」按钮读的就是它，
// 不钳就会出现「按钮写着 30s、实际只生成 15s」。
export function videoSecondsLabel(value: string, model = "") {
    const seconds = Math.floor(Number(value) || 6);
    return `${Math.max(1, Math.min(videoSecondsCap(model), seconds))}s`;
}

// 比例 → 像素串。判据全部下沉到 lib/seedance-video 的 videoSizePixels，这里只多管一个 "auto"。
//
// 原先这里自己维护着一份三项白名单 ["9:16","2:3","3:4"]：不在表里的一律当 16:9，
// 于是 1:1 / 4:3 / 21:9 这几档在视频生成页【静默变成了 16:9】——用户选了 1:1，
// 请求里发的是 1280x720，出片是横的，界面上还一直高亮着 1:1，无迹可寻。
// 现在与请求层共用同一张表（videoSizePixels 按数值找最接近的一档，认不出来才回退 16:9），
// 两边永不分叉。⚠️ 只影响【比例】这一维，清晰度档走 vquality 单发，扣费口径一个字没动。
export function normalizeVideoSizeValue(value: string) {
    // "adaptive" 与 "auto" 是同一档（Seedance 面板的比例胶囊写的是 adaptive，通用面板的写的是 auto）。
    // 不把 adaptive 一并归到 auto 的话，三个读取点会各说各话：这里把它当解析失败 → 回退 1280x720 →
    // 面板高亮「16:9」，而同文件的 videoSizeLabel 给的是「自适应」、请求层发出去的也是 adaptive。
    // 界面高亮的那一档与实际发出去的不是一回事，正是本轮要根治的毛病。
    if (value === "auto" || value === "adaptive") return "auto";
    return videoSizePixels(value);
}

export function normalizeVideoResolutionValue(value: string) {
    if (value === "480p" || value === "low") return "480";
    if (value === "720p" || value === "auto" || value === "high" || value === "medium") return "720";
    return value.replace(/p$/i, "") || "720";
}

/**
 * 比例 / 时长这两组的说明（同一份 videoModeNotice 里出来的，所以取一次就够）。**只说明，不置灰。**
 *
 * 曾经想过把首尾帧模式下的比例整组灰掉，那是错的，两个理由：
 *   ① 产品上就该给用户选择的空间——上游允许选的一律开放，上游会无视的照样给选、只加说明；
 *   ② 「上游会不会认比例」是【模式 × 模型】一格一格的事，不是一整列。同样是首尾帧，
 *      不同型号的表现并不一致：有的实测「请求竖屏 → 实际出竖屏」比例实打实生效，
 *      有的才真按首帧图定画幅。按整列一刀切，等于把前者一个能用的功能顺手砍掉。
 *
 * 文案与判据都来自 lib/seedance-video 的 videoModeNotice —— 那是「模式 × 模型 → 比例约束」
 * 的唯一出处，请求层的覆写(videoRatioForcedAdaptive)读的也是同一张表。
 * ⚠️ 别在界面里另写一份同义文案：两份文案一分叉，界面说的和请求真正做的就会对不上，
 *    而这种不一致只有用户拿到片子那一刻才看得见。
 *
 * ⚠️ 这里只渲染一行字，**绝不改写 config.size / config.vquality**：
 *    vquality 被 service/settings.go:459-488 与 constant/credits.tsx:98-114 拿去挑单价，
 *    写成空值或 "adaptive" 会让前后端双双静默落回 720p 档 = 按 720p 的价收 1080p 的片；
 *    size 还被节点几何预估、画布上那个比例按钮的标签读，动它会波及别处。
 *    真要覆盖比例是【请求层】的事（services/api/video.ts），UI 这边只负责如实告知。
 *    时长(videoSeconds)更是碰都不能碰 —— 它就是按秒计价的那个数，覆写成 -1 只发生在请求层
 *    的 videoDurationForcedSmart 那一处，而且只对已改成按源视频时长结算的「视频编辑」生效。
 */
function videoModeNoticeOf(config: Pick<AiConfig, "model" | "videoModel" | "videoMode">) {
    return videoModeNotice(config.videoMode || "auto", videoModelName(config));
}

// ratioWarning=true 才换成警示色（与模式分段里那条「当前模式不可用」同一个色号）：
// 它说的是「你选的值不会按你想的那样生效」，得压过普通说明文字才看得见。
// 留着 false 这一路不是多余：videoModeNotice 将来可能给出「只是提醒、并非硬约束」的说明
//（上游收得下任何比例、但这个模式下多半不生效），那种文案就该用普通灰字，不该一惊一乍。
function RatioNotice({ notice }: { notice: VideoModeNotice }) {
    if (!notice.ratioHint) return null;
    return (
        <div className="text-[11px] leading-4" style={notice.ratioWarning ? { color: "#f59e0b" } : undefined}>
            <span className={notice.ratioWarning ? undefined : "opacity-55"}>{notice.ratioHint}</span>
        </div>
    );
}

// 时长说明，与 RatioNotice 一个模子：文案和判据都来自 lib/seedance-video 的 videoModeNotice，
// 界面这边一个字都不另写 —— 另写一份同义文案，界面说的和请求真正做的就会各走各的。
function DurationNotice({ notice }: { notice: VideoModeNotice }) {
    if (!notice.durationHint) return null;
    return (
        <div className="text-[11px] leading-4" style={notice.durationWarning ? { color: "#f59e0b" } : undefined}>
            <span className={notice.durationWarning ? undefined : "opacity-55"}>{notice.durationHint}</span>
        </div>
    );
}

// 「模式」分段：让用户显式声明这次是文生 / 图生 / 首尾帧 / 参考生 / 视频编辑 / 视频延长，
// 后端不再按参考素材数量猜。
//
// 这里【不写】任何针对具体模型的判断。哪个模型支持哪些模式，唯一出处是 videoModeSupportedBy
//（Seedance 2.0 代是四档，2.5 代多出视频编辑/视频延长两档，
//  走通用 OpenAI 方言的第三方接口只有文生）。在界面里再补一条模型判据，
// 就一定会出现「界面让选、请求层又落回 auto」这种自相矛盾。
//
// ⭐ 模型不支持的模式【压根不渲染】，不是灰着。
//    灰一个 2.0 上永远点不亮的「视频编辑」，用户既点不动、也不知道该换成哪个模型才点得动，是纯噪音；
//    按模型给不同长度的列表才是能读懂的界面。
//
// 🔴 界面上【没有「自动」这一档】（VIDEO_MODES 里 hidden）。显示的是 resolveVideoModeForCounts
//    按当前参考素材落定后的具体模式：没素材=文生视频，接了素材=参考生视频，
//    用户显式选过的图生/首尾帧/编辑/延长不动。调用方会把同一个值写回 config/节点 metadata，
//    所以「看到的」与「发出去的」是同一个值；存量节点存着 "auto" 也会在这里显示成具体的一档。
//
// 「差什么素材、要几个」统一走每一项的 tooltip（见 modeTooltip），尤其是灰掉的那些项：
// 光说一句"不可用"等于让用户自己猜，得直接告诉他「需要连接图片节点（1~2 个）」。
function VideoModeSection({ config, theme, referenceCounts, onConfigChange }: { config: AiConfig; theme: CanvasTheme; referenceCounts?: VideoModeCounts; onConfigChange: VideoSettingsPanelProps["onConfigChange"] }) {
    const model = videoModelName(config);
    // ⚠️ 不直接用 config.videoMode：那是个裸字符串（存量 metadata 里的 "auto"、空、甚至拼错的值）。
    //    resolveVideoModeForCounts 保证返回一个【该模型支持】的具体模式，所以下面不再需要
    //    「当前值不在列表里就临时并进来」那段兜底，界面上也永远不会有一个胶囊都不高亮的情况。
    const current = resolveVideoModeForCounts(config.videoMode, model, referenceCounts);
    const supported = videoModeSupportedBy(model);
    const options = VIDEO_MODES_SELECTABLE.filter((item) => supported.includes(item.value)).map((item) => {
        // ⚠️ 不传 referenceCounts 时不按素材条件灰：拿不到素材数量的调用方若照它灰，
        // 那边会只剩「文生视频」一个能点。（三个调用点都传了，这条只是兜底。）
        // ⚠️ videoModeAvailable 返回的是 { ok, reason } 【对象】，对象恒为真值：
        //    直接拿返回值当布尔用（`const ok = !counts || videoModeAvailable(...)`）永远是 true，
        //    素材条件这一路的置灰与提示就整个静默失效——必须取 .ok。
        const availability = referenceCounts ? videoModeAvailable(item.value, model, referenceCounts) : { ok: true, reason: undefined };
        // 素材要求文案与置灰判据同源（videoModeRequirement 是 videoModeAvailable 的数据来源），
        // 所以 tooltip 里写的张数与真正卡的张数永远对得上。
        return { ...item, disabled: !availability.ok, reason: availability.reason, requirement: videoModeRequirement(item.value, model).text };
    });
    const currentOption = options.find((item) => item.value === current);
    // 选中的模式素材条件不满足时，请求层会【抛错】而不是换一档发出去（见 resolveVideoModeForRequest）；
    // 后端再按有没有素材二分，结果与这里算出来的一致）。文案里直接说那一档的中文名，
    // 别让用户自己去猜"自动"会变成什么。
    const fallbackLabel = videoModeLabel(resolveVideoModeForCounts("auto", model, referenceCounts));

    return (
        <SettingGroup title="模式" color={theme.node.muted}>
            <div className="grid grid-cols-3 gap-2.5">
                {options.map((item) => (
                    <OptionPill key={item.value} selected={current === item.value} disabled={item.disabled} tooltip={modeTooltip(item)} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                        {item.label}
                    </OptionPill>
                ))}
            </div>
            {currentOption && !currentOption.disabled ? <div className="text-[11px] leading-4 opacity-55">{currentOption.hint}</div> : null}
            {/* 选中的那个模式现在不可用（用户显式选了首尾帧、之后又把参考图改成了 3 张这类）：
                明说生成时会落到哪一档，别让用户看着「首尾帧」高亮、实际发出去的是另一回事。
                请求层 resolveVideoModeForRequest 对这种情况【抛错】而不是换一个模式发出去——
                结果与这里的 fallbackLabel 是同一个值（同一个 resolveVideoModeForCounts 算的），两边口径一致。
                具体差什么在那一项的 tooltip 里，这里只讲后果，免得同一句话说两遍。 */}
            {currentOption?.disabled ? <div className="text-[11px] leading-4" style={{ color: "#f59e0b" }}>当前选的「{currentOption.label}」在此素材条件下不可用：{currentOption.reason || "素材不满足要求"}。请调整参考素材，或改选其它模式后再生成。</div> : null}
        </SettingGroup>
    );
}

// 一项模式的 tooltip：这个模式是什么 + 需要什么素材/要几个。
// 灰着的那一项改显示【带当前数量的原因】（"首尾帧需要连接图片节点（1~2 个），当前 0 个"）——
// 它本身就把要求包含进去了，再把 requirement 重复一遍只是噪音。
function modeTooltip(option: { hint: string; requirement: string; disabled: boolean; reason?: string }) {
    const detail = option.disabled ? option.reason : option.requirement;
    return (
        <div className="text-[12px] leading-5">
            <div>{option.hint}</div>
            {detail ? <div style={option.disabled ? { color: "#ffd666" } : { opacity: 0.75 }}>{detail}</div> : null}
        </div>
    );
}

function OptionPill({ selected, disabled = false, tooltip, theme, onClick, children }: { selected: boolean; disabled?: boolean; tooltip?: ReactNode; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    const pill = (
        <button
            type="button"
            disabled={disabled}
            className="h-9 w-full cursor-pointer rounded-full border px-2 text-sm hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35"
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
    if (!tooltip) return pill;
    return (
        // ⚠️ 两个坑，都踩过才知道，改这里前先读完：
        // ① 【disabled 的 <button> 不派发鼠标事件】，Tooltip 直接挂在它身上，灰掉的那一项就永远不弹——
        //    而灰掉的那一项恰恰是最需要解释「差什么素材」的。所以统一套一层 <span> 去接 hover。
        //    span 变成了 grid 的格子，按钮得自己 w-full 撑满，否则宽度塌成文字宽。
        // ② 【zIndex 必须压过弹层】：画布的设置弹层是 zIndex:1200 的 fixed portal
        //    （canvas-image-option-popovers 的 Portal），而 antd Tooltip 默认 1070 ——
        //    不显式抬高的话 tooltip 会渲染在弹层【背后】，表现成"鼠标放上去什么都没有"。
        <Tooltip title={tooltip} mouseEnterDelay={0.15} zIndex={1300}>
            <span className="block">{pill}</span>
        </Tooltip>
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

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="number" min={1} className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

// 时长控件：4~15s 滑动条 + 自定义秒数输入（本地缓冲，失焦/回车才提交并 clamp，
// 避免外部 normalize 在每次按键时改写输入值导致没法正常打字）。
// 注：「智能时长(-1)」已取消，旧的 -1 存量值在此兜底成 5 秒。
// max 由调用方按模型传入（2.0 是 15 秒，2.5 是 30 秒）。
// 原先滑杆写死 4-15、旁边输入框却写着 max=30，两者本来就对不上：
// 用户从输入框敲个 20 能存进去，滑杆却显示在 15，请求发出去也被上游拒。现在两者同源。
function DurationControl({ value, max, theme, onChange }: { value: string; max: number; theme: CanvasTheme; onChange: (value: string) => void }) {
    const parsed = Math.floor(Number(value) || 5);
    const seconds = Math.max(4, Math.min(max, parsed >= 1 ? parsed : 5));

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1 px-1.5" onMouseDown={(event) => event.stopPropagation()}>
                    <Slider min={4} max={max} step={1} value={seconds} tooltip={{ formatter: (item) => `${item}s` }} onChange={(next) => onChange(String(next))} />
                </div>
                <DurationInput value={String(seconds)} min={4} max={max} disabled={false} theme={theme} onCommit={(next) => onChange(next)} />
            </div>
        </div>
    );
}

function DurationInput({ value, min, max, disabled, theme, onCommit }: { value: string; min: number; max: number; disabled: boolean; theme: CanvasTheme; onCommit: (value: string) => void }) {
    const [draft, setDraft] = useState(value);

    useEffect(() => {
        setDraft(value);
    }, [value]);

    const commit = () => {
        const num = Math.floor(Number(draft));
        if (draft.trim() === "" || !Number.isFinite(num)) {
            setDraft(value);
            return;
        }
        const clamped = String(Math.max(min, Math.min(max, num)));
        setDraft(clamped);
        onCommit(clamped);
    };

    return (
        <label className="flex h-9 w-[92px] shrink-0 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={min}
                max={max}
                disabled={disabled}
                placeholder="自定义"
                className="min-w-0 flex-1 bg-transparent pl-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ WebkitTextFillColor: theme.node.text }}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        commit();
                    }
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
            <span className="grid w-6 place-items-center pr-2" style={{ color: theme.node.muted }}>
                s
            </span>
        </label>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function ratioPreview(ratio: string) {
    if (ratio === "9:16") return { width: 9, height: 16 };
    if (ratio === "1:1") return { width: 1, height: 1 };
    if (ratio === "4:3") return { width: 4, height: 3 };
    if (ratio === "3:4") return { width: 3, height: 4 };
    if (ratio === "21:9") return { width: 21, height: 9 };
    if (ratio === "adaptive") return { width: 0, height: 0 };
    return { width: 16, height: 9 };
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex h-8 items-center justify-between gap-3">
            <span className="text-sm" style={{ color: theme.node.text }}>
                {label}
            </span>
            <span onMouseDown={(event) => event.stopPropagation()}>
                <Switch size="small" checked={checked} onChange={onChange} />
            </span>
        </div>
    );
}

function readSizeDimensions(size: string) {
    if (size === "auto") return { width: 0, height: 0 };
    const match = size.match(/^(\d+)x(\d+)$/);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}
