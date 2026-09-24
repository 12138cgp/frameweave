package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"mime/multipart"
	"net/textproto"
	"net/url"
	"os"
	"strconv"
	"strings"

	"aicanvas/model"
)

// seedreamMaxPixels Seedream 单张图面积上限（火山官方 4624220 px，约 2K）。
// 前端选 4K/2K 时算出的像素尺寸会超上限，火山直接 400（InvalidParameter: image area must be at most 4624220 pixels），
// 白扣费还报个看不懂的英文错。对 seedream 类模型统一做尺寸夹取：超上限就等比缩到刚好不超，用户选 4K 也能出图（实际出降档后的尺寸）。
const seedreamMaxPixels = 4624220

// clampSeedreamSize 若 size 是 "宽x高" 像素且面积超上限，等比缩到不超上限（长宽比不变，各边取整为偶数）。
// 非像素尺寸（如 "1024x1024" 以外的比例串 "16:9"、或空串）原样返回——只认能解析出正整数宽高的。
func clampSeedreamSize(size string) string {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(size)), "x")
	if len(parts) != 2 {
		return size
	}
	w, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	h, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil || w <= 0 || h <= 0 {
		return size
	}
	area := w * h
	if area <= seedreamMaxPixels {
		return size
	}
	scale := math.Sqrt(float64(seedreamMaxPixels) / float64(area))
	nw := int(float64(w) * scale)
	nh := int(float64(h) * scale)
	// 取偶数、并因取整可能仍略超而再收一像素级，确保 nw*nh <= 上限
	if nw%2 == 1 {
		nw--
	}
	if nh%2 == 1 {
		nh--
	}
	for nw > 2 && nh > 2 && nw*nh > seedreamMaxPixels {
		if nw >= nh {
			nw -= 2
		} else {
			nh -= 2
		}
	}
	return strconv.Itoa(nw) + "x" + strconv.Itoa(nh)
}

// isSeedreamModel 判定是否 seedream 系模型（需做尺寸夹取）。
func isSeedreamModel(model string) bool {
	return strings.Contains(strings.ToLower(model), "seedream")
}

// 火山方舟没有 OpenAI 风格的 /images/edits 接口（直接调用返回 404）：
// Seedream 的图生图走 /images/generations + image 参数（URL 或 base64 data URI，支持多图）。
// 这里把前端的 multipart edits 请求转写为方舟 generations JSON。

func isArkChannelBaseURL(baseURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return strings.HasSuffix(host, ".volces.com") || strings.HasSuffix(host, ".volcengine.com")
}

// arkImageEditsToGenerations 解析 multipart edits 载荷，产出 generations JSON。
// 返回 (新载荷, 错误)；带蒙版的局部编辑方舟不支持，明确报错而不是静默丢弃语义。
func arkImageEditsToGenerations(payload []byte, contentType string) ([]byte, error) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		return nil, errors.New("图生图请求格式异常")
	}
	reader := multipart.NewReader(bytes.NewReader(payload), params["boundary"])

	fields := map[string]string{}
	images := []string{}
	// 参考图总字节上限：单 part 已被 LimitReader 限到 32MB，但多图(图生图常 6 张)会累加进内存再各自 base64(×1.33)，
	// 不设总量上限时单请求即可累计数百 MB 顶崩进程。80MB 原始字节足够覆盖正常图生图。
	const maxTotalRefBytes = 80 << 20
	totalImageBytes := 0
	for {
		part, perr := reader.NextPart()
		if perr == io.EOF {
			break
		}
		if perr != nil {
			return nil, errors.New("图生图请求解析失败")
		}
		name := part.FormName()
		data, rerr := io.ReadAll(io.LimitReader(part, 32<<20))
		_ = part.Close()
		if rerr != nil {
			return nil, errors.New("图生图请求读取失败")
		}
		switch name {
		case "image":
			// 0 字节参考图显式拒掉，不能当成一张正常图往上游发。
			// 前端有一条会稳定造出 0 字节 File 的路：web/src/lib/image-utils.ts 的 dataUrlToFile
			// 对非 data: 开头的地址（空串、asset:// 这类）取不到逗号后半段 → atob("") 不抛错、
			// 产出一个 0 字节 File。放过去就是把 "data:image/png;base64," 这样一张空图塞进 image 数组：
			// 好一点的情况是上游回一句看不懂的参数错误，坏的情况是这张图形同不存在，而前端稳定在
			// 提示词最前面写着「参考图片编号：图片1、图片2…」(web/src/lib/image-reference-prompt.ts)，
			// 编号与实际可用的图一对不上，模型就按错的图作画，全程没有任何报错 —— 比直接失败难查得多。
			if len(data) == 0 {
				return nil, errors.New("有参考图读取失败（内容为空），请重新上传后再生成")
			}
			totalImageBytes += len(data)
			if totalImageBytes > maxTotalRefBytes {
				return nil, errors.New("图生图参考图总大小超过上限（≤80MB）")
			}
			mimeType := part.Header.Get("Content-Type")
			if mimeType == "" {
				mimeType = "image/png"
			}
			images = append(images, "data:"+mimeType+";base64,"+base64.StdEncoding.EncodeToString(data))
		case "mask":
			return nil, errors.New("方舟 Seedream 渠道暂不支持蒙版局部编辑，请改用 gpt-image-2 等支持的模型")
		default:
			fields[name] = string(data)
		}
	}
	if len(images) == 0 {
		return nil, errors.New("图生图请求缺少参考图")
	}

	body := map[string]any{
		"model":  fields["model"],
		"prompt": fields["prompt"],
	}
	if len(images) == 1 {
		body["image"] = images[0]
	} else {
		body["image"] = images
	}
	if v := fields["size"]; v != "" {
		// Seedream 面积上限：图生图转 generations 时一并夹取，避免选 4K 直接被火山 400
		if isSeedreamModel(fields["model"]) {
			v = clampSeedreamSize(v)
		}
		body["size"] = v
	}
	if v := fields["response_format"]; v != "" {
		body["response_format"] = v
	}
	if v := fields["watermark"]; v != "" {
		body["watermark"] = v == "true"
	}
	if v := fields["n"]; v != "" {
		if n, nerr := strconv.Atoi(v); nerr == nil && n > 0 {
			body["n"] = n
		}
	}
	return json.Marshal(body)
}

// 与标准库 mime/multipart 一致，转义 Content-Disposition 里 filename 的特殊字符。
var multipartQuoteEscaper = strings.NewReplacer("\\", "\\\\", `"`, "\\\"")

// adaptRelayGptImageEditPayload 改写 gpt-image-2 图生图的 multipart 载荷：
// ① model 改写成 newModel（当前唯一调用点传的就是原模型 gpt-image-2，等同不改；
//
//	保留这个参数是因为它曾用于回退到 -pool 变体，日后若需恢复回退不必再动函数签名）；
//
// ② 按图片数量把图片字段名归一化为上游要求的 image[]（多图，OpenAI 新规数组字段）或 image（单图）。
// 兼容前端发来的 image 或 image[] 两种形式；其它渠道需重复 image，由前端默认发送、不走此改写。
// 返回 (新载荷, 新 Content-Type)；重新编码会换 boundary，故必须回传新 Content-Type。
func adaptRelayGptImageEditPayload(payload []byte, contentType, newModel string) ([]byte, string, error) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		return nil, "", errors.New("图生图请求格式异常")
	}
	type formPart struct {
		header   textproto.MIMEHeader
		name     string
		filename string
		data     []byte
	}
	reader := multipart.NewReader(bytes.NewReader(payload), params["boundary"])
	var parts []formPart
	imageCount := 0
	for {
		part, perr := reader.NextPart()
		if perr == io.EOF {
			break
		}
		if perr != nil {
			return nil, "", errors.New("图生图请求解析失败")
		}
		name := part.FormName()
		filename := part.FileName()
		data, rerr := io.ReadAll(io.LimitReader(part, 64<<20))
		_ = part.Close()
		if rerr != nil {
			return nil, "", errors.New("图生图请求读取失败")
		}
		if name == "image" || name == "image[]" {
			// 同 arkImageEditsToGenerations 里那段说明：0 字节参考图要当场报错，
			// 不能原样转发成一个空 part —— 它既不会被上游画出来，也不会让用户知道是哪张图出了问题。
			if len(data) == 0 {
				return nil, "", errors.New("有参考图读取失败（内容为空），请重新上传后再生成")
			}
			imageCount++
		}
		parts = append(parts, formPart{header: part.Header, name: name, filename: filename, data: data})
	}
	// 多图用 image[]，单图保持 image（与改写前的既有行为一致，避免单图回归）。
	imageField := "image"
	if imageCount > 1 {
		imageField = "image[]"
	}
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	for _, p := range parts {
		switch {
		case p.name == "model":
			w, cerr := writer.CreatePart(p.header)
			if cerr != nil {
				return nil, "", errors.New("图生图请求重写失败")
			}
			if _, werr := w.Write([]byte(newModel)); werr != nil {
				return nil, "", errors.New("图生图请求重写失败")
			}
		case p.name == "image" || p.name == "image[]":
			filename := p.filename
			if filename == "" {
				filename = "image.png"
			}
			h := textproto.MIMEHeader{}
			h.Set("Content-Disposition", `form-data; name="`+imageField+`"; filename="`+multipartQuoteEscaper.Replace(filename)+`"`)
			if ct := p.header.Get("Content-Type"); ct != "" {
				h.Set("Content-Type", ct)
			}
			w, cerr := writer.CreatePart(h)
			if cerr != nil {
				return nil, "", errors.New("图生图请求重写失败")
			}
			if _, werr := w.Write(p.data); werr != nil {
				return nil, "", errors.New("图生图请求重写失败")
			}
		default:
			w, cerr := writer.CreatePart(p.header)
			if cerr != nil {
				return nil, "", errors.New("图生图请求重写失败")
			}
			if _, werr := w.Write(p.data); werr != nil {
				return nil, "", errors.New("图生图请求重写失败")
			}
		}
	}
	if cerr := writer.Close(); cerr != nil {
		return nil, "", errors.New("图生图请求重写失败")
	}
	return buf.Bytes(), writer.FormDataContentType(), nil
}

// gptImageArrayFieldHostsEnv 环境变量名：哪些上游主机的多图编辑要求 image[] 数组字段。
// 值为逗号分隔的域名片段（大小写不敏感），例如：
//
//	GPT_IMAGE_ARRAY_FIELD_HOSTS=relay-a.example.com,relay-b.example.cn
const gptImageArrayFieldHostsEnv = "GPT_IMAGE_ARRAY_FIELD_HOSTS"

// gptImageArrayFieldHosts 读出「多图编辑要求 image[] 数组字段」的上游主机名片段白名单。
//
// 为什么要有白名单：各家 OpenAI 兼容中转站对多图图生图的图片字段要求是分裂的 ——
// 少数站要求 image[] 数组语法，发重复的 image 字段会被上游 400 顶回
// （Duplicate parameter: 'image'）；多数站（含 OpenAI 官方语义）正相反，必须收重复的 image。
// 两者无法自动探测，只能按站点开启。
//
// 默认留空 = 不对任何渠道做改写，保持重复 image 字段的官方语义。
// 接入的中转站一旦报 Duplicate parameter: 'image'，把它的域名片段填进环境变量
// GPT_IMAGE_ARRAY_FIELD_HOSTS（多个用英文逗号分隔）后重启容器即生效，无需改源码重编译。
func gptImageArrayFieldHosts() []string {
	raw := strings.TrimSpace(os.Getenv(gptImageArrayFieldHostsEnv))
	if raw == "" {
		return nil
	}
	hosts := make([]string, 0, 4)
	for _, fragment := range strings.Split(raw, ",") {
		if f := strings.ToLower(strings.TrimSpace(fragment)); f != "" {
			hosts = append(hosts, f)
		}
	}
	return hosts
}

// needsGptImageArrayField 该渠道的多图编辑是否要求 image[] 字段。
func needsGptImageArrayField(channel model.ModelChannel) bool {
	hosts := gptImageArrayFieldHosts()
	if len(hosts) == 0 {
		return false
	}
	parsed, err := url.Parse(strings.TrimSpace(channel.BaseURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	for _, fragment := range hosts {
		if strings.Contains(host, fragment) {
			return true
		}
	}
	return false
}

// isRelayGptImageEdit 判定任务是否需要把图片字段归一化成 image[]（多图）/ image（单图），
// 见 adaptGenerationJobForChannel。名字保留历史叫法（最早只有一家中转上游有这个要求），
// 实际判据已经是 needsGptImageArrayField 的白名单。
// 注：曾据此在失败时回退 gpt-image-2-pool，该回退已去掉（加强版可正常使用）。
func isRelayGptImageEdit(channel model.ModelChannel, job model.GenerationJob) bool {
	return job.Path == "/images/edits" &&
		needsGptImageArrayField(channel) &&
		strings.EqualFold(strings.TrimSpace(job.Model), "gpt-image-2")
}

// adaptGenerationJobForChannel 按渠道特性改写任务请求；返回 (载荷, 路径, Content-Type)。
func adaptGenerationJobForChannel(channel model.ModelChannel, job model.GenerationJob) ([]byte, string, string, error) {
	// Seedream 在任何 OpenAI 兼容渠道（火山方舟、各类中转站等）都没有 /images/edits 端点，图生图必须转写成 generations + image；
	// 不能只认火山域名，否则其它中转渠道的 Seedream 图生图（故事板垫图）会直接打 /edits 失败。
	if job.Path == "/images/edits" && (isArkChannelBaseURL(channel.BaseURL) || strings.Contains(strings.ToLower(job.Model), "seedream")) {
		converted, err := arkImageEditsToGenerations(job.Payload, job.ContentType)
		if err != nil {
			return nil, "", "", err
		}
		return converted, "/images/generations", "application/json", nil
	}
	// gpt-image-2 图生图：只做图片字段归一化（部分中转站的多图编辑要 image[]，
	// 另一些中转站则要重复 image、由前端默认发送、不走此改写），模型保持用户所选的 gpt-image-2。
	// 历史：曾在 400/5xx/超时时由 worker 回退 gpt-image-2-pool 重试一次——因为这类中转站的 /images/edits 编辑
	// 含人像的真实图时，加强版会 400「图像编辑失败」（人像审核），而 -pool 更宽松能过。
	// 该回退已去掉（加强版现已能正常处理这类输入）。
	// 若日后人像图又开始报「图像编辑失败」，这里就是恢复回退的落点。
	if isRelayGptImageEdit(channel, job) {
		converted, contentType, err := adaptRelayGptImageEditPayload(job.Payload, job.ContentType, "gpt-image-2")
		if err != nil {
			return nil, "", "", err
		}
		return converted, job.Path, contentType, nil
	}
	// Seedream 文生图（/images/generations，JSON）：size 由前端原样发，选 4K 会超面积上限被火山 400。
	// 这里对 seedream 的 JSON payload 做尺寸夹取（仅当解析成功且确有超限的 size 时才改写，否则原样透传）。
	if isSeedreamModel(job.Model) && strings.HasPrefix(job.ContentType, "application/json") {
		if clamped, changed := clampSeedreamJSONSize(job.Payload); changed {
			return clamped, job.Path, job.ContentType, nil
		}
	}
	return job.Payload, job.Path, job.ContentType, nil
}

// clampSeedreamJSONSize 对 JSON 生图请求体里的 size 做 Seedream 面积夹取。
// 仅在成功解析且 size 确实被改小时返回 changed=true；任何解析异常或无需改写都返回原体、changed=false（绝不因夹取失败而阻断生成）。
func clampSeedreamJSONSize(payload []byte) ([]byte, bool) {
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		return payload, false
	}
	size, ok := body["size"].(string)
	if !ok || size == "" {
		return payload, false
	}
	clamped := clampSeedreamSize(size)
	if clamped == size {
		return payload, false
	}
	body["size"] = clamped
	out, err := json.Marshal(body)
	if err != nil {
		return payload, false
	}
	return out, true
}
