package service

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// ProbeVideoResult 服务端 ffprobe 出来的视频真实规格。
type ProbeVideoResult struct {
	Width           int    `json:"width"`
	Height          int    `json:"height"`
	DurationMs      int    `json:"durationMs"`
	VideoCodec      string `json:"videoCodec"`
	BrowserPlayable bool   `json:"browserPlayable"`
}

// mediaProbeTimeout ffprobe 通常只读文件头，但 moov 在文件尾的 mp4 要多拉一段，给宽裕些。
const mediaProbeTimeout = 90 * time.Second

// browserPlayableVideoCodecs 浏览器 <video> 能解的视频编码。
//
// 存在的理由：实测，用户传一段 iPhone 拍的 hevc(H.265) 1440x2560 竖屏片时，
// 浏览器直接 onerror —— 既播不出来，也读不到 videoWidth/videoHeight。
// 而前端当时把「读不到」兜底成 1280x720，于是 9:16 的片子在画布上被画成 16:9 带黑边，
// 下载下来却完全正常，用户只会觉得「你们把我的视频弄坏了」。
// iPhone 默认就用 HEVC 录像，所以这不是个别现象，是必然会反复发生的一类。
var browserPlayableVideoCodecs = map[string]bool{
	"h264": true, "avc1": true, "vp8": true, "vp9": true, "av1": true, "theora": true,
}

// ProbeVideo 用 ffprobe 读远端视频的真实宽高/时长/编码。
//
// 探不到不是致命错误：调用方拿不到就维持原样。这条链路只负责把「画得更准」变成可能，
// 绝不能因为探测失败而挡住用户的正常操作。
func ProbeVideo(sourceURL string) (ProbeVideoResult, error) {
	url := strings.TrimSpace(sourceURL)
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return ProbeVideoResult{}, errors.New("只支持公网地址")
	}
	ctx, cancel := context.WithTimeout(context.Background(), mediaProbeTimeout)
	defer cancel()
	args := []string{
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height,codec_name",
		"-show_entries", "format=duration",
		"-of", "json",
		url,
	}
	out, err := exec.CommandContext(ctx, "ffprobe", args...).Output()
	if err != nil {
		return ProbeVideoResult{}, err
	}
	var parsed struct {
		Streams []struct {
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			CodecName string `json:"codec_name"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if uerr := json.Unmarshal(out, &parsed); uerr != nil {
		return ProbeVideoResult{}, uerr
	}
	if len(parsed.Streams) == 0 || parsed.Streams[0].Width <= 0 || parsed.Streams[0].Height <= 0 {
		return ProbeVideoResult{}, errors.New("没有可用的视频流")
	}
	codec := strings.ToLower(strings.TrimSpace(parsed.Streams[0].CodecName))
	result := ProbeVideoResult{
		Width:           parsed.Streams[0].Width,
		Height:          parsed.Streams[0].Height,
		VideoCodec:      codec,
		BrowserPlayable: browserPlayableVideoCodecs[codec],
	}
	if seconds, perr := strconv.ParseFloat(strings.TrimSpace(parsed.Format.Duration), 64); perr == nil && seconds > 0 {
		result.DurationMs = int(seconds*1000 + 0.5)
	}
	return result, nil
}
