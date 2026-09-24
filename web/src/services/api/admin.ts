import { apiDelete, apiGet, apiPost, compactApiParams } from "@/services/api/request";
import type { Prompt, PromptListResponse } from "@/services/api/prompts";

export type AdminPromptCategory = {
    category: string;
    name: string;
    description: string;
    file: string;
    githubUrl: string;
    remote: boolean;
};

export type AdminUser = {
    id: string;
    username: string;
    email: string;
    displayName: string;
    avatarUrl: string;
    role: "user" | "admin" | "admin_l2";
    credits: number;
    affCode: string;
    status: "active" | "ban";
    groupId: string;
    // 用户级渠道 API Key 覆盖：JSON map「渠道名 → apiKey」。空=全部用团队渠道自带的 key。
    channelKeys?: string;
    // 哪个二级管理员创建的（超管视图用来显示归属）
    creatorId?: string;
    creatorName?: string;
    lastLoginAt: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminUserListResponse = {
    items: AdminUser[];
    total: number;
};

export type AdminCreditLog = {
    id: string;
    userId: string;
    userName: string;
    type: string;
    amount: number;
    balance: number;
    relatedId: string;
    operatorId: string;
    operatorName: string;
    remark: string;
    extra: string;
    model: string;
    // 来源：projectId 非空=该笔从项目积分池扣，projectName 为项目名；空=个人积分。
    projectId: string;
    projectName: string;
    createdAt: string;
};

export type AdminCreditLogListResponse = {
    items: AdminCreditLog[];
    total: number;
};

// 积分流水筛选：在分页基础上加 类型/模型/成员/时间范围；all="1" 时不分页返回全部（导出用）。
export type AdminCreditLogQuery = {
    keyword?: string;
    type?: string;
    model?: string;
    member?: string;
    start?: string;
    end?: string;
    source?: string; // 来源筛选：__personal__=个人 / 项目 id / 空=全部
    page?: number;
    pageSize?: number;
    all?: string;
};

// 任务日志：每次 AI 调用的请求体摘要 + 上游任务号(cgt)/LogID/类型/状态（只读观测）。
export type AdminTaskLog = {
    id: string;
    traceId: string;
    userId: string;
    userName: string;
    model: string;
    kind: string; // text | image | video | audio
    path: string;
    request: string; // 请求体摘要（base64 参考图已剥占位）
    taskId: string; // 火山视频 cgt-...；非视频为空
    logId: string;
    upstreamStatus: number;
    source: string;
    durationMs: number; // 生成用时(ms):图片=完成时算、视频=成功回填;0=未知/旧数据
    resultUrl: string; // 成片永久地址（仅视频、且为上线后新生成的才有）；后台内联播放
    createdAt: string;
    // 该视频任务是否已判定失败并退还点数。upstream_status 只代表提交被受理，
    // 异步生成阶段仍可能失败——列表要显示真实结局，就得靠这个字段。
    refunded?: boolean;
};

export type AdminTaskLogListResponse = {
    items: AdminTaskLog[];
    total: number;
};

// 任务日志筛选：keyword 搜 user/cgt/logid/model/request；type 复用为 kind。
export type AdminTaskLogQuery = {
    keyword?: string;
    type?: string;
    model?: string;
    member?: string;
    start?: string;
    end?: string;
    page?: number;
    pageSize?: number;
};

export type AdminCreditLogSummary = {
    consume: number;
    refund: number;
    adjust: number;
    net: number;
    count: number;
};

export type AdminCreditLogMemberStat = {
    userId: string;
    userName: string;
    consume: number;
    refund: number;
    adjust: number;
    net: number;
    count: number;
};

export type AdminCreditLogModelStat = {
    model: string;
    consume: number;
    refund: number;
    adjust: number;
    net: number;
    count: number;
};

export type AdminCreditLogSummaryResponse = {
    overall: AdminCreditLogSummary;
    byMember: AdminCreditLogMemberStat[];
    byModel: AdminCreditLogModelStat[];
};

export type AdminUserQuery = {
    keyword?: string;
    page?: number;
    pageSize?: number;
};

export type AdminGroup = {
    id: string;
    name: string;
    // 分组自有渠道列表：JSON 数组 []ModelChannel，每组自行维护渠道与密钥
    channels: string;
    channelBaseUrl: string;
    channelApiKey: string;
    channelKeys: string;
    volcAccessKey: string;
    volcSecretKey: string;
    volcAssetProject: string;
    volcRegion: string;
    volcGroupName: string;
    // 本组专属对象存储桶（S3 兼容：火山 TOS/阿里 OSS/腾讯 COS/MinIO）。六项全空=回退全局默认桶；
    // 填了桶名(tosBucket)即该组启用自有桶，此时 AK/SK/公网域名必须齐全。Endpoint/Region 留空继承全局默认。
    tosBucket: string;
    tosEndpoint: string;
    tosRegion: string;
    tosAccessKey: string;
    tosSecretKey: string;
    tosPublicBase: string;
    // 哪个二级管理员拥有（超管视图显示归属，归属由后端控制）
    ownerId?: string;
    ownerName?: string;
    createdAt: string;
    updatedAt: string;
};

export async function fetchAdminGroups(token: string) {
    return apiGet<AdminGroup[]>("/api/admin/groups", undefined, token);
}

export async function saveAdminGroup(token: string, group: Partial<AdminGroup>) {
    return apiPost<AdminGroup>("/api/admin/groups", group, token);
}

// 连通性自检：用后台填写的桶配置向桶写一个极小测试对象并从公网读回校验（保存前验证桶名/密钥/公共读/PublicBase）。
export type GroupStorageTestInput = Pick<AdminGroup, "tosBucket" | "tosEndpoint" | "tosRegion" | "tosAccessKey" | "tosSecretKey" | "tosPublicBase">;

export async function testGroupStorage(token: string, config: GroupStorageTestInput) {
    return apiPost<{ ok: boolean; message: string }>("/api/admin/groups/test-storage", config, token);
}

export async function deleteAdminGroup(token: string, id: string) {
    return apiDelete<{ id: string }>(`/api/admin/groups/${encodeURIComponent(id)}`, token);
}

// 项目级积分池：每个项目自带积分池，项目成员生成时统一从池中扣费（透传 X-Project-ID）。
export type AdminProject = {
    id: string;
    name: string;
    // 归属：项目属于哪个二级管理员（超管视图显示；空显示「超管」）。后端按 owner 隔离。
    ownerId?: string;
    ownerName?: string;
    credits: number; // 剩余积分
    creditsTotal: number; // 累计总额（用于显示「已用 X / 总 Y」）
    status: "active" | "disabled";
    memberUserIds: string[];
    memberCount?: number;
    // 有生成记录的画布数（后端统计）
    canvasCount?: number;
    // 每个成员在本项目的净消耗积分（used）；空用量成员也会列出（used=0）
    members?: { userId: string; username: string; used: number }[];
};

export async function fetchAdminProjects(token: string) {
    const res = await apiGet<{ items: AdminProject[] }>("/api/admin/projects", undefined, token);
    return res.items;
}

// 建/改：传 id 为改；credits 仅新建时作初始池
export async function saveAdminProject(token: string, project: Partial<AdminProject> & { name: string; memberUserIds: string[] }) {
    return apiPost<AdminProject>("/api/admin/projects", project, token);
}

export async function deleteAdminProject(token: string, id: string) {
    return apiDelete<{ id: string }>(`/api/admin/projects/${encodeURIComponent(id)}`, token);
}

// 加/减项目池：delta 正为加、负为减
export async function adjustProjectCredits(token: string, id: string, delta: number) {
    return apiPost<AdminProject>(`/api/admin/projects/${encodeURIComponent(id)}/credits`, { delta }, token);
}

// 二级管理员列表（超管专用：用于把分组/成员分配给二级管理员）
export async function getManagers(token: string) {
    const res = await apiGet<{ items: { id: string; username: string }[] }>("/api/admin/managers", undefined, token);
    return res.items;
}

// 生成情况统计：某二级管理员下辖成员在指定北京时间日期范围内的生成量。
export type GenStatBreakdownRow = {
    kind: string; // video / image / audio
    model: string;
    spec: string; // 视频=分辨率(720p)、图片=尺寸(2560x1440)、音频=空
    count: number;
    seconds: number;
    fail: number;
};

export type GenerationStatMember = {
    userId: string;
    userName: string;
    groupName: string;
    videoOk: number;
    videoOkSeconds: number;
    videoFail: number;
    videoFailSeconds: number;
    imageCount: number;
    audioCount: number;
    creditsUsed: number;
    breakdown: GenStatBreakdownRow[] | null;
};

export type GenerationStatResult = {
    ownerId: string;
    ownerName: string;
    members: GenerationStatMember[];
    total: GenerationStatMember;
    idleUsers: string[];
};

export async function fetchGenerationStats(token: string, params: { start: string; end: string; ownerId?: string }) {
    return apiGet<GenerationStatResult>("/api/admin/generation-stats", compactApiParams(params), token);
}

// 把分组归属分配给某二级管理员（ownerId 为空=收回到超管/全局）
export async function assignGroupOwner(token: string, groupId: string, ownerId: string) {
    return apiPost<AdminGroup>(`/api/admin/groups/${encodeURIComponent(groupId)}/owner`, { ownerId }, token);
}

// 分级定价（仅超管）：某二级管理员的价格覆盖（按模型；未列出的模型用全局默认价）。
export type ManagerPrices = { modelCosts: AdminModelCost[]; videoModelCosts: AdminVideoModelCost[]; audioModelCosts?: AdminAudioModelCost[] };

export async function fetchManagerPrices(token: string, managerId: string) {
    return apiGet<ManagerPrices>(`/api/admin/managers/${encodeURIComponent(managerId)}/prices`, undefined, token);
}

export async function saveManagerPrices(token: string, managerId: string, prices: ManagerPrices) {
    return apiPost<ManagerPrices>(`/api/admin/managers/${encodeURIComponent(managerId)}/prices`, prices, token);
}

// 把项目归属分配给某二级管理员（ownerId 为空=收回到超管/全局；仅超管可调）
export async function assignProjectOwner(token: string, projectId: string, ownerId: string) {
    return apiPost<AdminProject>(`/api/admin/projects/${encodeURIComponent(projectId)}/owner`, { ownerId }, token);
}

// 把成员（creator）分配给某二级管理员（creatorId 为空=收回；仅对 role==user 生效）
export async function assignUserCreator(token: string, userId: string, creatorId: string) {
    return apiPost<AdminUser>(`/api/admin/users/${encodeURIComponent(userId)}/creator`, { creatorId }, token);
}

export async function fetchAdminUsers(token: string, query: AdminUserQuery = {}) {
    return apiGet<AdminUserListResponse>("/api/admin/users", compactApiParams(query), token);
}

export async function saveAdminUser(token: string, user: Partial<AdminUser> & { password?: string }) {
    return apiPost<AdminUser>("/api/admin/users", user, token);
}

export async function adjustAdminUserCredits(token: string, id: string, credits: number) {
    return apiPost<AdminUser>(`/api/admin/users/${encodeURIComponent(id)}/credits`, { credits }, token);
}

export async function deleteAdminUser(token: string, id: string) {
    return apiDelete<boolean>(`/api/admin/users/${encodeURIComponent(id)}`, token);
}

export async function fetchAdminCreditLogs(token: string, query: AdminCreditLogQuery = {}) {
    return apiGet<AdminCreditLogListResponse>("/api/admin/credit-logs", compactApiParams(query), token);
}

export async function fetchAdminCreditLogsSummary(token: string, query: AdminCreditLogQuery = {}) {
    return apiGet<AdminCreditLogSummaryResponse>("/api/admin/credit-logs/summary", compactApiParams(query), token);
}

export async function fetchAdminTaskLogs(token: string, query: AdminTaskLogQuery = {}) {
    return apiGet<AdminTaskLogListResponse>("/api/admin/task-logs", compactApiParams(query), token);
}

export async function saveAdminCreditLog(token: string, log: Partial<AdminCreditLog>) {
    return apiPost<AdminCreditLog>("/api/admin/credit-logs", log, token);
}

export async function deleteAdminCreditLog(token: string, id: string) {
    return apiDelete<boolean>(`/api/admin/credit-logs/${encodeURIComponent(id)}`, token);
}

export async function fetchAdminPromptCategories(token: string) {
    return apiGet<AdminPromptCategory[]>("/api/admin/prompt-categories", undefined, token);
}

export async function syncAdminPromptCategory(token: string, category: string) {
    return apiPost<AdminPromptCategory[]>("/api/admin/prompt-categories/sync", { category }, token);
}

export type AdminPromptQuery = {
    keyword?: string;
    category?: string;
    tag?: string[];
    page?: number;
    pageSize?: number;
};

export type AdminAsset = {
    id: string;
    title: string;
    type: "text" | "image" | "video";
    coverUrl: string;
    tags: string[];
    category: string;
    description: string;
    content: string;
    url: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminAssetListResponse = {
    items: AdminAsset[];
    tags: string[];
    total: number;
};

export async function fetchAdminPrompts(token: string, query: AdminPromptQuery = {}) {
    return apiGet<PromptListResponse>("/api/admin/prompts", compactApiParams(query), token);
}

export async function saveAdminPrompt(token: string, prompt: Partial<Prompt>) {
    return apiPost<Prompt>("/api/admin/prompts", prompt, token);
}

export async function deleteAdminPrompt(token: string, id: string) {
    return apiDelete<boolean>(`/api/admin/prompts/${encodeURIComponent(id)}`, token);
}

export async function deleteAdminPrompts(token: string, ids: string[]) {
    return apiPost<boolean>("/api/admin/prompts/batch-delete", { ids }, token);
}

export type AdminAssetQuery = {
    keyword?: string;
    type?: string;
    tag?: string[];
    page?: number;
    pageSize?: number;
};

export async function fetchAdminAssets(token: string, query: AdminAssetQuery = {}) {
    return apiGet<AdminAssetListResponse>("/api/admin/assets", compactApiParams(query), token);
}

export async function saveAdminAsset(token: string, asset: Partial<AdminAsset>) {
    return apiPost<AdminAsset>("/api/admin/assets", asset, token);
}

export async function deleteAdminAsset(token: string, id: string) {
    return apiDelete<boolean>(`/api/admin/assets/${encodeURIComponent(id)}`, token);
}

export type AdminModelChannel = {
    // openai = OpenAI 兼容；volc-audio = 火山音频（豆包语音 openspeech，原生协议，不走 OpenAI 转发）
    protocol: "openai" | "volc-audio";
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
    weight: number;
    enabled: boolean;
    remark: string;
    // 以下几项是留给特定渠道的扩展配置，OpenAI 兼容协议一律留空。
    // resourceId 仅 protocol="volc-audio"：X-Api-Resource-Id，决定豆包 TTS 的版本（默认 seed-tts-1.0，
    // 声音复刻填 seed-icl-2.0）。音频生成 seed-audio-1.0 不看这个头，可留空。
    resourceId?: string;
    accessKeySecret?: string;
};

// 模型类型：决定它出现在前台哪个节点的下拉里、以及在分级定价页归到哪一张表。
// 一个模型只归一类（真实调用记录里没有出现过跨类型的模型）。
export type AdminModelKind = "text" | "image" | "video" | "audio";

// 图片画质档与视频分辨率档的取值范围，与后端 model.ImageQualityTiers / VideoResolutionTiers 一一对应。
export const IMAGE_QUALITY_TIERS = ["1k", "2k", "4k"] as const;
export const VIDEO_RESOLUTION_TIERS = ["480p", "720p", "1080p", "2160p"] as const;

// 模型元信息：类型 + 支持的档位。刻意与定价表分开——定价表会丢弃价为 0 的档位，
// 「支持但不额外收费」这个状态在价格表里表达不出来。
export type AdminModelMeta = {
    model: string;
    kind: AdminModelKind;
    // 支持的档位（图片=画质档，视频=分辨率档）。留空=不限制，前端全开。
    resolutions?: string[];
    // 视频出片最长秒数。0/缺省=不限制（前端用内置能力表或默认 15 秒）。仅视频类型有意义。
    maxSeconds?: number;
};

export type AdminPublicModelChannelSettings = {
    availableModels: string[];
    modelMetas?: AdminModelMeta[];
    modelCosts: AdminModelCost[];
    videoModelCosts?: AdminVideoModelCost[];
    // 音频按秒计价（seed-audio）。缺省/0 = 该模型仍按次一口价，走 modelCosts。
    audioModelCosts?: AdminAudioModelCost[];
    defaultModel: string;
    defaultImageModel: string;
    defaultVideoModel: string;
    defaultTextModel: string;
    systemPrompt: string;
    allowCustomChannel: boolean;
};

export type AdminModelCost = {
    model: string;
    credits: number;
    // 图片按画质档分别定价。非空时优先于 credits（按档取，取不到回落 credits）。
    // 留空 = 沿用「不分档，一口价」，所以存量配置零改动。
    qualityRates?: { quality: string; credits: number }[];
    // 显示代称：仅前台展示别名，不参与调用/扣费。
    label?: string;
};

export type AdminVideoResolutionRate = {
    resolution: string;
    creditsPerSecond: number; // 不带视频输入(文/图生视频)每秒点数
    creditsPerSecondWithVideo?: number; // 带视频输入(视频生视频)每秒点数;缺省/0=回退不带输入价
};

export type AdminVideoModelCost = {
    model: string;
    rates: AdminVideoResolutionRate[];
    label?: string;
};

// AdminAudioModelCost 音频模型按秒计价。
// ⚠️ 与视频不同：音频的秒数不是用户选定的参数，上游(seed-audio)没有时长参数、
// 真实秒数要等出片才知道。所以这里配的单价用于「按目标时长预扣」，最终以上游返回的
// original_duration 结算差额（后端 settleAudioCredits）。
export type AdminAudioModelCost = {
    model: string;
    // 每 100 字（不足 100 按 100 算）积分。**优先级高于 creditsPerSecond**，
    // 与后端 handler/ai.go 的「按字数 > 按秒 > 按次」一致。
    creditsPer100Chars?: number;
    creditsPerSecond: number;
    label?: string;
};

export type AdminAnnouncementSettings = {
    enabled: boolean;
    message: string;
    // id 由后端自动维护：每次开启或改消息会盖新 id，前端按「未读过该 id」弹一次
    id?: string;
};

export type AdminPublicSettings = {
    modelChannel: AdminPublicModelChannelSettings;
    auth: {
        allowRegister: boolean;
        smsCode: boolean;
    };
    portraitAsset?: {
        enabled: boolean;
    };
    announcement?: AdminAnnouncementSettings;
};

export type AdminSmsSettings = {
    enabled: boolean;
    accessKey: string;
    secretKey: string;
    region: string;
    smsAccount: string;
    sign: string;
    templateId: string;
    // 单手机号每日发送上限，默认 20（后端兜底）
    dailyLimitPerPhone: number;
    // 单 IP 每日发送上限，默认 100（后端兜底）
    dailyLimitPerIP: number;
    // 相同手机号+IP 连续错误上限，默认 5（后端兜底）
    verifyMaxAttempts: number;
    // 锁定时长（分钟），默认 5（后端兜底）
    verifyLockMinutes: number;
    devMode: boolean;
};

export type AdminPrivateSettings = {
    channels: AdminModelChannel[];
    promptSync: {
        enabled: boolean;
        cron: string;
    };
    portraitAsset?: {
        accessKey: string;
        secretKey: string;
        projectName: string;
        region: string;
        groupName: string;
    };
    sms?: AdminSmsSettings;
};

export type AdminSettings = {
    public: AdminPublicSettings;
    private: AdminPrivateSettings;
};

export async function fetchAdminSettings(token: string) {
    return apiGet<AdminSettings>("/api/admin/settings", undefined, token);
}

export async function saveAdminSettings(token: string, settings: AdminSettings) {
    return apiPost<AdminSettings>("/api/admin/settings", settings, token);
}

export type AdminChannelActionRequest = {
    index?: number;
    channel: AdminModelChannel;
    model?: string;
};

export async function fetchChannelModels(token: string, payload: AdminChannelActionRequest) {
    return apiPost<string[]>("/api/admin/settings/channel-models", payload, token);
}

export async function testChannelModel(token: string, payload: AdminChannelActionRequest) {
    return apiPost<string>("/api/admin/settings/channel-test", payload, token);
}

// ===== 服务端画布历史（快照）：仅超管 =====
// 后端响应外层统一 {code,data,msg}，apiGet/apiPost 已解包返回 data。

// 列表项：不含 data 大字段；projects 为该版本 manifest 内 data.projects 数组长度（解析失败给 0）。
export type AdminCanvasSnapshot = {
    id: string;
    createdAt: string; // RFC3339，如 2026-06-17T10:00:00+08:00
    bytes: number;
    projects: number;
};

// 详情：data 为整份 manifest JSON 字符串（前端需自行 JSON.parse）。
export type AdminCanvasSnapshotDetail = {
    id: string;
    userId: string;
    createdAt: string;
    bytes: number;
    data: string;
};

export type AdminCanvasRestoreResult = {
    restored: boolean;
    // 恢复前对该用户当前 canvas 数据强制创建的备份快照 ID（可预览或再次 restore 以撤销）。
    backupSnapshotId: string;
};

// GET /api/admin/users/:id/canvas-snapshots → 该用户快照列表（createdAt 倒序，最多 30 条；无快照为 []）
export async function listCanvasSnapshots(token: string, userId: string) {
    const res = await apiGet<{ snapshots: AdminCanvasSnapshot[] }>(`/api/admin/users/${encodeURIComponent(userId)}/canvas-snapshots`, undefined, token);
    return res.snapshots ?? [];
}

// GET /api/admin/canvas-snapshots/:snapId → 单个快照详情（含 manifest JSON 字符串）
export async function getCanvasSnapshot(token: string, snapId: string) {
    return apiGet<AdminCanvasSnapshotDetail>(`/api/admin/canvas-snapshots/${encodeURIComponent(snapId)}`, undefined, token);
}

// POST /api/admin/users/:id/canvas-snapshots/:snapId/restore → 恢复（先自动备份当前数据再覆盖）
export async function restoreCanvasSnapshot(token: string, userId: string, snapId: string) {
    return apiPost<AdminCanvasRestoreResult>(`/api/admin/users/${encodeURIComponent(userId)}/canvas-snapshots/${encodeURIComponent(snapId)}/restore`, undefined, token);
}
