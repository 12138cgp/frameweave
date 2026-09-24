import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { storageKey } from "@/constant/env";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { addCanvasRevTombstones, addSyncTombstones, markCanvasDeletion, readCanvasRevTombstones, readSyncTombstones } from "@/services/sync-tombstones";
import { logAction } from "@/services/action-log";
import { isCanvasContentful, mergeCanvasProjects } from "@/services/sync-merge";
import { tick } from "@/services/hlc";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasGroup, CanvasNodeData, ViewportTransform } from "../types";

export type CanvasProject = {
    id: string;
    title: string;
    // 软字段：所属的项目积分池 ID（空=不归属任何项目，用个人积分）。
    // 生成时透传 X-Project-ID，让扣费走该项目池。
    projectId?: string;
    // 子画布分组：同一「画布项目」下的多个子画布共享同一个 canvasGroupId；
    // 旧数据无此字段 → 读时用自身 id 兜底（每个旧画布=独立的单画布项目）。groupTitle=项目显示名（同组一致）。
    canvasGroupId?: string;
    groupTitle?: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    groups: CanvasGroup[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string, projectId?: string) => string;
    // 在既有画布项目(canvasGroupId)下新建一个子画布（同组、继承项目名与积分来源）。
    createSubCanvas: (groupId: string, options?: { title?: string; projectId?: string }) => string;
    // 重命名整个画布项目（同组所有子画布的 groupTitle 一并更新）。
    renameGroup: (groupId: string, groupTitle: string) => void;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "groups" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport" | "updatedAt" | "projectId">>, options?: { touch?: boolean }) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = storageKey("canvas_store");
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
// 水合完成前为 false：此期间 store.projects 仍是空初始态，绝不能落盘——否则页面加载竞态/闪退会把
// 「空」写进 IndexedDB 覆盖已存内容（丢数据的典型根因之一：本机加载未完成即写空）。
let hasHydrated = false;

// ── 节点/连线 rev 标记：与旧版逐一对比内容（忽略 rev/updatedAt），新增/变化则 tick 推进 rev，未变化保留旧 rev。
// 让同一节点的多设备编辑可按 rev 仲裁、删除可写带 rev 的墓碑。集中在此（updateProject 是节点写入唯一入口）。
function entityContentSig(item: Record<string, unknown>) {
    const rest: Record<string, unknown> = { ...item };
    delete rest.rev;
    delete rest.updatedAt;
    return JSON.stringify(rest);
}
function stampNodes(oldNodes: CanvasNodeData[], newNodes: CanvasNodeData[]) {
    const oldMap = new Map(oldNodes.map((n) => [n.id, n]));
    const now = new Date().toISOString();
    const stamped = newNodes.map((n) => {
        const o = oldMap.get(n.id);
        if (!o) return { ...n, rev: tick(n.rev), updatedAt: now };
        if (entityContentSig(n as unknown as Record<string, unknown>) !== entityContentSig(o as unknown as Record<string, unknown>)) return { ...n, rev: tick(o.rev), updatedAt: now };
        return { ...n, rev: o.rev ?? 0, updatedAt: o.updatedAt };
    });
    const newIds = new Set(newNodes.map((n) => n.id));
    const removed = oldNodes.filter((o) => o.id && !newIds.has(o.id)).map((o) => ({ id: o.id, rev: tick(o.rev) }));
    return { stamped, removed };
}
function stampConns(oldConns: CanvasConnection[], newConns: CanvasConnection[]) {
    const oldMap = new Map(oldConns.map((c) => [c.id, c]));
    const stamped = newConns.map((c) => {
        const o = oldMap.get(c.id);
        if (!o) return { ...c, rev: tick(c.rev) };
        if (entityContentSig(c as unknown as Record<string, unknown>) !== entityContentSig(o as unknown as Record<string, unknown>)) return { ...c, rev: tick(o.rev) };
        return { ...c, rev: o.rev ?? 0 };
    });
    const newIds = new Set(newConns.map((c) => c.id));
    const removed = oldConns.filter((o) => o.id && !newIds.has(o.id)).map((o) => ({ id: o.id, rev: tick(o.rev) }));
    return { stamped, removed };
}

// 落盘前的「空不覆盖非空」护栏：把待写画布与当前已存盘画布按云端同款逻辑合并
// （有内容方恒胜空方 + 墓碑放行删除 + 同状态按 updatedAt LWW），堵多标签陈旧态/本机空态冲掉已存内容。
// 仅在护栏「救回」了内存已丢/被清空的画布时才回灌内存（不反向覆盖用户正在编辑的较新版本）。
// 落盘失败静默（内存仍在，下次再存）。代价：每次落盘多一次读 IndexedDB + parse，已被 400ms 防抖摊薄。
async function persistCanvasWithGuard(name: string, value: StorageValue<CanvasStore>) {
    try {
        const outgoing = ((value.state as PersistedCanvasState).projects || []) as CanvasProject[];
        let merged = outgoing;
        const storedRaw = await localForageStorage.getItem(name);
        if (storedRaw) {
            const storedProjects = (JSON.parse(storedRaw) as StorageValue<CanvasStore>).state?.projects as CanvasProject[] | undefined;
            if (storedProjects && storedProjects.length) {
                // 落盘护栏也走节点级深合并，否则会把内存里的深合并结果又塌回「整项目 LWW」覆盖磁盘。
                // 本机场景两边都是本设备数据：anti-resurrection 传 () => true 关闭（绝不丢本机节点），删除靠墓碑。
                const projTomb = await readSyncTombstones("canvas");
                const nodeTomb = await readCanvasRevTombstones("node");
                const connTomb = await readCanvasRevTombstones("conn");
                merged = mergeCanvasProjects(outgoing as CanvasProject[], storedProjects, projTomb, nodeTomb, connTomb, () => true);
            }
        }
        const finalValue = { ...value, state: { ...value.state, projects: merged } } as StorageValue<CanvasStore>;
        queuedPersistState = finalValue.state as PersistedCanvasState;
        await localForageStorage.setItem(name, JSON.stringify(finalValue));
        const current = useCanvasStore.getState().projects;
        const currentById = new Map(current.map((p) => [p.id, p]));
        const rescued = merged.some((p) => {
            const cur = currentById.get(p.id);
            if (!cur) return true; // 护栏从磁盘救回了内存里没有的画布（多标签/本机丢失）
            return isCanvasContentful(p) && !isCanvasContentful(cur); // 救回了被内存清空的画布内容
        });
        if (rescued) useCanvasStore.setState({ projects: merged });
    } catch {
        // 落盘异常：保留内存数据，下次写入再尝试
    }
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        queuedPersistState = nextState;
        if (!hasHydrated) return; // 水合完成前不落盘，杜绝空初始态覆盖已存内容
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void persistCanvasWithGuard(name, value);
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

// 账号切换显式清空本机画布持久化：本机 IndexedDB 不分账号，换账号必须真清盘，
// 否则「空不覆盖非空」护栏会把上个账号的画布救回来（隐私/串号）。绕过护栏直接清。
export async function clearCanvasPersistence() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    queuedPersistState = { projects: [] };
    await localForageStorage.removeItem(CANVAS_STORE_KEY);
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布", projectId) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    projectId,
                    canvasGroupId: id, // 新建的顶层画布自成一个项目（它是该项目的子画布1）
                    groupTitle: title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    groups: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            createSubCanvas: (groupId, options) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const siblings = get().projects.filter((p) => (p.canvasGroupId || p.id) === groupId);
                const rep = siblings[0];
                const project: CanvasProject = {
                    id,
                    title: options?.title?.trim() || `子画布${siblings.length + 1}`,
                    projectId: options?.projectId ?? rep?.projectId,
                    canvasGroupId: groupId,
                    groupTitle: rep ? rep.groupTitle || rep.title : options?.title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    groups: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            renameGroup: (groupId, groupTitle) =>
                set((state) => {
                    const next = groupTitle.trim();
                    if (!next) return {};
                    // 单画布项目：标题与项目名同源（顶栏标题读的是 title），一并更新避免卡片名与顶栏名不一致；
                    // 多子画布项目只改 groupTitle（各子画布 title 是「子画布N」不动）。
                    const single = state.projects.filter((p) => (p.canvasGroupId || p.id) === groupId).length === 1;
                    return {
                        projects: state.projects.map((p) => {
                            if ((p.canvasGroupId || p.id) !== groupId) return p;
                            const patched = { ...p, groupTitle: next, updatedAt: new Date().toISOString() };
                            if (single) patched.title = next;
                            return patched;
                        }),
                    };
                }),
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    projectId: source.projectId,
                    // 保留分组：同一导出项目的多个子画布共享 canvasGroupId，导入后仍聚合成一个项目卡（旧导出无此字段→读时按自身 id 兜底成单画布项目）。
                    canvasGroupId: source.canvasGroupId,
                    groupTitle: source.groupTitle,
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    groups: source.groups || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) => {
                // 删画布是最不可逆的操作，删之前先把「删的是哪几个、各有多少节点」记下来。
                // 用户来问「我那个画布呢」时，这一条能直接回答是他自己删的还是系统弄丢的。
                const doomed = get().projects.filter((project) => ids.includes(project.id));
                logAction("canvas_projects_deleted", {
                    count: doomed.length,
                    titles: doomed.map((project) => project.title || "").join(" | ").slice(0, 200),
                    nodes: doomed.reduce((sum, project) => sum + (project.nodes?.length || 0), 0),
                    projectsBefore: get().projects.length,
                });
                // 写删除墓碑，云同步合并时阻止远端旧版本把删掉的画布拉回来
                void addSyncTombstones("canvas", ids);
                markCanvasDeletion(); // 真实删除：放行 P0 收缩护栏
                set((state) => {
                    const projects = state.projects.filter((project) => !ids.includes(project.id));
                    return { projects };
                });
            },
            replaceProjects: (projects) => {
                // 整体替换画布集合：切账号清空、云端合并回灌都走这里，是「画布数量突变」的唯一入口。
                // 变少时尤其要记——那正是用户会说「我画布不见了」的时刻。
                const before = get().projects;
                if (before.length !== projects.length) {
                    logAction("canvas_projects_replaced", {
                        before: before.length,
                        after: projects.length,
                        nodesBefore: before.reduce((sum, project) => sum + (project.nodes?.length || 0), 0),
                        nodesAfter: projects.reduce((sum, project) => sum + (project.nodes?.length || 0), 0),
                    });
                }
                set({ projects });
            },
            // touch:false 用于「不该让项目变新」的写入（视口平移、打开页面的初始回写）——
            // updatedAt 是多设备 LWW 仲裁依据，乱 bump 会让陈旧数据反向覆盖其它设备的真实编辑。
            // 节点/连线写入唯一入口：在此 diff 旧新、标 rev、对删除写带 rev 的节点/连线墓碑（用 get() 读当前态，副作用在 set 外，set 保持纯）。
            updateProject: (id, patch, options) => {
                const project = get().projects.find((p) => p.id === id);
                let nextNodes = patch.nodes;
                let nextConns = patch.connections;
                if (project && patch.nodes) {
                    const { stamped, removed } = stampNodes(project.nodes || [], patch.nodes);
                    nextNodes = stamped;
                    if (removed.length) {
                        // 节点被删（含被合并逻辑判掉的）。「节点凭空少了」的问题全靠这条对账：
                        // 有这条 = 是删除路径走的；没有这条而节点确实少了 = 合并或持久化出了问题。
                        logAction("canvas_nodes_removed", { projectId: id, count: removed.length, nodesBefore: project.nodes?.length || 0 });
                        void addCanvasRevTombstones("node", removed);
                        markCanvasDeletion();
                    }
                }
                if (project && patch.connections) {
                    const { stamped, removed } = stampConns(project.connections || [], patch.connections);
                    nextConns = stamped;
                    if (removed.length) {
                        void addCanvasRevTombstones("conn", removed);
                        markCanvasDeletion();
                    }
                }
                set((state) => ({
                    projects: state.projects.map((p) =>
                        p.id === id
                            ? {
                                  ...p,
                                  ...patch,
                                  ...(nextNodes ? { nodes: nextNodes } : {}),
                                  ...(nextConns ? { connections: nextConns } : {}),
                                  ...(options?.touch === false ? {} : { updatedAt: new Date().toISOString() }),
                              }
                            : p,
                    ),
                }));
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                hasHydrated = true; // 水合完成，此后才允许落盘
                // ⚠️ hydrated 必须【第一时间】置上，且绝不能被后面任何代码挡住。
                // 整个画布页都在等这个标志：它一旦没置上，用户就永久停在加载骨架屏上，
                // 且没有任何报错提示。触发条件很隐蔽：下面那条埋点里 restored.length 有可能抛异常，
                // 一抛就再也走不到这一行，用户就永久停在骨架屏上。
                // 埋点是辅助，交付是主线；主线永远不能被辅助挡住。
                useCanvasStore.setState({ hydrated: true });
                // 水合结果决定了「用户打开时看到什么」。水合出 0 个画布，用户就会说「我的东西全没了」，
                // 但那可能只是本地读失败——这条日志是区分「真丢了」和「没读出来」的唯一依据。
                try {
                    const restored = useCanvasStore.getState().projects || [];
                    logAction("canvas_hydrated", {
                        projects: restored.length,
                        nodes: restored.reduce((sum, project) => sum + (project?.nodes?.length || 0), 0),
                    });
                } catch {
                    /* 埋点失败绝不影响水合 */
                }
            },
        },
    ),
);

// 子画布分组辅助：groupId 用 canvasGroupId 兜底自身 id（旧数据=各自独立的单画布项目）；groupTitle 兜底 title。
export function canvasGroupIdOf(p: Pick<CanvasProject, "id" | "canvasGroupId">) {
    return p.canvasGroupId || p.id;
}
export function canvasGroupTitleOf(p: Pick<CanvasProject, "title" | "groupTitle">) {
    return (p.groupTitle || p.title || "未命名项目").trim() || "未命名项目";
}

// 「画布项目」= 一组共享 canvasGroupId 的子画布。列表页据此把扁平画布聚合成项目卡。
export type ProjectGroup = {
    groupId: string;
    groupTitle: string;
    projectId?: string;
    canvases: CanvasProject[]; // 组内子画布，按更新时间新→旧
    representative: CanvasProject; // 最近更新的子画布（卡片点开/展示用）
    updatedAt: string;
    totalNodes: number;
};

export function groupCanvasProjects(projects: CanvasProject[]): ProjectGroup[] {
    const map = new Map<string, CanvasProject[]>();
    for (const p of projects) {
        const gid = canvasGroupIdOf(p);
        const arr = map.get(gid);
        if (arr) arr.push(p);
        else map.set(gid, [p]);
    }
    const groups: ProjectGroup[] = [];
    for (const [groupId, list] of map) {
        const canvases = [...list].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        const representative = canvases[0];
        groups.push({
            groupId,
            groupTitle: canvasGroupTitleOf(representative),
            projectId: representative.projectId,
            canvases,
            representative,
            updatedAt: representative.updatedAt,
            totalNodes: canvases.reduce((sum, c) => sum + (c.nodes?.length || 0), 0),
        });
    }
    groups.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return groups;
}
