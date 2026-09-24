package handler

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"

	"aicanvas/config"
)

// useTempDataDir 把 config.DataDir() 指到临时目录：DataDir 取的是 SQLite DSN 所在目录，
// 不设的话测试会往工作副本的 ./data 里写真文件（还会被 rsync 带上服务器）。
func useTempDataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := config.Cfg.DatabaseDSN
	oldDriver := config.Cfg.StorageDriver
	config.Cfg.DatabaseDSN = filepath.Join(dir, "test.db")
	config.Cfg.StorageDriver = "sqlite"
	t.Cleanup(func() {
		config.Cfg.DatabaseDSN = old
		config.Cfg.StorageDriver = oldDriver
	})
	return dir
}

// 上限提到 300MB 之后，multipart 的「内存驻留量」必须与「允许的最大体积」脱钩：
// 两者若还相等，一次 300MB 上传就是 300MB 常驻内存。这条锁死它们不再相等。
func TestSyncFileMemoryBudgetIsFarBelowMaxSize(t *testing.T) {
	// 与 handler/sync.go 的 syncFileMaxBytes、Next 代理的 PROXY_MAX_UPLOAD_MB、
	// 前端预检的 MAX_BYTES 保持同一个数（现为 300MB）。
	// 改上限时四处一起改，否则会出现「界面放行 → 代理或后端拒收」的半截失败。
	if syncFileMaxBytes != 300<<20 {
		t.Fatalf("上限被改动: %d（应与 sync.go/代理/前端预检一致，当前约定 300MB）", syncFileMaxBytes)
	}
	if syncFileMemoryBytes >= syncFileMaxBytes {
		t.Fatalf("内存预算 %d 不该 >= 体积上限 %d：超出部分必须落临时文件", syncFileMemoryBytes, syncFileMaxBytes)
	}
}

// TOS 上传失败时的落盘回退：必须流式写、字节数如实返回，且内容逐字节一致。
func TestWriteSyncFileStreamWritesAllBytes(t *testing.T) {
	dir := useTempDataDir(t)

	payload := bytes.Repeat([]byte("画布"), 40000) // ~240KB，含多字节字符
	path, written, err := writeSyncFileStream("user-stream-test", "video:streamtest", bytes.NewReader(payload))
	if err == nil && !filepath.HasPrefix(path, dir) {
		t.Fatalf("写到了临时目录之外: %s", path)
	}
	if err != nil {
		t.Fatalf("写盘失败: %v", err)
	}
	if written != int64(len(payload)) {
		t.Fatalf("返回字节数 %d != 实际 %d", written, len(payload))
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("回读失败: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("落盘内容与源不一致: %d vs %d 字节", len(got), len(payload))
	}
}

// 写失败（比如磁盘满/目标不可写）时不能留下半截文件——半截视频比没有更糟：
// 它会被当成一次成功的上传记进 sync_files，之后所有取用都拿到损坏文件。
func TestWriteSyncFileStreamRemovesPartialOnError(t *testing.T) {
	dir := useTempDataDir(t)

	_, _, err := writeSyncFileStream("user-stream-fail", "video:failtest", io.MultiReader(
		bytes.NewReader([]byte("前半段")),
		&failingReader{},
	))
	if err == nil {
		t.Fatalf("读源出错时必须返回错误")
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, "sync-files", "user-stream-fail", "*"))
	if len(leftovers) != 0 {
		t.Fatalf("失败后不应留下残留文件: %v", leftovers)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
