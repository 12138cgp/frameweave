"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Modal, Spin } from "antd";
import { Film } from "@/components/icons";

import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasStageGuideModal, isStageGuideDismissed } from "./canvas-stage-guide-modal";
import {
    DIRECTOR_EXPORT_TIMEOUT_MS,
    DIRECTOR_MESSAGE,
    DIRECTOR_QUERY_TIMEOUT_MS,
    buildDirectorSrc,
    directorErrorText,
    readDirectorCaptures,
    type DirectorCapture,
    type DirectorRequestAction,
    type DirectorTimeline,
    type DirectorVideoResult,
} from "../utils/canvas-stage";

// 3D 场景台弹窗：整屏 iframe + postMessage 桥。
//
// 安全边界（这是从 iframe 收数据，必须当不可信输入处理）：
//  1. 只接受 event.origin === window.location.origin —— 场景台与本站同源部署，
//     任何别的来源发来的同名消息一律丢弃。
//  2. 只接受 event.source 是本 iframe 的 contentWindow，挡掉页面上其它 frame 冒充。
//  3. 截图内容在 readDirectorCaptures 里逐项校验，只放行 data:image/ 开头的。
//
// 上游协议见 docs/embed-contract.md（protocolVersion 1）。

type CanvasStageDialogProps = {
    open: boolean;
    instanceId: string;
    nodeTitle: string;
    onClose: () => void;
    onCaptures: (captures: DirectorCapture[]) => void;
    // 把录好的运镜视频落成画布节点。返回 Promise，弹窗据此显示「保存中」。
    onVideo: (result: DirectorVideoResult) => Promise<void>;
};

type PendingRequest = {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: number;
};

// 用户自己关掉弹窗导致的中断。用一个内部标记而不是普通错误，
// 这样调用方能区分「真失败」和「你自己关的」，后者不该再弹一条报错。
const REQUEST_CANCELLED = "__director_request_cancelled__";

const EMBED_STYLE_ID = "huijing-embed-fix";

// 嵌入修正样式：隐藏场景台自己顶栏的「关闭」按钮。
//
// 为什么要动它——两个理由，第二个才是真正的 bug：
//  1. 功能重复：点它只是发一条 close 消息让宿主关窗，而本弹窗右上角已经有关闭了。
//  2. **它会压住「导出运镜」按钮**。它绝对定位在视口右上角，而运镜工作台面板也浮在那儿。
//     在 1680 宽视口实测：顶栏关闭占 x 1620~1656，导出运镜占 1574~1633，重叠 13px；
//     对导出按钮做 6 点命中测试，隐藏前 2 个点落在关闭按钮上（用户看到的就是「导出被叉挡住」），
//     隐藏后 0 个点被挡。它同时还压住了面板自己的「关闭运镜工作台」按钮。
//
// ⚠️ 这是对上游 DOM 的脆弱耦合。选择器靠 aria-label 精确匹配「关闭」，实测全应用唯一命中
// 顶栏那一个（面板自己的是「关闭运镜工作台」，不会误伤）。上游改文案这条就会失效，
// 失效后果仅仅是恢复成现在这个重叠的样子、不影响任何功能，所以整段静默处理。
// **升级场景台版本后请重新验证这个选择器。**
const EMBED_FIX_CSS = [
    // ① 顶栏的关闭按钮。它和本弹窗右上角的关闭重复，而且绝对定位在视口右上角，
    //    会压住运镜工作台右上角那一排按钮（实测 1680 宽视口下与「关闭运镜工作台」重叠 18px）。
    'button[aria-label="关闭"]{display:none !important;}',
    // ④ 场景台自带的「导出 MP4」。它走 a[download] 把文件直接下到硬盘，视频**不会回到画布**，
    //    而且全程不发任何 postMessage，宿主连「用户导出过」都不知道。留着它就是两颗长得一样、
    //    结果完全不同的导出按钮，必然误点。统一收敛到本弹窗底部那颗「导出运镜到画布」。
    //    ⚠️ 面板必须跟着一起隐：展开状态是场景台组件的本地 state，用户只要展开过一次，
    //       面板就一直挂在 DOM 上，只隐开关等于没隐。
    //    ⚠️ 绝不能隐它们的父容器 .motion-studio-header-actions——「关闭运镜工作台」也在里面，
    //       一起隐掉用户就关不掉那个面板了。
    ".motion-studio-export,.motion-export-panel{display:none !important;}",
    // ② 堵死所有「离开当前节点工程」的入口。
    //
    // 每个画布节点对应一个独立的场景台工程（instanceId = 节点 id）。场景台原本是独立应用，
    // 顶栏留着一整套实例管理入口，在嵌入场景下全是有害的：
    //   .top-bar-home-nav-button   「首页」——进去能删实例，但删了不会影响画布上的节点，
    //                               于是留下一个点开是空工程的节点。
    //   .director-desk-select      「选择场景台」下拉——**最危险的一个**。它能在节点 A 的弹窗里
    //                               切到节点 B 的工程，之后截图会错回传给 A。
    //   .director-desk-create-button 「新建」——建出的实例不对应任何节点，用户再也找不到它。
    //   .performance-benchmark-tools 性能面板里的「标准性能测试」——它会**新开一个标签页**
    //                               打开不带 instanceId 的独立场景台，等于绕开整个节点绑定。
    '.top-bar-home-nav-button,.director-desk-select,.director-desk-create-button,.performance-benchmark-tools{display:none !important;}',
    // ③「3D场景台」这个标题本身也是回首页的按钮（class 里就带 home-button）。
    //    保留它做品牌标识、只掐掉点击，比整个隐藏更好——直接隐藏会让顶栏左侧空一块。
    ".top-bar-home-button{pointer-events:none !important;cursor:default !important;}",
].join("");

export function CanvasStageDialog({ open, instanceId, nodeTitle, onClose, onCaptures, onVideo }: CanvasStageDialogProps) {
    const { message } = App.useApp();
    const theme = useThemeStore((state) => state.theme);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [ready, setReady] = useState(false);
    // 使用说明：每次打开场景台时弹一次，除非用户勾过「以后不再显示」。
    // 在 effect 里读而不是用 useState 初始值，避免服务端渲染时碰 localStorage 造成首屏不一致。
    const [guideOpen, setGuideOpen] = useState(false);
    // 导出运镜视频的状态文案。非空即表示正在忙，按钮转圈并禁用。
    const [exportStatus, setExportStatus] = useState("");
    // 未完成的协议请求，按 requestId 配对。上游明确说过响应顺序不保证与请求顺序一致。
    const pendingRef = useRef(new Map<string, PendingRequest>());
    // 回调用 ref 兜住：监听器只挂一次，不能因为父组件重渲染就漏掉最新的处理函数。
    const onCapturesRef = useRef(onCaptures);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCapturesRef.current = onCaptures;
    }, [onCaptures]);
    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!open) {
            setReady(false);
            setGuideOpen(false);
            return;
        }
        setGuideOpen(!isStageGuideDismissed());
    }, [open]);

    // 弹窗关掉时把未完成的协议请求清干净。
    //
    // 录制一段 30 秒的运镜要等 30 秒，用户完全可能中途就把弹窗关了。不清理的话，
    // 那个 timer 会在几十秒后触发、对着一个已经关掉的弹窗弹「场景台没有响应」。
    useEffect(() => {
        if (open) return;
        const pending = pendingRef.current;
        pending.forEach((item) => {
            window.clearTimeout(item.timer);
            item.reject(new Error(REQUEST_CANCELLED));
        });
        pending.clear();
        setExportStatus("");
    }, [open]);

    // 幂等注入。CSS 是声明式的，注进 head 之后，场景台后续渲染出来的按钮同样会被匹配，
    // 所以不必等它整棵树渲染完；onLoad 和 ready 各调一次纯粹是双保险。
    const injectEmbedStyle = useCallback(() => {
        const frame = iframeRef.current;
        if (!frame) return;
        try {
            const doc = frame.contentDocument;
            if (!doc || !doc.head) return;
            if (doc.getElementById(EMBED_STYLE_ID)) return;
            const style = doc.createElement("style");
            style.id = EMBED_STYLE_ID;
            style.textContent = EMBED_FIX_CSS;
            doc.head.appendChild(style);
        } catch {
            // 同源理论上取得到 contentDocument；万一取不到就算了。
            // 这只是观感修正，绝不能让它把「打开场景台」这件事本身搞挂。
        }
    }, []);

    // 发一条协议请求并等响应。requestId 配对 + 超时清理，避免 pending 表越积越大。
    const requestDirector = useCallback((action: DirectorRequestAction, options?: Record<string, unknown>, timeoutMs = DIRECTOR_QUERY_TIMEOUT_MS) => {
        return new Promise<unknown>((resolve, reject) => {
            const target = iframeRef.current?.contentWindow;
            if (!target) {
                reject(new Error("场景台还没准备好"));
                return;
            }
            const requestId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            const timer = window.setTimeout(() => {
                pendingRef.current.delete(requestId);
                reject(new Error("场景台没有响应，请重试"));
            }, timeoutMs);
            pendingRef.current.set(requestId, { resolve, reject, timer });
            // 同源部署，targetOrigin 用本站 origin 即可（绝不用 "*"）。
            target.postMessage({ type: DIRECTOR_MESSAGE.request, payload: { requestId, action, options: options || {} } }, window.location.origin);
        });
    }, []);

    const handleMessage = useCallback(
        (event: MessageEvent) => {
            // 同源校验。场景台就在本站 /director-desk/ 下，跨源消息一律不理。
            if (event.origin !== window.location.origin) return;
            const frame = iframeRef.current;
            if (!frame || event.source !== frame.contentWindow) return;
            const data = event.data as { type?: unknown; payload?: unknown } | null;
            if (!data || typeof data.type !== "string") return;

            if (data.type === DIRECTOR_MESSAGE.ready) {
                setReady(true);
                injectEmbedStyle();
                return;
            }
            if (data.type === DIRECTOR_MESSAGE.close) {
                onCloseRef.current();
                return;
            }
            if (data.type === DIRECTOR_MESSAGE.response) {
                const payload = data.payload as { requestId?: string; ok?: boolean; data?: unknown; error?: { code?: string; message?: string } } | undefined;
                const requestId = payload?.requestId;
                if (!requestId) return;
                const pending = pendingRef.current.get(requestId);
                // 认不出的 requestId 直接丢弃——可能是超时后迟到的响应。
                if (!pending) return;
                pendingRef.current.delete(requestId);
                window.clearTimeout(pending.timer);
                if (payload?.ok) pending.resolve(payload.data);
                else pending.reject(new Error(directorErrorText(payload?.error?.code || "", payload?.error?.message || "")));
                return;
            }
            if (data.type === DIRECTOR_MESSAGE.capturesSent) {
                const captures = readDirectorCaptures(data.payload);
                if (!captures.length) {
                    message.warning("场景台没有传回可用的截图");
                    return;
                }
                onCapturesRef.current(captures);
            }
        },
        [message, injectEmbedStyle],
    );

    useEffect(() => {
        if (!open) return;
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [open, handleMessage]);

    // 导出运镜 → 直接落成画布视频节点。
    //
    // 走协议而不是让用户点场景台自带的「导出 MP4」：那个按钮走 downloadReferenceVideo()，
    // 造一个 a[download] 直接下到硬盘，视频根本不会回到画布。协议路径只把结果返回、不下载。
    const exportVideoToCanvas = async () => {
        if (exportStatus) return;
        try {
            // 先问一下运镜多长，好把等待时间如实告诉用户——录制是**实时**的，
            // 录 8 秒的运镜就要等 8 秒，不说清楚会被当成卡死。
            let hint = "正在录制运镜…";
            const timeline = (await requestDirector("timeline.get").catch(() => null)) as DirectorTimeline | null;
            const seconds = Math.ceil(timeline?.durationSeconds || 0);
            if (seconds > 0) hint = `正在录制运镜，约需 ${seconds} 秒（请勿切走页面）…`;
            setExportStatus(hint);

            const result = (await requestDirector("export.video", { fileName: `${nodeTitle}-运镜.mp4`, fps: 30, quality: "1080p" }, DIRECTOR_EXPORT_TIMEOUT_MS)) as DirectorVideoResult;
            if (!result || !(result.blob instanceof Blob)) throw new Error("场景台没有返回可用的视频");

            setExportStatus("正在保存到画布…");
            await onVideo(result);
            message.success("运镜视频已放到画布上");
        } catch (error) {
            const reason = error instanceof Error ? error.message : "";
            // 用户自己把弹窗关了，不用再追着他报错。
            if (reason === REQUEST_CANCELLED) return;
            message.error(reason || "导出失败");
        } finally {
            setExportStatus("");
        }
    };

    if (!open) return null;

    const src = buildDirectorSrc(instanceId, theme === "dark" ? "dark" : "light");
    const exporting = Boolean(exportStatus);
    let exportLabel = "导出运镜到画布";
    if (exporting) exportLabel = exportStatus;

    return (
        <Modal
            open
            onCancel={onClose}
            width="96vw"
            style={{ top: 24, maxWidth: 1680 }}
            styles={{ body: { padding: 0, height: "calc(100vh - 168px)" } }}
            title={`3D 场景台 · ${nodeTitle}`}
            destroyOnClose
            footer={
                <div className="flex items-center justify-between">
                    {/* 说清两件事：门槛（≥2 个轨迹点）和实时录制的代价（不能切走）。
                        录制走的是 MediaRecorder 实时采集，切到后台会被浏览器节流甚至暂停。 */}
                    <span className="text-xs opacity-55">记满 2 个以上镜头轨迹点即可导出；录制是实时的，期间请让本页面保持在前台</span>
                    <Button type="primary" icon={<Film className="size-3.5" />} loading={exporting} onClick={() => void exportVideoToCanvas()}>
                        {exportLabel}
                    </Button>
                </div>
            }
        >
            <div className="relative size-full">
                <StageLoading ready={ready} />
                <iframe
                    ref={iframeRef}
                    src={src}
                    title="3D 场景台"
                    onLoad={injectEmbedStyle}
                    className="size-full rounded-b-lg border-0"
                    // 这是同源子应用，需要 same-origin 才能用它自己的 localStorage/IndexedDB 存工程；
                    // 不给 allow-top-navigation，避免它能把整个页面导走。
                    sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-forms allow-modals"
                    allow="fullscreen; xr-spatial-tracking"
                />
            </div>
            <CanvasStageGuideModal open={guideOpen} onClose={() => setGuideOpen(false)} />
        </Modal>
    );
}

function StageLoading({ ready }: { ready: boolean }) {
    if (ready) return null;
    return (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/5 dark:bg-black/30">
            <Spin />
            <span className="text-xs opacity-60">正在加载 3D 场景台…首次打开需要下载模型资源</span>
        </div>
    );
}
