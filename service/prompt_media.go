package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"aicanvas/config"
	"aicanvas/model"
)

// GitHub raw 资源在国内（含本服务器）可能不可直连，按序尝试镜像。
// 前缀代理域名会失效轮换，可用 GH_MIRRORS 环境变量覆盖（逗号分隔前缀，如 https://gh-proxy.com）。
var defaultGhProxyPrefixes = []string{"https://gh-proxy.com", "https://ghfast.top"}

const (
	promptCoverURLPrefix   = "/api/media/prompt-covers/"
	promptCoverMaxBytes    = 20 << 20
	promptTextMaxBytes     = 8 << 20
	promptCoverConcurrency = 6
)

var (
	promptFetchClient = &http.Client{Timeout: 45 * time.Second}
	// 记住最近成功的镜像种类（direct/jsdelivr-cdn/…），优先重试，避免直连不通时每个文件都先空耗超时。
	// 按「种类」而非候选下标记忆：不同 URL 形态的候选数组长度不同，下标语义不稳定。
	lastGoodMirrorKind atomic.Value
	rawGithubRe        = regexp.MustCompile(`^https://raw\.githubusercontent\.com/([^/]+)/([^/]+)/([^/]+)/(.+)$`)
)

type mirrorCandidate struct {
	kind string
	url  string
}

func ghProxyPrefixes() []string {
	if env := strings.TrimSpace(os.Getenv("GH_MIRRORS")); env != "" {
		prefixes := []string{}
		for _, p := range strings.Split(env, ",") {
			if p = strings.TrimRight(strings.TrimSpace(p), "/"); p != "" {
				prefixes = append(prefixes, p)
			}
		}
		if len(prefixes) > 0 {
			return prefixes
		}
	}
	return defaultGhProxyPrefixes
}

func isGithubHostedURL(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "github.com" || host == "githubusercontent.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

// mirrorCandidates 给出一个 URL 的全部抓取候选：直连 → jsDelivr（仅 raw.githubusercontent）→ 前缀代理（GitHub 系域名通用）。
// 非 GitHub 域名只有直连一个候选。
func mirrorCandidates(rawURL string) []mirrorCandidate {
	candidates := []mirrorCandidate{{kind: "direct", url: rawURL}}
	if match := rawGithubRe.FindStringSubmatch(rawURL); match != nil {
		owner, repo, branch, path := match[1], match[2], match[3], match[4]
		candidates = append(candidates,
			mirrorCandidate{kind: "jsdelivr-cdn", url: "https://cdn.jsdelivr.net/gh/" + owner + "/" + repo + "@" + branch + "/" + path},
			mirrorCandidate{kind: "jsdelivr-fastly", url: "https://fastly.jsdelivr.net/gh/" + owner + "/" + repo + "@" + branch + "/" + path},
		)
	}
	if isGithubHostedURL(rawURL) {
		for _, prefix := range ghProxyPrefixes() {
			candidates = append(candidates, mirrorCandidate{kind: prefix, url: prefix + "/" + rawURL})
		}
	}
	return candidates
}

// fetchWithMirrors 依次尝试候选源，返回首个「状态码与内容都通过校验」的响应体。
// validate 不可为 nil：第三方前缀代理的典型故障是返回 200 的 HTML 拦截页，必须靠内容校验拦下，
// 否则垃圾内容会污染落盘文件甚至导致分类被空结果清空。
func fetchWithMirrors(rawURL string, maxBytes int64, validate func([]byte) error) ([]byte, error) {
	candidates := mirrorCandidates(rawURL)
	preferred, _ := lastGoodMirrorKind.Load().(string)
	order := make([]int, 0, len(candidates))
	for i, c := range candidates {
		if c.kind == preferred {
			order = append(order, i)
		}
	}
	for i, c := range candidates {
		if c.kind != preferred {
			order = append(order, i)
		}
	}
	var lastErr error
	for _, idx := range order {
		data, err := fetchOnce(candidates[idx].url, maxBytes)
		if err == nil {
			err = validate(data)
		}
		if err == nil {
			lastGoodMirrorKind.Store(candidates[idx].kind)
			return data, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("无可用下载源")
	}
	return nil, lastErr
}

func fetchOnce(target string, maxBytes int64) ([]byte, error) {
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	response, err := promptFetchClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, errors.New(target + " 返回 " + response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errors.New(target + " 超过大小上限")
	}
	return data, nil
}

// validatePromptText 拦截前缀代理的 HTML 拦截页/停放页（拉回来的只会是 markdown 或 JSON）。
func validatePromptText(data []byte) error {
	head := strings.ToLower(strings.TrimSpace(string(data[:min(len(data), 512)])))
	if head == "" {
		return errors.New("空响应")
	}
	if strings.HasPrefix(head, "<!doctype") || strings.HasPrefix(head, "<html") || strings.HasPrefix(head, "<head") {
		return errors.New("响应疑似 HTML 拦截页")
	}
	return nil
}

func validatePromptImage(data []byte) error {
	if len(data) == 0 {
		return errors.New("空响应")
	}
	if !strings.HasPrefix(http.DetectContentType(data), "image/") {
		return errors.New("响应不是图片")
	}
	return nil
}

func promptCoversDir() string {
	return filepath.Join(config.DataDir(), "prompt-covers")
}

// localizePromptCovers 把条目封面下载到本地并改写为本站相对路径；单图失败保留原 URL 降级。
// 文件名 = 源 URL 的 sha256 前 24 位 + 扩展名，幂等：已存在即跳过下载。
func localizePromptCovers(items []model.Prompt) {
	dir := promptCoversDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("prompt covers mkdir failed dir=%s err=%v", dir, err)
		return
	}
	cleanupPromptCoverTemps(dir)
	var wg sync.WaitGroup
	sem := make(chan struct{}, promptCoverConcurrency)
	var okCount, failCount, skipCount atomic.Int32
	for i := range items {
		cover := strings.TrimSpace(items[i].CoverURL)
		if cover == "" || !strings.HasPrefix(cover, "http") {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(item *model.Prompt, cover string) {
			defer wg.Done()
			defer func() { <-sem }()
			defer func() {
				if r := recover(); r != nil {
					log.Printf("prompt cover download panic recovered: %v", r)
				}
			}()
			local, downloaded, err := ensureLocalPromptCover(dir, cover)
			if err != nil {
				failCount.Add(1)
				return
			}
			if downloaded {
				okCount.Add(1)
			} else {
				skipCount.Add(1)
			}
			item.CoverURL = local
		}(&items[i], cover)
	}
	wg.Wait()
	if okCount.Load() > 0 || failCount.Load() > 0 {
		log.Printf("prompt covers localized downloaded=%d cached=%d failed=%d", okCount.Load(), skipCount.Load(), failCount.Load())
	}
}

// 进程崩溃可能遗留 .tmp，公开路由不放行 .tmp 扩展，但仍按轮清扫防累积。
func cleanupPromptCoverTemps(dir string) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.tmp"))
	if err != nil {
		return
	}
	for _, path := range matches {
		_ = os.Remove(path)
	}
}

// ensureLocalPromptCover 返回 (本站相对 URL, 是否新下载, error)。
func ensureLocalPromptCover(dir, cover string) (string, bool, error) {
	hash := promptCoverHash(cover)
	if name := findExistingPromptCover(dir, hash); name != "" {
		return promptCoverURLPrefix + name, false, nil
	}
	data, err := fetchWithMirrors(cover, promptCoverMaxBytes, validatePromptImage)
	if err != nil {
		return "", false, err
	}
	name := hash + promptCoverExt(cover, data)
	path := filepath.Join(dir, name)
	// 同一 URL 可能被多条目并发下载：用唯一临时名 + 原子 rename，后到者覆盖完整文件而非撕裂写
	tmp, err := os.CreateTemp(dir, hash+"-*.tmp")
	if err != nil {
		return "", false, err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return "", false, err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return "", false, err
	}
	_ = os.Chmod(tmpName, 0o644)
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return "", false, err
	}
	return promptCoverURLPrefix + name, true, nil
}

var promptCoverKnownExts = []string{".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}

func findExistingPromptCover(dir, hash string) string {
	for _, ext := range promptCoverKnownExts {
		if _, err := os.Stat(filepath.Join(dir, hash+ext)); err == nil {
			return hash + ext
		}
	}
	return ""
}

func promptCoverHash(cover string) string {
	sum := sha256.Sum256([]byte(cover))
	return hex.EncodeToString(sum[:])[:24]
}

// promptCoverExt 以内容嗅探为准（已通过 image/* 校验），URL 后缀仅作回退。
func promptCoverExt(cover string, data []byte) string {
	if ext := promptCoverExtFromMime(http.DetectContentType(data)); ext != "" {
		return ext
	}
	if parsed, err := url.Parse(cover); err == nil {
		switch ext := strings.ToLower(filepath.Ext(parsed.Path)); ext {
		case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif":
			return ext
		}
	}
	return ".jpg"
}

func promptCoverExtFromMime(mime string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0])) {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "image/bmp":
		return ".bmp"
	case "image/avif":
		return ".avif"
	default:
		return ""
	}
}
