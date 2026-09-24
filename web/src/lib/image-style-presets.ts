// 图片节点「风格(质感)」+「视图(排版)」预设库。真人写实档=纯质感(自然哑光但保留局部微高光、不油亮也不死板)+无姿势动作+纯白无背景;视图档只管转面排版与姿势(不含打光质感、与风格叠加)。
// 真人写实核心质感块经全网调研实测验证(andyhtu/即梦/PromptHero/Midjourney 多来源):写「photo of」不写「photorealistic」、加毛孔汗毛微瑕+次表面散射+胶片颗粒、关键是 matte T-zone 只留 subtle localized oil 而非整片 shine-free(后者出死皮),并显式排除 plastic/waxy/beauty filter。

export type ImageStylePreset = {
    id: string;
    nameZh: string;
    nameEn: string;
    category: string;
    description: string;
    injectPrompt: string;
    negativePrompt: string;
    // 以下仅「用户自定义风格」用(内置档不填):
    previewStorageKey?: string; // 预览图 storageKey(image:xxx),随预设云同步、换设备靠 resolveImageUrl 自愈
    custom?: boolean; // true=用户自定义(可编辑/删、归入「我的风格」分组)
    /** true=来自团队共享（他人分享，本人不可编辑/删除；由分享者或管理员在团队风格里取消共享）。 */
    shared?: boolean;
    /** 团队共享风格的预览图直链（服务端给的 URL，不是 storageKey——它存在团队存储里）。 */
    previewUrl?: string;
    /** 团队共享风格的分享者展示名，用于卡片上标注「来自 XXX」。 */
    ownerName?: string;
    updatedAt?: string; // LWW 合并用
};

// —— 用户自定义图片风格注册表 —— //
// 预设 store(use-preset-store)在变更/同步回灌时调 setCustomImageStyles 注册;lib 不反向依赖 store,避免循环。
// getImageStylePreset / 选择器 / composeImagePrompt 都据此让「内置 + 自定义」同源。
let customImageStyles: ImageStylePreset[] = [];
export function setCustomImageStyles(list: ImageStylePreset[]): void {
    customImageStyles = (list || []).map((s) => ({ ...s, custom: true }));
}

// 团队共享风格：与「我的风格」分开存一份注册表。
// 为什么不并进 customImageStyles：那个 setter 会把每一条都标成 custom:true，而 custom 正是
// 「可编辑/可删」的判据——并进去就等于让组内任何人都能改删别人分享的风格。
// 这里统一标 shared:true、custom:false，UI 据此只给「用」不给「改」。
let groupImageStyles: ImageStylePreset[] = [];
export function setGroupImageStyles(list: ImageStylePreset[]): void {
    groupImageStyles = (list || []).map((s) => ({ ...s, custom: false, shared: true }));
}

export type ImageViewPreset = {
    id: string;
    nameZh: string;
    nameEn: string;
    description: string;
    injectPrompt: string;
    negativePrompt: string;
    // 可选：选中该视图时自动把图片比例(config.size)设成此值（如三视图宽幅用 16:9）。
    aspect?: string;
};

export const IMAGE_STYLE_CATEGORIES: string[] = [
    "真人写实",
    "美式漫画·人物",
    "美式漫画·场景",
    "电影影视",
    "动漫二次元",
    "3D与CGI",
    "产品商业摄影",
    "插画美术",
    "氛围复古美学",
];

// ── 真人写实共享块（所有真人档复用，单点维护）─────────────────────────────
// 皮肤核心:哑光但不死板——matte T-zone + 仅局部微油、绝不整片油亮/湿亮高光;逐项写入真实微观瑕疵对抗默认磨皮;次表面散射+眼神光+胶片颗粒把分布从渲染拉回照片。
const REALISM_SKIN =
    "true-to-life human skin rendered as natural matte skin with visible pores, fine lines, faint freckles, subtle blemishes, fine peach-fuzz vellus hair and slightly uneven natural skin tone, a slightly matte T-zone showing only subtle localized oil and never an even glossy wet or greasy sheen across the face, soft natural subsurface scattering, realistic catchlights in the eyes, dry natural skin texture with real three-dimensional light and shadow, unretouched with no beauty filter and no over-smoothing, not waxy and not plastic and not doll-like, subtle fine film grain, authentic candid photographic look not a 3d render";
// 纯白无背景尾巴(人设三视图友好)。
const REALISM_BG =
    "on a plain seamless pure white studio background, clean and uncluttered, subject isolated with no scenery or props";
// 去塑料负面词:压塑料/蜡/磨皮/油亮/美颜滤镜,同时排除 perfect/flawless(会触发美颜默认值)与 powdery 死皮(防过矫)。
const REALISM_NEG =
    "oily skin, greasy shine, shiny sweaty forehead, glossy skin, wet-look skin, specular shine, sheen, skin glow, luminous skin, plastic skin, waxy skin, silicone skin, rubber skin, doll skin, mannequin skin, poreless skin, airbrushed skin, over-smoothed skin, flawless skin, perfect skin, beauty filter, facetune, instagram filter, over-retouched, over-sharpened digital sheen, matte painting, powdery cakey flat lifeless skin, 3d render, cgi, illustration, cartoon, oversaturated, deformed hands, extra fingers, distorted face, busy background, cluttered scenery, props, scenery, environment";

const realismStyle = (
    id: string,
    nameZh: string,
    nameEn: string,
    description: string,
    lead: string,
    extraNeg = "",
): ImageStylePreset => ({
    id,
    nameZh,
    nameEn,
    category: "真人写实",
    description,
    injectPrompt: `${lead}, ${REALISM_SKIN}, ${REALISM_BG}`,
    negativePrompt: extraNeg ? `${extraNeg}, ${REALISM_NEG}` : REALISM_NEG,
});

export const IMAGE_STYLE_PRESETS: ImageStylePreset[] = [
    realismStyle(
        "real-jp-clean-selfie",
        "日系清新",
        "Japanese Fresh Clean",
        "日系清新平光:柔和平光、真实毛孔绒毛雀斑不磨皮、轻颗粒、airy淡彩调,纯白底无背景。哑光但保留微高光不死板,姿势背景由你定,适合人设三视图。",
        "A candid photo in soft flat even daylight of a gentle overcast quality, low-contrast airy natural illumination, shot on a full-frame camera with a 35mm lens, gentle airy pastel color grading, clean and bright",
    ),
    realismStyle(
        "real-studio-rembrandt",
        "影棚商业·伦勃朗光",
        "Studio Commercial Rembrandt Light",
        "影棚伦勃朗布光:颧骨三角光+背缘光、85mm、真实毛孔次表面散射、中性精修,纯白底无背景。高级形象质感,三视图首选之一。",
        "A studio photo lit by a large softbox key light from the upper left creating Rembrandt lighting, a soft frontal fill light and a subtle back-right rim light for clean separation, shot on a full-frame camera with an 85mm f/2 portrait lens, controlled dynamic range with a clean true-to-life high-end commercial color grade",
        "blown highlights, flat lighting",
    ),
    realismStyle(
        "real-cinematic-character",
        "电影感人物",
        "Cinematic Character",
        "电影剧照质感:柔和定向光+青橙调+胶片颗粒、皮肤真实有故事感,纯白底无背景。给角色叙事感,姿势由你定。",
        "A cinematic film still with a soft directional key light and gentle shadow falloff, shot on a 35mm lens on a full-frame cinema camera, restrained teal-and-orange color grade with gently crushed shadows and low-key moody contrast, wide natural dynamic range",
        "hdr halo, halation glow",
    ),
    realismStyle(
        "real-golden-hour-outdoor",
        "黄金时刻",
        "Golden Hour",
        "黄昏暖光:逆光金边打发丝轮廓、50mm、眩光空气感、暖蜜调,逆光只勾边不打油脸,纯白底无背景。温暖光感,适合三视图。",
        "A photo in warm golden-hour light, a soft low-angle sun used as a backlight creating a glowing rim along the hair and shoulders with gentle bounced fill softening the face, shot on a full-frame camera with a 50mm f/1.8 lens, faint lens flare and a touch of light atmospheric haze, warm honeyed color grade; the backlight stays on the hair and shoulder rim only and must not make the facial skin glow or look oily",
        "harsh midday shadows",
    ),
    realismStyle(
        "real-street-documentary",
        "自然光纪实",
        "Natural Light Documentary",
        "自然光纪实:单一柔和自然光、35mm、保留皱纹毛孔雀斑、低饱和、胶片颗粒,纯白底无背景。质朴真实,中老年/职业人物质感强。",
        "A candid documentary photograph in a single soft directional natural light from camera left with gentle realistic shadow falloff, available natural light with no heavy styling, shot on a full-frame camera with a 35mm lens, true-to-life muted color grading, every pore wrinkle and freckle preserved, documentary unposed feel",
        "studio glamour, fashion styling, dramatic colored lighting",
    ),
    realismStyle(
        "real-clean-beauty-closeup",
        "清透美肤",
        "Clean Beauty Skin",
        "美肤质感:蛤壳柔光、100mm微距、毛孔绒毛雀斑、次表面散射通透肌,纯白底无背景。专治塑料脸,三视图正脸质感首选。",
        "A close-up photo with soft frontal clamshell lighting, bright even fill and twin catchlights, shot on a 100mm macro lens at f/4 on a full-frame camera, soft natural understated makeup, clean natural color grading, ultra-detailed lifelike skin micro-texture",
        "uncanny valley, pink doll skin, oversaturated makeup",
    ),
    {
        id: "cine-teal-orange",
        nameZh: "好莱坞大片·青橙调·人物",
        nameEn: "Hollywood Teal & Orange - Character",
        category: "电影影视",
        description: "经典商业大片观感:暖肤色压冷蓝阴影、宽银幕、变形宽荧幕镜头光晕,最稳的电影感万金油。【画人物用】",
        injectPrompt: "cinematic film still, Hollywood blockbuster color grade, teal and orange complementary palette, warm skin tones against cool teal shadows, anamorphic widescreen, anamorphic lens flare, shallow depth of field with creamy bokeh, motivated dramatic lighting with rim light and atmospheric haze, subtle film grain, high dynamic range, professional cinematography, ultra detailed",
        negativePrompt: "flat lighting, washed out colors, oversaturated, low contrast, snapshot, amateur, cluttered background",
    },
    {
        id: "cine-teal-orange-scene",
        nameZh: "好莱坞大片·青橙调·场景",
        nameEn: "Hollywood Teal & Orange - Scene",
        category: "电影影视",
        description: "同款青橙调色与宽银幕光影的空镜/场景档,不会凭空加人。【画场景用】",
        // 把「warm skin tones」换成「warm highlights」——原词是人物词，画空镜时会诱导模型塞进一个人。
        injectPrompt: "cinematic film still, Hollywood blockbuster color grade, teal and orange complementary palette, warm amber highlights against cool teal shadows, anamorphic widescreen, anamorphic lens flare, shallow depth of field with creamy bokeh, motivated dramatic lighting with rim light and atmospheric haze, subtle film grain, high dynamic range, professional cinematography, establishing shot of an environment, ultra detailed",
        negativePrompt: "people, person, human figure, crowd, portrait, character, flat lighting, washed out colors, oversaturated, low contrast, snapshot, amateur",
    },
    {
        id: "cine-neo-noir",
        nameZh: "新黑色·霓虹雨夜",
        nameEn: "Neo-Noir / Blade Runner",
        category: "电影影视",
        description: "赛博黑色片观感:青品红霓虹+深蓝阴影、雨夜湿地反光、低调布光大面积暗部,强氛围强对比、偏电影叙事低调布光。",
        injectPrompt: "neo-noir cinematic still, blade runner aesthetic, low-key lighting with most of the frame in deep shadow, chiaroscuro contrast, cyan and magenta neon glow with warm orange accents, rain-soaked reflective streets, volumetric haze and light shafts, hard rim backlight with soft fill, anamorphic look with subtle lens flare, moody desaturated palette, fine film grain, dramatic atmosphere, widescreen composition",
        negativePrompt: "bright daylight, flat even lighting, cheerful colors, high key, washed out, low contrast",
    },
    {
        id: "anime-cel-shaded",
        nameZh: "日系赛璐璐(动画截图)",
        nameEn: "Japanese Cel-Shaded Anime",
        category: "动漫二次元",
        description: "经典 TV 动画截图质感:硬边平涂色块、干净细线、两段式柔投影,画面像番剧定格画面,色彩明快。",
        injectPrompt: "Japanese cel-shaded anime style, clean crisp thin line art, flat color fills with hard-edged two-tone shadows, soft cel shading, bold confident linework, bright saturated palette, anime screencap look, simple gradient sky, 2D hand-drawn animation aesthetic, no visible brush texture",
        negativePrompt: "photorealistic, 3D render, realistic skin texture, thick oil paint texture, western cartoon style, blurry, overexposed highlights",
    },
    {
        id: "anime-shinkai-cinematic",
        nameZh: "新海诚式(光之绘景)·人物",
        nameEn: "Makoto Shinkai Cinematic Lighting - Character",
        category: "动漫二次元",
        description: "超精细写实背景+简洁人物,体积光阳光透射、镜头光晕、通透天空与云、湿润玻璃反光,电影级唯美氛围。【画人物用】",
        injectPrompt: "ultra-detailed cinematic anime film background, hyper-detailed realistic scenery with simple clean character design, volumetric god rays of warm sunlight, lens flare and light bloom, luminous translucent sky with crisp clouds, glossy reflective surfaces, soft melancholic atmosphere, photoreal lighting on hand-drawn art, high detail, reminiscent of modern Japanese animated film aesthetics",
        negativePrompt: "flat colors, low detail background, muddy lighting, western cartoon, harsh black outlines",
    },
    {
        id: "anime-shinkai-cinematic-scene",
        nameZh: "新海诚式(光之绘景)·场景",
        nameEn: "Makoto Shinkai Cinematic Lighting - Scene",
        category: "动漫二次元",
        description: "同款光之绘景的纯空镜档,去掉人物设计词,不会凭空加人。【画场景用】",
        // 去掉「with simple clean character design」，换成明确的无人空镜取向。
        injectPrompt: "ultra-detailed cinematic anime film background, hyper-detailed realistic scenery, unpopulated empty landscape, volumetric god rays of warm sunlight, lens flare and light bloom, luminous translucent sky with crisp clouds, glossy reflective surfaces, soft melancholic atmosphere, photoreal lighting on hand-drawn art, high detail, reminiscent of modern Japanese animated film aesthetics",
        negativePrompt: "people, person, human figure, crowd, character, portrait, flat colors, low detail background, muddy lighting, western cartoon, harsh black outlines",
    },
    {
        id: "anime-donghua-guofeng",
        nameZh: "国漫古风(东方动画)·人物",
        nameEn: "Chinese Donghua / Guofeng - Character",
        category: "动漫二次元",
        description: "中式动画美学:古风3D光影体积感、东方建筑与飘逸汉服、传统与现代融合、明亮多彩、奇幻场景与动态光效。【画人物用】",
        injectPrompt: "Chinese donghua animation style, guofeng aesthetic blending traditional Chinese art with modern 3D-cinematic depth, elegant flowing hanfu costumes, traditional Chinese architecture and fantasy landscapes, bright vivid color palette, soft cinematic volumetric lighting, dynamic glowing light effects, refined detailed rendering, ethereal oriental atmosphere",
        negativePrompt: "western cartoon, japanese moe anime, flat low detail, photorealistic photo",
    },
    {
        id: "anime-donghua-guofeng-scene",
        nameZh: "国漫古风(东方动画)·场景",
        nameEn: "Chinese Donghua / Guofeng - Scene",
        category: "动漫二次元",
        description: "同款国漫古风画法的空镜档,保留东方建筑与山水、去掉汉服人物词。【画场景用】",
        // 去掉「elegant flowing hanfu costumes」（服饰=人物），把建筑/山水提到主位。
        injectPrompt: "Chinese donghua animation style, guofeng aesthetic blending traditional Chinese art with modern 3D-cinematic depth, traditional Chinese architecture, misty mountains and fantasy landscapes, unpopulated empty scenery, bright vivid color palette, soft cinematic volumetric lighting, dynamic glowing light effects, refined detailed rendering, ethereal oriental atmosphere",
        negativePrompt: "people, person, human figure, crowd, character, hanfu costume, portrait, western cartoon, japanese moe anime, flat low detail, photorealistic photo",
    },
    {
        id: "3d-pixar-disney",
        nameZh: "皮克斯/迪士尼3D动画·人物",
        nameEn: "Pixar / Disney 3D Animation - Character",
        category: "3D与CGI",
        description: "温暖讨喜的皮克斯/迪士尼电影级3D卡通,大眼软皮肤、次表面散射通透感,适合做可爱角色头像和故事插画。【画人物用】",
        injectPrompt: "in the style of a Pixar Disney 3D animated movie still, stylized 3D cartoon character, expressive oversized eyes with soft catchlights, smooth rounded features, soft 3D skin with subsurface scattering so skin glows warmly, glossy hair highlights, cinematic three-point studio lighting, warm soft global illumination, gentle soft shadows, softly blurred pastel background, polished CGI finish, high detail",
        negativePrompt: "photorealistic photo, real human skin pores, harsh flat lighting, ugly, deformed, extra fingers, plastic toy look, low detail, watermark, text",
    },
    {
        id: "3d-pixar-disney-scene",
        nameZh: "皮克斯/迪士尼3D动画·场景",
        nameEn: "Pixar / Disney 3D Animation - Scene",
        category: "3D与CGI",
        description: "同款皮克斯3D质感的场景/道具档,保留柔光与通透渲染、去掉大眼软皮肤等角色词。【画场景用】",
        // 原档几乎整句都在描述角色（character/eyes/skin/hair），场景档只保留「渲染与打光语言」，
        // 换成环境与道具设计取向——否则画一间空房间也会凭空冒出个卡通角色。
        injectPrompt: "in the style of a Pixar Disney 3D animated movie still, stylized 3D environment and prop design, rounded friendly shapes with soft bevels, warm inviting art direction, cinematic soft global illumination, gentle soft shadows, subtle depth of field, rich but gentle color palette, polished CGI finish, unpopulated empty set, high detail",
        negativePrompt: "people, person, human figure, crowd, character, creature, face, photorealistic photo, harsh flat lighting, low detail, watermark, text",
    },
    {
        id: "3d-chibi-figure",
        nameZh: "Q版三头身手办(C4D)·人物",
        nameEn: "Chibi C4D Figure - Character",
        category: "3D与CGI",
        description: "三头身大头Q版手办风,C4D/Octane软塑料质感+柔光,玩具收藏摆件即视感,适合做萌系IP和盲盒角色。【画人物用】",
        injectPrompt: "cute chibi 3D character render, big head small compact body proportions, large glossy eyes with soft reflections, soft claymorphism smooth toy-like surface, subsurface scattering for natural skin glow, C4D Octane render, soft cinematic studio lighting, warm gentle light, soft shadow beneath the figure, clean pastel gradient background, collectible vinyl figure aesthetic, smooth matte-glossy material, high detail",
        negativePrompt: "realistic adult proportions, photographic, harsh shadows, sharp scary features, text, watermark, low poly, jagged edges",
    },
    {
        id: "3d-chibi-figure-scene",
        nameZh: "Q版三头身手办(C4D)·场景",
        nameEn: "Chibi C4D Figure - Scene",
        category: "3D与CGI",
        description: "同款软塑料手办材质的微缩场景档(小房间/小街景/摆件),不含人物。【画场景用】",
        // 这一档原本整句都在描述「人形手办」（三头身/大眼/皮肤），没法只删几个词。
        // 场景版改成把同一套材质语言（claymorphism 软塑料 + C4D Octane 柔光）用在微缩立体场景上，
        // 保住风格辨识度，同时彻底不提人。
        injectPrompt: "cute miniature 3D diorama render, soft claymorphism smooth toy-like surfaces, rounded chunky stylized props and architecture, C4D Octane render, soft cinematic studio lighting, warm gentle light, soft contact shadows, clean pastel gradient background, collectible vinyl toy scene aesthetic, smooth matte-glossy material, tilt-shift miniature feel, unpopulated empty scene, high detail",
        negativePrompt: "people, person, human figure, crowd, character, chibi character, face, eyes, photographic, harsh shadows, text, watermark, low poly, jagged edges",
    },
    {
        id: "prod-ecommerce-white",
        nameZh: "电商白底精修",
        nameEn: "Ecommerce White Background",
        category: "产品商业摄影",
        description: "纯白无影背景、均匀柔光、商品居中带轻接地阴影,符合亚马逊/天猫主图规范的干净电商图。建议比例 1:1。",
        injectPrompt: "professional ecommerce product photography, centered on a seamless pure white studio background, soft even diffused studio lighting from large overhead softbox, shadow-free background with a slight soft contact shadow beneath the product grounding it on the surface, three-point lighting with white fill reflector to eliminate harsh shadows, sharp focus across the entire product revealing material texture and detail, true color accurate, shot on 85mm lens at f/8, commercial catalog look, clean minimal, high resolution, photorealistic",
        negativePrompt: "harsh shadows, colored cast, cluttered background, props, reflections of photographer, floating product, blurry, low resolution, watermark, text",
    },
    {
        id: "prod-luxury-soft",
        nameZh: "奢品柔光质感",
        nameEn: "Luxury Soft-Light",
        category: "产品商业摄影",
        description: "大柔光箱包裹式柔光、极淡阴影与细腻高光,灰渐变或大理石台面,呈现高级奢侈品的精致优雅。",
        injectPrompt: "luxury product photography, soft diffused lighting from a large octabox softbox creating gentle wraparound illumination, subtle rim light for elegant edge definition, minimal soft shadows, smooth gradient grey-to-white seamless background, product resting on a polished marble surface with a soft natural reflection and subtle marble vein texture, refined specular highlights revealing premium material finish, shallow depth of field, 85mm lens at f/2.8, sophisticated editorial aesthetic, calm premium mood, photorealistic, ultra detailed",
        negativePrompt: "harsh shadows, hard light, cluttered, cheap plastic look, oversaturated, neon colors, busy background, blurry product, watermark",
    },
    {
        id: "art-watercolor",
        nameZh: "通透水彩",
        nameEn: "Luminous Watercolor",
        category: "插画美术",
        description: "湿画法水彩,颜料在湿纸上自然晕染流淌、边缘泛色、留白做高光,通透轻盈有手绘纸纹。",
        injectPrompt: "rendered as a luminous watercolor painting, loose wet-on-wet washes with pigment blooming and bleeding softly into the wet paper, delicate transparent color layers, granulating pigment pooling at the edges, visible cold-pressed paper texture, white of the paper left as highlights, gentle gradients, soft uneven hand-painted edges, airy and fluid, traditional aquarelle medium",
        negativePrompt: "digital flat color, hard vector edges, 3d render, photographic, harsh outlines, oversaturated, plastic look",
    },
    {
        id: "art-concept-art",
        nameZh: "影视概念设计",
        nameEn: "Cinematic Concept Art",
        category: "插画美术",
        description: "游戏/影视级数字概念设计稿,电影感戏剧光影、大气环境氛围、厚涂数字绘画,ArtStation 精品质感。",
        injectPrompt: "professional digital concept art, cinematic environment design, dramatic volumetric lighting and atmospheric haze, painterly digital matte painting, epic composition with strong depth and scale, moody color grading, rim light and soft key light, highly detailed intricate rendering, key art illustration quality",
        negativePrompt: "flat lighting, amateur, low detail, snapshot, watermark, text, oversimplified, ugly composition",
    },
    {
        id: "mood-vintage-film-kodak",
        nameZh: "胶片复古·人物",
        nameEn: "Vintage Film / Kodak Portra - Character",
        category: "氛围复古美学",
        description: "经典胶片质感,暖调柔光、自然肤色、细腻颗粒、高光柔和过渡,怀旧文艺;最适合人像、生活日常与街拍。【画人物用】",
        injectPrompt: "shot on 35mm analog film, Kodak Portra 400 aesthetic, warm natural skin tones, soft diffused light, gentle warm highlights, low contrast film color, fine organic film grain, subtle halation and light leak, slight vignette, nostalgic analog mood, cinematic still, shallow depth of field, photorealistic",
        negativePrompt: "oversaturated, harsh HDR, digital plastic skin, oversharpened, neon colors, CGI render",
    },
    {
        id: "mood-vintage-film-kodak-scene",
        nameZh: "胶片复古·场景",
        nameEn: "Vintage Film / Kodak Portra - Scene",
        category: "氛围复古美学",
        description: "同款胶片质感的空镜/静物档,把肤色词换成整体色彩还原,不会凭空加人。【画场景用】",
        // 「warm natural skin tones」是人物词，换成「warm natural color rendition」，胶片观感不变。
        injectPrompt: "shot on 35mm analog film, Kodak Portra 400 aesthetic, warm natural color rendition, soft diffused light, gentle warm highlights, low contrast film color, fine organic film grain, subtle halation and light leak, slight vignette, nostalgic analog mood, cinematic still of an empty scene, shallow depth of field, photorealistic",
        negativePrompt: "people, person, human figure, crowd, portrait, character, oversaturated, harsh HDR, oversharpened, neon colors, CGI render",
    },
    {
        id: "mood-hongkong-retro",
        nameZh: "港风复古",
        nameEn: "Hong Kong Retro 90s",
        category: "氛围复古美学",
        description: "王家卫式90年代港片质感:霓虹夜色、暖暮+青绿阴影、暗调背光与胶片颗粒,慵懒怀旧;最适合都市夜景人像与电影感场景。",
        injectPrompt: "1990s Hong Kong cinematic aesthetic, Wong Kar-wai style, moody neon-lit night, muted saturated film color, warm amber and teal-green tint in shadows, dramatic low-key back lighting with rim light, glowing neon signage reflections, vintage 40mm lens look, slight light distortion and halation, nostalgic melancholic mood, film grain, dreamlike cinematic still, photorealistic",
        negativePrompt: "bright flat daylight, clean modern look, pastel colors, oversharpened digital, HDR",
    },
    // —— 美式漫画(短剧生产版,来自「美漫短剧提示词包」六套基底) —— //
    // 每套基底拆「·人物」「·场景」两档:人物档保留皮肤/表情/体格等主体描述(出角色更准),
    // 场景档只留画法+环境倾向并排除「描述中未提及的人物」——否则主体词会把人硬塞进空镜(实测:用人物档画场景会凭空多出人)。
    // 视频侧对应档只锁画风、不提人物也不提场景(见 video-style-presets)。做剧只锁一套基底,勿跨基底混用。
    {
        id: "comic-a-flat",
        nameZh: "现代平涂",
        nameEn: "Modern Flat Comic (Invincible) - Character",
        category: "美式漫画·人物",
        description: "干净平涂、粗黑描边、无印刷质感,多帧一致性最好,叙事剧/对话戏首选。【画人物用】",
        injectPrompt: "美式漫画风格,现代平涂:modern American comic art, clean bold linework, flat cel-shaded colors, minimal gradients, bright saturated palette, expressive character acting, clean digital coloring, no print texture。避免照片写实、3D渲染、日系萌系,画面中不出现任何文字和水印。",
        negativePrompt: "",
    },
    {
        id: "comic-a-flat-scene",
        nameZh: "现代平涂",
        nameEn: "Modern Flat Comic (Invincible) - Scene",
        category: "美式漫画·场景",
        description: "同款平涂画法的空镜/场景档,不会凭空加人。【画场景用】",
        injectPrompt: "美式漫画风格,现代平涂:modern American comic art, clean bold linework, flat cel-shaded colors, minimal gradients, bright saturated palette, clean digital coloring, no print texture, environment and background illustration。避免照片写实、3D渲染、日系萌系,画面中不出现描述中未提及的人物,不出现任何文字和水印。",
        negativePrompt: "",
    },
    {
        id: "comic-b-superhero",
        nameZh: "主流超英",
        nameEn: "Superhero Comic (Marvel/DC) - Character",
        category: "美式漫画·人物",
        description: "硬朗健硕、半调网点阴影、大片低角度构图,超级英雄动作题材首选。【画人物用】",
        injectPrompt: "dynamic American superhero comic art, bold black ink outlines, cel-shaded saturated colors, muscular heroic anatomy, halftone dot shading, dramatic low-angle composition, modern Marvel/DC comics style。避免照片写实、3D渲染,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-b-superhero-scene",
        nameZh: "主流超英",
        nameEn: "Superhero Comic (Marvel/DC) - Scene",
        category: "美式漫画·场景",
        description: "同款超英画法的空镜/场景档,不会凭空加人。【画场景用】",
        injectPrompt: "dynamic American superhero comic art, bold black ink outlines, cel-shaded saturated colors, halftone dot shading, dramatic low-angle composition, modern Marvel/DC comics style, environment and background illustration。避免照片写实、3D渲染,画面中不出现描述中未提及的人物,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-c-spiderverse",
        nameZh: "Spider-Verse",
        nameEn: "Spider-Verse - Character",
        category: "美式漫画·人物",
        description: "套印错位+边缘色差+Kirby能量点,最炫;适合高强度动作/炫技段。【画人物用】",
        injectPrompt: "Into the Spider-Verse art style, halftone dot shading, CMYK offset print misregistration, chromatic aberration on edges, bold ink outlines, expressive stylized character rendering, Kirby dots energy effects, graffiti-pop neon color palette, 2.5D comic-render look。避免照片写实,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-c-spiderverse-scene",
        nameZh: "Spider-Verse",
        nameEn: "Spider-Verse - Scene",
        category: "美式漫画·场景",
        description: "同款套印错位/色差画法的空镜/场景档,不会凭空加人。【画场景用】",
        injectPrompt: "Into the Spider-Verse art style, halftone dot shading, CMYK offset print misregistration, chromatic aberration on edges, bold ink outlines, Kirby dots energy effects, graffiti-pop neon color palette, 2.5D comic-render look, environment and background illustration。避免照片写实,画面中不出现描述中未提及的人物,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-d-noir",
        nameZh: "黑色犯罪noir",
        nameEn: "Noir (Sin City) - Character",
        category: "美式漫画·人物",
        description: "黑白高对比+厚重墨影+单一红色点缀,悬疑/罪案/黑帮签名风格。【画人物用】",
        injectPrompt: "noir comic art, stark high-contrast black and white, heavy ink shadows, dramatic chiaroscuro, stark white silhouettes against black, single spot color: red, gritty hard-boiled film noir atmosphere。避免照片写实,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-d-noir-scene",
        nameZh: "黑色犯罪noir",
        nameEn: "Noir (Sin City) - Scene",
        category: "美式漫画·场景",
        description: "同款黑白高对比画法的空镜/场景档(雨夜街道等),不会凭空加人。【画场景用】",
        injectPrompt: "noir comic art, stark high-contrast black and white, heavy ink shadows, dramatic chiaroscuro, rain-slick streets, single spot color: red, gritty hard-boiled film noir atmosphere, environment and background illustration。避免照片写实,画面中不出现描述中未提及的人物,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-e1-popart-clean",
        nameZh: "复古波普·干净",
        nameEn: "Retro Pop-art (Clean) - Character",
        category: "美式漫画·人物",
        description: "粗线+三原色平涂+夸张情绪表情,干净无网点、脸最干净;复古情绪爆点。【画人物用】",
        injectPrompt: "复古波普美漫风格 retro pop-art / vintage American comic look, bold black ink outlines, bright saturated flat cel colors, clean smooth flat skin, glamorous dramatic exaggerated facial expression, punchy red-yellow-blue leaning palette, crisp clean comic rendering。避免:任何网点/screentone、点状渐变阴影、日系、照片写实、3D渲染、柔光渐变,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-e1-popart-clean-scene",
        nameZh: "复古波普·干净",
        nameEn: "Retro Pop-art (Clean) - Scene",
        category: "美式漫画·场景",
        description: "同款干净波普画法的空镜/场景档(无网点),不会凭空加人。【画场景用】",
        injectPrompt: "复古波普美漫风格 retro pop-art / vintage American comic look, bold black ink outlines, bright saturated flat cel colors, punchy red-yellow-blue leaning palette, crisp clean comic rendering, environment and background illustration。避免:任何网点/screentone、点状渐变阴影、日系、照片写实、3D渲染、柔光渐变,画面中不出现描述中未提及的人物,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-e2-popart-print",
        nameZh: "复古波普·印刷",
        nameEn: "Retro Pop-art (Ben-Day Print) - Character",
        category: "美式漫画·人物",
        description: "Ben-Day 网点作平面印刷底纹+套印错位+旧报纸味;网点只铺底纹不做脸部阴影。【画人物用】",
        injectPrompt: "复古波普美漫风格·复古印刷版 retro pop-art / Silver Age printed comic look, bold black ink outlines, bright saturated flat colors, glamorous dramatic exaggerated facial expression, punchy red-yellow-blue palette, flat even Ben-Day halftone dots as a uniform vintage print texture (mainly on background and flat color fields), slight off-register CMYK printing, faint yellowed newsprint feel。避免:用网点做立体渐变阴影、满脸厚重点状阴影、照片写实、3D、日系、柔光渐变,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-e2-popart-print-scene",
        nameZh: "复古波普·印刷",
        nameEn: "Retro Pop-art (Ben-Day Print) - Scene",
        category: "美式漫画·场景",
        description: "同款网点印刷画法的空镜/场景档(旧报纸味),不会凭空加人。【画场景用】",
        injectPrompt: "复古波普美漫风格·复古印刷版 retro pop-art / Silver Age printed comic look, bold black ink outlines, bright saturated flat colors, punchy red-yellow-blue palette, flat even Ben-Day halftone dots as a uniform vintage print texture (mainly on background and flat color fields), slight off-register CMYK printing, faint yellowed newsprint feel, environment and background illustration。避免:用网点做立体渐变阴影、照片写实、3D、日系、柔光渐变,画面中不出现描述中未提及的人物,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-f-arcane",
        nameZh: "Arcane厚涂",
        nameEn: "Arcane Painterly (Fortiche) - Character",
        category: "美式漫画·人物",
        description: "手绘厚涂笔触+半写实+电影光+霓虹脏彩,质感天花板;一致性最差,只用于关键单帧/海报/短段。【画人物用】",
        injectPrompt: "《英雄联盟:双城之战》Arcane 厚涂动画风格 Fortiche painterly style, textured hand-painted brushwork, visible oil-paint strokes, semi-realistic stylized proportions, gritty dieselpunk/steampunk world, moody cinematic lighting, vibrant neon accents (magenta, cyan, teal), painterly skin shading, graffiti-pop background texture, 2.5D rendered animation look。避免纯平涂日系、照片写实、光滑塑料3D,无文字水印。",
        negativePrompt: "",
    },
    {
        id: "comic-f-arcane-scene",
        nameZh: "Arcane厚涂",
        nameEn: "Arcane Painterly (Fortiche) - Scene",
        category: "美式漫画·场景",
        description: "同款厚涂笔触+霓虹脏彩的空镜/场景档(蒸汽底城等),不会凭空加人。【画场景用】",
        injectPrompt: "《英雄联盟:双城之战》Arcane 厚涂动画风格 Fortiche painterly style, textured hand-painted brushwork, visible oil-paint strokes, gritty dieselpunk/steampunk world, moody cinematic lighting, vibrant neon accents (magenta, cyan, teal), painterly rendering with visible brush texture, graffiti-pop background texture, 2.5D rendered animation look, environment and background illustration。避免纯平涂日系、照片写实、光滑塑料3D,画面中不出现描述中未提及的人物,无文字水印。",
        negativePrompt: "",
    },
];

export const IMAGE_VIEW_PRESETS: ImageViewPreset[] = [
    {
        id: "real-turnaround",
        nameZh: "真人三视图",
        nameEn: "Character Turnaround",
        description: "人设转面图排版:左大正脸特写(强制正面平视直看镜头)+右三张全身(正/侧/背)、直立站姿双手垂放、各视图同角色同服装、纯白背景。表情/鞋履等造型交给你的描述,预设只管排版,质感交给风格档叠加。",
        injectPrompt: "character model sheet turnaround of the exact same person repeated with consistent identical appearance and outfit across every view, laid out with a large head-and-shoulders close-up on the left that must face the camera perfectly straight-on at eye level — head upright and perfectly level, neither tilted up nor down, chin not raised, eyes looking directly into the lens, a frontal symmetric portrait — and three evenly spaced full-body shots on the right — front view, left side profile view, and back view — standing upright with arms hanging straight down naturally at the sides and feet together, identical hairstyle and clothing in all views, keep the same facial expression and the same footwear as described, full body fully visible and not cropped, flat neutral studio lighting that is consistent across all views with no harsh shadows, orthographic camera, on a plain seamless pure white studio background, clean uncluttered professional character reference sheet",
        negativePrompt: "different outfits, inconsistent character, different faces, cropped body, cut off limbs, harsh cinematic shadows, busy background, scenery, props, text, watermark, deformed hands, extra fingers, left close-up tilted or angled, chin raised in the close-up, three-quarter or profile close-up, close-up looking away from the camera or looking down",
        aspect: "16:9",
    },
    {
        // 「非真人三视图」。设计依据：把公开案例库与真实提示词日志里
        // 实践者真正用的写法挖了一遍，结论有四条，改动都由它们推出来：
        //  1. 英文语料里根本不存在成熟的「反人形化」措辞；唯一成熟的一条是中文，
        //     写法是「保留真实动物的头身比与四肢结构，绝非『兽头＋人类身躯』」——
        //     它【允许】双足直立，只否定「兽头＋人身」这一个具体错误构型。本条照此设计。
        //  2. 想要人形化的用户（兽人/人身兽首）远多于想要反人形化的，量级差了好几倍。
        //     所以硬性反拟人词一律不能进 negativePrompt —— 那会对拟人角色和人形机甲开火。
        //     ⚠️ 反人形表述共四处：负面词三条（`human face`、`human hairstyle` 切头部区，
        //     以及 `humanized body replacing the subject's own` —— 用 replacing 把否定限定在
        //     「用人类身体整体替换掉本体」这一构型，不指名 torso/legs/arms，故不会对拟人角色与机甲逐项开火）；
        //     正面词里 `never a human torso with the subject's head attached` 一条从句，
        //     它是【故意写成可整句删除】的：若收到「我要画兽人却被顶回野兽体型」的投诉，第一个砍它，
        //     砍掉后其余部分仍独立成立。**绝不要改去往 negativePrompt 里补 human torso/legs/arms。**
        //  3. `orthographic camera` 是无据写法（535 案例里仅 2 次且都是标签不是相机指令），
        //     且与同一句里的「大头特写」物理互斥（特写必然透视），已删。
        //  4. 左格退化成半身胸像是因为只写了 head close-up。实践者能拿到「只有头」靠的是三重约束：
        //     只有头/不要躯干肩膀/装不下就缩小且不许裁切。已照抄。
        // 姿态一律不写具体动作，只给可枚举的承重方式（含 upright on two），四足与双足都合法。
        id: "creature-turnaround",
        nameZh: "非真人三视图",
        nameEn: "Subject Turnaround",
        description: "给动物、鸟类、鱼类、昆虫、怪物、吉祥物、机甲机器人等非真人对象出转面设定图：左边一张完整的头部特写，右边正面、侧面、背面三张全身图，等比例排列、纯白背景、四格造型与配色一致。会按你写的体型、肢体结构和站立/趴伏/栖停/悬浮方式来画。若你要画的是人，或身体是人类比例的兽人／拟人角色，请改选「真人三视图」。",
        injectPrompt: "non-human creature or machine model sheet turnaround, four panels on a plain seamless pure white background: at the left one large close-up of the head alone, no torso or shoulders, seen from directly in front, the whole head scaled down to fit, never cut off; at the right three panels in a row at the same scale on one common baseline, in this order - front, side profile, back - each whole body inside the frame. Draw the subject's own anatomy: its own body plan, the same number and shape of limbs, the same head-to-body proportion, its limbs staying its own limbs, and the same way it carries its weight - on four or more legs, coiled, perched, upright on two, or floating - never a human torso with the subject's head attached. Identical subject, colours, markings, materials and lighting in all four panels, flat even studio lighting, panels never overlapping, clean uncluttered layout",
        negativePrompt: "human face, human hairstyle, humanized body replacing the subject's own, subject changing between panels, portrait or bust crop, cropped head, cut off limbs, overlapping or unequal panels, harsh shadows, scenery, unrelated props, text, labels, watermark",
        aspect: "16:9",
    },
];

export function getImageStylePreset(id?: string): ImageStylePreset | undefined {
    if (!id) return undefined;
    const builtin = IMAGE_STYLE_PRESETS.find((p) => p.id === id);
    if (builtin) return builtin;
    const own = customImageStyles.find((p) => p.id === id);
    if (own) return own;
    // 团队共享风格也要能按 id 解析：否则选中后 composeImagePrompt 拿不到助词，等于选了个空风格。
    return groupImageStyles.find((p) => p.id === id);
}

export function getImageViewPreset(id?: string): ImageViewPreset | undefined {
    if (!id) return undefined;
    return IMAGE_VIEW_PRESETS.find((p) => p.id === id);
}

export function composeImagePrompt(prompt: string, styleId?: string, viewId?: string): string {
    const style = getImageStylePreset(styleId);
    const view = getImageViewPreset(viewId);
    const parts = [prompt.trim()];
    if (view) parts.push(view.injectPrompt.trim());
    if (style) parts.push(style.injectPrompt.trim());
    let styled = parts.filter(Boolean).join("\n\n");
    const negatives = [view?.negativePrompt, style?.negativePrompt].map((n) => (n || "").trim()).filter(Boolean);
    if (negatives.length) styled = `${styled}\n\nAvoid: ${negatives.join(", ")}.`;
    return styled;
}
