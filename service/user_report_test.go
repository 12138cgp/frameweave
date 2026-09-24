package service

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// 日志超限时必须丢【最旧】的、保住【最近】的。
//
// 这个方向极易写反，而且写反了只在「日志特别多」——也就是真出大事——的时候才触发，
// 平时怎么点都测不出来：等发现时，恰恰是最关键的那几分钟被扔掉了。
func TestPackActionLogKeepsNewestWhenTruncated(t *testing.T) {
	// 上限压到 8KB 来测：用真实的 1MB 得先造好几 MB 不可压缩的数据，慢且脆，
	// 而「丢哪一头」这个逻辑跟上限具体是多少无关。
	const total = 4000
	const limit = 8 << 10
	entries := make([]json.RawMessage, 0, total)
	for i := 0; i < total; i++ {
		entries = append(entries, json.RawMessage(fmt.Sprintf(
			`{"t":%d,"s":%d,"e":"evt_%d","d":{"pad":"%s"}}`,
			1754500000000+int64(i), i, i, strings.Repeat(fmt.Sprintf("%x", i*2654435761), 6))))
	}

	gz, count, rawBytes, truncated, err := packActionLogWithLimit(entries, limit)
	if err != nil {
		t.Fatalf("打包失败: %v", err)
	}
	if !truncated {
		t.Fatalf("这批日志应该超限被截断，实际没有（压缩后 %d 字节）", len(gz))
	}
	if len(gz) > limit {
		t.Fatalf("截断后仍超过上限: %d > %d", len(gz), limit)
	}
	if rawBytes <= 0 {
		t.Fatalf("原始体积应记录下来，实得 %d", rawBytes)
	}

	kept, err := UnpackUserReportLog(gz)
	if err != nil {
		t.Fatalf("解包失败: %v", err)
	}
	if len(kept) != count {
		t.Fatalf("条数对不上: 声称 %d，实际解出 %d", count, len(kept))
	}

	// 关键断言：保留的必须是【末尾】那一段
	var last struct {
		E string `json:"e"`
	}
	if err := json.Unmarshal(kept[len(kept)-1], &last); err != nil {
		t.Fatalf("解析末条失败: %v", err)
	}
	if want := fmt.Sprintf("evt_%d", total-1); last.E != want {
		t.Fatalf("截断后最后一条应是最新的 %s，实得 %s —— 丢错了方向，把最近发生的扔了", want, last.E)
	}

	var first struct {
		E string `json:"e"`
	}
	if err := json.Unmarshal(kept[0], &first); err != nil {
		t.Fatalf("解析首条失败: %v", err)
	}
	if first.E == "evt_0" {
		t.Fatal("首条还是 evt_0，说明丢的是新的那头（应该丢最旧的）")
	}
}

// 不超限时原样保留，不能无谓截断。
func TestPackActionLogKeepsAllWhenSmall(t *testing.T) {
	entries := []json.RawMessage{
		json.RawMessage(`{"t":1,"s":1,"e":"app_start"}`),
		json.RawMessage(`{"t":2,"s":2,"e":"sync_started"}`),
		json.RawMessage(`{"t":3,"s":3,"e":"sync_succeeded"}`),
	}
	gz, count, _, truncated, err := packActionLog(entries)
	if err != nil {
		t.Fatalf("打包失败: %v", err)
	}
	if truncated || count != 3 {
		t.Fatalf("小日志不该截断: truncated=%v count=%d", truncated, count)
	}
	kept, err := UnpackUserReportLog(gz)
	if err != nil || len(kept) != 3 {
		t.Fatalf("解包应得 3 条，实得 %d, err=%v", len(kept), err)
	}
}

// 空日志不能炸：用户可能刚进来什么都没干就来提反馈。
func TestPackActionLogEmpty(t *testing.T) {
	gz, count, raw, truncated, err := packActionLog(nil)
	if err != nil || gz != nil || count != 0 || raw != 0 || truncated {
		t.Fatalf("空日志应安静返回空，实得 gz=%v count=%d raw=%d truncated=%v err=%v", gz, count, raw, truncated, err)
	}
	entries, err := UnpackUserReportLog(nil)
	if err != nil || entries != nil {
		t.Fatalf("解空包应返回 nil,nil，实得 %v, %v", entries, err)
	}
}
