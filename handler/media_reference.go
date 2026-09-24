package handler

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"aicanvas/config"
	"aicanvas/service"
	"github.com/google/uuid"
)

const (
	referenceMediaMaxBytes    = 80 << 20
	referenceImageMaxBytes    = 30 << 20
	referenceVideoMaxBytes    = 50 << 20
	referenceAudioMaxBytes    = 15 << 20
	referenceImageAllowedText = "jpeg/png/webp/bmp/gif/heic/heif 图片"
	referenceVideoAllowedText = "mp4/mov 视频"
	referenceAudioAllowedText = "mp3/wav 音频"
	referenceMediaAllowedText = referenceImageAllowedText + "、" + referenceVideoAllowedText + "或" + referenceAudioAllowedText
)

type referenceMediaUploadResult struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	MimeType string `json:"mimeType"`
	Bytes    int64  `json:"bytes"`
}

func UploadReferenceMedia(w http.ResponseWriter, r *http.Request) {
	// 登录用户按其分组桶配置判定/上传；匿名(shared)走全局桶。
	user, hasUser := service.UserFromContext(r.Context())
	tosConfigured := service.TOSEnabled()
	if hasUser {
		tosConfigured = service.TOSConfiguredForUser(user.ID)
	}
	publicBaseURL := strings.TrimRight(strings.TrimSpace(config.Cfg.PublicBaseURL), "/")
	if !tosConfigured && publicBaseURL == "" {
		Fail(w, "未配置对象存储或 PUBLIC_BASE_URL，无法把本地参考素材提供给火山方舟访问")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, referenceMediaMaxBytes+1)
	if err := r.ParseMultipartForm(referenceMediaMaxBytes); err != nil {
		Fail(w, "参考素材过大或上传格式不正确")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请上传参考图片或视频")
		return
	}
	defer file.Close()

	mimeType, ext, ok := normalizeReferenceMediaType(header.Header.Get("Content-Type"), filepath.Ext(header.Filename))
	if !ok {
		Fail(w, "参考素材格式不支持，请使用 "+referenceMediaAllowedText)
		return
	}
	// 读入内存做大小校验（参考素材上限 80MB，按类型还有更小限额）
	data, rerr := io.ReadAll(file)
	if rerr != nil {
		Fail(w, "参考素材读取失败")
		return
	}
	bytes := int64(len(data))
	if bytes <= 0 {
		Fail(w, "参考素材为空")
		return
	}
	if limit := referenceMediaTypeMaxBytes(mimeType); limit > 0 && bytes > limit {
		Fail(w, referenceMediaSizeMessage(mimeType))
		return
	}
	id := uuid.NewString() + ext

	// 优先对象存储：火山从公网抓参考图，不占本机公网带宽、不落盘（治根「image_url timeout」）。
	// 登录用户走其分组桶(UploadToTOSForUser)，匿名走全局桶。
	if tosConfigured {
		var url string
		var terr error
		if hasUser {
			url, terr = service.UploadToTOSForUser(user.ID, "media/"+user.ID+"/reference/"+id, data, mimeType)
		} else {
			url, terr = service.UploadToTOS("media/shared/reference/"+id, data, mimeType)
		}
		if terr == nil {
			OK(w, referenceMediaUploadResult{ID: id, URL: url, MimeType: mimeType, Bytes: bytes})
			return
		}
		if publicBaseURL == "" {
			Fail(w, "参考素材上传失败（对象存储不可用且未配置 PUBLIC_BASE_URL）")
			return
		}
		// 对象存储失败但有 PUBLIC_BASE_URL：落回磁盘
	}

	if err := os.MkdirAll(referenceMediaDir(), 0o755); err != nil {
		Fail(w, "参考素材保存失败")
		return
	}
	if err := os.WriteFile(filepath.Join(referenceMediaDir(), id), data, 0o644); err != nil {
		Fail(w, "参考素材保存失败")
		return
	}
	OK(w, referenceMediaUploadResult{
		ID:       id,
		URL:      fmt.Sprintf("%s/api/media/references/%s", publicBaseURL, id),
		MimeType: mimeType,
		Bytes:    bytes,
	})
}

func ReferenceMedia(w http.ResponseWriter, r *http.Request, id string) {
	if id == "" || id != filepath.Base(id) || strings.Contains(id, "..") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(referenceMediaDir(), id)
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	if mimeType := mimeTypeByReferenceMediaExt(filepath.Ext(id)); mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeContent(w, r, id, info.ModTime(), file)
}

func referenceMediaDir() string {
	return filepath.Join(referenceDataDir(), "reference-media")
}

func referenceDataDir() string {
	return config.DataDir()
}

func normalizeReferenceMediaType(contentType string, ext string) (string, string, bool) {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	ext = strings.ToLower(strings.TrimSpace(ext))
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = mimeTypeByReferenceMediaExt(ext)
	}
	if fixedExt := referenceMediaExtByMimeType(contentType); fixedExt != "" {
		return contentType, fixedExt, true
	}
	if mimeType := mimeTypeByReferenceMediaExt(ext); mimeType != "" {
		return mimeType, ext, true
	}
	return "", "", false
}

func referenceMediaExtByMimeType(mimeType string) string {
	switch strings.ToLower(mimeType) {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	case "image/gif":
		return ".gif"
	case "image/heic":
		return ".heic"
	case "image/heif":
		return ".heif"
	case "video/mp4":
		return ".mp4"
	case "video/quicktime", "video/mov":
		return ".mov"
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/wav", "audio/x-wav", "audio/wave":
		return ".wav"
	default:
		return ""
	}
}

func mimeTypeByReferenceMediaExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".gif":
		return "image/gif"
	case ".avif":
		return "image/avif"
	case ".heic":
		return "image/heic"
	case ".heif":
		return "image/heif"
	case ".mp4":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	default:
		return ""
	}
}

func referenceMediaTypeMaxBytes(mimeType string) int64 {
	if strings.HasPrefix(mimeType, "image/") {
		return referenceImageMaxBytes
	}
	if strings.HasPrefix(mimeType, "video/") {
		return referenceVideoMaxBytes
	}
	if strings.HasPrefix(mimeType, "audio/") {
		return referenceAudioMaxBytes
	}
	return referenceMediaMaxBytes
}

func referenceMediaSizeMessage(mimeType string) string {
	if strings.HasPrefix(mimeType, "image/") {
		return "参考图片超过大小限制，请使用 30MB 以内的图片"
	}
	if strings.HasPrefix(mimeType, "video/") {
		return "参考视频超过大小限制，请使用 50MB 以内的 mp4/mov 视频"
	}
	if strings.HasPrefix(mimeType, "audio/") {
		return "参考音频超过大小限制，请使用 15MB 以内的 mp3/wav 音频"
	}
	return "参考素材超过大小限制"
}
