package main

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// 落盘日志。
//
// 为什么必须有：容器日志（docker logs）在容器【重建】时会随旧容器目录一起被删，
// 而本项目每次发版都是重建（docker compose up -d --build），不是 restart。
// 结果是「上一版到底发生过什么」永远查不到。
//
// 吃过的亏：一次排查「成片没送达用户」，后台放弃任务时只写了 docker 日志，
// 发版之后一条不剩，只能靠翻数据库反推。日志不落盘 = 故障不可追溯。
//
// 实现上刻意不引三方库（lumberjack 之类）：诉求只有「按大小切、留几份」，
// 为这点功能改 go.mod、拉新依赖，部署风险比下面这几十行代码大得多。
//
// 落点选 data/ 下面，因为 compose 只把 APP_DATA_DIR 挂到 /app/data 这一个卷，
// 写这里就能落到宿主机上，不用改 compose、不用动容器配置。
// ⚠️ 注意 data/ 整个目录都是备份对象，所以必须限制总体积（见下面的上限）。

const (
	logFileDefault  = "data/logs/app.log"
	logFileMaxBytes = 32 << 20 // 单份 32MB 就滚动
	logFileKeep     = 5        // 含当前这份最多留 5 份 → 最多占 160MB
)

// rotatingFile 按大小滚动的日志文件。app.log → app.log.1 → … → app.log.4，最老的丢弃。
// maxBytes 为 0 时取 logFileMaxBytes（留成字段是为了测试能用很小的阈值驱动滚动）。
type rotatingFile struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	f        *os.File
	size     int64
}

func (r *rotatingFile) limit() int64 {
	if r.maxBytes > 0 {
		return r.maxBytes
	}
	return logFileMaxBytes
}

func (r *rotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		// 打不开文件时假装写成功：日志写不了是小事，绝不能因此让调用方（整个服务）出错。
		return len(p), nil
	}
	if r.size > 0 && r.size+int64(len(p)) > r.limit() {
		r.rotateLocked()
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

func (r *rotatingFile) rotateLocked() {
	if r.f != nil {
		_ = r.f.Close()
		r.f = nil
	}
	// 最老的一份直接删，其余整体往后挪一位，然后当前文件变成 .1。
	_ = os.Remove(r.path + "." + strconv.Itoa(logFileKeep-1))
	for i := logFileKeep - 2; i >= 1; i-- {
		_ = os.Rename(r.path+"."+strconv.Itoa(i), r.path+"."+strconv.Itoa(i+1))
	}
	_ = os.Rename(r.path, r.path+".1")
	r.openLocked()
}

func (r *rotatingFile) openLocked() {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		r.f, r.size = nil, 0
		return
	}
	r.f = f
	r.size = 0
	if st, serr := f.Stat(); serr == nil {
		r.size = st.Size()
	}
}

// setupFileLogging 让所有 log.* 输出同时进容器日志和落盘文件。
//
// 必须在 main 里第一个调用：启动阶段的日志（bootStep 那些）恰恰是最需要留证的，
// 启动被某一步阻塞时表现为「端口不通、日志一片空白」，没有落盘日志就完全无从判断卡在哪。
//
// 用 APP_LOG_FILE 可以改路径；设成 off 可以整个关掉（本地跑测试时用）。
// 任何一步失败都只是退回「仅容器日志」，绝不 Fatal —— 日志系统自己绝不能成为故障源。
func setupFileLogging() {
	path := strings.TrimSpace(os.Getenv("APP_LOG_FILE"))
	if path == "" {
		path = logFileDefault
	}
	if strings.EqualFold(path, "off") {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		log.Printf("落盘日志不可用（建目录失败，仅写容器日志）: %v", err)
		return
	}
	r := &rotatingFile{path: path}
	r.openLocked()
	if r.f == nil {
		log.Printf("落盘日志不可用（打开文件失败，仅写容器日志）: %s", path)
		return
	}
	// 标准库默认写 os.Stderr，docker 同样会收；这里保持 Stderr 以免改变既有采集行为。
	log.SetOutput(io.MultiWriter(os.Stderr, r))
	log.Printf("落盘日志已启用: %s（单份上限 %dMB，最多保留 %d 份）", path, logFileMaxBytes>>20, logFileKeep)
}
