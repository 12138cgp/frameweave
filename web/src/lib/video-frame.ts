// 视频截取帧：用一个临时的离屏 video 元素 seek 到目标时间，抓取该帧画面到 canvas，导出为 PNG Blob。
// 远端视频先 fetch 成 blob（no-store，拿带 ACAO 的新鲜响应）再用同源 blob URL 喂离屏 video，
// 绕开「主播放器以非 CORS 请求加载视频、其无 ACAO 的缓存响应被抓帧的 <video crossOrigin> 复用 → error/加载失败」的坑：
// TOS 桶已配 ACAO:*，但浏览器媒体元素缓存不区分 CORS/非CORS 请求；fetch 路径正常拿得到 ACAO，故统一走 fetch→blob→同源 URL。

export type VideoFrameTarget = "first" | "last" | "current";

export class VideoFrameCorsError extends Error {
    constructor() {
        super("该视频跨域暂无法截取（需配置存储 CORS）");
        this.name = "VideoFrameCorsError";
    }
}

/**
 * 抓取视频指定时间点的画面。
 * @param src 视频地址（blob: 本地缓存 或 http(s): 远端 URL）
 * @param target 首帧 / 尾帧 / 当前帧
 * @param currentTime 当 target 为 "current" 时，主播放器的 video.currentTime（秒）
 * @returns PNG 格式的 Blob
 */
export function captureVideoFrame(src: string, target: VideoFrameTarget, currentTime = 0): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
        const video = document.createElement("video");
        // 全程喂同源源（本地 blob:/data: 直接用；远端 http(s) 先 fetch 成 blob 再喂），故不设 crossOrigin
        // （同源不需要，且在 blob URL 上设 crossOrigin 部分浏览器反而异常）。
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        // 离屏但保留视频自然尺寸：压成 1px 会让部分浏览器（尤其 Safari）不解码当前帧 → 抓到透明帧。
        video.style.position = "fixed";
        video.style.left = "-10000px";
        video.style.top = "0";
        video.style.opacity = "0";
        video.style.pointerEvents = "none";

        let settled = false;
        let objectUrl: string | null = null; // 远端视频 fetch 成 blob 后的临时同源 URL；cleanup 时 revoke 防内存泄漏。
        const cleanup = () => {
            video.removeAttribute("src");
            try {
                video.load();
            } catch {
                /* noop */
            }
            video.remove();
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
                objectUrl = null;
            }
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(error);
        };
        const grab = () => {
            if (settled) return;
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (!width || !height) {
                fail(new Error("无法读取视频画面尺寸"));
                return;
            }
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                fail(new Error("无法创建画布上下文"));
                return;
            }
            try {
                ctx.drawImage(video, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    cleanup();
                    if (blob) resolve(blob);
                    else reject(new Error("视频帧导出失败"));
                }, "image/png");
            } catch (error) {
                // 跨域未配 CORS：drawImage 污染 canvas，toBlob/导出抛 SecurityError。
                if (error instanceof DOMException && error.name === "SecurityError") fail(new VideoFrameCorsError());
                else fail(error instanceof Error ? error : new Error("视频帧截取失败"));
            }
        };

        // seek 后视频处于暂停状态，requestVideoFrameCallback 要等「新帧呈现」故不会回调（会一直卡到超时）；
        // seeked 已表示目标帧解码到位，双 rAF 等一次渲染后直接抓即可。
        const grabWhenReady = () => {
            if (settled) return;
            requestAnimationFrame(() => requestAnimationFrame(grab));
        };

        const seekTo = (time: number) => {
            const duration = Number.isFinite(video.duration) ? video.duration : 0;
            const clamped = Math.max(0, duration ? Math.min(time, Math.max(0, duration - 0.05)) : time);
            // seek 到与当前几乎相同的时间不会触发 seeked，直接抓当前帧。
            if (Math.abs(video.currentTime - clamped) < 0.001) {
                grabWhenReady();
                return;
            }
            const onSeeked = () => {
                video.removeEventListener("seeked", onSeeked);
                grabWhenReady();
            };
            video.addEventListener("seeked", onSeeked);
            try {
                video.currentTime = clamped;
            } catch {
                video.removeEventListener("seeked", onSeeked);
                fail(new Error("视频跳转失败"));
            }
        };

        // 用 loadeddata（首帧数据已可用，readyState>=2）而非 loadedmetadata，避免帧未解码就抓。
        video.addEventListener("loadeddata", () => {
            if (settled) return;
            const duration = Number.isFinite(video.duration) ? video.duration : 0;
            // 首帧用极小正值：seek 到 0 往往不触发 seeked，且更稳地取到已解码的首帧。
            const time = target === "first" ? Math.min(0.04, duration || 0.04) : target === "last" ? Math.max(0, duration - 0.05) : Math.max(0, currentTime);
            seekTo(time);
        });
        video.addEventListener("error", () => fail(new Error("视频加载失败")));

        const timer = setTimeout(() => fail(new Error("视频截取超时")), 20000);

        document.body.appendChild(video);
        // 本地 blob:/data: 直接喂；远端 http(s) 先 fetch 成 blob（强制 CORS + no-store 拿带 ACAO 的新鲜响应，
        // 绕开媒体元素缓存复用主播放器非 CORS 响应的坑），再用同源 blob URL 喂离屏 video。
        if (src.startsWith("blob:") || src.startsWith("data:")) {
            video.src = src;
            video.load();
        } else {
            fetch(src, { mode: "cors", cache: "no-store", credentials: "omit" })
                .then((response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.blob();
                })
                .then((blob) => {
                    if (settled) return;
                    objectUrl = URL.createObjectURL(blob);
                    video.src = objectUrl;
                    video.load();
                })
                .catch((error) => {
                    // fetch 跨域被拦（TOS CORS 真没配/被 CDN 挡）→ TypeError，给「需配置存储 CORS」；其余网络/HTTP 错统一「加载失败」。
                    if (error instanceof TypeError) fail(new VideoFrameCorsError());
                    else fail(error instanceof Error ? error : new Error("视频加载失败"));
                });
        }
    });
}
