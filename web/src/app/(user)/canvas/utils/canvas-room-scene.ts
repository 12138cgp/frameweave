// 场景机位：核心工具（纯 TS，无 React）。
// 流程：文本模型据用户房间描述 → 输出俯视平面布局 JSON（parseRoomPlan 容错解析+清洗）；
// 用户在平面图上摆相机（位置 + 朝向 + 视野）→ 文本模型描述该机位画面（buildView*）；
// 最终把「原始场景描述 + 机位视角描述」拼成图片模型 prompt（buildRoomImagePrompt）。
// JSON 容错思路复用同目录 canvas-storyboard.ts 的 parseStoryboardPlan（extractJsonCandidate/findBalancedEnd/repairTruncatedJson）。

// 俯视平面图上的家具/物件。坐标归一化 0..1，原点左上，x 向右、y 向下；(x,y)=左上角，w/h=宽高占比。
export type RoomItem = { id: string; label: string; x: number; y: number; w: number; h: number };
// 门窗：贴在某面墙上。pos/len 是沿该墙方向的归一化位置与长度（0..1）。
export type RoomOpening = { id: string; kind: "door" | "window"; wall: "top" | "right" | "bottom" | "left"; pos: number; len: number };
export type RoomPlan = { items: RoomItem[]; openings: RoomOpening[]; note?: string };
// 相机：x,y 归一化 0..1；angle 角度制，0=朝上（平面图上方/北）、顺时针为正；fov 视野角度数。
export type RoomCamera = { x: number; y: number; angle: number; fov: number };
export type RoomSceneState = { prompt: string; sceneImageUrl?: string; sceneStorageKey?: string; plan: RoomPlan | null; camera: RoomCamera; imageModel?: string; refImageUrl?: string; refImageStorageKey?: string };

export const DEFAULT_ROOM_CAMERA: RoomCamera = { x: 0.5, y: 0.82, angle: 0, fov: 60 };

// ① 文本模型 system：据房间描述输出俯视平面布局 JSON。
export const ROOM_PLAN_SYSTEM_PROMPT = `你是室内布局规划助手。请根据用户给出的房间/场景描述，输出该房间的「俯视平面布局」JSON。

坐标系与规则（务必严格遵守）：
- 俯视图（从天花板往下看），坐标归一化到 0..1：原点在左上角，x 轴向右、y 轴向下。
- 每件家具用矩形表示：(x, y) 是矩形左上角，w/h 是宽、高占整张平面图的比例（0..1）。
- 家具数量不超过约 10 件；彼此尽量不重叠，且不超出 0..1 边界（x + w ≤ 1、y + h ≤ 1）。
- label 用简体中文家具名（如：沙发、电视柜、床、餐桌、书桌、衣柜、茶几、地毯、冰箱、灶台等）。
- 门窗放在对应的墙上：wall 取 top/right/bottom/left，pos 是门窗起点沿该墙的归一化位置（0..1），len 是门窗长度（0..1）。窗用 "window"，门用 "door"，label 用「窗」「门」。
- note 可选，简体中文，一句话补充（如朝向、用途），没有就给空字符串。

输出规范：
- 只输出一个完整、合规的 JSON 对象；不要使用 markdown 代码块（不要 \`\`\`），不要输出任何解释、前后缀或多余文字。
- 确保所有引号、括号、方括号正确闭合，绝不中途截断。

JSON 结构如下：
{
  "items": [{ "id": "item-1", "label": "沙发", "x": 0.1, "y": 0.6, "w": 0.3, "h": 0.15 }],
  "openings": [{ "id": "open-1", "kind": "door", "wall": "bottom", "pos": 0.4, "len": 0.15 }],
  "note": ""
}

若随附了房间照片，请优先依据照片推断房间形状、家具种类与相对位置、门窗位置朝向；文字描述用于补充用途/风格/未在图中体现的信息。输出仍为同样的 JSON。`;

// ② 包裹用户房间描述成 user 内容。
export function buildRoomPlanUserPrompt(prompt: string): string {
    const room = (prompt || "").trim() || "（用户未填写，请按一个普通的家居房间合理布置）";
    return `房间：${room}

请据此输出该房间的俯视平面布局 JSON。再次强调：只输出 JSON 本身，不要 markdown 代码块、不要任何解释。`;
}

// ───── 以下三个 JSON 容错辅助逻辑照搬自 canvas-storyboard.ts，按本文件「失败返回 null」风格略作调整 ─────

// 从模型原始输出里抓出候选 JSON 子串：剥掉 markdown 代码块包裹，定位第一个 { 开始。找不到返回 null。
function extractJsonCandidate(raw: string): string | null {
    const text = raw.trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : text;
    const start = body.indexOf("{");
    if (start < 0) return null;
    return body.slice(start);
}

// 对候选 JSON 做括号/方括号配对扫描，正确跳过字符串内的括号（处理进入/退出字符串态与 \" 转义）。
// 返回：最后一个使「整体配对回到平衡」的右括号下标（即一个完整 JSON 对象的结束位置）；找不到返回 -1。
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
            if (depth < 0) break;
        }
    }
    const balanced = started && depth === 0 && !inString;
    return { lastBalanced, balanced };
}

// 截断容错：候选 JSON 未闭合时，扫描到「最后一个完整的对象/数组元素」边界，裁掉残缺尾巴，再按括号栈补齐闭合符，凑成可解析对象。
function repairTruncatedJson(candidate: string): string | null {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let lastSafe = -1;
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
            if (stack.length) lastSafe = i;
        }
    }
    if (lastSafe < 0) return null;
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

// 把候选串按「先截到平衡点、再尝试截断修复」两级解析成对象；都失败返回 null。
function parseJsonLoose(candidate: string): unknown {
    const { lastBalanced } = findBalancedEnd(candidate);
    if (lastBalanced >= 0) {
        try {
            return JSON.parse(candidate.slice(0, lastBalanced + 1));
        } catch {
            // 落到截断修复
        }
    }
    const repaired = repairTruncatedJson(candidate);
    if (repaired) {
        try {
            return JSON.parse(repaired);
        } catch {
            return null;
        }
    }
    return null;
}

// 数值兜底：非有限数字回退到 fallback，再 clamp 到 [min, max]。
function clampNum(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, n));
}

const OPENING_KINDS = new Set(["door", "window"]);
const OPENING_WALLS = new Set(["top", "right", "bottom", "left"]);

// ③ 解析 + 校验 + 清洗。彻底失败返回 null。
export function parseRoomPlan(raw: string): RoomPlan | null {
    if (!raw || !raw.trim()) return null;
    const candidate = extractJsonCandidate(raw);
    if (!candidate) return null;
    const parsed = parseJsonLoose(candidate);
    if (!parsed || typeof parsed !== "object") return null;

    const obj = parsed as Record<string, unknown>;
    const rawItems = Array.isArray(obj.items) ? obj.items : [];
    const rawOpenings = Array.isArray(obj.openings) ? obj.openings : [];

    const items: RoomItem[] = [];
    rawItems.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") return;
        const it = entry as Record<string, unknown>;
        const label = typeof it.label === "string" ? it.label.trim() : "";
        if (!label) return; // 没有家具名的项视为非法，过滤掉
        const id = typeof it.id === "string" && it.id.trim() ? it.id.trim() : `item-${index + 1}`;
        const x = clampNum(it.x, 0, 1, 0);
        const y = clampNum(it.y, 0, 1, 0);
        const w = clampNum(it.w, 0.02, 1, 0.1);
        const h = clampNum(it.h, 0.02, 1, 0.1);
        items.push({ id, label, x, y, w, h });
    });

    const openings: RoomOpening[] = [];
    rawOpenings.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") return;
        const op = entry as Record<string, unknown>;
        const kind = typeof op.kind === "string" && OPENING_KINDS.has(op.kind) ? (op.kind as RoomOpening["kind"]) : null;
        const wall = typeof op.wall === "string" && OPENING_WALLS.has(op.wall) ? (op.wall as RoomOpening["wall"]) : null;
        if (!kind || !wall) return; // 类型/墙面非法 → 过滤
        const id = typeof op.id === "string" && op.id.trim() ? op.id.trim() : `open-${index + 1}`;
        const pos = clampNum(op.pos, 0, 1, 0);
        const len = clampNum(op.len, 0.02, 1, 0.1);
        openings.push({ id, kind, wall, pos, len });
    });

    // items / openings 全空视为解析失败（拿不到任何可用结构）
    if (items.length === 0 && openings.length === 0) return null;

    const note = typeof obj.note === "string" ? obj.note.trim() : undefined;
    return note ? { items, openings, note } : { items, openings };
}

// ④ 文本模型 system：据平面布局 + 相机位姿，用简体中文描述该机位画面。
export function buildViewSystemPrompt(): string {
    return `你是室内取景与镜头描述助手。给定一个房间的俯视平面布局（家具列表与归一化坐标）以及一台相机的位置和朝向，请用简体中文描述这台相机拍出来的画面。

要求：
- 分近景 / 中景 / 远景分别说明各有什么家具。
- 说明朝向（用东南西北，或「朝门 / 朝窗」这类直觉表达）。
- 说明视线尽头是什么——是哪面墙、还是窗户 / 门。
- 只输出一段简洁的中文描述，不要 JSON、不要分点编号、不要任何解释或前后缀。`;
}

// 把 angle（0=上/北，顺时针为正）转成方位直觉文本。
function angleToBearing(angle: number): string {
    const a = ((angle % 360) + 360) % 360;
    // 8 方位扇区，每 45°，0=正上（北）
    const dirs = ["朝平面图上方（北）", "朝右上方（东北）", "朝平面图右方（东）", "朝右下方（东南）", "朝平面图下方（南）", "朝左下方（西南）", "朝平面图左方（西）", "朝左上方（西北）"];
    const index = Math.round(a / 45) % 8;
    return dirs[index];
}

// 相机朝向单位向量（平面图坐标：x 向右、y 向下；angle 0=向上即 -y，顺时针为正）。
function cameraForward(angle: number): { fx: number; fy: number } {
    const rad = (angle * Math.PI) / 180;
    // 0° → (0,-1)；90°(顺时针，朝右) → (1,0)
    return { fx: Math.sin(rad), fy: -Math.cos(rad) };
}

// 简单判断哪些家具落在相机前方扇形（半视野角）内，按距离近→远排序。
function itemsInView(plan: RoomPlan, camera: RoomCamera): { item: RoomItem; dist: number; bearing: string }[] {
    const { fx, fy } = cameraForward(camera.angle);
    const halfFov = Math.min(170, Math.max(10, camera.fov)) / 2;
    const cosThreshold = Math.cos((halfFov * Math.PI) / 180);
    const hits: { item: RoomItem; dist: number; bearing: string }[] = [];
    for (const item of plan.items) {
        const cx = item.x + item.w / 2;
        const cy = item.y + item.h / 2;
        const dx = cx - camera.x;
        const dy = cy - camera.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1e-6) {
            // 相机几乎压在家具上，算作最近景
            hits.push({ item, dist, bearing: "脚下/极近处" });
            continue;
        }
        const dot = (dx * fx + dy * fy) / dist; // 与朝向的夹角余弦
        if (dot < cosThreshold) continue; // 在视野扇形外
        const bearing = dist < 0.25 ? "近景" : dist < 0.55 ? "中景" : "远景";
        hits.push({ item, dist, bearing });
    }
    hits.sort((a, b) => a.dist - b.dist);
    return hits;
}

// 估算视线尽头撞到哪面墙（沿朝向把相机射线推到 0..1 边界）。
function lineOfSightWall(plan: RoomPlan, camera: RoomCamera): string {
    const { fx, fy } = cameraForward(camera.angle);
    // 求射线到四条边界（x=0/1、y=0/1）的最小正向参数 t
    let bestT = Infinity;
    let wall: RoomOpening["wall"] = "top";
    const consider = (t: number, w: RoomOpening["wall"]) => {
        if (t > 1e-6 && t < bestT) {
            bestT = t;
            wall = w;
        }
    };
    if (fx > 1e-6) consider((1 - camera.x) / fx, "right");
    if (fx < -1e-6) consider((0 - camera.x) / fx, "left");
    if (fy > 1e-6) consider((1 - camera.y) / fy, "bottom");
    if (fy < -1e-6) consider((0 - camera.y) / fy, "top");
    if (!Number.isFinite(bestT)) return "正前方的墙";

    // 命中点坐标，看该墙上有没有门窗刚好覆盖到
    const hx = camera.x + fx * bestT;
    const hy = camera.y + fy * bestT;
    const along = wall === "top" || wall === "bottom" ? hx : hy;
    const opening = plan.openings.find((op) => op.wall === wall && along >= op.pos && along <= op.pos + op.len);
    const wallName: Record<RoomOpening["wall"], string> = { top: "上方（北）墙", right: "右侧（东）墙", bottom: "下方（南）墙", left: "左侧（西）墙" };
    if (opening) return `${wallName[wall]}上的${opening.kind === "window" ? "窗户" : "门"}`;
    return wallName[wall];
}

// ⑤ 把 plan + camera 整理成文本喂给 buildViewSystemPrompt。
export function buildViewUserPrompt(scene: RoomSceneState): string {
    const { plan, camera } = scene;
    const bearing = angleToBearing(camera.angle);
    const lines: string[] = [];
    lines.push(`相机位置（俯视图归一化坐标，原点左上、x 向右、y 向下）：x=${camera.x.toFixed(2)}, y=${camera.y.toFixed(2)}。`);
    lines.push(`相机朝向：angle=${Math.round(camera.angle)}°（0°=朝平面图上方/北，顺时针为正），即${bearing}；视野 fov=${Math.round(camera.fov)}°。`);

    if (plan && plan.items.length) {
        const itemLine = plan.items.map((it) => `${it.label}（中心 x=${(it.x + it.w / 2).toFixed(2)}, y=${(it.y + it.h / 2).toFixed(2)}）`).join("；");
        lines.push(`房间内家具（俯视坐标）：${itemLine}。`);
    } else {
        lines.push("房间内暂无明确家具列表。");
    }

    if (plan && plan.openings.length) {
        const openLine = plan.openings.map((op) => `${op.kind === "window" ? "窗" : "门"}在${({ top: "上墙", right: "右墙", bottom: "下墙", left: "左墙" } as const)[op.wall]}`).join("；");
        lines.push(`门窗：${openLine}。`);
    }

    if (plan) {
        const inView = itemsInView(plan, camera);
        if (inView.length) {
            const viewLine = inView.map((h) => `${h.item.label}（${h.bearing}）`).join("、");
            lines.push(`相机前方视野扇形内大致可见：${viewLine}。`);
        } else {
            lines.push("相机前方视野扇形内没有明显家具，主要是空间与墙面。");
        }
        lines.push(`视线尽头大致是：${lineOfSightWall(plan, camera)}。`);
    }

    lines.push("请据上述信息，用一段简洁中文描述这台相机拍出来的画面（近景/中景/远景的家具、朝向、视线尽头）。");
    return lines.join("\n");
}

// ⑥ 最终给图片模型的 prompt：原始场景描述 + 机位视角描述 + 写实指令。
export function buildRoomImagePrompt(scene: RoomSceneState, viewDescription: string): string {
    const desc = (scene.prompt || "").trim() || "一个室内房间";
    const view = (viewDescription || "").trim();
    return `房间整体设定：${desc}

当前机位视角描述：${view || "（按所给平面图的相机位置与朝向自行判断构图）"}

要求：这是从该房间某个机位拍摄的写实场景照片。严格按所给平面图标注的相机位置与朝向决定构图与可见家具——相机朝向决定画面正前方、视野范围决定取景宽窄。画面要真实感强、透视合理，与参考图（若有）的风格、配色、材质保持一致。`;
}

// ⑦ 兜底归一化：补默认值、清洗相机字段非法回退默认。
export function normalizeRoomScene(raw: Partial<RoomSceneState> | undefined): RoomSceneState {
    const src = raw ?? {};
    const rawCamera = src.camera;
    const camera: RoomCamera = rawCamera
        ? {
              x: clampNum(rawCamera.x, 0, 1, DEFAULT_ROOM_CAMERA.x),
              y: clampNum(rawCamera.y, 0, 1, DEFAULT_ROOM_CAMERA.y),
              // angle 取模 360（先兜底成有限数，再归一到 0..360）
              angle: ((((typeof rawCamera.angle === "number" && Number.isFinite(rawCamera.angle) ? rawCamera.angle : DEFAULT_ROOM_CAMERA.angle) % 360) + 360) % 360),
              fov: clampNum(rawCamera.fov, 30, 120, DEFAULT_ROOM_CAMERA.fov),
          }
        : { ...DEFAULT_ROOM_CAMERA };

    return {
        prompt: typeof src.prompt === "string" ? src.prompt : "",
        sceneImageUrl: typeof src.sceneImageUrl === "string" ? src.sceneImageUrl : undefined,
        sceneStorageKey: typeof src.sceneStorageKey === "string" ? src.sceneStorageKey : undefined,
        plan: src.plan && typeof src.plan === "object" ? src.plan : null,
        camera,
        ...(typeof src.imageModel === "string" ? { imageModel: src.imageModel } : {}),
        ...(typeof src.refImageUrl === "string" ? { refImageUrl: src.refImageUrl } : {}),
        ...(typeof src.refImageStorageKey === "string" ? { refImageStorageKey: src.refImageStorageKey } : {}),
    };
}
