export type ReferenceImage = {
    id: string;
    name: string;
    label?: string;
    type: string;
    dataUrl: string;
    // sourceUrl 水合前的原始地址。
    // hydrateNodeGenerationContext 会把 dataUrl 覆写成 base64，覆写之后就再也认不出这张图原本存在哪里了——
    // 而记录参考快照(metadata.references)恰恰发生在水合【之后】。没有这个字段时，凡是只有公网地址、
    // 没有 storageKey 的参考图（团队素材/分享取用的图最常见）都会在快照里被整条丢掉。
    sourceUrl?: string;
    url?: string;
    storageKey?: string;
    // frameRole 首尾帧模式下这张图的角色：first=首帧、last=尾帧。
    // 只有「首尾帧」模式读它，其余模式一律忽略。
    // ⚠️ 不能靠数组下标定首尾：参考素材的顺序会随连线增删而变，靠顺序就等于在「猜」用户的意图。
    //    「按素材的数量/顺序去猜任务类型」这种隐式约定，猜错时既不报错也没痕迹，用户只看到出片方向反了。
    frameRole?: "first" | "last";
    // 人像资产认证（Seedance 2.0 真人参考必需）：认证通过后 url 改写为 asset://，调用链自动以授权素材引用
    portraitAssetStatus?: "processing" | "active" | "failed";
    portraitAssetId?: string;
    portraitAssetUri?: string;
    portraitAssetError?: string;
};
