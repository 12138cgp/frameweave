package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"aicanvas/config"
)

// PromptCover 公开服务本地化的提示词封面（哈希命名，内容不可变，给长缓存）。
func PromptCover(w http.ResponseWriter, r *http.Request, id string) {
	if id == "" || id != filepath.Base(id) || strings.Contains(id, "..") {
		http.NotFound(w, r)
		return
	}
	// 只放行图片扩展名，杜绝 .tmp 等中间文件被公开读取
	switch strings.ToLower(filepath.Ext(id)) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif":
	default:
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(config.DataDir(), "prompt-covers", id)
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
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, id, info.ModTime(), file)
}
