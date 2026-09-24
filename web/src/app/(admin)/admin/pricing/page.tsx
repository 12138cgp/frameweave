"use client";

import { App, Button, Card, Flex, Input, InputNumber, Popconfirm, Select, Space, Table, Typography } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { IMAGE_QUALITY_TIERS, VIDEO_RESOLUTION_TIERS, fetchAdminGroups, fetchAdminSettings, fetchManagerPrices, getManagers, saveAdminSettings, saveManagerPrices, type AdminGroup, type AdminModelChannel, type AdminModelCost, type AdminModelKind, type AdminModelMeta, type AdminSettings, type AdminVideoModelCost, type AdminAudioModelCost} from "@/services/api/admin";
import { inferModelKindFromName } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const RESOLUTIONS = ["480p", "720p", "1080p", "2160p"] as const;
type Reso = (typeof RESOLUTIONS)[number];
// 特殊 scope：编辑全局默认价（不归属任何二级管理员）。
const DEFAULT_SCOPE = "__default__";

// 覆盖草稿：值为数字=覆盖、undefined=用默认。
//
// 图片这边刻意做成「一口价 + 分档价」两层：后端 ModelCost 就是这个结构，
// 只存一个数字的话，二级管理员一填覆盖就把该模型的 1K/2K/4K 分档价悄悄拍平成一口价。
type ImgTier = (typeof IMAGE_QUALITY_TIERS)[number];
type ImgDraft = Record<string, { flat?: number; tiers?: Partial<Record<ImgTier, number>> }>;
// 视频每档两个价：base=不带视频输入(文/图生视频)、withVideo=带视频输入(视频生视频)。
// 以前这里只存一个数字，于是「分级定价」页给二级管理员配的覆盖价读也读不到、存也存不下，
// 该团队做视频生视频一律按无输入价收——这个 bug 就是这么来的。
type VidDraft = Record<string, Partial<Record<Reso, { base?: number; withVideo?: number }>>>;

function uniqueModels(models: string[]): string[] {
    return Array.from(new Set(models.map((m) => (m || "").trim()).filter(Boolean)));
}

function parseGroupChannels(raw: string | undefined): AdminModelChannel[] {
    if (!raw?.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as AdminModelChannel[]) : [];
    } catch {
        return [];
    }
}

// 汇总所有分组各渠道配置过的模型名（不限启用与否，供列出设价）
function collectGroupModels(groups: AdminGroup[]): string[] {
    return uniqueModels(groups.flatMap((group) => parseGroupChannels(group.channels).flatMap((channel) => channel.models || [])));
}

// 保存前规整：与系统设置里原逻辑一致（图片保留所有有模型名的项、点数≥0；视频过滤空档、无档且无别名则丢弃）
function normalizeImgCosts(items: AdminModelCost[]): AdminModelCost[] {
    return items
        .filter((item) => item.model)
        .map((item) => ({
            model: item.model,
            credits: Math.max(0, Number(item.credits) || 0),
            // ⚠️ 逐字段重建时必须把 qualityRates 一起带上。这个项目已经在同一个坑里摔过一次：
            // creditsPerSecondWithVideo 当年就是在这种「重建对象时漏字段」里被清零的，且零报错。
            // 档价 <= 0 一律丢掉：「这档没单独定价」和「这档免费」必须能区分（后端 NormalizeImageQualityRates 同口径）。
            qualityRates: (item.qualityRates || []).filter((rate) => rate && Number(rate.credits) > 0).map((rate) => ({ quality: rate.quality, credits: Math.max(0, Number(rate.credits) || 0) })),
            label: item.label?.trim() || undefined,
        }))
        .map((item) => ({ ...item, qualityRates: item.qualityRates.length ? item.qualityRates : undefined }));
}

function normalizeVidCosts(items: AdminVideoModelCost[]): AdminVideoModelCost[] {
    return items
        .filter((item) => item.model)
        .map((item) => ({
            model: item.model,
            rates: (item.rates || []).filter((rate) => rate?.resolution).map((rate) => ({ resolution: rate.resolution, creditsPerSecond: Math.max(0, Number(rate.creditsPerSecond) || 0), creditsPerSecondWithVideo: Math.max(0, Number(rate.creditsPerSecondWithVideo) || 0) })),
            label: item.label?.trim() || undefined,
        }))
        .filter((item) => item.rates.length || item.label);
}

// 音频按秒价规整：每秒点数 <= 0 的整条丢掉（=该模型不配按秒价，回退按次一口价），
// 与后端 AudioModelCredits「CreditsPerSecond<=0 视为未配置」同口径。保留只填了别名的行。
function normalizeAudCosts(items: AdminAudioModelCost[]): AdminAudioModelCost[] {
    return items
        .filter((item) => item.model)
        .map((item) => ({
            model: item.model,
            creditsPer100Chars: Math.max(0, Number(item.creditsPer100Chars) || 0),
            creditsPerSecond: Math.max(0, Number(item.creditsPerSecond) || 0),
            label: item.label?.trim() || undefined,
        }))
        .filter((item) => item.creditsPer100Chars > 0 || item.creditsPerSecond > 0 || item.label);
}

export default function AdminPricingPage() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const role = useUserStore((state) => state.user?.role);
    const isSuperAdmin = role === "admin";

    const [managers, setManagers] = useState<{ id: string; username: string }[]>([]);
    // scope：DEFAULT_SCOPE=编辑全局默认价；其它=某二级管理员 id 的覆盖价。
    const [scope, setScope] = useState<string>(DEFAULT_SCOPE);
    const [groups, setGroups] = useState<AdminGroup[]>([]);
    const [settings, setSettings] = useState<AdminSettings | null>(null);
    // 基线（只读）：从后端载入的全局默认价，覆盖模式用它算「默认价 / 回填」，切换对象不改动它，只有 loadBase 会重置。
    const [defaultModelCosts, setDefaultModelCosts] = useState<AdminModelCost[]>([]);
    const [defaultVideoCosts, setDefaultVideoCosts] = useState<AdminVideoModelCost[]>([]);
    const [defaultAudioCosts, setDefaultAudioCosts] = useState<AdminAudioModelCost[]>([]);
    // 默认模式的可编辑副本（与基线分开，避免未保存的默认改动泄漏进覆盖模式的显示/保存）。
    const [editMetas, setEditMetas] = useState<AdminModelMeta[]>([]);
    const [editImg, setEditImg] = useState<AdminModelCost[]>([]);
    const [editVid, setEditVid] = useState<AdminVideoModelCost[]>([]);
    const [editAud, setEditAud] = useState<AdminAudioModelCost[]>([]);
    const [imgDraft, setImgDraft] = useState<ImgDraft>({});
    const [vidDraft, setVidDraft] = useState<VidDraft>({});
    // 音频覆盖草稿：模型 → 每秒点数。音频没有分辨率/画质这种维度，一个模型一个数。
    const [audDraft, setAudDraft] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    // 覆盖加载的请求代际：快速切换对象时丢弃过期响应，避免把上一个管理员的草稿留在别的 scope 下。
    const overrideReqRef = useRef(0);

    const isDefault = scope === DEFAULT_SCOPE;

    // 载入全局默认价 + 分组（供列出所有可定价模型）+ 二级管理员列表
    const loadBase = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        try {
            const [s, gs, ms] = await Promise.all([fetchAdminSettings(token), fetchAdminGroups(token).catch(() => []), getManagers(token).catch(() => [])]);
            const img = s.public.modelChannel.modelCosts || [];
            const vid = s.public.modelChannel.videoModelCosts || [];
            const aud = s.public.modelChannel.audioModelCosts || [];
            setSettings(s);
            setDefaultModelCosts(img);
            setDefaultVideoCosts(vid);
            setDefaultAudioCosts(aud);
            // 深拷贝出可编辑副本（默认模式改这份，不动基线）
            setEditMetas((s.public.modelChannel.modelMetas || []).map((m) => ({ ...m, resolutions: [...(m.resolutions || [])] })));
            setEditImg(img.map((c) => ({ ...c })));
            setEditVid(vid.map((c) => ({ ...c, rates: (c.rates || []).map((r) => ({ ...r })) })));
            setEditAud(aud.map((c) => ({ ...c })));
            setGroups(gs);
            setManagers(ms);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "载入失败");
        } finally {
            setLoading(false);
        }
    }, [token, message]);

    useEffect(() => {
        void loadBase();
    }, [loadBase]);

    // 选了某个二级管理员 → 载入其覆盖草稿
    const loadOverride = useCallback(
        async (id: string) => {
            if (!token || !id) return;
            const seq = ++overrideReqRef.current;
            setLoading(true);
            try {
                const prices = await fetchManagerPrices(token, id);
                if (seq !== overrideReqRef.current) return; // 期间已切到别的对象，丢弃过期响应
                const img: ImgDraft = {};
                for (const c of prices.modelCosts || []) {
                    const tiers: Partial<Record<ImgTier, number>> = {};
                    for (const rate of c.qualityRates || []) {
                        const tier = (rate.quality || "").trim().toLowerCase() as ImgTier;
                        if (IMAGE_QUALITY_TIERS.includes(tier)) tiers[tier] = rate.credits;
                    }
                    img[c.model] = { flat: c.credits, tiers };
                }
                const vid: VidDraft = {};
                for (const v of prices.videoModelCosts || []) {
                    vid[v.model] = {};
                    // 两个价都要读回来。只读 creditsPerSecond 的话，保存时带视频价就会被当成"没配"而清掉。
                    for (const rt of v.rates || []) vid[v.model][rt.resolution as Reso] = { base: rt.creditsPerSecond, withVideo: rt.creditsPerSecondWithVideo || undefined };
                }
                const aud: Record<string, number> = {};
                for (const a of prices.audioModelCosts || []) aud[a.model] = a.creditsPerSecond;
                setImgDraft(img);
                setVidDraft(vid);
                setAudDraft(aud);
            } catch (error) {
                if (seq === overrideReqRef.current) message.error(error instanceof Error ? error.message : "载入价格失败");
            } finally {
                if (seq === overrideReqRef.current) setLoading(false);
            }
        },
        [token, message],
    );

    useEffect(() => {
        if (isDefault) {
            overrideReqRef.current++; // 作废在途的覆盖加载
            setImgDraft({});
            setVidDraft({});
            setAudDraft({});
            return;
        }
        void loadOverride(scope);
    }, [scope, isDefault, loadOverride]);

    // 所有可定价模型（默认模式列出全部：可用模型 ∪ 各分组渠道模型）
    const billingModels = useMemo(() => uniqueModels([...(settings?.public.modelChannel.availableModels || []), ...collectGroupModels(groups)]), [settings, groups]);
    // 按后台配置的类型分表。以前这里用的是前端名字启发式（filterModelsByCapability），
    // 名字里不含 seedance/video 之类关键词的新模型永远不会出现在按秒计费表里、也就永远配不了分辨率价。
    // 没标类型时回落名字启发式（与后端 inferModelKind、前端 modelMatchesCapability 同一套判据）。
    // 不能直接当成 "text"：modelMetas 只在后端启动时回填一次，运行期新加到渠道里的模型在重启前
    // 没有 meta，一律算文本会让它在「音频/视频按秒计费」表里整行消失、管理员根本找不到在哪配价。
    const kindOfModel = useCallback(
        (model: string): AdminModelKind => editMetas.find((m) => m.model === model)?.kind || inferModelKindFromName(model),
        [editMetas],
    );
    const billingVideoModels = useMemo(() => billingModels.filter((m) => kindOfModel(m) === "video"), [billingModels, kindOfModel]);
    // 按次计费表只列非视频模型：视频走下面的按秒表，同时出现在两张表里会让人不知道到底按哪个收。
    const billingPerCallModels = useMemo(() => billingModels.filter((m) => kindOfModel(m) !== "video"), [billingModels, kindOfModel]);
    // 音频按秒表：音频模型仍留在上面的按次表里（没配按秒价时就走按次），所以这里不从按次表里剔除。
    // 理由与视频不同——视频是「要么按秒要么按次」，音频是「按秒价没配就回退按次」，两张表都有意义。
    const billingAudioModels = useMemo(() => billingModels.filter((m) => kindOfModel(m) === "audio"), [billingModels, kindOfModel]);

    // 默认模式：音频每秒点数的读写。
    const editAudPer100 = (model: string) => editAud.find((c) => c.model === model)?.creditsPer100Chars ?? 0;
    const setEditAudPer100 = (model: string, value: number) =>
        setEditAud((prev) => {
            const hit = prev.find((c) => c.model === model);
            if (hit) return prev.map((c) => (c.model === model ? { ...c, creditsPer100Chars: value } : c));
            return [...prev, { model, creditsPer100Chars: value, creditsPerSecond: 0 }];
        });
    const editAudPerSecond = (model: string) => editAud.find((c) => c.model === model)?.creditsPerSecond ?? 0;
    const setEditAudPerSecond = (model: string, value: number) =>
        setEditAud((prev) => {
            const hit = prev.find((c) => c.model === model);
            if (hit) return prev.map((c) => (c.model === model ? { ...c, creditsPerSecond: value } : c));
            return [...prev, { model, creditsPerSecond: value }];
        });
    const editAudLabel = (model: string) => editAud.find((c) => c.model === model)?.label ?? "";
    const setEditAudLabel = (model: string, value: string) =>
        setEditAud((prev) => {
            const hit = prev.find((c) => c.model === model);
            if (hit) return prev.map((c) => (c.model === model ? { ...c, label: value } : c));
            return [...prev, { model, creditsPerSecond: 0, label: value }];
        });

    // —— 覆盖模式基线（读只读的 defaultModelCosts/defaultVideoCosts）——
    const defImg = (model: string) => defaultModelCosts.find((c) => c.model === model)?.credits ?? 0;
    const defAud = (model: string) => defaultAudioCosts.find((c) => c.model === model)?.creditsPerSecond ?? 0;
    // 有效默认档价：精确档→720p 档→首档（与后端 pickVideoResolutionRate 一致），供覆盖未填档位回填与占位显示，避免回填成 0=免费。
    const effDefVid = (model: string, res: Reso): number => {
        const rates = defaultVideoCosts.find((c) => c.model === model)?.rates || [];
        if (!rates.length) return 0;
        const exact = rates.find((r) => r.resolution === res);
        if (exact) return exact.creditsPerSecond;
        const r720 = rates.find((r) => r.resolution === "720p");
        if (r720) return r720.creditsPerSecond;
        return rates[0].creditsPerSecond;
    };

    // 有效默认「带视频输入」价：与 effDefVid 同构。回填时用它，避免把带输入价填成 0
    // ——0 在后端是「回退用无输入价」的意思，填 0 不会免费，但会让覆盖后的带输入价莫名其妙等于无输入价。
    const effDefVidWithVideo = (model: string, res: Reso): number => {
        const rates = defaultVideoCosts.find((c) => c.model === model)?.rates || [];
        if (!rates.length) return 0;
        const exact = rates.find((r) => r.resolution === res);
        if (exact) return exact.creditsPerSecondWithVideo || 0;
        const r720 = rates.find((r) => r.resolution === "720p");
        if (r720) return r720.creditsPerSecondWithVideo || 0;
        return rates[0].creditsPerSecondWithVideo || 0;
    };
    // 某模型某档的默认分档价（覆盖模式的占位提示用）：配了分档用分档价，没配回落一口价。
    const defImgTier = (model: string, tier: ImgTier): number => {
        const entry = defaultModelCosts.find((c) => c.model === model);
        if (!entry) return 0;
        const rate = (entry.qualityRates || []).find((item) => (item.quality || "").trim().toLowerCase() === tier);
        if (rate && rate.credits > 0) return rate.credits;
        return entry.credits || 0;
    };

    // —— 默认模式：编辑可编辑副本 editImg/editVid ——
    const editImgCredits = (model: string) => editImg.find((c) => c.model === model)?.credits ?? 0;
    const editImgLabel = (model: string) => editImg.find((c) => c.model === model)?.label ?? "";
    // withVideo=false 读不带视频输入价，true 读带视频输入价。
    const editVidRate = (model: string, res: Reso, withVideo: boolean) => {
        const rate = editVid.find((c) => c.model === model)?.rates.find((r) => r.resolution === res);
        if (!rate) return 0;
        if (withVideo) return rate.creditsPerSecondWithVideo ?? 0;
        return rate.creditsPerSecond;
    };
    const editVidLabel = (model: string) => editVid.find((c) => c.model === model)?.label ?? "";

    // 默认模式的分档价读写：档价为 0/未填 = 这档不单独定价，走一口价。
    const editImgTier = (model: string, tier: ImgTier): number => {
        const rate = (editImg.find((c) => c.model === model)?.qualityRates || []).find((item) => (item.quality || "").trim().toLowerCase() === tier);
        return rate?.credits || 0;
    };
    const setEditImgTier = (model: string, tier: ImgTier, credits: number) => {
        setEditImg((prev) => {
            const existing = prev.find((c) => c.model === model);
            const rates = IMAGE_QUALITY_TIERS.map((t) => {
                let value = 0;
                const cur = (existing?.qualityRates || []).find((item) => (item.quality || "").trim().toLowerCase() === t);
                if (cur) value = cur.credits;
                if (t === tier) value = Math.max(0, credits);
                return { quality: t, credits: value };
            }).filter((rate) => rate.credits > 0);
            const next = { model, credits: Math.max(0, existing?.credits || 0), label: existing?.label, qualityRates: rates.length ? rates : undefined };
            return [...prev.filter((c) => c.model !== model), next];
        });
    };

    const setEditImgCredits = (model: string, credits: number) => {
        setEditImg((prev) => {
            const existing = prev.find((c) => c.model === model);
            // qualityRates 必须原样带过来，否则改一口价就把分档价清了（同一类漏字段 bug 的第三次）。
            return [...prev.filter((c) => c.model !== model), { model, credits: Math.max(0, credits), label: existing?.label, qualityRates: existing?.qualityRates }];
        });
    };
    // —— 模型类型与档位 ——
    // 查不到 meta 时不擅自给默认值，交给下面的 modelKind() 统一回落，避免这里和后端的推断各写一套。
    const metaOf = (model: string) => editMetas.find((m) => m.model === model);
    const modelKind = (model: string): AdminModelKind => {
        const meta = metaOf(model);
        if (meta && meta.kind) return meta.kind;
        // 后端启动时会回填一遍，但运行期新加的模型在重启前没有 meta，所以这里按名字推断，
        // 而不是一律当文本（否则这张表会把新加的音频/视频模型显示成"文本"，误导管理员）。
        return inferModelKindFromName(model);
    };
    const setModelKind = (model: string, kind: AdminModelKind) => {
        setEditMetas((prev) => {
            const rest = prev.filter((m) => m.model !== model);
            // 换类型后原来的档位一定不再适用（图片档位和视频档位取值范围完全不同），直接清空重选。
            return [...rest, { model, kind, resolutions: [] }];
        });
    };
    const setModelMaxSeconds = (model: string, maxSeconds: number) => {
        setEditMetas((prev) => {
            const existing = prev.find((m) => m.model === model);
            const rest = prev.filter((m) => m.model !== model);
            return [...rest, { model, kind: existing?.kind || modelKind(model), resolutions: existing?.resolutions || [], maxSeconds: Math.max(0, maxSeconds) }];
        });
    };
    // 某模型是否支持某档位：没配档位=不限制（全支持）。定价表据此禁用不支持的档位单元格。
    const supportsTier = (model: string, tier: string) => {
        const list = metaOf(model)?.resolutions || [];
        return list.length === 0 || list.includes(tier);
    };

    const setModelResolutions = (model: string, resolutions: string[]) => {
        setEditMetas((prev) => {
            const existing = prev.find((m) => m.model === model);
            const rest = prev.filter((m) => m.model !== model);
            // ⚠️ maxSeconds 必须显式带过来。这里是【逐字段重建】整条 meta，漏写一个字段
            // 就等于把它清成 undefined —— 之前漏了 maxSeconds，管理员只是改一下档位勾选，
            // 视频模型配好的「最长秒数」就被静默抹掉（各视频模型的秒数上限不同，
            // 全都躺在这个雷上），而界面上没有任何提示。
            return [...rest, { model, kind: existing?.kind || modelKind(model), resolutions, maxSeconds: existing?.maxSeconds }];
        });
    };

    const setEditImgLabel = (model: string, label: string) => {
        const trimmed = label.trim();
        setEditImg((prev) => {
            const existing = prev.find((c) => c.model === model);
            return [...prev.filter((c) => c.model !== model), { model, credits: Math.max(0, existing?.credits || 0), label: trimmed || undefined, qualityRates: existing?.qualityRates }];
        });
    };
    // withVideo=false 改不带视频输入价，true 改带视频输入价；另一价保留。
    const setEditVidRate = (model: string, res: Reso, val: number, withVideo: boolean) => {
        setEditVid((prev) => {
            const existing = prev.find((c) => c.model === model);
            const rates = RESOLUTIONS.map((r) => {
                const cur = existing?.rates.find((rt) => rt.resolution === r);
                let base = 0;
                if (cur) base = cur.creditsPerSecond;
                let withV = 0;
                if (cur && cur.creditsPerSecondWithVideo) withV = cur.creditsPerSecondWithVideo;
                if (r === res) {
                    if (withVideo) withV = Math.max(0, val);
                    else base = Math.max(0, val);
                }
                return { resolution: r, creditsPerSecond: base, creditsPerSecondWithVideo: withV };
            }).filter((rt) => rt.creditsPerSecond > 0 || rt.creditsPerSecondWithVideo > 0);
            const rest = prev.filter((c) => c.model !== model);
            if (rates.length || existing?.label) return [...rest, { model, rates, label: existing?.label }];
            return rest;
        });
    };
    const setEditVidLabel = (model: string, label: string) => {
        const trimmed = label.trim();
        setEditVid((prev) => {
            const existing = prev.find((c) => c.model === model);
            const rates = existing?.rates || [];
            const rest = prev.filter((c) => c.model !== model);
            if (trimmed || rates.length) return [...rest, { model, rates, label: trimmed || undefined }];
            return rest;
        });
    };

    const saveDefault = async () => {
        if (!token) return;
        if (!settings) {
            message.error("配置尚未载入完成，请刷新后再保存");
            return;
        }
        setSaving(true);
        try {
            // 保存前拉一次最新 settings，仅替换定价字段再回存，避免覆盖他人在系统设置里的并发改动。
            const fresh = await fetchAdminSettings(token);
            const next: AdminSettings = {
                ...fresh,
                public: {
                    ...fresh.public,
                    modelChannel: {
                        ...fresh.public.modelChannel,
                        modelMetas: editMetas.filter((m) => m.model.trim()),
                        modelCosts: normalizeImgCosts(editImg),
                        videoModelCosts: normalizeVidCosts(editVid),
                        audioModelCosts: normalizeAudCosts(editAud),
                    },
                },
            };
            await saveAdminSettings(token, next);
            message.success("已保存默认价（所有未单独定价的团队都用它）");
            await loadBase();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    // —— 覆盖模式：某二级管理员单独定价 ——
    const saveOverride = async () => {
        if (!scope || isDefault) return;
        const modelCosts: AdminModelCost[] = [];
        for (const [model, draft] of Object.entries(imgDraft)) {
            const tiers = IMAGE_QUALITY_TIERS.map((tier) => ({ quality: tier, credits: draft.tiers?.[tier] })).filter((item) => item.credits !== undefined && item.credits !== null && Number(item.credits) > 0) as { quality: string; credits: number }[];
            const flatFilled = draft.flat !== undefined && draft.flat !== null;
            if (!flatFilled && !tiers.length) continue;
            // 只填了分档、没填一口价时，一口价必须回填成默认价而不是 0：
            // 一口价是「没单独定价的档」的兜底，落成 0 等于把没配的档白送。
            modelCosts.push({ model, credits: flatFilled ? Number(draft.flat) : defImg(model), qualityRates: tiers.length ? tiers : undefined });
        }
        const videoModelCosts: AdminVideoModelCost[] = [];
        for (const [model, draft] of Object.entries(vidDraft)) {
            const touched = RESOLUTIONS.some((res) => draft[res]?.base !== undefined || draft[res]?.withVideo !== undefined);
            if (!touched) continue;
            // 未填档位用「有效默认价」回填（精确→720p→首档，与后端一致），绝不回填 0，否则该团队该档免费。
            // 带视频输入价同理一起回填——只写一个价正是它当年被清零的原因。
            videoModelCosts.push({
                model,
                rates: RESOLUTIONS.map((res) => ({
                    resolution: res,
                    creditsPerSecond: draft[res]?.base ?? effDefVid(model, res),
                    creditsPerSecondWithVideo: draft[res]?.withVideo ?? effDefVidWithVideo(model, res),
                })),
            });
        }
        // 音频覆盖：只提交填过的模型；填 0 是有意义的（=该团队这个模型回退按次计费），所以按「是否出现在草稿里」判断。
        const audioModelCosts: AdminAudioModelCost[] = Object.entries(audDraft).map(([model, perSecond]) => ({ model, creditsPerSecond: Math.max(0, Number(perSecond) || 0) }));
        setSaving(true);
        try {
            await saveManagerPrices(token, scope, { modelCosts, videoModelCosts, audioModelCosts });
            message.success(modelCosts.length || videoModelCosts.length || audioModelCosts.length ? "已保存该管理员的价格覆盖" : "已清空覆盖（该管理员团队全部按默认价）");
            await loadOverride(scope);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    const clearOverride = async () => {
        setImgDraft({});
        setVidDraft({});
        setAudDraft({});
        if (!scope || isDefault) return;
        setSaving(true);
        try {
            await saveManagerPrices(token, scope, { modelCosts: [], videoModelCosts: [], audioModelCosts: [] });
            message.success("已清空覆盖，该管理员团队全部按全局默认价");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败");
        } finally {
            setSaving(false);
        }
    };

    if (!isSuperAdmin) {
        return (
            <main className="anim-fade" style={{ padding: 24 }}>
                <Typography.Text type="secondary">分级定价仅超级管理员可用。</Typography.Text>
            </main>
        );
    }

    const scopeOptions = [{ label: "默认定价（全局基准价）", value: DEFAULT_SCOPE }, ...managers.map((m) => ({ label: m.username, value: m.id }))];

    return (
        <main className="anim-fade" style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <Typography.Title level={5} className="!mb-1">
                        分级定价
                    </Typography.Title>
                    <Typography.Paragraph type="secondary" className="!mb-3">
                        {isDefault
                            ? "默认定价 = 全局基准价，不归属任何二级管理员。所有没有被单独定价的团队都按这里计费。改这里等于改原「系统设置」里的模型价格。"
                            : "给某个二级管理员单独设置模型价格：该管理员本人及其名下所有用户，对下方「填了覆盖价」的模型按覆盖价计费；没填的模型按默认定价。留空全部即整体回退默认定价。"}
                    </Typography.Paragraph>
                    <Space wrap>
                        <Select style={{ width: 260 }} placeholder="选择定价对象" value={scope} onChange={setScope} options={scopeOptions} showSearch optionFilterProp="label" />
                        {isDefault ? (
                            <Button type="primary" onClick={() => void saveDefault()} loading={saving} disabled={loading || !settings}>
                                保存默认价
                            </Button>
                        ) : (
                            <>
                                <Button type="primary" onClick={() => void saveOverride()} loading={saving}>
                                    保存覆盖
                                </Button>
                                <Popconfirm title="清空该管理员的所有价格覆盖？" description="清空后其团队全部按默认定价计费。" onConfirm={() => void clearOverride()}>
                                    <Button danger>清空覆盖</Button>
                                </Popconfirm>
                            </>
                        )}
                    </Space>
                </Card>

                {isDefault ? (
                    <>
                        <Card variant="borderless">
                            <Typography.Title level={5}>模型类型与可用档位</Typography.Title>
                            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                                给每个模型标一次类型，它就会自动出现在下面对应的定价表里，前台也只在对应类型的节点下拉里出现——加新模型不用再改代码。
                                「可用档位」决定用户在画布上能选哪些画质/分辨率，没勾的档位会置灰不可选；<b>留空 = 不限制（全部可选）</b>。
                                文本与音频模型没有档位维度。
                            </Typography.Paragraph>
                            <Table
                                rowKey="model"
                                size="small"
                                loading={loading}
                                pagination={false}
                                dataSource={billingModels.map((model) => ({ model }))}
                                columns={[
                                    { title: "模型", dataIndex: "model" },
                                    {
                                        title: "类型",
                                        width: 150,
                                        render: (_: unknown, r: { model: string }) => (
                                            <Select
                                                className="!w-full"
                                                value={modelKind(r.model)}
                                                onChange={(v) => setModelKind(r.model, v)}
                                                // ⚠️ onSelect 不能省：没有 meta 的模型这里显示的是【按名字推断】的值，
                                                // 管理员想把它显式钉成这个类型时会选中同一个选项，而 onChange 对
                                                // 「值没变」不触发 —— 结果就是点了没反应、存不下来。onSelect 每次
                                                // 选择都会触发，补上这条才能把推断值固化成配置。
                                                onSelect={(v: AdminModelKind) => setModelKind(r.model, v)}
                                                options={[
                                                    { label: "文本", value: "text" },
                                                    { label: "图片", value: "image" },
                                                    { label: "视频", value: "video" },
                                                    { label: "音频", value: "audio" },
                                                ]}
                                            />
                                        ),
                                    },
                                    {
                                        title: "最长秒数",
                                        width: 140,
                                        render: (_: unknown, r: { model: string }) => {
                                            if (modelKind(r.model) !== "video") {
                                                return <Typography.Text type="secondary">—</Typography.Text>;
                                            }
                                            return (
                                                <InputNumber
                                                    min={0}
                                                    max={600}
                                                    step={1}
                                                    precision={0}
                                                    className="!w-full"
                                                    addonAfter="秒"
                                                    placeholder="0=不限"
                                                    value={metaOf(r.model)?.maxSeconds || 0}
                                                    onChange={(v) => setModelMaxSeconds(r.model, Number(v) || 0)}
                                                />
                                            );
                                        },
                                    },
                                    {
                                        title: "可用档位",
                                        render: (_: unknown, r: { model: string }) => {
                                            const kind = modelKind(r.model);
                                            if (kind === "text" || kind === "audio") {
                                                return <Typography.Text type="secondary">—</Typography.Text>;
                                            }
                                            const tiers = kind === "image" ? IMAGE_QUALITY_TIERS : VIDEO_RESOLUTION_TIERS;
                                            const options = tiers.map((t) => ({ label: t.toUpperCase(), value: t }));
                                            return (
                                                <Select
                                                    mode="multiple"
                                                    allowClear
                                                    className="!w-full"
                                                    placeholder="留空 = 不限制（全部可选）"
                                                    value={metaOf(r.model)?.resolutions || []}
                                                    onChange={(v) => setModelResolutions(r.model, v)}
                                                    options={options}
                                                />
                                            );
                                        },
                                    },
                                ]}
                            />
                        </Card>

                        <Card variant="borderless">
                            <Typography.Title level={5}>模型点数（按次）</Typography.Title>
                            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                                已自动汇总所有分组配置的模型，默认 0 点。每次调用扣除固定点数；视频模型若在下方配置了按秒计费，则优先按秒计费，此处的按次值仅作未配置时的回退。
                                图片模型可以再按画质档（1K/2K/4K）分别定价：<b>某档留空/填 0 = 该档不单独定价，按左边的「每次调用扣除」收</b>；填了就按档收。用户选的画质档由前台画布决定，后端按同一套口径反查，不会出现「显示一个价、扣另一个价」。
                            </Typography.Paragraph>
                            <Table
                                rowKey="model"
                                size="small"
                                loading={loading}
                                pagination={false}
                                dataSource={billingPerCallModels.map((model) => ({ model }))}
                                columns={[
                                    { title: "模型", dataIndex: "model" },
                                    {
                                        title: "显示代称",
                                        width: 200,
                                        render: (_: unknown, r: { model: string }) => (
                                            <Input allowClear placeholder="留空=显示原模型名" value={editImgLabel(r.model)} onChange={(e) => setEditImgLabel(r.model, e.target.value)} />
                                        ),
                                    },
                                    {
                                        title: "每次调用扣除",
                                        width: 200,
                                        render: (_: unknown, r: { model: string }) => (
                                            <InputNumber min={0} step={1} precision={0} className="!w-full" addonAfter="点" value={editImgCredits(r.model)} onChange={(v) => setEditImgCredits(r.model, Number(v) || 0)} />
                                        ),
                                    },
                                    ...IMAGE_QUALITY_TIERS.map((tier) => ({
                                        title: `${tier.toUpperCase()} 每张`,
                                        width: 170,
                                        render: (_: unknown, r: { model: string }) => {
                                            // 只有图片模型有画质档；文本/音频按次收，没有这个维度。
                                            if (modelKind(r.model) !== "image") {
                                                return <Typography.Text type="secondary">—</Typography.Text>;
                                            }
                                            // 上面「可用档位」没勾的档，这里一律禁用：配了也永远取不到。
                                            if (!supportsTier(r.model, tier)) {
                                                return <Typography.Text type="secondary">该模型未启用此档</Typography.Text>;
                                            }
                                            return <InputNumber min={0} step={1} precision={0} className="!w-full" addonAfter="点" placeholder={`留空=${editImgCredits(r.model)}`} value={editImgTier(r.model, tier) || null} onChange={(v) => setEditImgTier(r.model, tier, Number(v) || 0)} />;
                                        },
                                    })),
                                ]}
                            />
                        </Card>

                        {billingVideoModels.length ? (
                            <Card variant="borderless">
                                <Typography.Title level={5}>视频模型按秒计费</Typography.Title>
                                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                                    扣费 = 生成秒数 × 所选分辨率的每秒点数。每档分「无输入 / 带视频」两价：<b>带视频输入</b>=用参考视频做视频生视频时的单价，<b>无输入</b>=文/图生视频。带视频价填 0 时回退用无输入价。各档都为 0 时该模型回退按次计费；请求的分辨率档位未单独定价时按 720p 档（再退第一个有值档位）计费。2160p 即 4K（3840×2160）。
                                </Typography.Paragraph>
                                <Table
                                    rowKey="model"
                                    size="small"
                                    loading={loading}
                                    pagination={false}
                                    scroll={{ x: "max-content" }}
                                    dataSource={billingVideoModels.map((model) => ({ model }))}
                                    columns={[
                                        { title: "视频模型", dataIndex: "model" },
                                        {
                                            title: "显示代称",
                                            width: 200,
                                            render: (_: unknown, r: { model: string }) => (
                                                <Input allowClear placeholder="留空=显示原模型名" value={editVidLabel(r.model)} onChange={(e) => setEditVidLabel(r.model, e.target.value)} />
                                            ),
                                        },
                                        ...RESOLUTIONS.map((res) => ({
                                            title: `${res} 每秒`,
                                            width: 230,
                                            render: (_: unknown, r: { model: string }) => {
                                                // 上面「可用档位」没勾的档，这里一律禁用：配了也永远不会被取到，
                                                // 留着能填只会让人以为已经生效。
                                                const off = !supportsTier(r.model, res);
                                                if (off) {
                                                    return <Typography.Text type="secondary">该模型未启用此档</Typography.Text>;
                                                }
                                                return (
                                                    <Space direction="vertical" size={4} className="!w-full">
                                                        <InputNumber min={0} step={1} precision={0} className="!w-full" addonBefore="无输入" addonAfter="点/秒" value={editVidRate(r.model, res, false)} onChange={(v) => setEditVidRate(r.model, res, Number(v) || 0, false)} />
                                                        <InputNumber min={0} step={1} precision={0} className="!w-full" addonBefore="带视频" addonAfter="点/秒" value={editVidRate(r.model, res, true)} onChange={(v) => setEditVidRate(r.model, res, Number(v) || 0, true)} />
                                                    </Space>
                                                );
                                            },
                                        })),
                                    ]}
                                />
                            </Card>
                        ) : null}

                        {billingAudioModels.length ? (
                            <Card variant="borderless">
                                <Typography.Title level={5}>音频模型按秒计费</Typography.Title>
                                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                                    扣费 = 出片秒数 × 每秒点数。填 0 = 不按秒计费，该模型回退上面的「按次」价（老的 doubao-tts 就该留 0）。
                                    <br />
                                    ⚠️ 与视频不同：音频生成（seed-audio）<b>上游没有时长参数</b>，出片多少秒事前不可知。所以提交时先按用户选的「目标时长」预扣，
                                    上游返回真实时长后由后端<b>自动结算差额</b>（多退少补），用户看到的预估价只是按目标时长算的估算。单次出片上限 120 秒。
                                </Typography.Paragraph>
                                <Table
                                    rowKey="model"
                                    size="small"
                                    loading={loading}
                                    pagination={false}
                                    dataSource={billingAudioModels.map((model) => ({ model }))}
                                    columns={[
                                        { title: "音频模型", dataIndex: "model" },
                                        {
                                            title: "显示代称",
                                            width: 200,
                                            render: (_: unknown, r: { model: string }) => <Input allowClear placeholder="留空=显示原模型名" value={editAudLabel(r.model)} onChange={(e) => setEditAudLabel(r.model, e.target.value)} />,
                                        },
                                        {
                                            title: "每 100 字积分",
                                            width: 200,
                                            render: (_: unknown, r: { model: string }) => (
                                                <InputNumber min={0} step={1} precision={0} className="!w-full" addonAfter="点/100字" placeholder="0=不按字数" value={editAudPer100(r.model)} onChange={(v) => setEditAudPer100(r.model, Number(v) || 0)} />
                                            ),
                                        },
                                        {
                                            title: "每秒点数",
                                            width: 200,
                                            render: (_: unknown, r: { model: string }) => (
                                                <InputNumber min={0} step={1} precision={0} className="!w-full" addonAfter="点/秒" placeholder="0=按次计费" value={editAudPerSecond(r.model)} onChange={(v) => setEditAudPerSecond(r.model, Number(v) || 0)} />
                                            ),
                                        },
                                        {
                                            title: "满额参考",
                                            width: 180,
                                            align: "right" as const,
                                            render: (_: unknown, r: { model: string }) => {
                                                if (editAudPer100(r.model) > 0) return <Typography.Text type="secondary">2000 字 = {editAudPer100(r.model) * 20} 点</Typography.Text>;
                                                return <Typography.Text type="secondary">120 秒 = {editAudPerSecond(r.model) * 120} 点</Typography.Text>;
                                            },
                                        },
                                    ]}
                                />
                            </Card>
                        ) : null}
                    </>
                ) : (
                    <>
                        <Card variant="borderless">
                            <Typography.Title level={5}>图片 / 音频模型（按次）</Typography.Title>
                            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                                「覆盖价」留空=用默认价，填了才对该管理员团队生效。图片模型还可以按画质档单独覆盖：只填某一档时，其余档仍走「覆盖价」；「覆盖价」也留空时，其余档自动沿用全局默认价（不会变 0）。
                            </Typography.Paragraph>
                            <Table
                                rowKey="model"
                                size="small"
                                loading={loading}
                                pagination={false}
                                dataSource={defaultModelCosts}
                                columns={[
                                    { title: "模型", dataIndex: "model", render: (v: string, r: AdminModelCost) => r.label || v },
                                    { title: "全局默认价", dataIndex: "credits", width: 140, align: "right" as const, render: (v: number) => `${v} 点/次` },
                                    {
                                        title: "覆盖价（留空=用默认）",
                                        width: 200,
                                        render: (_: unknown, r: AdminModelCost) => (
                                            <InputNumber
                                                min={0}
                                                precision={0}
                                                className="!w-full"
                                                placeholder={`默认 ${defImg(r.model)}`}
                                                addonAfter="点/次"
                                                value={imgDraft[r.model]?.flat ?? null}
                                                onChange={(val) =>
                                                    setImgDraft((prev) => ({
                                                        ...prev,
                                                        [r.model]: { ...(prev[r.model] || {}), flat: val === null ? undefined : Number(val) },
                                                    }))
                                                }
                                            />
                                        ),
                                    },
                                    ...IMAGE_QUALITY_TIERS.map((tier) => ({
                                        title: `${tier.toUpperCase()} 覆盖价`,
                                        width: 170,
                                        render: (_: unknown, r: AdminModelCost) => {
                                            if (modelKind(r.model) !== "image") {
                                                return <Typography.Text type="secondary">—</Typography.Text>;
                                            }
                                            if (!supportsTier(r.model, tier)) {
                                                return <Typography.Text type="secondary">该模型未启用此档</Typography.Text>;
                                            }
                                            return (
                                                <InputNumber
                                                    min={0}
                                                    precision={0}
                                                    className="!w-full"
                                                    placeholder={`默认 ${defImgTier(r.model, tier)}`}
                                                    addonAfter="点/张"
                                                    value={imgDraft[r.model]?.tiers?.[tier] ?? null}
                                                    onChange={(val) =>
                                                        setImgDraft((prev) => ({
                                                            ...prev,
                                                            [r.model]: {
                                                                ...(prev[r.model] || {}),
                                                                tiers: { ...(prev[r.model]?.tiers || {}), [tier]: val === null ? undefined : Number(val) },
                                                            },
                                                        }))
                                                    }
                                                />
                                            );
                                        },
                                    })),
                                ]}
                            />
                        </Card>

                        {defaultVideoCosts.length ? (
                            <Card variant="borderless">
                                <Typography.Title level={5}>视频模型（按秒 × 分辨率）</Typography.Title>
                                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                                某视频模型任一档位填了覆盖，该模型即按覆盖计费；同一模型未填的档位自动用该档默认价（不会变 0）。全不填=用默认。2160p 即 4K。
                                每档分「无输入 / 带视频」两价：<b>带视频输入</b>=用参考视频做视频生视频时的单价，<b>无输入</b>=文/图生视频；带视频价为 0 时后端回退用无输入价。
                                </Typography.Paragraph>
                                <Table
                                    rowKey="model"
                                    size="small"
                                    loading={loading}
                                    pagination={false}
                                    scroll={{ x: "max-content" }}
                                    dataSource={defaultVideoCosts}
                                    columns={[
                                        { title: "视频模型", dataIndex: "model", render: (v: string, r: AdminVideoModelCost) => r.label || v },
                                        ...RESOLUTIONS.map((res) => ({
                                            title: `${res} 每秒`,
                                            width: 230,
                                            render: (_: unknown, r: AdminVideoModelCost) => (
                                                <Space direction="vertical" size={4} className="!w-full">
                                                    <InputNumber
                                                        min={0}
                                                        precision={0}
                                                        className="!w-full"
                                                        addonBefore="无输入"
                                                        placeholder={`默认 ${effDefVid(r.model, res)}`}
                                                        addonAfter="点/秒"
                                                        value={vidDraft[r.model]?.[res]?.base ?? null}
                                                        onChange={(val) =>
                                                            setVidDraft((prev) => ({
                                                                ...prev,
                                                                [r.model]: { ...(prev[r.model] || {}), [res]: { ...(prev[r.model]?.[res] || {}), base: val === null ? undefined : Number(val) } },
                                                            }))
                                                        }
                                                    />
                                                    <InputNumber
                                                        min={0}
                                                        precision={0}
                                                        className="!w-full"
                                                        addonBefore="带视频"
                                                        placeholder={`默认 ${effDefVidWithVideo(r.model, res)}`}
                                                        addonAfter="点/秒"
                                                        value={vidDraft[r.model]?.[res]?.withVideo ?? null}
                                                        onChange={(val) =>
                                                            setVidDraft((prev) => ({
                                                                ...prev,
                                                                [r.model]: { ...(prev[r.model] || {}), [res]: { ...(prev[r.model]?.[res] || {}), withVideo: val === null ? undefined : Number(val) } },
                                                            }))
                                                        }
                                                    />
                                                </Space>
                                            ),
                                        })),
                                    ]}
                                />
                            </Card>
                        ) : null}

                        {defaultAudioCosts.length ? (
                            <Card variant="borderless">
                                <Typography.Title level={5}>音频模型（按秒）</Typography.Title>
                                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                                    「覆盖价」留空=用默认价。填 0 = 该团队这个模型不按秒计费，回退按次价。扣费同样是「按目标时长预扣、按实际出片秒数结算差额」。
                                </Typography.Paragraph>
                                <Table
                                    rowKey="model"
                                    size="small"
                                    loading={loading}
                                    pagination={false}
                                    dataSource={defaultAudioCosts}
                                    columns={[
                                        { title: "音频模型", dataIndex: "model", render: (v: string, r: AdminAudioModelCost) => r.label || v },
                                        { title: "全局默认价", dataIndex: "creditsPerSecond", width: 140, align: "right" as const, render: (v: number) => `${v} 点/秒` },
                                        {
                                            title: "覆盖价（留空=用默认）",
                                            width: 220,
                                            render: (_: unknown, r: AdminAudioModelCost) => (
                                                <InputNumber
                                                    min={0}
                                                    precision={0}
                                                    className="!w-full"
                                                    placeholder={`默认 ${defAud(r.model)}`}
                                                    addonAfter="点/秒"
                                                    value={audDraft[r.model] ?? null}
                                                    onChange={(val) =>
                                                        setAudDraft((prev) => {
                                                            if (val === null) {
                                                                const next = { ...prev };
                                                                delete next[r.model];
                                                                return next;
                                                            }
                                                            return { ...prev, [r.model]: Number(val) };
                                                        })
                                                    }
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            </Card>
                        ) : null}
                    </>
                )}
            </Flex>
        </main>
    );
}
