// 画布图片「按显示尺寸取小图」(LOD)。
//
// 背景：画布上的图片节点直接把原图挂在 <img src> 上，靠 object-contain 缩。而 AI 出图的分辨率
// 普遍在百万像素量级、4K 档能到四千万以上，节点在画布上却通常只有几百 px 见方——浏览器每帧都在
// 把 4MP 位图缩到 300px 画，多解码/多合成十几倍的像素。视口裁剪已经做过了，剩下的就是「单个元素太重」。
//
// 做法：火山 TOS 自带图片处理，给公共读地址加 `?x-tos-process=image/resize,l_<长边>/format,webp`
// 就能拿到一张小图。实测（各桶均可用，无需额外开通）：
//   3840×2160 PNG 8374 KB → l_512/webp 512×288  24.5 KB  （342×）
//   1440×2560 PNG  732 KB → l_512/webp 288×512   2.5 KB  （293×）
// 存量图片无需重新生成、不占额外存储，加个参数即刻生效。
//
// ⚠️ 只能用于【显示】。生成、下载、导出、图片编辑、人像/素材授权、内容哈希一律必须用原图——
// 它们读的是 node.metadata.content，与这里返回的显示地址无关，别把这个函数接到那些链路上。

// 档位阶梯。只用固定几档而不是按需精确计算：每个不同的 URL 都是一次独立的 TOS 处理请求 + 一条独立
// 缓存，档位无限多会把缓存打散、把处理次数放大。
//
// ⚠️ 下限必须够小。缩小看全局时（如 0.1 倍）一个 300px 的节点只占屏幕 30px，若最小档是 512，
// 等于为一个 30px 的小方块解码并合成 512px 的位图——像素多出十几倍，正是「缩小后更卡」的直接原因。
// 64 档相对 512 档的位图面积是 1/64，几百个节点同屏时差别极大。
const LOD_LADDER = [64, 128, 256, 512, 1024, 2048] as const;

// 只对火山 TOS 的公共读域名生效。其它来源（外部图床、我们自己的 /api 代理、blob:、data:）
// 不支持这个参数，贴上去会 400 或原样返回，反而多一次失败请求。
const TOS_HOST_RE = /^[a-z0-9-]+\.tos-cn-[a-z0-9-]+\.volces\.com$/i;

/**
 * 判断这个地址能不能挂 x-tos-process 处理参数：能则原样返回，不能返回空串。
 *
 * 抽出来是因为视频首帧封面（canvas-video-poster.ts）要用完全相同的两条判据：
 *   ① 带查询串的一律不动——签名地址加参数会破坏签名，已带 x-tos-process 的不该叠加；
 *   ② 只认火山 TOS 的公共读域名——CDN 自定义域 / 外部图床 / /api 代理 / blob: / data:
 *      贴上去会 400 或原样返回，白搭一次失败请求。
 *
 * ⚠️ 只判「能不能加参数」，不判「加哪种参数」：图片走 image/*、视频走 video/*，两者按对象类型
 *    互斥（实测给视频对象加 image/resize 直接 400），生成逻辑必须各写各的。
 */
export function tosProcessableUrl(rawUrl: string | undefined): string {
    const url = (rawUrl || "").trim();
    if (!url) return "";
    if (url.includes("?")) return "";
    if (!/^https?:\/\//i.test(url)) return "";
    let host = "";
    try {
        host = new URL(url).host;
    } catch {
        return "";
    }
    if (!TOS_HOST_RE.test(host)) return "";
    return url;
}

/**
 * 返回用于显示的小图地址；不适用时返回空串（调用方回退原图）。
 *
 * @param rawUrl       原图地址
 * @param displayLongEdgePx 该图在屏幕上实际占的长边像素（已含缩放与 devicePixelRatio）
 * @param naturalLongEdge   原图长边像素，已知时用于判断「换小图是否真有收益」
 */
export function tosDisplayThumbUrl(rawUrl: string | undefined, displayLongEdgePx: number, naturalLongEdge?: number): string {
    if (!displayLongEdgePx || displayLongEdgePx <= 0) return "";
    // 「带查询串不碰 + 只认 TOS 公共读域名」这两条判据与视频封面共用一份（见 tosProcessableUrl）。
    const url = tosProcessableUrl(rawUrl);
    if (!url) return "";

    const tier = LOD_LADDER.find((value) => value >= displayLongEdgePx);
    if (!tier) return ""; // 显示尺寸已超过最大档 → 直接用原图，避免放大反而更糊
    // 原图本来就不比这一档大，换了没收益还多一次请求
    if (naturalLongEdge && naturalLongEdge <= tier) return "";

    // quality,q_90：默认 webp 质量偏软，细节多的图在缩略图档位上会糊。实测同一张 3840×2160：
    // l_1024 默认 77.7KB → q_90 98.4KB（+27%），换来的锐度在画布上肉眼可见。
    return `${url}?x-tos-process=image/resize,l_${tier}/format,webp/quality,q_90`;
}

/**
 * 由节点尺寸与画布缩放算出该图在屏幕上的长边像素。
 * 乘 devicePixelRatio 是为了在高清屏上不发虚（2 倍屏上 300 CSS px 实际要 600 物理像素）。
 */
export function displayLongEdgePx(nodeWidth: number, nodeHeight: number, scale: number, dpr = 1): number {
    const longEdge = Math.max(nodeWidth || 0, nodeHeight || 0);
    if (longEdge <= 0) return 0;
    const zoom = scale > 0 ? scale : 1;
    const ratio = dpr > 0 ? dpr : 1;
    return Math.ceil(longEdge * zoom * ratio);
}

/**
 * 从 LOD 地址反解出档位；无参数（原图）视为最高档，空串为 0。仅用于调试与测试断言。
 */
export function lodTierOf(url: string): number {
    const match = url.match(/image\/resize,l_(\d+)/);
    if (!match) return url ? Number.MAX_SAFE_INTEGER : 0;
    return Number(match[1]);
}

/**
 * 把连续的缩放值量化成粗档位，只有跨档时才会变。
 *
 * 缩放是连续量：一次滚轮手势会产出几十个 scale 值。若 LOD 直接依赖原始 scale，
 * 几百个节点每帧都要重跑一遍副作用（清定时器、设定时器、换 src），本身就成了卡顿源
 * ——这正是「加了 LOD 之后缩小反而更卡」的一部分原因。
 *
 * 量化到 2 的整数次幂：与档位阶梯同为倍增关系，跨档次数天然与档位数同阶（一次手势最多几次），
 * 且同一档内节点完全不需要重算。夹在 [1/32, 8] 内覆盖 0.05~5 的缩放范围。
 */
/**
 * 低于该缩放进入「远景视图」：节点只画本体，省掉缩放手柄 / 连线圆点 / 名字标签 / 信息条。
 * 取 0.35 —— 量化后即「0.25 及更小进远景，0.5 及更大保持完整」。
 * 0.25 倍时 14px 的手柄只有 3.5 个屏幕像素、名字标签的字更是糊成一条，删掉没有可感知的损失。
 */
export const NODE_FAR_VIEW_ZOOM = 0.35;

/**
 * 缩放达到该档就【不再用小图，直接上原图】。
 *
 * 起因：用户反馈「没放大之前的缩略图太糊，必须放大到最大才切高清」。原因是档位阶梯最高只有 2048，
 * 而 tier 只在「显示尺寸超过最高档」时才回退原图——640px 的节点在 1 倍屏上要放大到 320% 才够得着，
 * 所以在常用的 50%~150% 区间里看到的一直是 1024/2048 的 webp。
 *
 * 现在按用户要的口径：缩放到这一档及以上就用原图。代价是这时每个可见节点都要解一张完整位图
 * （3840×2160 的图约 33MB RGBA），但视口裁剪保证放大时同屏节点本来就没几个，是划算的交换。
 * 真嫌卡就把这个值调大（比如 1），缩略图区间会相应变长。
 *
 * ⚠️ 比较的是 zoomBucketOf 量化【之后】的值：0.5 这一档覆盖实际缩放约 0.35~0.71，
 *    所以实际是「缩放约 35% 以上」就切原图，比字面的 50% 略早一点。
 */
export const LOD_FULL_QUALITY_ZOOM = 0.5;

export function zoomBucketOf(scale: number): number {
    const value = scale > 0 ? scale : 1;
    const bucket = Math.pow(2, Math.round(Math.log2(value)));
    return Math.min(Math.max(bucket, 1 / 32), 8);
}
