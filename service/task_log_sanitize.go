package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"strings"
)

const (
	maxTaskLogRequestBytes = 32768 // 单条请求体日志封顶(防暴涨;容纳完整提示词)
	maxTaskLogFieldBytes   = 512   // 单字符串字段超此长度视为大数据(多为 base64 图),剥成占位符
)

// SanitizeAIRequestBody 把请求体压成可读摘要用于任务日志:保留 prompt/model/size/n/seconds/resolution 等短字段,
// base64 参考图/掩码/首帧图剥成 "[stripped NB]" 占位;multipart(图生图 edits)解析出文本字段、文件字段只记大小;整体封顶。
// 纯只读、不改真实请求体、不参与任何转发/扣费。handler(视频 proxy)与 service(图片 job)共用。
func SanitizeAIRequestBody(body []byte, contentType string) string {
	if strings.HasPrefix(contentType, "multipart/form-data") {
		return sanitizeMultipartTaskLog(body, contentType)
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return truncateTaskLog(string(body))
	}
	out, err := json.Marshal(sanitizeTaskLogValue(v))
	if err != nil {
		return truncateTaskLog(string(body))
	}
	return truncateTaskLog(string(out))
}

// sanitizeMultipartTaskLog 解析 multipart/form-data(图生图 edits):文本字段(model/prompt/size/n/quality...)保留,
// 文件字段(参考图 image)只记文件名+字节数,拼成可读 JSON 摘要。解析失败退回大小占位。
func sanitizeMultipartTaskLog(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["boundary"] == "" {
		return fmt.Sprintf("[multipart %d bytes]", len(body))
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	fields := map[string]any{}
	images := []string{}
	for {
		part, perr := reader.NextPart()
		if perr != nil {
			break
		}
		name := part.FormName()
		filename := part.FileName()
		if filename != "" {
			// 文件字段(参考图 image):不读内容,只数字节数
			total, _ := io.Copy(io.Discard, part)
			part.Close()
			images = append(images, fmt.Sprintf("%s(%dB)", filename, total))
			continue
		}
		// 文本字段(model/prompt/size/n/quality...):读到整体上限,用 isStripworthyBlob 区分 base64(剥占位)与自然语言 prompt(保留全文),与 JSON 路径一致。
		data, _ := io.ReadAll(io.LimitReader(part, maxTaskLogRequestBytes+1))
		part.Close()
		fields[name] = sanitizeTaskLogValue(string(data))
	}
	if len(images) > 0 {
		fields["_images"] = images
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return fmt.Sprintf("[multipart %d bytes]", len(body))
	}
	return truncateTaskLog(string(out))
}

// isStripworthyBlob 判断字符串字段是否为需剥离的大二进制(base64 参考图/掩码/首帧图):
// data: URL 一律剥;超长且「纯 base64 字符集、无空白、无非 ASCII」才剥。自然语言提示词(含空格/换行/中文)一律保留。
func isStripworthyBlob(s string) bool {
	if strings.HasPrefix(s, "data:") {
		return true
	}
	if len(s) <= maxTaskLogFieldBytes {
		return false
	}
	limit := len(s)
	if limit > 512 {
		limit = 512
	}
	for i := 0; i < limit; i++ {
		c := s[i]
		if c == ' ' || c == '\n' || c == '\r' || c == '\t' {
			return false
		}
		if c > 127 {
			return false
		}
		isB64 := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '=' || c == '-' || c == '_'
		if !isB64 {
			return false
		}
	}
	return true
}

func sanitizeTaskLogValue(v any) any {
	switch t := v.(type) {
	case string:
		if isStripworthyBlob(t) {
			return fmt.Sprintf("[stripped %dB]", len(t))
		}
		return t
	case []any:
		for i, item := range t {
			t[i] = sanitizeTaskLogValue(item)
		}
		return t
	case map[string]any:
		for k, item := range t {
			t[k] = sanitizeTaskLogValue(item)
		}
		return t
	default:
		return v
	}
}

func truncateTaskLog(s string) string {
	if len(s) <= maxTaskLogRequestBytes {
		return s
	}
	return strings.ToValidUTF8(s[:maxTaskLogRequestBytes], "") + "...[truncated]"
}
