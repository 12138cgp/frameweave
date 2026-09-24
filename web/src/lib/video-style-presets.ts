// 视频节点「风格」预设库。与图片风格(image-style-presets)对称、但自成一套(视频重运镜/动态/时序，词与图片不同)。
// 生成时 composeVideoPrompt(用户描述, 风格id) 把预设的助提示词追加到用户描述后、负面词合并成一句 Avoid，
// 再交给 buildSeedancePromptText 拼上参考素材编号前言。内置档 + 用户自定义(「我的视频风格」)同源。

export type VideoStylePreset = {
    id: string;
    nameZh: string;
    nameEn: string;
    category: string;
    description: string;
    // 视频风格前缀(可选):放到最终提示词最开头(用户描述之前)。美漫基底的「视频风格前缀」用它。
    // Seedance「防洗回真人」对前缀放开头更有效;留空则只在末尾追加 injectPrompt。
    prefixPrompt?: string;
    injectPrompt: string; // 视频约束后缀:追加到用户描述之后
    negativePrompt: string;
    // 以下仅「用户自定义视频风格」用(内置档不填)：
    previewStorageKey?: string; // 预览图 storageKey(image:xxx)，随预设云同步、换设备靠 resolveImageUrl 自愈
    custom?: boolean; // true=用户自定义(可编辑/删、归入「我的视频风格」分组)
    /** true=来自团队共享（他人分享，本人不可编辑/删除）。 */
    shared?: boolean;
    /** 团队共享风格的预览图直链（服务端给的 URL，不是 storageKey——它存在团队存储里）。 */
    previewUrl?: string;
    /** 团队共享风格的分享者展示名，用于卡片上标注「来自 XXX」。 */
    ownerName?: string;
    updatedAt?: string; // LWW 合并用
};

// —— 用户自定义视频风格注册表 —— //
// 预设 store(use-preset-store)在变更/同步回灌时调 setCustomVideoStyles 注册；lib 不反向依赖 store，避免循环。
// getVideoStylePreset / 选择器 / composeVideoPrompt 都据此让「内置 + 自定义」同源。
let customVideoStyles: VideoStylePreset[] = [];
export function setCustomVideoStyles(list: VideoStylePreset[]): void {
    customVideoStyles = (list || []).map((s) => ({ ...s, custom: true }));
}

// —— 团队共享视频风格注册表 —— //
// 与自定义分开存：setCustomVideoStyles 会把每条标 custom:true，而 custom 就是「可编辑/可删」的判据，
// 并进去等于让组内任何人都能改删别人分享的风格。这里标 shared:true / custom:false。
let groupVideoStyles: VideoStylePreset[] = [];
export function setGroupVideoStyles(list: VideoStylePreset[]): void {
    groupVideoStyles = (list || []).map((s) => ({ ...s, custom: false, shared: true }));
}

export const VIDEO_STYLE_CATEGORIES: string[] = ["影视质感", "美式漫画", "动画", "写实纪实", "氛围风格"];

export const VIDEO_STYLE_PRESETS: VideoStylePreset[] = [
    {
        id: "vid-cinematic",
        nameZh: "电影感",
        nameEn: "Cinematic",
        category: "影视质感",
        description: "浅景深、戏剧光影、平稳运镜、胶片颗粒的电影质感。",
        injectPrompt: "cinematic film aesthetic, shallow depth of field, dramatic volumetric lighting, smooth cinematic camera movement, subtle film grain, professional color grading, wide anamorphic feel",
        negativePrompt: "",
    },
    {
        id: "vid-vintage-film",
        nameZh: "复古胶片",
        nameEn: "Vintage Film",
        category: "影视质感",
        description: "16mm 胶片颗粒、暖调褪色、漏光的怀旧质感。",
        injectPrompt: "vintage film look, 16mm film grain, warm faded retro color palette, nostalgic mood, gentle light leaks, soft focus",
        negativePrompt: "",
    },
    {
        id: "vid-commercial",
        nameZh: "广告大片",
        nameEn: "Commercial",
        category: "影视质感",
        description: "高级质感、干净影棚光、锐利精致的商业广告风。",
        injectPrompt: "high-end commercial video, glossy polished surfaces, clean bright studio lighting, crisp sharp details, premium and refined presentation",
        negativePrompt: "",
    },
    {
        id: "vid-anime-motion",
        nameZh: "日式动漫",
        nameEn: "Anime",
        category: "动画",
        description: "赛璐璐上色、鲜艳饱和、动态表现力强的二次元动画。",
        injectPrompt: "Japanese anime animation, cel-shaded rendering, vivid saturated colors, dynamic expressive motion, clean crisp linework, hand-drawn feel",
        negativePrompt: "",
    },
    {
        id: "vid-3d-animation",
        nameZh: "3D动画",
        nameEn: "3D Animation",
        category: "动画",
        description: "皮克斯式精致 CGI、柔和全局光的三维动画电影质感。",
        injectPrompt: "3D animated film style, Pixar-like polished CGI rendering, soft global illumination, appealing stylized look, smooth animation",
        negativePrompt: "",
    },
    {
        id: "vid-documentary",
        nameZh: "纪录写实",
        nameEn: "Documentary",
        category: "写实纪实",
        description: "自然光、真实色彩、轻微手持感的纪录片写实风。",
        injectPrompt: "documentary realism, natural available lighting, authentic true-to-life colors, subtle handheld camera motion, candid lifelike atmosphere",
        negativePrompt: "",
    },
    {
        id: "vid-dreamy",
        nameZh: "梦境唯美",
        nameEn: "Dreamy",
        category: "氛围风格",
        description: "柔光光晕、慢动作、粉彩梦幻、漂浮光粒的唯美氛围。",
        injectPrompt: "dreamy ethereal atmosphere, soft glowing bloom, gentle slow motion, pastel dreamy tones, floating light particles, hazy romantic mood",
        negativePrompt: "",
    },
    {
        id: "vid-cyberpunk",
        nameZh: "赛博霓虹",
        nameEn: "Cyberpunk",
        category: "氛围风格",
        description: "雨后反光街道、霓虹光牌、高对比夜景的赛博未来感。",
        injectPrompt: "cyberpunk neon aesthetic, rain-slick reflective streets, vibrant glowing neon signage, moody high-contrast night atmosphere, futuristic",
        negativePrompt: "",
    },
    // —— 美式漫画(短剧生产版,与 image-style-presets 的美漫档配对) —— //
    // prefixPrompt=风格前缀(放提示词最开头);injectPrompt=风格约束后缀(放结尾)。
    // ⚠️ 视频档一律「只锁画风」:前后缀都不提人物、也不提场景(原文档那套含「同一角色/服装一致/发型不变/表情」等主体词,
    //    会把人硬塞进空镜)。主体画什么完全交给用户描述;图片侧才按「·人物 / ·场景」分档。勿跨基底混用。
    {
        id: "comic-a-flat",
        nameZh: "现代平涂",
        nameEn: "Modern Flat Comic (Invincible)",
        category: "美式漫画",
        description: "2D赛璐璐平涂、粗黑描边,多帧最稳,叙事剧/对话戏首选。",
        prefixPrompt: "美式漫画风格,2D赛璐璐平涂,粗黑描边,高饱和色块,干净数码上色,手绘质感。",
        injectPrompt: "全程锁定2D美漫画风:绝不是真人实拍,禁止照片级写实质感与3D渲染;粗黑描边与平涂色块稳定;画面稳定无闪烁,无字幕无水印。",
        negativePrompt: "",
    },
    {
        id: "comic-b-superhero",
        nameZh: "主流超英",
        nameEn: "Superhero Comic (Marvel/DC)",
        category: "美式漫画",
        description: "粗黑墨线+半调网点+英雄健硕体格+低角度,超英动作首选。",
        prefixPrompt: "美式超级英雄漫画风格,粗黑墨线描边,赛璐璐高饱和上色,半调网点阴影,戏剧化低角度构图,现代Marvel/DC漫画质感。",
        injectPrompt: "全程锁定2D超英漫画:禁止真人实拍与照片级写实质感,禁止3D渲染;墨线描边与半调网点阴影稳定;画面稳定无闪烁,无字幕无水印。",
        negativePrompt: "",
    },
    {
        id: "comic-c-spiderverse",
        nameZh: "Spider-Verse",
        nameEn: "Spider-Verse",
        category: "美式漫画",
        description: "套印错位+色差+Kirby能量点+一拍二帧率感,最炫动作/炫技段。",
        prefixPrompt: "蜘蛛侠平行宇宙动画风格,半调网点着色,CMYK套印错位,边缘色差,粗黑墨线,Kirby能量点特效,涂鸦波普霓虹配色,2.5D漫画渲染,一拍二帧率感(stepped-frame animation, animate on 2s)。",
        injectPrompt: "全程锁定Spider-Verse漫画渲染:套印错位与边缘色差为风格特征需保留;禁止真人实拍与照片级写实质感;一拍二动画节奏,粗黑描边稳定;画面无字幕无水印。",
        negativePrompt: "",
    },
    {
        id: "comic-d-noir",
        nameZh: "黑色犯罪noir",
        nameEn: "Noir (Sin City)",
        category: "美式漫画",
        description: "强烈黑白高对比+厚重墨影+单一红色点缀,悬疑/罪案氛围。",
        prefixPrompt: "黑色犯罪漫画风格,强烈黑白高对比,厚重墨影,戏剧化明暗光,单一点缀色:红,硬派黑色电影氛围。",
        injectPrompt: "全程锁定noir漫画黑白高对比:仅保留单一点缀色(红),禁止全彩化;禁止真人实拍与照片级写实质感;墨影与明暗分界稳定;画面稳定无闪烁,无字幕无水印。",
        negativePrompt: "",
    },
    {
        id: "comic-e1-popart-clean",
        nameZh: "复古波普·干净",
        nameEn: "Retro Pop-art (Clean)",
        category: "美式漫画",
        description: "粗黑描边+明亮平涂+干净皮肤+夸张表情,复古情绪特写;禁网点。",
        prefixPrompt: "复古波普美漫风格(干净版),粗黑墨线描边,明亮高饱和平涂色块,红黄蓝为主的鲜明配色,干净利落的漫画质感。",
        injectPrompt: "全程锁定复古波普美漫(干净版):粗黑描边+明亮平涂,禁止任何网点/screentone、点状渐变阴影、柔光渐变;禁止真人实拍与照片级写实质感;配色鲜明稳定;画面稳定无闪烁,无字幕无水印。",
        negativePrompt: "",
    },
    {
        id: "comic-e2-popart-print",
        nameZh: "复古波普·印刷",
        nameEn: "Retro Pop-art (Ben-Day Print)",
        category: "美式漫画",
        description: "均匀Ben-Day网点作复古印刷底纹+套印错位+旧报纸味;网点只铺底纹不做脸部阴影。",
        prefixPrompt: "复古波普美漫风格(复古印刷版),粗黑墨线描边,明亮高饱和平涂色块,红黄蓝三原色;均匀 Ben-Day 网点作复古印刷底纹(主要铺在背景与色块上),轻微套印错位与旧报纸印刷感。",
        injectPrompt: "全程锁定复古波普印刷版:保留均匀网点印刷底纹、套印错位与旧报纸复古味,网点只作平面印刷质感、不用来做立体渐变阴影;粗黑描边+明亮平涂;禁止真人实拍与照片级写实质感;画面稳定无闪烁,无字幕无水印。",
        negativePrompt: "",
    },
    {
        id: "comic-f-arcane",
        nameZh: "Arcane厚涂",
        nameEn: "Arcane Painterly (Fortiche)",
        category: "美式漫画",
        description: "手绘厚涂笔触+半写实+电影光+霓虹脏彩,质感天花板;漂移大,只用于短打/单帧。",
        prefixPrompt: "Arcane《双城之战》厚涂动画风格,手绘厚涂笔触质感,可见油画笔触,半写实风格化质感,暗调电影级光影,霓虹高光(品红/青),硫磺蒸汽/柴油朋克氛围,2.5D渲染动画。",
        injectPrompt: "全程锁定Arcane厚涂动画质感:保留可见笔触与颗粒感;禁止真人实拍照片,禁止光滑塑料3D,禁止扁平日系赛璐璐;运镜电影感缓慢,画面无闪烁,无字幕无水印。",
        negativePrompt: "",
    },
];

// 取视频风格档：先内置，再落到自定义注册表(让内置 + 自定义同源)。
export function getVideoStylePreset(id?: string): VideoStylePreset | undefined {
    if (!id) return undefined;
    const builtin = VIDEO_STYLE_PRESETS.find((p) => p.id === id);
    if (builtin) return builtin;
    const own = customVideoStyles.find((p) => p.id === id);
    if (own) return own;
    // 团队共享风格也要能按 id 解析，否则选中后 composeVideoPrompt 拿不到助词/前缀。
    return groupVideoStyles.find((p) => p.id === id);
}

// 把所选视频风格的助提示词追加到用户描述后；负面词合并成一句 Avoid。无风格时原样返回。
// 不改用户原始 prompt/metadata（风格切换/重生成不污染），仅用于发给上游的文本。
export function composeVideoPrompt(prompt: string, styleId?: string): string {
    const style = getVideoStylePreset(styleId);
    const text = prompt.trim();
    if (!style) return text;
    // 前缀放最前(用户描述之前)、后缀放最后:还原美漫基底「风格前缀 + 主体 + 风格约束后缀」结构;
    // 无前缀的普通风格则退化为「主体 + 后缀」(与旧行为一致)。
    const prefix = (style.prefixPrompt || "").trim();
    const suffix = (style.injectPrompt || "").trim();
    const parts = [prefix, text, suffix].filter(Boolean);
    let styled = parts.join("\n\n");
    const neg = (style.negativePrompt || "").trim();
    if (neg) styled = `${styled}\n\nAvoid: ${neg}.`;
    return styled;
}
