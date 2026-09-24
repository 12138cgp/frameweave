export const audioVoiceOptions = [
    { value: "alloy", label: "Alloy" },
    { value: "ash", label: "Ash" },
    { value: "ballad", label: "Ballad" },
    { value: "coral", label: "Coral" },
    { value: "echo", label: "Echo" },
    { value: "fable", label: "Fable" },
    { value: "nova", label: "Nova" },
    { value: "onyx", label: "Onyx" },
    { value: "sage", label: "Sage" },
    { value: "shimmer", label: "Shimmer" },
    { value: "verse", label: "Verse" },
    { value: "marin", label: "Marin" },
    { value: "cedar", label: "Cedar" },
];

// ── 豆包语音(火山 openspeech TTS)——原生协议，和上面 OpenAI 音色不同 ──
// 选用 model="doubao-tts" 时走豆包通道；voice 即 speaker 音色 ID。
// 可用音色取决于账号在控制台「音色库」的开通，未开通的会报 55000000；下面是常见 seed-tts-1.0 公版音色初始清单，按账号开通增删。
export const DOUBAO_AUDIO_MODEL = "doubao-tts";

export function isDoubaoAudioModel(model: string) {
    return (model || "").trim().toLowerCase().startsWith("doubao");
}

export const doubaoVoiceOptions = [
    { value: "zh_female_cancan_mars_bigtts", label: "灿灿（女·明快）" },
    { value: "zh_female_shuangkuaisisi_moon_bigtts", label: "爽快思思（女）" },
    { value: "zh_female_vv_mars_bigtts", label: "薇薇（女·温柔）" },
    { value: "zh_female_qinqienvsheng_moon_bigtts", label: "亲切女声" },
    { value: "zh_female_tianmeixiaoyuan_moon_bigtts", label: "甜美小源（女）" },
    { value: "zh_female_linjianvhai_moon_bigtts", label: "邻家女孩" },
    { value: "zh_female_zhixingnvsheng_mars_bigtts", label: "知性女声" },
    { value: "zh_male_yangguangqingnian_moon_bigtts", label: "阳光青年（男）" },
    { value: "zh_male_jingqiangkanye_moon_bigtts", label: "京腔侃爷（男）" },
    { value: "zh_male_qingshuangnanda_mars_bigtts", label: "清爽男大（男）" },
    { value: "zh_female_wanwanxiaohe_moon_bigtts", label: "湾湾小何（女·台湾腔）" },
];

// 按所选模型返回对应音色清单：豆包模型用豆包音色，其它用 OpenAI 音色。
export function audioVoiceOptionsForModel(model: string) {
    return isDoubaoAudioModel(model) ? doubaoVoiceOptions : audioVoiceOptions;
}

export function normalizeAudioVoiceForModel(model: string, value: string) {
    const options = audioVoiceOptionsForModel(model);
    if (options.some((item) => item.value === value)) return value;
    // 豆包模型支持自定义音色 ID（火山控制台「设计/复刻」得到的 speaker_id），非空自由文本原样保留；
    // 但排除从 OpenAI 模型遗留过来的音色名(alloy 等)，否则会被当成自定义 speaker 发给豆包导致报错。
    if (isDoubaoAudioModel(model)) {
        const custom = (value || "").trim();
        if (custom && !audioVoiceOptions.some((item) => item.value === custom)) return custom;
    }
    return options[0].value;
}

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

export function normalizeAudioVoiceValue(value: string) {
    return audioVoiceOptions.some((item) => item.value === value) ? value : "alloy";
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

export function normalizeAudioSpeedValue(value: string) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return "1";
    return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function audioVoiceLabel(value: string, model = "") {
    // 豆包模型：先按模型归一(保留自定义 speaker_id)，命中公版清单则显示中文名，否则直接显示 ID。
    if (isDoubaoAudioModel(model)) {
        const voice = normalizeAudioVoiceForModel(model, value);
        return doubaoVoiceOptions.find((item) => item.value === voice)?.label || voice;
    }
    const voice = normalizeAudioVoiceValue(value);
    return audioVoiceOptions.find((item) => item.value === voice)?.label || voice;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function audioSpeedLabel(value: string) {
    return `${normalizeAudioSpeedValue(value)}x`;
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "opus") return "audio/opus";
    if (format === "aac") return "audio/aac";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}

// ── 豆包「音频生成」(seed-audio) —— 与上面的 TTS 是两条独立的路 ──
//
//   TTS(doubao-tts)  : 文本 + 音色 → 语音。没有参考，走 /tts/unidirectional。
//   音频生成(seed-audio): 文本 / 文本+参考音频 / 文本+参考图片 → 音频（音效、音色、配音都行），
//                        走 /tts/create，出片最长 120 秒。
//
// ⚠️ isSeedAudioModel 与后端 service/doubao_audio_gen.go 的 IsDoubaoAudioGenModel 是同一个判据的
// 两处实现（本项目的老毛病）。改这里必须同步改那边，否则会出现「前端按参考模式发、后端按 TTS 解析」
// 这种两边各自为政的故障。
export const SEED_AUDIO_MODEL = "seed-audio-1.0";

export function isSeedAudioModel(model: string) {
    return (model || "").trim().toLowerCase().includes("seed-audio");
}

// 上游硬约束。写死在这里是为了在【发请求之前】就把超限挡住并明确告知用户，
// 而不是等上游顶回来——那时候钱已经扣了。
export const seedAudioLimits = {
    /** 参考音频最多 3 条 */
    audios: 3,
    /** 参考图片最多 1 张 */
    images: 1,
    /** 单条参考素材 ≤10MB */
    maxRefBytes: 10 * 1024 * 1024,
    /** 单条参考音频 ≤30 秒 */
    maxRefSeconds: 30,
    /** 文本上限（字符，数码点不数字节）。上游硬限是 3000，产品收到 2000。 */
    maxTextPrompt: 2000,
    /** 按字数计费的档位：每 100 字一档，不足一档按一档算。与后端 model.AudioCharBillingUnit 同值。 */
    charBillingUnit: 100,
    /** 上游出片硬上限（秒）。仅用于说明与计费钳位，界面上不再让用户指定目标时长——
     *  实测该模型对「总时长」的自然语言约束不可靠（尤其带参考音频时），给了也不算数。 */
    maxSeconds: 120,
} as const;

// 采样率：各输出格式支持的取值不同（官方文档明列），选错会被上游直接拒掉。
//   wav / pcm  默认 40000，可选 8000/16000/24000/32000/40000/44100/48000
//   mp3        默认 44100，可选 8000/16000/24000/32000/44100/48000
//   ogg_opus   只支持 48000
const SEED_AUDIO_SAMPLE_RATES: Record<string, number[]> = {
    wav: [8000, 16000, 24000, 32000, 40000, 44100, 48000],
    pcm: [8000, 16000, 24000, 32000, 40000, 44100, 48000],
    mp3: [8000, 16000, 24000, 32000, 44100, 48000],
    opus: [48000],
};

const SEED_AUDIO_DEFAULT_SAMPLE_RATE: Record<string, number> = { wav: 40000, pcm: 40000, mp3: 44100, opus: 48000 };

// 语速实测值（用于估算出片时长，防止用户写到超出上游 120 秒上限才被拒）：
//   中文（含日韩）约 3.8 字/秒 —— 实测 300 字出片 78.6 秒
//   拉丁字符约 9.5 字符/秒     —— 实测 63 字符 7.3 秒、170 字符 16.5 秒
// 这两个数只用于**提示**，不参与计费，也不阻止生成。
const CJK_CHARS_PER_SECOND = 3.8;
const LATIN_CHARS_PER_SECOND = 9.5;

/** 按语种估算出片时长（秒）。中英混排时分别折算再相加。 */
export function estimateAudioSeconds(text: string) {
    let cjk = 0;
    let latin = 0;
    for (const ch of text) {
        if (/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1;
        else if (/\S/.test(ch)) latin += 1;
    }
    return cjk / CJK_CHARS_PER_SECOND + latin / LATIN_CHARS_PER_SECOND;
}

/** 按字数计费的档数：ceil(字数/100)，空文本 0 档。 */
export function audioCharUnits(text: string) {
    const chars = Array.from(text).length;
    if (chars <= 0) return 0;
    return Math.ceil(chars / seedAudioLimits.charBillingUnit);
}

/**
 * 文本计数摘要：字数、档数、预计时长，以及两条警戒线。
 *
 * 两条线是不同的东西，别混：
 *   overLimit   —— 超过我们的字数上限(2000)，**必拒**，生成按钮要禁用。
 *   overDuration—— 按语速估算会超过上游 120 秒出片上限。上游会回
 *                  `40000020 InvalidPayload:DurationOutOfRange`。这是估算，所以只警告不拦——
 *                  实测中文约 450 字、英文约 1100 字符就会撞线，而 2000 字的上限远在它之后，
 *                  光看字数计数器是看不出来的。
 */
export function audioTextStats(text: string) {
    const chars = Array.from(text).length;
    const seconds = estimateAudioSeconds(text);
    return {
        chars,
        units: audioCharUnits(text),
        seconds,
        overLimit: chars > seedAudioLimits.maxTextPrompt,
        overDuration: seconds > seedAudioLimits.maxSeconds,
    };
}

/** 某输出格式可选的采样率清单。 *//** 某输出格式可选的采样率清单。 */
export function seedAudioSampleRates(format: string) {
    return SEED_AUDIO_SAMPLE_RATES[normalizeAudioFormatValue(format)] || SEED_AUDIO_SAMPLE_RATES.mp3;
}

/** 把采样率归一到该格式合法的取值；非法/空值回落该格式的官方默认值。 */
export function normalizeAudioSampleRate(format: string, value: string | number) {
    const allowed = seedAudioSampleRates(format);
    const rate = Math.round(Number(value));
    if (allowed.includes(rate)) return rate;
    return SEED_AUDIO_DEFAULT_SAMPLE_RATE[normalizeAudioFormatValue(format)] || allowed[allowed.length - 1];
}

/** 采样率显示用短名：24000 → 24k */
export function audioSampleRateLabel(rate: number | string) {
    const value = Math.round(Number(rate)) || 0;
    if (value % 1000 === 0) return `${value / 1000}k`;
    return `${(value / 1000).toFixed(1)}k`;
}

// seed-audio 只支持这四种输出格式（没有 aac/flac）。
export const seedAudioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "pcm", label: "PCM" },
];

export function audioFormatOptionsForModel(model: string) {
    return isSeedAudioModel(model) ? seedAudioFormatOptions : audioFormatOptions;
}

export function normalizeAudioFormatForModel(model: string, value: string) {
    const options = audioFormatOptionsForModel(model);
    return options.some((item) => item.value === value) ? value : options[0].value;
}

/** 音量 / 语速：[-50,100]，0=不调整。 */
export function normalizeAudioRateValue(value: string | number) {
    const rate = Math.round(Number(value));
    if (!Number.isFinite(rate)) return 0;
    return Math.max(-50, Math.min(100, rate));
}

/** 音调：[-12,12]，0=不调整。 */
export function normalizeAudioPitchValue(value: string | number) {
    const pitch = Math.round(Number(value));
    if (!Number.isFinite(pitch)) return 0;
    return Math.max(-12, Math.min(12, pitch));
}

/**
 * 把提示词里的参考标签改写成上游要求的 @音频N 编号。
 *
 * 上游规定：「参考音频的上传顺序须与 text_prompt 中 @音频N 的编号顺序严格对应」。
 * 而我们画布上的标签会用【用户改过的自定义名】（比如「旁白男声」），上游根本不认识——
 * 于是必须在发请求前按上传顺序重写一遍。这正是 2026-07-04「前言编号与正文 @标签两套逻辑不同源」
 * 那个老坑的同源点：编号只能有一个真相，就是实际发送顺序。
 *
 * labels 按上传顺序给（第 1 条参考音频的标签排第 1），返回改写后的提示词。
 */
export function applySeedAudioReferenceLabels(prompt: string, labels: string[]) {
    // 按标签长度【从长到短】处理：否则「音频1」会先啃掉「音频10」的前三个字。
    const ordered = labels
        .map((label, index) => ({ name: (label || "").trim(), token: `@音频${index + 1}` }))
        .filter((item) => item.name)
        .sort((a, b) => b.name.length - a.name.length);
    const placeholders: string[] = [];
    let next = prompt;
    const stash = (text: string, needle: string, token: string, guardDigit: boolean) => {
        if (!text.includes(needle)) return text;
        const slot = `\u0000REF${placeholders.length}\u0000`;
        let out = "";
        let rest = text;
        let hit = false;
        for (;;) {
            const at = rest.indexOf(needle);
            if (at < 0) break;
            // guardDigit：「音频1」后面紧跟数字时，它其实是「音频10」「音频12」的一部分，跳过。
            const following = rest[at + needle.length];
            const isDigit = following !== undefined && following >= "0" && following <= "9";
            if (guardDigit && isDigit) {
                out += rest.slice(0, at + needle.length);
            } else {
                out += rest.slice(0, at) + slot;
                hit = true;
            }
            rest = rest.slice(at + needle.length);
        }
        if (!hit) return text;
        placeholders.push(token);
        return out + rest;
    };
    // 第一轮：带 @ 的显式引用。无歧义，先换成占位符，免得第二轮再动它们。
    for (const item of ordered) {
        next = stash(next, `@${item.name}`, item.token, false);
    }
    // 第二轮：用户没打 @ 的裸标签。
    // ⚠️ 只对【默认标签】(音频N) 做裸替换。中文不用空格分词，「用音频1的声音说」是最常见的写法，
    // 若要求词边界它反而匹配不上；而「音频N」本身足够特异，误伤概率极低（只需防住「音频10」）。
    // 自定义名（比如节点被改叫「故事」）一律【不做】裸替换——那种词出现在正文里是常态，
    // 无锚点替换会把用户的正文改坏。没打 @ 的自定义名由 findUnreferencedSeedAudioLabels 提醒。
    for (const item of ordered) {
        if (!isDefaultAudioLabel(item.name)) continue;
        next = stash(next, item.name, item.token, true);
    }
    placeholders.forEach((token, index) => {
        next = next.split(`\u0000REF${index}\u0000`).join(token);
    });
    return next;
}

// isDefaultAudioLabel 是不是自动生成的默认标签「音频N」（而非用户改过的自定义名）。
function isDefaultAudioLabel(name: string) {
    return /^音频\d+$/.test(name);
}

/**
 * 提示词里没提到的参考音频标签。上游要求 @音频N 必须出现，否则那条参考不生效。
 *
 * 口径与 applySeedAudioReferenceLabels 严格一致（同一判据两处实现是本项目的老毛病）：
 * 默认标签「音频N」裸写也算提到了；自定义名必须带 @ 才算——裸的自定义名不会被改写成编号，
 * 光在正文里出现对上游毫无意义。
 */
export function findUnreferencedSeedAudioLabels(prompt: string, labels: string[]) {
    return labels.filter((label, index) => {
        const name = (label || "").trim();
        if (prompt.includes(`@音频${index + 1}`)) return false;
        if (!name) return true;
        if (prompt.includes(`@${name}`)) return false;
        if (isDefaultAudioLabel(name)) {
            let from = 0;
            for (;;) {
                const at = prompt.indexOf(name, from);
                if (at < 0) break;
                const following = prompt[at + name.length];
                const isDigit = following !== undefined && following >= "0" && following <= "9";
                if (!isDigit) return false;
                from = at + name.length;
            }
        }
        return true;
    });
}

/**
 * 组装一次音频生成(seed-audio)的请求：按上游上限裁参考、改写编号、拼时长提示，并把被裁掉/有问题的
 * 地方以人话汇总成 warnings 交给调用方弹给用户。
 *
 * 设计原则：**丢可以，但绝不能静默丢**。
 * 早先前端写死只发 7 张参考图，用户传 15 张、界面毫无提示，只能靠肉眼发现参考没生效。
 *
 * 非 seed-audio 模型原样返回、不带任何参考——老的 TTS 路径逐字段不变。
 */
export function buildSeedAudioRequest(params: { prompt: string; model: string; audios: SeedAudioRef[]; images: SeedAudioRef[] }) {
    const warnings: string[] = [];
    if (!isSeedAudioModel(params.model)) {
        return { prompt: params.prompt, audios: [] as SeedAudioRef[], images: [] as SeedAudioRef[], warnings, blocked: "" };
    }

    let audios = params.audios || [];
    let images = params.images || [];

    // 上游硬约束：图片参考不能与音频参考混用，混用会被整个请求拒掉。
    // 两种都接了就只留音频（音频参考是这个模型的主用法），并明确告诉用户图片被丢了。
    if (audios.length > 0 && images.length > 0) {
        warnings.push(`参考图片不能和参考音频一起用（上游限制），本次已忽略 ${images.length} 张图片，只用参考音频。想用图片请先断开音频参考。`);
        images = [];
    }
    let droppedLabels: string[] = [];
    if (audios.length > seedAudioLimits.audios) {
        warnings.push(`参考音频最多 ${seedAudioLimits.audios} 条，已按顺序只取前 ${seedAudioLimits.audios} 条，丢弃 ${audios.length - seedAudioLimits.audios} 条。`);
        // 被丢掉那几条在提示词里的引用必须一并清掉，否则 @音频4 会指向一条压根没发出去的参考。
        droppedLabels = audios.slice(seedAudioLimits.audios).map((audio, index) => audio.label || `音频${seedAudioLimits.audios + index + 1}`);
        audios = audios.slice(0, seedAudioLimits.audios);
    }
    if (images.length > seedAudioLimits.images) {
        warnings.push(`参考图片最多 ${seedAudioLimits.images} 张，已只取第 1 张，丢弃 ${images.length - seedAudioLimits.images} 张。`);
        images = images.slice(0, seedAudioLimits.images);
    }
    for (const audio of audios) {
        if (audio.durationMs && audio.durationMs > seedAudioLimits.maxRefSeconds * 1000) {
            warnings.push(`「${audio.label || audio.name || "参考音频"}」超过 ${seedAudioLimits.maxRefSeconds} 秒，上游可能拒收，建议先裁剪。`);
        }
        if (audio.bytes && audio.bytes > seedAudioLimits.maxRefBytes) {
            warnings.push(`「${audio.label || audio.name || "参考音频"}」超过 ${Math.round(seedAudioLimits.maxRefBytes / 1024 / 1024)}MB，上游可能拒收，建议先压缩。`);
        }
    }

    // 编号对齐：上游只认 @音频N，且 N 必须等于上传顺序。
    const labels = audios.map((audio, index) => audio.label || `音频${index + 1}`);
    // 先摘掉被丢弃参考的引用，再做编号改写——顺序反了会把它们也编上号。
    let basePrompt = params.prompt;
    for (const dropped of droppedLabels) {
        const name = (dropped || "").trim();
        if (!name) continue;
        basePrompt = basePrompt.split(`@${name}`).join("").split(name).join("");
    }
    const unreferenced = findUnreferencedSeedAudioLabels(basePrompt, labels);
    if (unreferenced.length) {
        warnings.push(`提示词里没有提到 ${unreferenced.join("、")}，上游要求用 @音频1 这样的编号引用参考音频，否则这条参考不会生效。`);
    }
    // 注意：这里【不再】往提示词里拼「音频总时长约 N 秒」。
    // 实测该模型对总时长的自然语言约束不可靠——同一句台词，单发能精确命中 30 秒，
    // 画布上带参考音频时只出 11 秒。给一个不算数的控件比不给更糟，所以整条去掉。
    const prompt = applySeedAudioReferenceLabels(basePrompt, labels);
    // ⚠️ 数码点不数 UTF-16 码元：`"🎵".length === 2`，后端数的是 rune。
    // 按 .length 判会让带 emoji 的提示词在前端被误报超限。
    const promptLength = Array.from(prompt).length;
    // 超限直接拦下而不只是警告：后端会硬拒，而在那之前它已经把最多 30MB 的参考素材下完了，
    // 用户白等十几秒换一句报错。长度算的是【拼上时长提示之后】的最终串——发出去的正是它。
    let blocked = "";
    if (promptLength > seedAudioLimits.maxTextPrompt) {
        blocked = `文本 ${promptLength} 字，超过上限 ${seedAudioLimits.maxTextPrompt} 字，请精简后再生成。`;
    }
    return { prompt, audios, images, warnings, blocked };
}

/** buildSeedAudioRequest 需要的参考素材字段（ReferenceAudio / ReferenceImage 的公共子集）。 */
export type SeedAudioRef = {
    label?: string;
    name?: string;
    bytes?: number;
    durationMs?: number;
};
