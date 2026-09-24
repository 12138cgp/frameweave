"use client";

import { RequireAuth } from "@/components/require-auth";
import { LOCAL_DB_NAME, storageKey } from "@/constant/env";

import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Drawer, Image, Input, Modal, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { requestEdit, requestGeneration, resumeImageGenerationJob } from "@/services/api/image";
import { deleteStoredImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { addSyncTombstones } from "@/services/sync-tombstones";
import { CLOUD_SYNCED_EVENT, scheduleCloudSync } from "@/services/cloud-sync";
import { loadDraft, saveDraft } from "@/services/workbench-draft";
import { useAssetStore } from "@/stores/use-asset-store";
import type { ReferenceImage } from "@/types/image";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "成功" | "失败" | "进行中" | "已中断";
    // 状态更新时间戳：云同步按它仲裁，断点续传完成的状态不被旧快照滚回
    updatedAt?: number;
    images: GeneratedImage[];
    thumbnails: string[];
    // 服务端生成任务 ID（按槽位对应）：刷新/切页后凭 ID 自动找回结果（保留 48 小时）
    jobIds?: string[];
};

// 一次生成 = 一个会话，与左侧记录卡片一一对应（logId）；多个会话可并发运行，
// 点击卡片切换右侧查看的会话。会话只存在于内存，刷新后由持久化记录兜底展示。
type GenerationSession = {
    logId: string;
    results: GenerationResult[];
    running: boolean;
    startedAt: number;
    elapsedMs: number;
};

const MAX_CONCURRENT_SESSIONS = 3;

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = storageKey("image_generation_logs");
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStore = localforage.createInstance({ name: LOCAL_DB_NAME, storeName: "image_generation_logs" });

export default function ImagePage() {
    return (
        <RequireAuth>
            <ImagePageInner />
        </RequireAuth>
    );
}

function ImagePageInner() {
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [sessions, setSessions] = useState<Record<string, GenerationSession>>({});
    const [activeLogId, setActiveLogId] = useState<string | null>(null);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));
    const runningCount = Object.values(sessions).filter((session) => session.running).length;
    // 右侧展示当前选中的会话：运行中的会话优先（实时进度），否则回退到持久化记录的图片
    const activeSession = activeLogId ? sessions[activeLogId] : null;
    const activeLog = activeLogId ? logs.find((log) => log.id === activeLogId) || null : null;
    const displayResults: GenerationResult[] = activeSession ? activeSession.results : (activeLog?.images || []).map((image) => ({ id: image.id, status: "success" as const, image }));
    const showInterrupted = !activeSession && activeLog?.status === "已中断";

    useEffect(() => {
        if (!runningCount) return;
        const timer = window.setInterval(() => {
            setSessions((prev) => {
                const next: Record<string, GenerationSession> = {};
                for (const [key, session] of Object.entries(prev)) next[key] = session.running ? { ...session, elapsedMs: performance.now() - session.startedAt } : session;
                return next;
            });
        }, 1000);
        return () => window.clearInterval(timer);
    }, [runningCount]);

    useEffect(() => {
        void reconcileStaleLogs();
    }, []);

    // 输入草稿持久化：恢复刷新前的提示词与参考图（参考图按 storageKey 重新解析地址，避免图裂）。
    const draftHydratedRef = useRef(false);
    useEffect(() => {
        void (async () => {
            const draft = await loadDraft<{ prompt?: string; references?: ReferenceImage[] }>("image");
            if (draft) {
                if (typeof draft.prompt === "string") setPrompt(draft.prompt);
                if (Array.isArray(draft.references)) {
                    const restored = await Promise.all(draft.references.map(async (ref) => ({ ...ref, dataUrl: await resolveImageUrl(ref.storageKey, ref.dataUrl) })));
                    setReferences(restored);
                }
            }
            draftHydratedRef.current = true;
        })();
    }, []);
    useEffect(() => {
        if (!draftHydratedRef.current) return;
        saveDraft("image", { prompt, references });
    }, [prompt, references]);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error("剪切板里没有可读取的图片");
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(`已读取 ${nextReferences.length} 张参考图`);
        } catch {
            message.error("剪切板里没有可读取的图片");
        }
    };

    const generate = async () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return;
        }

        if (runningCount >= MAX_CONCURRENT_SESSIONS) {
            message.warning(`最多同时进行 ${MAX_CONCURRENT_SESSIONS} 个生成任务，请等待其中一个完成`);
            return;
        }
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;

        // 每次生成是一个独立会话（可并发）：左侧立即出现「进行中」卡片，右侧切到该会话的实时进度
        const logId = nanoid();
        const logCreatedAt = Date.now();
        const logConfig = { ...snapshot.config, count: String(generationCount) };
        const batchStartedAt = performance.now();
        setSessions((prev) => ({
            ...prev,
            [logId]: { logId, running: true, startedAt: batchStartedAt, elapsedMs: 0, results: Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })) },
        }));
        setActiveLogId(logId);
        saveLog(buildLog({ id: logId, createdAt: logCreatedAt, prompt: text, model, config: logConfig, references: snapshot.references, durationMs: 0, successCount: 0, failCount: 0, status: "进行中", images: [] }));

        const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(logId, index, snapshot));

        const result = await Promise.allSettled(tasks);
        await completeLog({ logId, createdAt: logCreatedAt, prompt: text, model, config: logConfig, references: snapshot.references, batchStartedAt, outcomes: result, total: generationCount });
    };

    // 会话收尾：成功图片落库、写最终记录、关会话（generate 与断点恢复共用）
    const completeLog = async (params: { logId: string; createdAt: number; prompt: string; model: string; config: GenerationLogConfig; references: ReferenceImage[]; batchStartedAt: number; outcomes: PromiseSettledResult<GeneratedImage>[]; total: number }) => {
        const successImages = params.outcomes.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const failCount = params.total - successCount;
        const failed = params.outcomes.find((item): item is PromiseRejectedResult => item.status === "rejected");

        try {
            const logImages = await Promise.all(
                successImages.map(async (image) => {
                    try {
                        const stored = await uploadImage(image.dataUrl);
                        return { ...image, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
                    } catch (error) {
                        // 入库失败（如跨域图源）不拖垮整条记录：保留原始数据，状态仍要正常落库
                        console.warn("生成图片入库失败，保留原始链接", error);
                        return image;
                    }
                }),
            );
            saveLog(
                buildLog({
                    id: params.logId,
                    createdAt: params.createdAt,
                    prompt: params.prompt,
                    model: params.model,
                    config: params.config,
                    references: params.references,
                    durationMs: performance.now() - params.batchStartedAt,
                    successCount,
                    failCount,
                    status: successCount ? "成功" : "失败",
                    images: logImages,
                }),
            );
            successCount ? message.success("图片已生成") : message.error(failed?.reason instanceof Error ? failed.reason.message : "生成失败");
        } finally {
            setSessions((prev) => (prev[params.logId] ? { ...prev, [params.logId]: { ...prev[params.logId], running: false, elapsedMs: performance.now() - params.batchStartedAt } } : prev));
        }
    };

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        message.success("已加入参考图");
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        addAsset({
            kind: "image",
            title: `生成结果 ${index + 1}`,
            coverUrl: stored.url,
            tags: [],
            source: "图片生成",
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt },
        });
        message.success("已加入我的素材");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            message.warning("图片生成只能使用文本或图片素材");
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setSelectedLogIds([]);
        setActiveLogId(null);
    };

    const deleteSelectedLogs = () => {
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), addSyncTombstones("image-workbench", selectedLogIds), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(refreshLogs);
        if (activeLogId && selectedLogIds.includes(activeLogId)) setActiveLogId(null);
        setSessions((prev) => {
            const next = { ...prev };
            selectedLogIds.forEach((id) => delete next[id]);
            return next;
        });
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void logStore
            .setItem(log.id, serializeLog({ ...log, updatedAt: Date.now() }))
            .then(refreshLogs)
            .catch((error) => console.warn("生成记录保存失败", error));
        scheduleCloudSync(5000);
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    // 云同步完成后重读记录：跨设备的新记录/状态变化及时反映（落库仲裁已保证本地新状态不被滚回）
    useEffect(() => {
        const onSynced = () => void readStoredLogs().then(setLogs);
        window.addEventListener(CLOUD_SYNCED_EVENT, onSynced);
        return () => window.removeEventListener(CLOUD_SYNCED_EVENT, onSynced);
    }, []);

    // 页面加载：进行中的记录若带服务端任务 ID（remote 渠道），自动续查找回结果；
    // 没有任务 ID 的（local 渠道浏览器直连，无法跨刷新续传）标「已中断」。
    const reconcileStaleLogs = async () => {
        const stored = await readStoredLogs();
        const stale = stored.filter((log) => log.status === "进行中");
        const resumable = stale.filter((log) => (log.jobIds || []).some(Boolean));
        const broken = stale.filter((log) => !(log.jobIds || []).some(Boolean));
        if (broken.length) {
            await Promise.all(broken.map((log) => logStore.setItem(log.id, serializeLog({ ...log, status: "已中断", updatedAt: Date.now() }))));
        }
        await refreshLogs();
        if (resumable.length) {
            message.info("检测到刷新前进行中的生图任务，正在自动找回结果…");
            resumable.forEach((log) => void resumeInterruptedLog(log));
        }
    };

    // 断点恢复：按记录里的任务 ID 逐槽位领取结果，完整重建会话进度
    const resumeInterruptedLog = async (log: GenerationLog) => {
        const jobIds = (log.jobIds || []).filter((id): id is string => Boolean(id));
        if (!jobIds.length) return;
        const batchStartedAt = performance.now();
        setSessions((prev) => ({
            ...prev,
            [log.id]: { logId: log.id, running: true, startedAt: batchStartedAt, elapsedMs: 0, results: jobIds.map(() => ({ id: nanoid(), status: "pending" })) },
        }));
        setActiveLogId((current) => current || log.id);
        const outcomes = await Promise.allSettled(
            jobIds.map(async (jobId, index) => {
                const itemStartedAt = performance.now();
                try {
                    const image = (await resumeImageGenerationJob(jobId))[0];
                    if (!image) throw new Error("接口没有返回图片");
                    const meta = await readImageMeta(image.dataUrl);
                    const nextImage = { id: image.id, dataUrl: image.dataUrl, durationMs: performance.now() - itemStartedAt, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(image.dataUrl) };
                    updateSessionResult(log.id, index, { status: "success", image: nextImage });
                    return nextImage;
                } catch (error) {
                    updateSessionResult(log.id, index, { status: "failed", error: error instanceof Error ? error.message : "生成失败" });
                    throw error;
                }
            }),
        );
        await completeLog({ logId: log.id, createdAt: log.createdAt, prompt: log.prompt, model: log.model, config: log.config, references: log.references, batchStartedAt, outcomes, total: jobIds.length });
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        setActiveLogId(log.id);
        setLogsOpen(false);
        // 运行中的会话：只切换右侧视图（显示实时进度），不打扰当前输入
        if (sessions[log.id]?.running) return;
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
    };

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    const updateSessionResult = (logId: string, index: number, next: Partial<GenerationResult>) => {
        setSessions((prev) => {
            const session = prev[logId];
            if (!session) return prev;
            return { ...prev, [logId]: { ...session, results: updateResultAt(session.results, index, next) } };
        });
    };

    // 任务 ID 落到记录的对应槽位：刷新/切页后凭它自动找回结果（直接补到已序列化的存储记录上）
    const attachJobId = (logId: string, index: number, jobId: string) => {
        void (async () => {
            const stored = await logStore.getItem<GenerationLog>(logId);
            if (!stored) return;
            const jobIds = [...(stored.jobIds || [])];
            jobIds[index] = jobId;
            await logStore.setItem(logId, { ...stored, jobIds });
        })();
    };

    const runGenerationSlot = async (logId: string, index: number, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }) => {
        const itemStartedAt = performance.now();
        try {
            const onJobCreated = (jobId: string) => attachJobId(logId, index, jobId);
            const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references, undefined, onJobCreated) : await requestGeneration(snapshot.config, snapshot.text, onJobCreated);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const nextImage = { id: image.id, dataUrl: image.dataUrl, durationMs: performance.now() - itemStartedAt, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(image.dataUrl) };
            updateSessionResult(logId, index, { status: "success", image: nextImage });
            return nextImage;
        } catch (error) {
            updateSessionResult(logId, index, { status: "failed", error: error instanceof Error ? error.message : "生成失败" });
            throw error;
        }
    };

    const retryResult = (index: number) => {
        const logId = activeLogId;
        if (!logId || !sessions[logId]) return;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        updateSessionResult(logId, index, { status: "pending", error: undefined, image: undefined });
        void runGenerationSlot(logId, index, snapshot).catch(() => {});
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="paper-card anim-rise thin-scrollbar hidden min-h-0 overflow-y-auto p-4 lg:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={activeLogId || undefined}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="paper-card anim-rise thin-scrollbar flex flex-col p-4 lg:min-h-0 lg:overflow-y-auto" style={{ "--rise-delay": "60ms" } as React.CSSProperties}>
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="font-heading text-2xl font-medium tracking-wide text-stone-950 dark:text-stone-100">图片生成</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                        记录
                                    </Button>
                                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        参数
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">提示词</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            查看提示词模板
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            查看我的素材
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder="描述画面主体、风格、构图、光线和用途" />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考图</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            剪切板
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            上传
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className="hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-xl border border-dashed border-stone-300 p-2 pb-3 overscroll-x-contain dark:border-stone-700"
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-[#0F172A]/75 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-[#0F172A]/75 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label="移除参考图"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">暂无参考图</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {model} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    调整
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            <Button type="primary" size="large" block className="hover-lift" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={() => void generate()}>
                                {runningCount ? `开始生成（${runningCount} 个任务进行中）` : "开始生成"}
                            </Button>
                        </div>
                    </div>

                    <div className="paper-card anim-rise thin-scrollbar p-4 lg:min-h-0 lg:overflow-y-auto lg:p-5" style={{ "--rise-delay": "120ms" } as React.CSSProperties}>
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2">
                                <h2 className="text-xl font-semibold">生成结果</h2>
                                {activeLog ? <Tag className="m-0 max-w-56 truncate px-2 py-1">{activeLog.title}</Tag> : null}
                            </div>
                            {activeSession?.running ? <Tag className="m-0 px-2 py-1">等待 {formatDuration(activeSession.elapsedMs)}</Tag> : null}
                        </div>
                        {showInterrupted ? (
                            <div className="anim-fade flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-amber-300 bg-amber-50/40 p-6 text-center dark:border-amber-900 dark:bg-amber-950/20 lg:min-h-[560px]">
                                <div className="text-base font-medium text-amber-700 dark:text-amber-300">这次生成被页面刷新中断了</div>
                                <div className="text-sm text-stone-500 dark:text-stone-400">提示词和参数已恢复到左侧输入区，点「开始生成」即可重新生成。</div>
                            </div>
                        ) : displayResults.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {displayResults.map((result, index) => (
                                    <div key={result.id} className="anim-rise" style={{ "--rise-delay": `${Math.min(index, 12) * 40}ms` } as React.CSSProperties}>
                                        {result.status === "success" && result.image ? (
                                            <ResultImageCard image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                        ) : result.status === "failed" ? (
                                            <FailedImageCard error={result.error || "生成失败"} onRetry={() => retryResult(index)} />
                                        ) : (
                                            <PendingImageCard />
                                        )}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="anim-fade flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 px-6 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <div className="font-heading text-lg font-medium tracking-wide text-stone-500 dark:text-stone-400">纸上还空着，落笔成画</div>
                                <div className="mt-1.5 text-sm text-stone-400 dark:text-stone-500">写下提示词，生成你的第一张图</div>
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title="生成记录" placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={activeLogId || undefined}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title="参数" placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">模型</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    return (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
            <Image src={image.dataUrl} alt={`生成结果 ${index + 1}`} className="aspect-square object-cover" />
            <div className="space-y-2 border-t border-border px-3 py-2.5">
                <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-2">
                    <Tooltip title="添加到素材">
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            添加到素材
                        </Button>
                    </Tooltip>
                    <Tooltip title="加入参考图">
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            加入参考图
                        </Button>
                    </Tooltip>
                    <Tooltip title="下载">
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            下载
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard() {
    return (
        <div className="relative aspect-square overflow-hidden rounded-xl border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(100,116,139,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="anim-shimmer absolute inset-0" />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>生成中</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <div className="overflow-hidden rounded-xl border border-destructive/30 bg-destructive/10">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-destructive">生成失败</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-destructive">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-destructive/30 p-3">
                <Button size="small" danger onClick={onRetry}>
                    重试
                </Button>
            </div>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">生成记录</h2>
                </div>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    新建
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? "取消" : "全选"}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    删除
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">暂无生成记录</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const thumbnails = (log.thumbnails || []).filter(Boolean).slice(0, 4);

    return (
        <button
            type="button"
            className={`block w-full rounded-xl border border-l-2 p-2 text-left transition-colors duration-[180ms] ${active ? "border-[#2563EB]/45 border-l-[#2563EB] bg-[#2563EB]/[0.07] dark:border-[#3B82F6]/45 dark:border-l-[#3B82F6] dark:bg-[#3B82F6]/[0.10]" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image, index) => (
                                    <img key={`${log.id}-${index}`} src={image} alt="" className="size-8 shrink-0 rounded-lg object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        {log.status === "进行中" ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="processing">
                                进行中
                            </Tag>
                        ) : log.status === "已中断" ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="orange">
                                已中断
                            </Tag>
                        ) : (
                            <>
                                <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                                    成功 {log.successCount ?? log.imageCount}
                                </Tag>
                                {log.failCount ? (
                                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                        失败 {log.failCount}
                                    </Tag>
                                ) : null}
                            </>
                        )}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.imageCount} 张</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                            {formatDuration(log.durationMs)}
                        </Tag>
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.time}</Tag>
                    </div>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "成功",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
        jobIds: log.jobIds,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
        thumbnails: [],
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function buildLog({
    id,
    createdAt,
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    id?: string;
    createdAt?: number;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: id || nanoid(),
        createdAt: createdAt || Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}
