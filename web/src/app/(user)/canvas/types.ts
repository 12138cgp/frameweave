export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

import type { StoryboardNodeState } from "./utils/canvas-storyboard";
import type { RoomSceneState } from "./utils/canvas-room-scene";
import type { StageNodeState } from "./utils/canvas-stage";

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Storyboard = "storyboard",
    SceneCamera = "sceneCamera",
    // Stage 3D 场景台。枚举值必须是 "stage"：utils/node-naming.ts 的标签表里
    // 早就预留了 stage: "场景台" 这一行（用字符串键而非枚举引用），取这个值就能直接拿到
    // 正确的默认名「场景台1」，那个文件一行都不用改。
    Stage = "stage",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    // 提示词输入框草稿：生成后/刷新后保留用户输入（prompt 字段会被生成流程覆盖成最终生效提示词）
    promptDraft?: string;
    // 分镜故事板节点：第六步生成视频用的提示词（垫故事板图+定妆图后使用）
    videoPrompt?: string;
    // 进行中的视频生成任务（断点续查：超时/刷新后重试会先查询原任务，避免重复扣费）
    videoTaskId?: string;
    videoTaskProvider?: "openai" | "seedance";
    // 进行中的生图任务（服务端异步任务：刷新/切页后凭 ID 自动领回结果，保留 48 小时）
    imageJobId?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    // 生成计时：进 loading 记开始时间(ISO,持久化抗刷新)，出 loading 由中心 effect 算耗时(毫秒)。
    generationStartedAt?: string;
    generationMs?: number;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    size?: string;
    quality?: string;
    count?: number;
    // 图片节点所选「风格」预设 id（见 lib/image-style-presets）。空=不注入风格；生成时助提示词追加到用户描述后。
    imageStyle?: string;
    // 图片节点所选「视图(排版)」预设 id（如真人三视图）。空=不注入；与 imageStyle 独立可叠加。
    imageView?: string;
    // 视频节点所选「风格」预设 id（见 lib/video-style-presets）。空=不注入；生成时助提示词追加到描述后。
    videoStyle?: string;
    // 视频节点所选「模式」（取值见 lib/seedance-video 的 VideoMode）。空 / "auto" = 沿用旧行为。
    //
    // 为什么要把模式变成用户显式选的：上游 Seedance 是按 content[].role 显式声明任务类型的
    //（first_frame / last_frame / reference_image …），而我们这边以前所有参考图一律发 reference_image，
    // 于是「图生视频」「首尾帧」在 Seedance 上根本发不出正确形态 —— 用户接两张图想做首尾帧，
    // 实际发出去的是「把两张图当内容参考」，语义整个错掉，而且不报任何错。
    // 反过来，让上游按素材数量自行推断也一样危险：接「场景图 + 人物图」两张参考，
    // 会被判成「从 A 图渐变到 B 图」的首尾帧任务，连输出画幅都跟着首帧图走。
    // 结论是：任务类型必须【显式声明】，不能靠数量猜——这条教训与具体渠道无关。
    videoMode?: string;
    // 首尾帧模式下，哪张参考图当首帧、哪张当尾帧。值是该参考素材的【节点 id】。
    // ⚠️ 存标识而不是下标：参考素材顺序会随连线增删变动，存下标等于换个地方继续「猜」。
    // ⚠️ 也别改存地址：图片自愈换链、blob 重建、肖像授权换成 asset:// 都会换地址，一失配就静默落回接入顺序，
    //    用户点过的「对调首尾帧」白点且界面看不出异常。节点 id 在这条画布里从生到死都不变。
    //    （请求层 frameRoleMatches 对地址型键也留了兼容，但那只是兜底，不该是常态。见 services/api/video.ts）
    videoFrameRoles?: { first?: string; last?: string };
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    /** 视频输出封装格式：mp4 / mov（mov 仅 Seedance 2.5） */
    videoOutputFormat?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    // 音频生成(seed-audio)：采样率(Hz)/音量/音调。
    audioSampleRate?: string;
    audioLoudness?: string;
    audioPitch?: string;
    // audioBilledSeconds 上游返回的音频时长(original_duration)。
    // ⚠️ 名字里的 billed 是历史包袱：音频当前是【按次一口价】，时长不参与计费；
    // 只有后台给该模型配了「每秒点数」时它才是结算依据。别把它当扣费金额看。
    audioBilledSeconds?: number;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    manualSize?: boolean; // 用户手动拉伸过尺寸，加载时不被统一尺寸规范覆盖
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    // browserPlayable=false：这个视频浏览器解不了（最常见是 iPhone 默认的 H.265）。
    // 此时 <video> 读不到宽高，真实规格靠服务端 ffprobe 补（见 services/file-storage.ts）。
    browserPlayable?: boolean;
    videoCodec?: string;
    // previewContent 只用于画布里播放：源片浏览器解不了（或者大得离谱）时，
    // 服务端转出的 H.264 720p 版本。当参考 / 下载 / 后续处理读的都还是 content（原片）。
    previewContent?: string;
    portraitAsset?: boolean;
    portraitAssetId?: string;
    portraitAssetStatus?: "processing" | "active" | "failed";
    portraitAssetUri?: string;
    portraitAssetError?: string;
    // 故事板节点：整个分镜向导的持久化状态
    storyboard?: StoryboardNodeState;
    roomScene?: RoomSceneState;
    // 3D 场景台节点的状态。
    stage?: StageNodeState;
    // AI 调用追踪码（对应后台日志 trace=，仅节点信息弹窗显示）
    traceId?: string;
    // favoriteId 这次生成已被收藏（值＝收藏记录 id）。收藏本体存在服务端 prompt_favorites 表，
    // 这里只是让按钮能显示「已收藏」的本地标记。
    //
    // ⚠️ 别把它当权威：写它的那一拍可能被 skipNextPersist 吞掉，
    // 所以画布加载时会向服务端拉一次「本画布已收藏的节点」来校正（见 canvas-client-page 里的
    // favoriteNodeIds 同步）。服务端那张表才是唯一真相，收藏接口也做了幂等。
    favoriteId?: string;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeType;
    title: string;
    // 节点自定义命名（详见 utils/node-naming.ts）：
    // name=用户自定义显示名（仅 nameIsCustom 时生效）；nameIsCustom=是否被用户双击改过；
    // nameSeq=创建时分配的「同类型稳定序号」，默认名=类型前缀+nameSeq，删除节点不重排号。
    name?: string;
    nameIsCustom?: boolean;
    nameSeq?: number;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
    // 多设备同步：节点级修订号（单调递增逻辑时钟，见 services/hlc.ts），用于逐节点合并仲裁；
    // updatedAt 为回退键。均可选，老数据/老客户端缺失时按 0 处理，绝不因缺字段丢节点。
    rev?: number;
    updatedAt?: string;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    // 多设备同步：连线级修订号，含义同 CanvasNodeData.rev。
    rev?: number;
};

// 节点打组：独立实体，不给节点加 groupId。一节点最多属于一组、不嵌套。
// 组框不存坐标，每帧由成员节点包围盒 + padding 实时计算。
export type CanvasGroup = {
    id: string;
    title?: string;
    memberNodeIds: string[];
    color?: string;
    createdAt: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeType;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
    // 肖像授权状态随「我的素材」取用还原回节点（分享存图时仅当已认证 active 才带）
    portraitAssetId?: string;
    portraitAssetStatus?: "processing" | "active" | "failed";
    portraitAssetUri?: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant";
    mode: "ask" | "image";
    text: string;
    isLoading?: boolean;
    references?: CanvasAssistantReference[];
    images?: CanvasAssistantImage[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      }
    | {
          type: "group";
          x: number;
          y: number;
          groupId: string;
      };
