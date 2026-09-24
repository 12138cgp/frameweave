package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// 滚动写错方向会静默删掉最新的日志（把 .1 覆盖成旧的），而日志正是用来事后追责的，
// 错了不会有任何人发现。这条锁住「留下的永远是最近 logFileKeep 份，且顺序不乱」。
func TestRotationKeepsNewestAndDropsOldest(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	r := &rotatingFile{path: path, maxBytes: 16}
	r.openLocked()
	if r.f == nil {
		t.Fatal("测试文件打不开")
	}
	// 每次写 10 字节、阈值 16 → 每写一次就滚一次，一共产生 8 代，只该留下最近 5 代。
	for i := 1; i <= 8; i++ {
		payload := "gen" + strconv.Itoa(i) + "______" // 3+1+6 = 10 字节
		if _, err := r.Write([]byte(payload)); err != nil {
			t.Fatalf("写第 %d 代失败: %v", i, err)
		}
	}

	// 当前文件应是最后一代。
	cur, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读当前文件失败: %v", err)
	}
	if !strings.Contains(string(cur), "gen8") {
		t.Fatalf("app.log 应含最新一代 gen8，实得 %q", string(cur))
	}
	// .1 是上一代，.2 是再上一代，依次往前。顺序反了就说明 rotate 的方向写反了。
	for i := 1; i <= logFileKeep-1; i++ {
		b, err := os.ReadFile(path + "." + strconv.Itoa(i))
		if err != nil {
			t.Fatalf("app.log.%d 应存在: %v", i, err)
		}
		want := "gen" + strconv.Itoa(8-i)
		if !strings.Contains(string(b), want) {
			t.Fatalf("app.log.%d 应含 %s，实得 %q", i, want, string(b))
		}
	}
	// 超出保留份数的必须已被丢弃，否则日志会无限占盘（data/ 还要被备份整个打包）。
	if _, err := os.Stat(path + "." + strconv.Itoa(logFileKeep)); !os.IsNotExist(err) {
		t.Fatalf("app.log.%d 不该存在（保留 %d 份），err=%v", logFileKeep, logFileKeep, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != logFileKeep {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("目录里应恰好 %d 个文件，实得 %d 个: %v", logFileKeep, len(entries), names)
	}
}

// 重启后必须【追加】而不是清空重来：清空的话每次发版都把当轮日志弄丢，
// 而发版前后那段恰恰是最需要看的。
func TestReopenAppendsInsteadOfTruncating(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	first := &rotatingFile{path: path}
	first.openLocked()
	_, _ = first.Write([]byte("上一次进程的日志\n"))
	_ = first.f.Close()

	second := &rotatingFile{path: path}
	second.openLocked()
	if second.size == 0 {
		t.Fatal("重开后 size 应是已有文件大小，否则会误判成空文件、滚动时机全错")
	}
	_, _ = second.Write([]byte("这次进程的日志\n"))

	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "上一次进程的日志") || !strings.Contains(string(b), "这次进程的日志") {
		t.Fatalf("重开应追加，实得 %q", string(b))
	}
}

// 日志系统自己绝不能成为故障源：文件打不开时 Write 必须假装成功，
// 否则 log.Printf 里的错误会顺着 io.MultiWriter 冒出来影响主流程。
func TestWriteNeverFailsWhenFileUnavailable(t *testing.T) {
	r := &rotatingFile{path: "/definitely/not/writable/app.log"}
	r.openLocked()
	if r.f != nil {
		t.Skip("这台机器居然能建这个路径，跳过")
	}
	n, err := r.Write([]byte("hello"))
	if err != nil || n != 5 {
		t.Fatalf("文件不可用时 Write 必须静默成功，实得 n=%d err=%v", n, err)
	}
}

// APP_LOG_FILE=off 要能整个关掉（本地跑测试、或磁盘紧张时的逃生开关）。
func TestSetupRespectsOffSwitch(t *testing.T) {
	t.Setenv("APP_LOG_FILE", "off")
	setupFileLogging() // 不 panic、不建目录即可
}
