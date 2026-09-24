package service

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"aicanvas/model"
)

// 豆包语音(火山 openspeech)单向流式语音合成。和现有 OpenAI 风格 /audio/speech 不同：
// 鉴权 X-Api-Key + X-Api-Resource-Id + X-Api-Request-Id；端点 /api/v3/tts/unidirectional；
// 响应是 NDJSON 流（每行 {"code","message","data":base64}），code=0 是音频块、20000000 是结束标志、其它为错误。
// 凭证从「火山音频」渠道(protocol=volc-audio，按分组配置)取：APIKey=渠道key、Endpoint=渠道baseUrl、ResourceID=渠道resourceId。实测验证过线格式。

const (
	doubaoTTSDefaultEndpoint   = "https://openspeech.bytedance.com"
	doubaoTTSDefaultResourceID = "seed-tts-1.0" // 账号当前开通的版本；开通 2.0 后后台改成 seed-tts-2.0 即可
	doubaoTTSCloneResourceID   = "seed-icl-2.0" // 自定义设计/复刻音色(S_/icl_ 开头)固定走声音复刻 ICL2.0 资源
	doubaoTTSSynthPath         = "/api/v3/tts/unidirectional"
	doubaoTTSSuccessEndCode    = 20000000 // 末块「OK」状态码
)

// isCustomDoubaoSpeaker 判断是否「音色设计/声音复刻」得到的自定义音色（speaker_id 以 S_ 或 icl_ 开头）。
// 这类音色必须用声音复刻 ICL 资源(seed-icl-2.0)合成，公版预设音色(zh_xxx_bigtts 等)则用 seed-tts。
func isCustomDoubaoSpeaker(speaker string) bool {
	s := strings.TrimSpace(speaker)
	return strings.HasPrefix(s, "S_") || strings.HasPrefix(s, "icl_")
}

// DoubaoTTSConfig 运行时凭证/版本。
type DoubaoTTSConfig struct {
	APIKey     string
	ResourceID string
	Endpoint   string
}

// DoubaoTTSConfigFromChannel 从火山音频渠道(protocol=volc-audio)构造豆包凭证。
// APIKey=渠道 key、Endpoint=渠道 baseUrl(空回退默认域名)、ResourceID=渠道 resourceId(空回退 seed-tts-1.0)。
func DoubaoTTSConfigFromChannel(channel model.ModelChannel) DoubaoTTSConfig {
	cfg := DoubaoTTSConfig{
		APIKey:     strings.TrimSpace(channel.APIKey),
		ResourceID: strings.TrimSpace(channel.ResourceID),
		Endpoint:   strings.TrimSpace(channel.BaseURL),
	}
	if cfg.ResourceID == "" {
		cfg.ResourceID = doubaoTTSDefaultResourceID
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = doubaoTTSDefaultEndpoint
	}
	return cfg
}

// DoubaoFormatFromOpenAI 把 OpenAI response_format 归一到豆包支持的格式(mp3/wav/pcm/ogg_opus)。
func DoubaoFormatFromOpenAI(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "wav":
		return "wav"
	case "pcm":
		return "pcm"
	case "opus", "ogg_opus", "ogg":
		return "ogg_opus"
	default:
		return "mp3"
	}
}

// DoubaoSpeechRateFromSpeed 把 OpenAI 倍速(0.25~4,1=常速)映射到豆包 speech_rate([-50,100],0=常速,100=2x,-50=0.5x)。
func DoubaoSpeechRateFromSpeed(speed float64) int {
	rate := int((speed - 1) * 100)
	if rate < -50 {
		rate = -50
	}
	if rate > 100 {
		rate = 100
	}
	return rate
}

// DoubaoTTSParams 一次合成的参数。
type DoubaoTTSParams struct {
	Text         string
	Speaker      string
	Format       string // mp3(默认)/ogg_opus/pcm/wav
	SampleRate   int    // 默认 24000
	SpeechRate   int    // 语速 [-50,100]，默认 0
	LoudnessRate int    // 音量 [-50,100]，默认 0
}

type doubaoAudioParams struct {
	Format       string `json:"format,omitempty"`
	SampleRate   int    `json:"sample_rate,omitempty"`
	SpeechRate   int    `json:"speech_rate,omitempty"`
	LoudnessRate int    `json:"loudness_rate,omitempty"`
}

type doubaoReqParams struct {
	Text        string            `json:"text"`
	Speaker     string            `json:"speaker"`
	AudioParams doubaoAudioParams `json:"audio_params"`
	Additions   string            `json:"additions,omitempty"` // ICL2.0 音色传 {"model_type":4} 走 ICL2.0 效果
}

type doubaoReqBody struct {
	User      map[string]string `json:"user,omitempty"`
	ReqParams doubaoReqParams   `json:"req_params"`
}

type doubaoStreamChunk struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data"`
}

// RunDoubaoTTS 调豆包单向流式合成，聚合 NDJSON 音频块返回完整音频字节 + mime 类型。
func RunDoubaoTTS(cfg DoubaoTTSConfig, p DoubaoTTSParams) ([]byte, string, error) {
	format := strings.TrimSpace(p.Format)
	if format == "" {
		format = "mp3"
	}
	sampleRate := p.SampleRate
	if sampleRate <= 0 {
		sampleRate = 24000
	}
	// 自定义设计/复刻音色(S_/icl_) 固定走 seed-icl-2.0 + model_type:4(ICL2.0 效果)，不论渠道配的哪个 resourceId；
	// 公版音色用渠道配置的 resourceId(seed-tts)。同账号 key 两类资源都有权限，故用户无需切渠道/模型。
	resourceID := cfg.ResourceID
	additions := ""
	if isCustomDoubaoSpeaker(p.Speaker) {
		resourceID = doubaoTTSCloneResourceID
		additions = `{"model_type":4}`
	}
	body := doubaoReqBody{
		User: map[string]string{"uid": "huijing"},
		ReqParams: doubaoReqParams{
			Text:    p.Text,
			Speaker: p.Speaker,
			AudioParams: doubaoAudioParams{
				Format:       format,
				SampleRate:   sampleRate,
				SpeechRate:   p.SpeechRate,
				LoudnessRate: p.LoudnessRate,
			},
			Additions: additions,
		},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, "", err
	}
	url := strings.TrimRight(cfg.Endpoint, "/") + doubaoTTSSynthPath
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", cfg.APIKey)
	req.Header.Set("X-Api-Resource-Id", resourceID)
	req.Header.Set("X-Api-Request-Id", uuid.NewString())

	resp, err := UpstreamHTTPClient.Do(req)
	if err != nil {
		return nil, "", safeMessageError{message: "豆包语音请求失败：" + err.Error()}
	}
	defer resp.Body.Close()

	var audio bytes.Buffer
	scanner := bufio.NewScanner(resp.Body)
	// 单行(一块base64)可能较大，放宽行缓冲上限到 16MB，避免长文本被 bufio 默认 64KB 截断。
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var chunk doubaoStreamChunk
		if err := json.Unmarshal(line, &chunk); err != nil {
			continue // 跳过无法解析的行
		}
		if chunk.Code != 0 && chunk.Code != doubaoTTSSuccessEndCode {
			return nil, "", safeMessageError{message: fmt.Sprintf("豆包语音合成失败(%d)：%s", chunk.Code, strings.TrimSpace(chunk.Message))}
		}
		if chunk.Data == "" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(chunk.Data)
		if err != nil {
			continue
		}
		audio.Write(decoded)
	}
	if err := scanner.Err(); err != nil {
		return nil, "", safeMessageError{message: "豆包语音响应读取失败：" + err.Error()}
	}
	if audio.Len() == 0 {
		return nil, "", safeMessageError{message: "豆包语音合成结果为空，请重试"}
	}
	return audio.Bytes(), doubaoTTSMimeType(format), nil
}

func doubaoTTSMimeType(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "ogg_opus", "opus", "ogg":
		return "audio/ogg"
	case "pcm":
		return "audio/pcm"
	case "wav":
		return "audio/wav"
	default:
		return "audio/mpeg"
	}
}
