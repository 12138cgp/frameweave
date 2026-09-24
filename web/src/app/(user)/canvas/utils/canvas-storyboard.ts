import type { ChatCompletionMessage } from "@/services/api/image";

// 分镜故事板向导：数据结构与提示词模板（模板来自「特效小哥教程」六步成片流程）。

export type StoryboardDurationKey = "15s" | "30s" | "60s" | "120s";

export const STORYBOARD_DURATIONS: Record<StoryboardDurationKey, { label: string; segments: number; shotsPerSegment: number }> = {
    "15s": { label: "15秒 · 8镜 · 1段", segments: 1, shotsPerSegment: 8 },
    "30s": { label: "30秒 · 16镜 · 2段", segments: 2, shotsPerSegment: 8 },
    "60s": { label: "60秒 · 32镜 · 4段", segments: 4, shotsPerSegment: 8 },
    "120s": { label: "2分钟 · 64镜 · 8段", segments: 8, shotsPerSegment: 8 },
};

export type StoryboardWizardInput = {
    story: string;
    genre: string;
    tone: string;
    duration: StoryboardDurationKey;
    characters: string;
    extra: string;
};

export type StoryboardShot = {
    no: number;
    shotSize: string;
    camera: string;
    desc: string;
    dialogue?: string;
};

export type StoryboardSegment = {
    title: string;
    story: string;
    characters: string[];
    scenes: string[];
    shots: StoryboardShot[];
};

export type StoryboardPlan = {
    title: string;
    style: string;
    characters: { name: string; prompt: string }[];
    scenes: { name: string; prompt: string }[];
    segments: StoryboardSegment[];
};

// 故事板「节点」持久化状态：随画布存 IndexedDB + 云同步，刷新不丢。资产只存 storageKey 等可序列化字段（blob url 刷新即失效）。
export type StoryboardAsset = {
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export type StoryboardNodeState = {
    mode: "auto" | "custom";
    // AI 自动成片输入
    story?: string;
    genre?: string;
    tone?: string;
    duration?: StoryboardDurationKey;
    characters?: string;
    extra?: string;
    // 我的分镜脚本输入
    script?: string;
    style?: string;
    // 解析/生成出的方案
    plan?: StoryboardPlan;
    // 每个人物/场景资产：AI 生成提示词 or 用户上传
    assetMode?: Record<string, "ai" | "upload">;
    assets?: Record<string, StoryboardAsset>;
    // 节点级选择的文本模型（解析用，覆盖全局默认文本模型）
    model?: string;
    // 最近一次解析失败信息（持久化，浮层卸载/刷新后仍能看到）
    parseError?: string;
};

const SHOT_SIZES = "大远景/远景/全景/中景/近景/特写/大特写";
const CAMERA_MOVES = "固定/跟拍/推进/拉远/环绕/横移/手持";

// 通用要求块：约束模型输出（① 只吐一个合规 JSON、不要代码块/解释、所有括号闭合不截断；② 规范简体；③ 标准景别/运镜术语；④ 描述/对白精简，便于画到分镜图上不乱）。
const STORYBOARD_OUTPUT_RULES = `输出与文字规范（务必严格遵守）：
- 只输出一个完整、合规的 JSON 对象；不要使用 markdown 代码块（不要 \`\`\`），不要输出任何解释、前后缀或多余文字。
- 确保 JSON 所有引号、括号、方括号都正确闭合，绝不中途截断；内容宁可精简也不要写到一半。
- 所有中文使用规范简体字，避免生僻字、繁简混用与错别字，标点使用规范中文标点。
- 景别只能从「${SHOT_SIZES}」中选用标准术语；运镜只能从「${CAMERA_MOVES}」中选用标准术语。
- 每个镜头的 desc 简洁（建议不超过 30 字），dialogue 简短（建议不超过 20 字），避免超长句子，便于后续绘制到分镜图上不致糊乱。`;

// 把任意文本压成适合写进生图 prompt 的单行短文本：去换行/制表/多余空格、去掉易干扰排版的特殊符号（保留中日韩文字与常用中英文标点），超长截断。
export function sanitizeStoryboardText(value: string | undefined | null, maxLen = 0): string {
    if (!value) return "";
    let text = String(value)
        // 换行、制表、回车等空白统一成单空格
        .replace(/[\r\n\t\f\v]+/g, " ")
        // 去掉控制字符、零宽字符、方向控制符与 BOM 等不可见字符（保留 CJK、字母数字、空格与常用标点）
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
        // 去掉容易干扰生图排版/可能被当作格式标记的符号
        .replace(/[`*#~^|<>{}[\]\\]/g, "")
        // 多个空格压成一个
        .replace(/\s{2,}/g, " ")
        .trim();
    if (maxLen > 0 && text.length > maxLen) {
        text = `${text.slice(0, maxLen)}…`;
    }
    return text;
}

// 从模型原始输出里抓出候选 JSON 子串：定位第一个 { 到最后一个 }。
function extractJsonCandidate(raw: string): string {
    const text = raw.trim();
    // 去掉可能的 markdown 代码块包裹
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : text;
    const start = body.indexOf("{");
    if (start < 0) throw new Error("未找到 JSON 内容（模型未返回 { 开头的对象）");
    return body.slice(start);
}

// 对候选 JSON 做括号/方括号配对扫描，正确跳过字符串内的括号（处理进入/退出字符串态与 \" 转义）。
// 返回：最后一个使「整体配对回到平衡」的右括号下标（即一个完整 JSON 对象的结束位置）；找不到返回 -1。
// 同时通过 balanced 判断整段是否平衡（用于判断截断）。
function findBalancedEnd(candidate: string): { lastBalanced: number; balanced: boolean } {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    let lastBalanced = -1;
    for (let i = 0; i < candidate.length; i++) {
        const ch = candidate[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === "{" || ch === "[") {
            depth++;
            started = true;
        } else if (ch === "}" || ch === "]") {
            depth--;
            if (depth === 0 && started) lastBalanced = i;
            // depth < 0 说明出现多余的右括号，配对已乱，停在这
            if (depth < 0) break;
        }
    }
    const balanced = started && depth === 0 && !inString;
    return { lastBalanced, balanced };
}

// 截断容错：候选 JSON 未闭合时，扫描到「最后一个完整的对象/数组元素」的边界（即处于某层、刚结束一个元素、其后是 , 或层级闭合的位置），
// 裁掉残缺尾巴，再按当时的括号栈补齐闭合符，凑成一个可解析的对象。尽量多保住已生成的 segment/shot。
function repairTruncatedJson(candidate: string): string | null {
    const stack: string[] = []; // 记录还未闭合的 { / [
    let inString = false;
    let escaped = false;
    let lastSafe = -1; // 安全裁切点（此下标处字符之后可以补闭合符）
    for (let i = 0; i < candidate.length; i++) {
        const ch = candidate[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === "{" || ch === "[") {
            stack.push(ch);
        } else if (ch === "}" || ch === "]") {
            if (stack.length) stack.pop();
            // 刚闭合一个对象/数组元素，且仍处于某个数组/对象内部 → 是个安全裁切点
            if (stack.length) lastSafe = i;
        }
    }
    if (lastSafe < 0) return null;
    // 在 lastSafe 处重新计算尚未闭合的栈，决定要补哪些闭合符
    const head = candidate.slice(0, lastSafe + 1);
    const closeStack: string[] = [];
    let s = false;
    let esc = false;
    for (let i = 0; i < head.length; i++) {
        const ch = head[i];
        if (s) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') s = false;
            continue;
        }
        if (ch === '"') s = true;
        else if (ch === "{") closeStack.push("}");
        else if (ch === "[") closeStack.push("]");
        else if (ch === "}" || ch === "]") closeStack.pop();
    }
    return head + closeStack.reverse().join("");
}

function validateStoryboardPlan(parsed: StoryboardPlan): void {
    if (!parsed || typeof parsed !== "object") throw new Error("JSON 顶层不是对象");
    if (!Array.isArray(parsed.characters)) throw new Error("JSON 缺少 characters 数组");
    if (!Array.isArray(parsed.scenes)) throw new Error("JSON 缺少 scenes 数组");
    if (!Array.isArray(parsed.segments) || !parsed.segments.length) throw new Error("JSON 缺少 segments 数组或为空");
    const badSegment = parsed.segments.findIndex((seg) => !seg || !Array.isArray(seg.shots));
    if (badSegment >= 0) throw new Error(`第 ${badSegment + 1} 段缺少 shots 数组`);
}

export function buildStoryboardPlannerMessages(input: StoryboardWizardInput): ChatCompletionMessage[] {
    const duration = STORYBOARD_DURATIONS[input.duration];
    const totalShots = duration.segments * duration.shotsPerSegment;
    const prompt = `你是专业的电影分镜师和 AI 生图提示词专家。请根据下面的故事创意，产出一套可直接用于 AI 生图的分镜方案。

故事创意：${input.story}
题材类型：${input.genre || "由你根据故事判断"}
风格基调：${input.tone || "由你根据故事判断"}
${input.characters ? `核心人物设定：${input.characters}` : "核心人物：由你根据故事设计（主角几人、性格特征、关键道具、标志性服装，越具体越好）"}
${input.extra ? `补充要求：${input.extra}` : ""}

结构要求：
- 共 ${duration.segments} 段，每段约 15 秒、${duration.shotsPerSegment} 个镜头，总计 ${totalShots} 个镜头，镜头编号全局连续（镜头1~镜头${totalShots}）。
- 每个镜头包含：景别（从 ${SHOT_SIZES} 中选）、摄影机运动方式（从 ${CAMERA_MOVES} 中选）、人物动作与情绪描述、对白（可选，没有就留空）。
- 每段开头声明本段出场人物（对应人物定妆图）和所用场景（对应场景图），镜头描述里点名当前人物和场景名。
- 避免不同镜头之间画面构图过于相似；注意节奏：开场定调、中段推进、结尾收束。

人物定妆图提示词格式（用于 characters[].prompt，每个角色一段完整提示词）：
[性别年龄]，[发型发色]，[眼睛特征]，[肤色/皮肤质感]，[服装描述：上衣/下装/鞋/配件]，[标志性道具]，[性格气质]，站立展示状态，包含正面、侧面、背面角色设定参考，[不要出现的元素]。风格：[整体视觉风格]，[光线描述]，[色调描述]。关键词：[英文标签，5~8个]

场景图提示词格式（用于 scenes[].prompt，每个场景一段完整提示词）：
[场景名称/类型]，[空间特征描述]，[光线描述]，[标志性道具]，[氛围关键词]，无人物，环境概念图，[视觉风格]，[色调]，高细节，写实摄影质感

${STORYBOARD_OUTPUT_RULES}

JSON 结构如下：
{
  "title": "短片名（4~8字）",
  "style": "整体风格限定与色调方向，一句话",
  "characters": [{ "name": "角色名", "prompt": "定妆图提示词" }],
  "scenes": [{ "name": "场景名", "prompt": "场景图提示词" }],
  "segments": [
    {
      "title": "段落小标题",
      "story": "本段一句话故事",
      "characters": ["出场角色名"],
      "scenes": ["所用场景名"],
      "shots": [{ "no": 1, "shotSize": "中景", "camera": "跟拍", "desc": "人物动作与情绪描述（含场景名）", "dialogue": "" }]
    }
  ]
}`;

    return [{ role: "user", content: prompt }];
}

export type StoryboardScriptInput = {
    script: string;
    style: string;
};

// 自定义分镜：把用户写好的分镜脚本「忠实解析」成结构化方案（不重编剧情），并识别出需要的人物/场景资产。
export function buildStoryboardParserMessages(input: StoryboardScriptInput): ChatCompletionMessage[] {
    const prompt = `你是专业的分镜脚本解析助手。下面是用户已经写好的分镜脚本，请严格按照用户提供的内容，把它整理、结构化成一套可直接用于 AI 生图的分镜方案。

铁律：
- 忠实于用户脚本，不要新增、删减或改写剧情与镜头内容；你的工作是「整理结构」，不是「再创作」。
- 只有当某个镜头缺少景别或运镜信息时，才根据该镜头画面合理补一个；画面描述与对白必须基于用户原文。

用户分镜脚本：
${input.script}
${input.style ? `\n整体风格基调：${input.style}` : ""}

结构要求：
- 按脚本中的镜头顺序拆分；脚本未明确编号时，按画面切换合理切分镜头，镜头编号全局连续。
- 每个镜头包含：景别（从 ${SHOT_SIZES} 中选）、摄影机运动方式（从 ${CAMERA_MOVES} 中选）、人物动作与情绪描述（基于用户原文）、对白（脚本中有才填，没有就留空）。
- 按顺序分段，每段不超过 8 个镜头（每段对应一张分镜故事板图）。每段给出段落小标题、一句话故事概括、本段出场人物名、本段所用场景名。
- 识别脚本里出现的所有人物与场景，为每个人物写一段定妆图提示词、每个场景写一段场景图提示词（供后续 AI 生图使用；即使用户可能自己上传，也照常输出作为备选）。

人物定妆图提示词格式（用于 characters[].prompt，每个角色一段完整提示词）：
[性别年龄]，[发型发色]，[眼睛特征]，[肤色/皮肤质感]，[服装描述：上衣/下装/鞋/配件]，[标志性道具]，[性格气质]，站立展示状态，包含正面、侧面、背面角色设定参考，[不要出现的元素]。风格：[整体视觉风格]，[光线描述]，[色调描述]。关键词：[英文标签，5~8个]

场景图提示词格式（用于 scenes[].prompt，每个场景一段完整提示词）：
[场景名称/类型]，[空间特征描述]，[光线描述]，[标志性道具]，[氛围关键词]，无人物，环境概念图，[视觉风格]，[色调]，高细节，写实摄影质感

${STORYBOARD_OUTPUT_RULES}

JSON 结构如下：
{
  "title": "短片名（4~8字，可据脚本拟定）",
  "style": "整体风格限定与色调方向，一句话",
  "characters": [{ "name": "角色名", "prompt": "定妆图提示词" }],
  "scenes": [{ "name": "场景名", "prompt": "场景图提示词" }],
  "segments": [
    {
      "title": "段落小标题",
      "story": "本段一句话故事",
      "characters": ["出场角色名"],
      "scenes": ["所用场景名"],
      "shots": [{ "no": 1, "shotSize": "中景", "camera": "跟拍", "desc": "人物动作与情绪描述（含场景名）", "dialogue": "" }]
    }
  ]
}`;

    return [{ role: "user", content: prompt }];
}

export function parseStoryboardPlan(raw: string): StoryboardPlan {
    if (!raw || !raw.trim()) throw new Error("模型未返回任何内容");
    const candidate = extractJsonCandidate(raw);
    const { lastBalanced, balanced } = findBalancedEnd(candidate);

    let parsed: StoryboardPlan | null = null;
    let lastError: unknown = null;

    // ① 存在「整体配对回到平衡」的闭合点：截到该点解析（丢掉对象后多余文字 / 多余右括号）。
    if (lastBalanced >= 0) {
        try {
            parsed = JSON.parse(candidate.slice(0, lastBalanced + 1)) as StoryboardPlan;
        } catch (error) {
            lastError = error;
        }
    }

    // ② 疑似截断（顶层未闭合）或①解析失败：裁掉残缺尾巴 + 补齐闭合符，尽量保住已生成的 segment/shot。
    if (!parsed) {
        const repaired = repairTruncatedJson(candidate);
        if (repaired) {
            try {
                parsed = JSON.parse(repaired) as StoryboardPlan;
            } catch (error) {
                lastError = error;
            }
        }
    }

    if (!parsed) {
        const near = candidate.slice(Math.max(0, candidate.length - 80)).replace(/\s+/g, " ").trim();
        const hint = balanced ? "JSON 解析失败" : "JSON 疑似被截断（括号未闭合）";
        const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "");
        throw new Error(`${hint}${reason ? `：${reason}` : ""}。结尾附近文本：…${near}`);
    }

    validateStoryboardPlan(parsed);

    // 镜头全局重编号，避免模型编号错乱
    let no = 1;
    parsed.segments.forEach((segment) => {
        segment.shots = (segment.shots || []).map((shot) => ({ ...shot, no: no++ }));
        segment.characters = segment.characters || [];
        segment.scenes = segment.scenes || [];
    });
    parsed.characters = parsed.characters.filter((item) => item?.name && item?.prompt);
    parsed.scenes = parsed.scenes.filter((item) => item?.name && item?.prompt);
    return parsed;
}

// 第五步「分镜故事板图」提示词框架（每段一张，垫人物定妆图 + 场景图）
export function buildStoryboardImagePrompt(plan: StoryboardPlan, segment: StoryboardSegment): string {
    const shotCount = segment.shots.length;
    const rows = Math.ceil(shotCount / 2);
    // 清洗角色/场景名（去特殊符号、压单行、限长），降低画到图上时的乱码与排版错乱
    const cleanNames = (names: string[]) => names.map((name) => sanitizeStoryboardText(name, 12)).filter(Boolean);
    const charNames = segment.characters.length ? cleanNames(segment.characters) : cleanNames(plan.characters.map((item) => item.name));
    const sceneNames = segment.scenes.length ? cleanNames(segment.scenes) : cleanNames(plan.scenes.map((item) => item.name));
    const characterLine = charNames.join("、");
    const sceneLine = sceneNames.join("、");
    const style = sanitizeStoryboardText(plan.style, 60);
    const story = sanitizeStoryboardText(segment.story, 40);
    const shotLines = segment.shots
        .map((shot) => {
            const desc = sanitizeStoryboardText(shot.desc, 30);
            const dialogue = sanitizeStoryboardText(shot.dialogue, 20);
            const size = sanitizeStoryboardText(shot.shotSize, 6);
            const camera = sanitizeStoryboardText(shot.camera, 6);
            return `镜头${shot.no}：${size}，${camera}，${desc}${dialogue ? `，说："${dialogue}"` : ""}`;
        })
        .join("\n");

    return `生成一张专业电影预制作分镜故事板，16:9横版，网格布局，2列${rows}行共${shotCount}格，排版清晰专业。

整体风格：${style}。${story}
主角：${characterLine}（外观以参考图中的人物定妆图为准，强调跨镜头外貌一致性）
场景：${sceneLine}（以参考图中的场景图为准）

包含以下区域：
【顶部创意总览栏】整体风格限定、色调方向、镜头数量、统一环境背景说明。
【角色参考区】主角多角度设定（正面/侧面/背面/特写），标注服装与标志性道具，强调跨镜头外貌一致性。
【场景环境区】核心场景概念图，附俯视机位调度示意图，标注摄影机位置、移动路径、拍摄方向。
【分镜格区（${shotCount}个镜头）】每格包含：
- 镜头编号与景别类型
- 摄影机运动方式（固定/跟拍/推进/拉远/手持等）
- 人物动作与情绪描述
- 对白文字（如有）
【灯光与氛围区】光线类型、色调、时间段、情绪关键词。
【音频方向区】环境音、音乐风格、整体声音氛围。
【摄影风格备注区】镜头焦段偏好、景深风格、后期调色方向。

${shotCount}镜分镜如下：
${shotLines}

各镜头标注摄影机运动方式与景别类型，关键情绪镜头适当放大展示。
整体效果：专业导演预制作指南风格，电影感强，信息密度高，一眼传达视觉叙事逻辑。
避免不同镜头格之间画面过于相似。

图上文字要求：所有标注文字使用规范简体中文，保留中文标签，不要英文化；文字必须准确、清晰、可读，不要错别字、乱码、缺笔少画或重复字；文字精简、字号适中、排版整齐、不与画面重叠；宁可少写文字也不要写糊、写错。`;
}

// 第六步「视频生成」提示词（标准版，垫故事板图 + 定妆图后使用）
export function buildVideoPrompt(plan: StoryboardPlan, segment: StoryboardSegment): string {
    const shotLines = segment.shots.map((shot) => `镜头${shot.no}：${shot.shotSize}，${shot.camera}，${shot.desc}${shot.dialogue ? `，说："${shot.dialogue}"` : ""}`).join("\n");
    return `将上传的分镜故事板图作为最高优先级执行蓝图。

按照分镜故事板创作电影短片。动态摄像机运动，镜头中不出现摄像机设备。

故事 = ${segment.story}

${shotLines}

避免不同镜头之间画面构图过于相似。`;
}

// 完整分镜脚本文本（落到画布上的文本节点，方便后续修改与生成视频时取用）
export function buildScriptText(plan: StoryboardPlan): string {
    const header = `《${plan.title}》分镜脚本\n整体风格：${plan.style}\n\n角色：${plan.characters.map((item) => item.name).join("、")}\n场景：${plan.scenes.map((item) => item.name).join("、")}`;
    const segments = plan.segments
        .map((segment, index) => {
            const refs = [`本段参考图：`, ...segment.characters.map((name) => `- 人物：${name} — 对应${name}定妆图`), ...segment.scenes.map((name) => `- 场景：${name} — 对应${name}场景图`)].join("\n");
            const shots = segment.shots.map((shot) => `镜头${shot.no}：${shot.shotSize}，${shot.camera}，${shot.desc}${shot.dialogue ? `，说："${shot.dialogue}"` : ""}`).join("\n");
            return `第${index + 1}段（${index * 15}~${(index + 1) * 15}秒）——${segment.title}\n故事 = ${segment.story}\n\n${refs}\n\n${shots}`;
        })
        .join("\n\n────────────\n\n");
    return `${header}\n\n${segments}`;
}
