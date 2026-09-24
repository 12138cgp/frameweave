package service

import (
	"strings"
	"testing"

	"aicanvas/repository"
)

func probes(bytes ...int) []repository.SnapshotProbe {
	out := make([]repository.SnapshotProbe, 0, len(bytes))
	for i, b := range bytes {
		out = append(out, repository.SnapshotProbe{CreatedAt: "2026-08-0" + string(rune('1'+i%9)) + "T00:00:00Z", Bytes: b})
	}
	return out
}

// 一路增长 = 没丢，绝不能报警。
// 误报的代价很实在：管理员照着「可能丢过内容」去翻半天，最后发现什么事都没有，
// 几次之后这条判读就再也没人看了。
func TestSnapshotDropNoteSilentWhenGrowing(t *testing.T) {
	if note := snapshotDropNote(probes(1_000_000, 2_000_000, 3_000_000, 8_000_000)); note != "" {
		t.Fatalf("一路增长不该报警，实得: %s", note)
	}
}

// ZYM 那种情形：中间跌过一次但又长回来了，最终值仍是峰值——不该报警。
func TestSnapshotDropNoteSilentWhenRecovered(t *testing.T) {
	if note := snapshotDropNote(probes(8_000_000, 15_000_000, 13_000_000, 16_000_000)); note != "" {
		t.Fatalf("跌过又长回来（当前即峰值）不该报警，实得: %s", note)
	}
}

// 真跌了且没回来 = 必须报警，并指出峰值那份可作恢复点。
func TestSnapshotDropNoteFiresOnRealDrop(t *testing.T) {
	note := snapshotDropNote(probes(2_000_000, 20_000_000, 18_000_000, 3_000_000))
	if note == "" {
		t.Fatal("从 20MB 掉到 3MB 必须报警")
	}
	for _, want := range []string{"19.07MB", "2.86MB", "85%", "恢复点"} {
		if !strings.Contains(note, want) {
			t.Errorf("提示里应含 %q，实得: %s", want, note)
		}
	}
}

// 小幅波动（日常删几个节点）不报警：阈值是 30%。
func TestSnapshotDropNoteIgnoresMinorFluctuation(t *testing.T) {
	if note := snapshotDropNote(probes(10_000_000, 10_000_000, 9_000_000)); note != "" {
		t.Fatalf("跌 10%% 属日常编辑，不该报警，实得: %s", note)
	}
}

// 只有一份或没有快照：无从比较，安静返回。
func TestSnapshotDropNoteHandlesTooFewSamples(t *testing.T) {
	if snapshotDropNote(nil) != "" || snapshotDropNote(probes(5_000_000)) != "" {
		t.Fatal("样本不足时应安静返回")
	}
}
