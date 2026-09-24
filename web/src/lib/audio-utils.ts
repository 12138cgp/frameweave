// 纯前端音频处理（零依赖）：从视频/音频 URL 解码出 PCM，编码为 WAV Blob。
// 用于「视频提取音频」和「音频裁切」。远端 TOS 资源依赖桶 CORS（GET 已放行）。

export class AudioDecodeError extends Error {}

// 拉取 URL 字节并用 Web Audio 解码为 AudioBuffer。
// decodeAudioData 能从 MP4/WebM 等容器中解出音轨（视频无音轨时会 reject）。
export async function decodeAudioFromUrl(src: string): Promise<AudioBuffer> {
    let arrayBuffer: ArrayBuffer;
    try {
        const res = await fetch(src, { mode: "cors" });
        if (!res.ok) throw new AudioDecodeError(`资源下载失败（${res.status}）`);
        arrayBuffer = await res.arrayBuffer();
    } catch (error) {
        if (error instanceof AudioDecodeError) throw error;
        throw new AudioDecodeError("资源下载失败，可能是跨域限制（CORS）");
    }
    const Ctx: typeof AudioContext | undefined = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new AudioDecodeError("当前浏览器不支持音频解码");
    const ctx = new Ctx();
    try {
        // 兼容旧 Safari 的回调式签名
        return await new Promise<AudioBuffer>((resolve, reject) => {
            const result = ctx.decodeAudioData(
                arrayBuffer,
                (buffer) => resolve(buffer),
                (err) => reject(new AudioDecodeError(err?.message || "无法解码该音轨（可能无音频或格式不支持）")),
            );
            // 现代浏览器返回 Promise
            if (result && typeof (result as Promise<AudioBuffer>).then === "function") {
                (result as Promise<AudioBuffer>).then(resolve, (err) => reject(new AudioDecodeError(err?.message || "无法解码该音轨")));
            }
        });
    } finally {
        void ctx.close?.();
    }
}

// 把 AudioBuffer 的 [startSec, endSec) 区间编码为 16-bit PCM WAV Blob（不裁则导出全段）。
export function audioBufferToWavBlob(buffer: AudioBuffer, startSec = 0, endSec = buffer.duration): Blob {
    const sampleRate = buffer.sampleRate;
    const numChannels = buffer.numberOfChannels;
    const start = Math.max(0, Math.floor(startSec * sampleRate));
    const end = Math.min(buffer.length, Math.ceil(endSec * sampleRate));
    const frameCount = Math.max(0, end - start);
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = frameCount * blockAlign;
    const out = new ArrayBuffer(44 + dataSize);
    const view = new DataView(out);
    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));
    let offset = 44;
    for (let i = start; i < end; i++) {
        for (let c = 0; c < numChannels; c++) {
            let sample = channels[c][i];
            sample = sample < -1 ? -1 : sample > 1 ? 1 : sample;
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += 2;
        }
    }
    return new Blob([out], { type: "audio/wav" });
}

// 从 AudioBuffer 抽取波形峰值（用于裁切弹窗绘制），返回 [0,1] 的 bars 个峰值。
export function extractWaveformPeaks(buffer: AudioBuffer, bars = 600): number[] {
    const data = buffer.getChannelData(0);
    const block = Math.max(1, Math.floor(data.length / bars));
    const peaks: number[] = [];
    for (let i = 0; i < bars; i++) {
        let peak = 0;
        const begin = i * block;
        const stop = Math.min(data.length, begin + block);
        for (let j = begin; j < stop; j++) {
            const v = Math.abs(data[j]);
            if (v > peak) peak = v;
        }
        peaks.push(peak);
    }
    return peaks;
}
