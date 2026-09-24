package service

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// 火山 TOS / S3 兼容对象存储：用 AWS SigV4(service=s3)向 S3 兼容端点 PUT 对象。
// 桶为「公共读」，上传后返回 PublicBase + key 的稳定公网 URL。
// 选手写 SigV4(仅标准库)而非引入 SDK：本机无 Go,改 go.mod/go.sum 风险大。
//
// 配置来源分两层(见 tos_config.go)：全局 config.Cfg.TOS*（兜底/匿名）+ 每用户组自有桶（组优先）。
// 本文件的核心 uploadToTOSWithConfig / fetchAndUploadWithConfig 只认传入的 cfg，不直接读全局，
// 以便调用方按「当前用户所属组」解析出该组桶配置后再上传。

// tosCacheControl 写入对象时附带的缓存头：对象 key 均含随机哈希/uuid、内容一经写入不再变，
// 故可让浏览器/CDN 永久缓存（immutable=不再回源校验）。治「同一张图/视频每次进画布都重下」的
// 重复下行流量（存量对象需在 TOS 控制台另配桶级默认响应头）。
const tosCacheControl = "public, max-age=31536000, immutable"

// TOSEnabled 返回「全局」对象存储是否配置齐全（匿名/兜底路径用）。
// 判断某登录用户是否可用对象存储请用 TOSConfiguredForUser（会考虑其分组自有桶）。
func TOSEnabled() bool {
	return globalTOSConfig().complete()
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// UploadToTOS 用「全局」配置把 data 以 PUT 写到 key，返回公网 URL（匿名/兜底路径）。
func UploadToTOS(key string, data []byte, contentType string) (string, error) {
	return uploadToTOSWithConfig(globalTOSConfig(), key, data, contentType)
}

// uploadToTOSWithConfig 用指定 cfg 把 data 以 PUT 写到 key(虚拟主机风格:host = bucket.endpoint),返回公网 URL。
func uploadToTOSWithConfig(cfg tosStorageConfig, key string, data []byte, contentType string) (string, error) {
	if !cfg.complete() {
		return "", errTOSNotConfigured
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	key = strings.TrimPrefix(key, "/")
	host := cfg.Bucket + "." + cfg.Endpoint
	endpoint := "https://" + host + "/" + key

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	region := cfg.Region
	if region == "" {
		region = "cn-beijing"
	}
	const svc = "s3"
	payloadHash := sha256Hex(data)

	// 规范请求(key 仅由安全字符构成，canonicalURI 直接用 /key)
	canonicalURI := "/" + key
	canonicalHeaders := fmt.Sprintf("content-type:%s\nhost:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", contentType, host, payloadHash, amzDate)
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := strings.Join([]string{"PUT", canonicalURI, "", canonicalHeaders, signedHeaders, payloadHash}, "\n")

	// 待签字符串
	scope := dateStamp + "/" + region + "/" + svc + "/aws4_request"
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex([]byte(canonicalRequest))}, "\n")

	// 派生签名密钥
	kDate := hmacSHA256([]byte("AWS4"+cfg.SecretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(svc))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))
	authorization := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", cfg.AccessKey, scope, signedHeaders, signature)

	req, err := http.NewRequest(http.MethodPut, endpoint, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	req.Header.Set("Authorization", authorization)
	// Cache-Control 作为对象元数据存下（不进 SigV4 签名，已实测 TOS 会保存并在 GET 时返回）。
	req.Header.Set("Cache-Control", tosCacheControl)
	req.ContentLength = int64(len(data))

	resp, err := (&http.Client{Timeout: 150 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		// 注意：不记录 AK/SK/Authorization 签名头，仅返回桶侧状态码与响应体。
		return "", fmt.Errorf("对象存储上传失败: %d %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return strings.TrimRight(cfg.PublicBase, "/") + "/" + key, nil
}

// uploadStreamToTOSWithConfig 与 uploadToTOSWithConfig 等价，但从 io.ReadSeeker 读、不把整个文件读进内存。
//
// 为什么需要单独一份：SigV4 要在签名里带 payload 的 sha256，所以必须先把内容过一遍哈希。
// 传 []byte 的那份是「整个文件驻留内存」——500MB 的视频就是 500MB 常驻，再加上 Next 代理侧
// 缓冲的那一份，一次上传能顶掉 1GB 以上。这里改成：先流式过一遍哈希、Seek 回开头、再把同一个
// ReadSeeker 当请求体发出去。上传大文件时内容只在磁盘临时文件里（multipart 溢出落盘），
// 内存占用与文件大小无关。
//
// 超时也必须另算：原来那份写死 150 秒，500MB 走公网 150 秒根本传不完（约需 2.7MB/s 以上）。
// 这里按大小估算，最少 5 分钟、每 10MB 加 1 秒、最多 30 分钟。
func uploadStreamToTOSWithConfig(cfg tosStorageConfig, key string, body io.ReadSeeker, size int64, contentType string) (string, error) {
	if !cfg.complete() {
		return "", errTOSNotConfigured
	}
	if size < 0 {
		return "", fmt.Errorf("对象存储上传失败: 未知的文件大小")
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	key = strings.TrimPrefix(key, "/")
	host := cfg.Bucket + "." + cfg.Endpoint
	endpoint := "https://" + host + "/" + key

	if _, err := body.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, body); err != nil {
		return "", err
	}
	payloadHash := hex.EncodeToString(hasher.Sum(nil))
	if _, err := body.Seek(0, io.SeekStart); err != nil {
		return "", err
	}

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	region := cfg.Region
	if region == "" {
		region = "cn-beijing"
	}
	const svc = "s3"
	canonicalURI := "/" + key
	canonicalHeaders := fmt.Sprintf("content-type:%s\nhost:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", contentType, host, payloadHash, amzDate)
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := strings.Join([]string{"PUT", canonicalURI, "", canonicalHeaders, signedHeaders, payloadHash}, "\n")
	scope := dateStamp + "/" + region + "/" + svc + "/aws4_request"
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex([]byte(canonicalRequest))}, "\n")
	kDate := hmacSHA256([]byte("AWS4"+cfg.SecretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(svc))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))
	authorization := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", cfg.AccessKey, scope, signedHeaders, signature)

	req, err := http.NewRequest(http.MethodPut, endpoint, body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	req.Header.Set("Authorization", authorization)
	req.Header.Set("Cache-Control", tosCacheControl)
	req.ContentLength = size

	resp, err := (&http.Client{Timeout: tosUploadTimeoutFor(size)}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusMultipleChoices {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("对象存储上传失败: %d %s", resp.StatusCode, strings.TrimSpace(string(errBody)))
	}
	return strings.TrimRight(cfg.PublicBase, "/") + "/" + key, nil
}

// tosUploadTimeoutFor 按文件大小给整体超时：下限 5 分钟，每 10MB 追加 1 秒，上限 30 分钟。
func tosUploadTimeoutFor(size int64) time.Duration {
	timeout := 5*time.Minute + time.Duration(size/(10<<20))*time.Second
	if timeout > 30*time.Minute {
		return 30 * time.Minute
	}
	return timeout
}

// UploadedMedia 一次「服务端下载 + 转存」的结果。
// 多这个结构体是因为调用方要给 sync_files 登记 Bytes / MimeType，而这两项只有下载那一刻知道；
// 原来只返回 URL，登记就只能填 0 和空串，而 bytes 是同步链路判「要不要重传」的依据之一。
type UploadedMedia struct {
	URL         string
	Bytes       int64
	ContentType string
}

// fetchAndUploadWithConfig 用指定 cfg：服务端下载 srcURL 再转存（走服务器/内网带宽）。
// 用 SafeHTTPClient：禁止下载内网/本地地址（防 SSRF），并校验重定向目标。
// maxBytes 为单文件字节上限（≤0 时回退默认 256MB）：① 先按 Content-Length 预检、② 读取时多读 1 字节
// 探测溢出并直接报错——绝不静默截断（截断会上传半截损坏文件），同时避免登录用户用超大文件把进程顶到 OOM。
func fetchAndUploadWithConfig(cfg tosStorageConfig, srcURL, key, contentType string, maxBytes int64) (UploadedMedia, error) {
	if !cfg.complete() {
		return UploadedMedia{}, errTOSNotConfigured
	}
	if maxBytes <= 0 {
		maxBytes = 256 << 20
	}
	resp, err := SafeHTTPClient(180 * time.Second).Get(srcURL)
	if err != nil {
		return UploadedMedia{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusMultipleChoices {
		return UploadedMedia{}, fmt.Errorf("下载源媒体失败: %d", resp.StatusCode)
	}
	if resp.ContentLength > maxBytes {
		return UploadedMedia{}, fmt.Errorf("源媒体超过大小上限（%d > %d 字节）", resp.ContentLength, maxBytes)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return UploadedMedia{}, err
	}
	if int64(len(data)) > maxBytes {
		return UploadedMedia{}, fmt.Errorf("源媒体超过大小上限（%d 字节）", maxBytes)
	}
	if contentType == "" {
		contentType = resp.Header.Get("Content-Type")
	}
	url, uerr := uploadToTOSWithConfig(cfg, key, data, contentType)
	if uerr != nil {
		return UploadedMedia{}, uerr
	}
	return UploadedMedia{URL: url, Bytes: int64(len(data)), ContentType: contentType}, nil
}
