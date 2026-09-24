export type ReferenceVideo = {
    id: string;
    name: string;
    label?: string;
    type: string;
    url: string;
    // sourceUrl 素材本体的地址。节点做过素材授权时 url 会被换成火山方舟的 asset://，
    // 原来的公网地址就此丢失——而部分上游不认 asset://、只能用真实地址，故单独留一份。
    sourceUrl?: string;
    storageKey?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type ReferenceAudio = {
    id: string;
    name: string;
    label?: string;
    type: string;
    // bytes 文件字节数。seed-audio 的参考音频有 10MB 硬上限，前端据此在发请求前提醒；
    // 缺这个字段的话那条校验就是永远不触发的死代码（2026-09-20 审查发现）。
    bytes?: number;
    url: string;
    // sourceUrl 素材本体的地址。节点做过素材授权时 url 会被换成火山方舟的 asset://，
    // 原来的公网地址就此丢失——而部分上游不认 asset://、只能用真实地址，故单独留一份。
    sourceUrl?: string;
    storageKey?: string;
    durationMs?: number;
};
