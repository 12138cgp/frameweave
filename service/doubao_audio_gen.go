package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"aicanvas/model"
	"aicanvas/repository"
)

// 豆包语音「音频生成」(火山 openspeech)。和同目录 doubao_tts.go 的 TTS 是两条独立的路：
//
//	TTS  : /api/v3/tts/unidirectional  流式 NDJSON  只能「文本 + 音色」
//	本文件: /api/v3/tts/create         一次性 JSON  支持「文本 / 文本+参考音频 / 文本+参考图片」
//
// 鉴权同样是 X-Api-Key 单头，但资源不同：create 接口固定走 volc.service_type.10074，
// 上游会忽略我们传的 X-Api-Resource-Id（实测：显式带 seed-tts-1.0 仍报同一个资源未授权），
// 所以这里干脆不发那个头。账号没开通该资源时返回 403 + code 45000030。
//
// ⚠️ 上游【没有时长参数】：出片时长靠 text_prompt 里的自然语言描述控制，真实秒数只能从响应的
// original_duration 读到（计费依据，上限 120 秒）。按秒计费因此必须「预扣 + 结算」，
// 见 handler/ai.go 的 settleAudioCredits。
const (
	doubaoAudioGenPath = "/api/v3/tts/create"
	// DoubaoAudioGenModel 音频生成模型名。上游当前只有这一个版本。
	DoubaoAudioGenModel = "seed-audio-1.0"
	// DoubaoAudioMaxTextPrompt 提示词上限（字符，不是字节）。
	//
	// 上游的硬限制是 3000（实测：发 3001 个中文字报
	// "text_prompt length 3001 exceeds maximum of 3000"），我们按产品决定收到 2000。
	//
	// ⚠️ 但无论 2000 还是 3000 都**到不了**：出片有 120 秒硬上限，中文实测约 3.8 字/秒，
	// 500 字就会被上游以 `40000020 InvalidPayload:DurationOutOfRange` 拒掉（300 字=78.6 秒可以过）。
	// 所以真正会先撞到的是时长墙，前端另有一条按语种估算时长的预警，见 lib/audio-generation.ts。
	DoubaoAudioMaxTextPrompt = 2000
	// DoubaoAudioMaxRefAudios 参考音频最多 3 条（单条 ≤30 秒、≤10MB）。
	DoubaoAudioMaxRefAudios = 3
	// DoubaoAudioMaxRefImages 参考图片最多 1 张（≤10MB）。
	DoubaoAudioMaxRefImages = 1
	// DoubaoAudioMaxRefBytes 单条参考素材的大小上限（音频/图片都是 10MB）。
	DoubaoAudioMaxRefBytes = 10 * 1024 * 1024
)

// audioGenTotalTimeout 一次音频生成的总超时。
// 它的作用是兜底而不是控制体验：不会结束的请求 = 不会被结算的钱，必须有个硬边界。
const audioGenTotalTimeout = 10 * time.Minute

// audioGenHTTPClient 音频生成专用的上游客户端。
//
// 与 UpstreamHTTPClient 的唯一区别是【多了总超时】：seed-audio 是同步接口，一次调用要等整段
// 音频生成完才返回，上游若在回了响应头之后断流，io.ReadAll 会一直阻塞；而这个 handler 一阻塞，
// 预扣的钱就既不会退（onFailure 没被调）也不会结算（onSettle 没被调），成了无人负责的孤儿。
//
// ⚠️ ResponseHeaderTimeout 必须和 UpstreamHTTPClient 一样宽（300 秒），**不能用 60 秒**：
// 这个接口只在音频全部生成完毕时才回响应头，30 秒目标 + 长台词实测会超过 60 秒。
// 2026-09-20 我一度改用 SafeHTTPClient（60 秒响应头超时），结果长音频一律失败在
// "timeout awaiting response headers"——钱每次都正确退了，但功能等于废掉。
// SafeHTTPClient 是给「下载用户提供的地址」用的（它的价值在 safeDialControl 防 SSRF），
// 这里的地址来自管理员配置的渠道，不是用户输入，用它反而引入了不合适的短超时。
var audioGenHTTPClient = &http.Client{
	Timeout: audioGenTotalTimeout,
	Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 300 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	},
}

// IsDoubaoAudioGenModel 判断模型名是否走「音频生成」这条路（而不是老的 TTS）。
// 与前端 lib/audio-generation.ts 的 isSeedAudioModel 必须同口径——这是本项目的老毛病
// （同一判据两处实现），改一处务必改另一处。
func IsDoubaoAudioGenModel(name string) bool {
	return strings.Contains(strings.ToLower(strings.TrimSpace(name)), "seed-audio")
}

// DoubaoAudioReference 一条参考资源。speaker / audioData / audioURL 三者互斥；
// 图片参考(imageData/imageURL)不能与任何音频参考或 speaker 混用（上游硬约束）。
type DoubaoAudioReference struct {
	Speaker   string
	AudioData []byte // 原始字节，发之前在这里做 base64
	AudioURL  string
	ImageData []byte
	ImageURL  string
}

func (r DoubaoAudioReference) isImage() bool {
	return len(r.ImageData) > 0 || strings.TrimSpace(r.ImageURL) != ""
}

func (r DoubaoAudioReference) isAudio() bool {
	return len(r.AudioData) > 0 || strings.TrimSpace(r.AudioURL) != "" || strings.TrimSpace(r.Speaker) != ""
}

// DoubaoAudioGenParams 一次音频生成的参数。
type DoubaoAudioGenParams struct {
	Model      string
	TextPrompt string
	References []DoubaoAudioReference
	Format     string // wav(上游默认)/mp3/pcm/ogg_opus
	SampleRate int
	// SpeechRate 语速 [-50,100]、LoudnessRate 音量 [-50,100]、PitchRate 音调 [-12,12]，0 都表示不调整。
	SpeechRate     int
	LoudnessRate   int
	PitchRate      int
	EnableSubtitle bool
}

// DoubaoAudioGenResult 一次音频生成的结果。
type DoubaoAudioGenResult struct {
	Audio    []byte
	MimeType string
	// Duration 处理后时长（变速/后处理后的秒数）。
	Duration float64
	// OriginalDuration 模型输出的原始时长，**上游明确这是计费依据**，上限 120 秒。
	OriginalDuration float64
	// Subtitle 字幕（仅 EnableSubtitle 时上游才返回），原样透传给前端，本服务不解析。
	Subtitle json.RawMessage
}

type doubaoAudioGenRef struct {
	Speaker   string `json:"speaker,omitempty"`
	AudioData string `json:"audio_data,omitempty"`
	AudioURL  string `json:"audio_url,omitempty"`
	ImageData string `json:"image_data,omitempty"`
	ImageURL  string `json:"image_url,omitempty"`
}

type doubaoAudioGenConfig struct {
	Format         string `json:"format,omitempty"`
	SampleRate     int    `json:"sample_rate,omitempty"`
	SpeechRate     int    `json:"speech_rate,omitempty"`
	LoudnessRate   int    `json:"loudness_rate,omitempty"`
	PitchRate      int    `json:"pitch_rate,omitempty"`
	EnableSubtitle bool   `json:"enable_subtitle,omitempty"`
}

type doubaoAudioGenBody struct {
	Model       string               `json:"model"`
	TextPrompt  string               `json:"text_prompt"`
	References  []doubaoAudioGenRef  `json:"references,omitempty"`
	AudioConfig doubaoAudioGenConfig `json:"audio_config,omitempty"`
}

type doubaoAudioGenResponse struct {
	Code             int             `json:"code"`
	Message          string          `json:"message"`
	Audio            string          `json:"audio"`
	Duration         float64         `json:"duration"`
	OriginalDuration float64         `json:"original_duration"`
	URL              string          `json:"url"`
	Subtitle         json.RawMessage `json:"subtitle,omitempty"`
}

// ValidateDoubaoAudioReferences 按上游硬约束校验参考集合。
// 这是第二道闸（第一道在前端），存在的理由是前端那道只拦得住自家界面——
// 上游把超限当错误直接顶回来，而那时钱已经扣了。
func ValidateDoubaoAudioReferences(refs []DoubaoAudioReference) error {
	audios, images := 0, 0
	for _, ref := range refs {
		if ref.isImage() {
			images++
			if len(ref.ImageData) > DoubaoAudioMaxRefBytes {
				return safeMessageError{message: fmt.Sprintf("参考图片超过 %dMB，请压缩后再用", DoubaoAudioMaxRefBytes/1024/1024)}
			}
			continue
		}
		if ref.isAudio() {
			audios++
			if len(ref.AudioData) > DoubaoAudioMaxRefBytes {
				return safeMessageError{message: fmt.Sprintf("参考音频超过 %dMB，请压缩后再用", DoubaoAudioMaxRefBytes/1024/1024)}
			}
		}
	}
	if audios > DoubaoAudioMaxRefAudios {
		return safeMessageError{message: fmt.Sprintf("参考音频最多 %d 条，当前 %d 条", DoubaoAudioMaxRefAudios, audios)}
	}
	if images > DoubaoAudioMaxRefImages {
		return safeMessageError{message: fmt.Sprintf("参考图片最多 %d 张，当前 %d 张", DoubaoAudioMaxRefImages, images)}
	}
	// 上游不接受图片参考与音频参考(含 speaker)混用，且这种请求会被直接拒掉。
	if images > 0 && audios > 0 {
		return safeMessageError{message: "参考图片不能和参考音频一起用，请只留一种"}
	}
	return nil
}

// RunDoubaoAudioGen 调豆包音频生成，返回完整音频字节 + 计费用的原始时长。
func RunDoubaoAudioGen(cfg DoubaoTTSConfig, p DoubaoAudioGenParams) (DoubaoAudioGenResult, error) {
	var empty DoubaoAudioGenResult
	text := strings.TrimSpace(p.TextPrompt)
	if text == "" {
		return empty, safeMessageError{message: "请输入要生成的音频内容"}
	}
	// 数的是字符不是字节：上游写明「最大支持3000字符」，中文按字节算会在 1000 字左右误判超限。
	if len([]rune(text)) > DoubaoAudioMaxTextPrompt {
		return empty, safeMessageError{message: fmt.Sprintf("文本超过 %d 字，请精简后再生成", DoubaoAudioMaxTextPrompt)}
	}
	if err := ValidateDoubaoAudioReferences(p.References); err != nil {
		return empty, err
	}

	modelName := strings.TrimSpace(p.Model)
	if modelName == "" {
		modelName = DoubaoAudioGenModel
	}
	format := strings.ToLower(strings.TrimSpace(p.Format))
	switch format {
	case "wav", "mp3", "pcm", "ogg_opus":
	case "opus", "ogg":
		format = "ogg_opus"
	default:
		format = "mp3"
	}

	refs := make([]doubaoAudioGenRef, 0, len(p.References))
	for index, ref := range p.References {
		item := doubaoAudioGenRef{Speaker: strings.TrimSpace(ref.Speaker), AudioURL: strings.TrimSpace(ref.AudioURL), ImageURL: strings.TrimSpace(ref.ImageURL)}
		if len(ref.AudioData) > 0 {
			item.AudioData = base64.StdEncoding.EncodeToString(ref.AudioData)
		}
		if len(ref.ImageData) > 0 {
			item.ImageData = base64.StdEncoding.EncodeToString(ref.ImageData)
		}
		// ⚠️ 绝不能「空的就跳过」。上游的 @音频N 是按 references 的下标编号的，
		// 中途少一条，后面所有参考的编号都会前移一位——用户写的 @音频2 会拿到他标为「音频3」
		// 的那条（串音色），而且前后端都不会有任何提示。
		// 0 字节参考是真实存在的（桶里上传中断/同步半截的文件，库里照样标「已完成」），
		// 所以这里宁可整条请求失败，也不能默默换一条素材。
		if item == (doubaoAudioGenRef{}) {
			return empty, safeMessageError{message: fmt.Sprintf("第 %d 条参考素材是空的（可能还没上传完），请重新上传后再试", index+1)}
		}
		refs = append(refs, item)
	}

	body := doubaoAudioGenBody{
		Model:      modelName,
		TextPrompt: text,
		References: refs,
		AudioConfig: doubaoAudioGenConfig{
			Format:         format,
			SampleRate:     normalizeAudioSampleRate(format, p.SampleRate),
			SpeechRate:     clampInt(p.SpeechRate, -50, 100),
			LoudnessRate:   clampInt(p.LoudnessRate, -50, 100),
			PitchRate:      clampInt(p.PitchRate, -12, 12),
			EnableSubtitle: p.EnableSubtitle,
		},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return empty, err
	}

	url := strings.TrimRight(cfg.Endpoint, "/") + doubaoAudioGenPath
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return empty, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", cfg.APIKey)
	req.Header.Set("X-Api-Request-Id", uuid.NewString())

	// 用专用客户端（见 audioGenHTTPClient 的说明）：响应头超时 300 秒 + 总超时兜底。
	resp, err := audioGenHTTPClient.Do(req)
	if err != nil {
		return empty, safeMessageError{message: "豆包音频生成请求失败：" + shortErr(err)}
	}
	defer resp.Body.Close()

	// 响应是一次性 JSON，音频以 base64 装在 audio 字段里：120 秒 wav 可达几十 MB，
	// 按 base64 膨胀 1.34 倍预留到 256MB 再截断，避免把整个进程读爆。
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024*1024))
	if err != nil {
		// 用 shortErr 而不是 err.Error()：原始错误形如
		// `read tcp 172.20.0.2:56914->221.231.47.46:443: read: connection timed out`，
		// 带着容器内网 IP 和上游 IP。下游虽有脱敏，但不该依赖它。
		return empty, safeMessageError{message: "豆包音频生成响应读取失败：" + shortErr(err)}
	}
	var parsed doubaoAudioGenResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// 解析不了就别把上游原文吐给用户（可能带上游地址/内部标识），只给状态码。
		return empty, safeMessageError{message: fmt.Sprintf("豆包音频生成返回异常(HTTP %d)", resp.StatusCode)}
	}
	if parsed.Code != 0 {
		return empty, safeMessageError{message: doubaoAudioGenErrorText(parsed.Code, parsed.Message)}
	}
	if strings.TrimSpace(parsed.Audio) == "" {
		return empty, safeMessageError{message: "豆包音频生成结果为空，请重试"}
	}
	audio, err := base64.StdEncoding.DecodeString(parsed.Audio)
	if err != nil {
		return empty, safeMessageError{message: "豆包音频生成结果解码失败，请重试"}
	}
	return DoubaoAudioGenResult{
		Audio:            audio,
		MimeType:         doubaoTTSMimeType(format),
		Duration:         parsed.Duration,
		OriginalDuration: parsed.OriginalDuration,
		Subtitle:         parsed.Subtitle,
	}, nil
}

// doubaoAudioGenErrorText 把上游错误码翻成用户能看懂的话。
// 45000030 是「资源未授权」——账号没在火山语音技术控制台开通「音频生成」，
// 这条如果不单独翻，用户只会看到一串内部资源号，根本不知道该去开通什么。
func doubaoAudioGenErrorText(code int, message string) string {
	msg := ScrubForUser(strings.TrimSpace(message))
	if code == 45000030 {
		return "火山账号尚未开通「音频生成」服务（语音技术控制台），请联系管理员开通后再试"
	}
	// 40000020 DurationOutOfRange：文本太长，按正常语速读完会超过上游 120 秒的出片上限。
	// 不翻的话用户只会看到一句英文 InvalidPayload，完全不知道该删字。
	if code == 40000020 {
		return "文本太长了：按正常语速读完会超过上游 120 秒的出片上限，请分段生成（中文大约 450 字以内）"
	}
	if msg == "" {
		return fmt.Sprintf("豆包音频生成失败(%d)", code)
	}
	if len([]rune(msg)) > 300 {
		msg = string([]rune(msg)[:300])
	}
	return fmt.Sprintf("豆包音频生成失败(%d)：%s", code, msg)
}

// audioSampleRates 各输出格式支持的采样率（官方文档明列，选错上游直接拒）。
// ⚠️ 与前端 lib/audio-generation.ts 的 SEED_AUDIO_SAMPLE_RATES 是同一张表的两处实现——
// 这是本项目的常见病，改一处必须同步改另一处。
var audioSampleRates = map[string][]int{
	"wav":      {8000, 16000, 24000, 32000, 40000, 44100, 48000},
	"pcm":      {8000, 16000, 24000, 32000, 40000, 44100, 48000},
	"mp3":      {8000, 16000, 24000, 32000, 44100, 48000},
	"ogg_opus": {48000},
}

var audioDefaultSampleRate = map[string]int{"wav": 40000, "pcm": 40000, "mp3": 44100, "ogg_opus": 48000}

// normalizeAudioSampleRate 把采样率归一到该格式的合法取值。
// 0/缺省 → 不发这个字段（omitempty），用上游默认值；非法值 → 落到该格式的官方默认值，
// 而不是原样发出去让上游拒掉——前端那道校验拦不住绕过界面直接打接口的请求。
func normalizeAudioSampleRate(format string, rate int) int {
	if rate <= 0 {
		return 0
	}
	allowed, ok := audioSampleRates[format]
	if !ok {
		return 0
	}
	for _, v := range allowed {
		if v == rate {
			return rate
		}
	}
	return audioDefaultSampleRate[format]
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// ReadUserMediaBytes 取一条参考素材的原始字节，供发给上游。
//
// 为什么后端自己取、而不是把地址丢给上游：各组的桶不一定开公共读，我们自己的鉴权接口上游更够不着，
// 「地址给出去能不能读」没有任何保证；而后端取字节是本项目早就有的能力（见 ResolveDesubtitleSource）。
// 代价是参考素材要在内存里过一遍——上限 10MB/条、最多 3 条，可接受。
//
// 顺序：本人 sync_files 登记 → 本地盘/公网地址 → 跨账号公共读回退（分享来的素材在对方名下，
// 按本人查必然查不到，这是「同一画布换个账号就丢图」那条老 bug 的同源点）→ 直接给的公网地址。
func ReadUserMediaBytes(userID, storageKey, rawURL string, maxBytes int64) ([]byte, error) {
	key := strings.TrimSpace(storageKey)
	if key != "" {
		if item, err := repository.GetSyncFile(userID, key); err == nil && item.ID != "" {
			return assertNonEmptyMedia(readMediaFromSyncFile(item, maxBytes))
		}
		if item, err := repository.GetPublicSyncFileByKey(key); err == nil && item.ID != "" && isPublicHTTPURL(item.Path) {
			return assertNonEmptyMedia(downloadMediaBytes(item.Path, maxBytes))
		}
	}
	if isPublicHTTPURL(rawURL) {
		return assertNonEmptyMedia(downloadMediaBytes(rawURL, maxBytes))
	}
	return nil, safeMessageError{message: "参考素材还没同步到云端，请稍等片刻再试"}
}

// assertNonEmptyMedia 0 字节素材一律当失败。
// 取到空字节不报错的话，调用方拿到的是一条「看起来成功的空参考」，后果见 RunDoubaoAudioGen
// 里关于编号前移的说明。本项目对 0 字节媒体有实证（库里标「已完成」、桶里是空文件）。
func assertNonEmptyMedia(data []byte, err error) ([]byte, error) {
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, safeMessageError{message: "参考素材是空文件（可能上传中断），请重新上传后再试"}
	}
	return data, nil
}

func readMediaFromSyncFile(item model.SyncFile, maxBytes int64) ([]byte, error) {
	if isPublicHTTPURL(item.Path) {
		return downloadMediaBytes(item.Path, maxBytes)
	}
	// 先看文件大小再读：原先是整读进内存再判超限，等于「为了拒绝一个 2GB 文件先把它读进内存」。
	if info, serr := os.Stat(item.Path); serr == nil && info.Size() > maxBytes {
		return nil, safeMessageError{message: fmt.Sprintf("参考素材超过 %dMB，请压缩后再用", maxBytes/1024/1024)}
	}
	file, oerr := os.Open(item.Path)
	if oerr != nil {
		return nil, safeMessageError{message: "读取参考素材失败，请重新上传后再试"}
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, safeMessageError{message: "读取参考素材失败，请重新上传后再试"}
	}
	if int64(len(data)) > maxBytes {
		return nil, safeMessageError{message: fmt.Sprintf("参考素材超过 %dMB，请压缩后再用", maxBytes/1024/1024)}
	}
	return data, nil
}

func downloadMediaBytes(url string, maxBytes int64) ([]byte, error) {
	resp, err := SafeHTTPClient(60 * time.Second).Get(url)
	if err != nil {
		return nil, safeMessageError{message: "下载参考素材失败：" + shortErr(err)}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, safeMessageError{message: fmt.Sprintf("下载参考素材失败(%d)", resp.StatusCode)}
	}
	// 多读 1 字节用来判「是不是正好超限」：只读 maxBytes 的话，恰好等于上限的文件和超限文件读出来一样长。
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, safeMessageError{message: "下载参考素材失败：" + shortErr(err)}
	}
	if int64(len(data)) > maxBytes {
		return nil, safeMessageError{message: fmt.Sprintf("参考素材超过 %dMB，请压缩后再用", maxBytes/1024/1024)}
	}
	return data, nil
}
