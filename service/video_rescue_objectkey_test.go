package service

import (
	"regexp"
	"testing"
)

// 这条是「重传不再堆垃圾」的全部依据：同一个任务反复救援必须落在同一个对象名上。
// 一旦有人改回随机名，一个卡住的候选 6 小时内最多重试 72 轮，
// 就会在用户桶里留下 72 份几十 MB 的孤儿对象，而系统里没有任何清理机制。
func TestRescueObjectIDIsStableAcrossRetries(t *testing.T) {
	a := rescueObjectID("user-1", "cgt-20260101000000-fghij")
	b := rescueObjectID("user-1", "cgt-20260101000000-fghij")
	if a != b {
		t.Fatalf("同一用户同一任务必须得到同一个对象名，实得 %s vs %s", a, b)
	}
}

// 换任务、换用户都必须换名字，否则会互相覆盖 —— 那就从「多存一份垃圾」变成「弄丢别人的成片」。
func TestRescueObjectIDSeparatesTaskAndUser(t *testing.T) {
	base := rescueObjectID("user-1", "task-A")
	if same := rescueObjectID("user-1", "task-B"); same == base {
		t.Fatal("不同任务必须得到不同对象名，否则后一个会覆盖前一个")
	}
	if same := rescueObjectID("user-2", "task-A"); same == base {
		t.Fatal("不同用户必须得到不同对象名")
	}
}

// 长度和字符集必须与原先 uuid 去横杠后一致：下游 storageKey("video:"+id)、sync_files 登记、
// 前端按 storageKey 自愈都对这个形状有既有假设，变了会在很远的地方炸。
func TestRescueObjectIDShapeMatchesLegacyUUID(t *testing.T) {
	id := rescueObjectID("user-00000000-0000-4000-8000-000000000001", "cgt-20260101000000-abcde")
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(id) {
		t.Fatalf("必须是 32 位小写十六进制（与 uuid 去横杠等形），实得 %q（长度 %d）", id, len(id))
	}
}
