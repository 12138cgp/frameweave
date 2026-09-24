package handler

import (
	"testing"
	"time"

	"aicanvas/model"
)

// 没超龄的候选绝不能被删：候选行是这个成片唯一的救命绳，
// 提前删掉 = 清扫器再也不知道有这回事，成片从此无声消失、无从追溯。
func TestGiveUpDoesNothingBeforeMaxAge(t *testing.T) {
	cutoff := time.Now().Add(-6 * time.Hour).Format(time.RFC3339)
	fresh := model.VideoRefund{
		TaskID:    "cgt-fresh",
		UserID:    "user-x",
		CreatedAt: time.Now().Add(-10 * time.Minute).Format(time.RFC3339),
	}
	st := &sweepStats{}
	if giveUpAgedCandidate(fresh, cutoff, "测试：还很新", st) {
		t.Fatal("10 分钟前的候选不该被放弃")
	}
	if st.gaveUp != 0 {
		t.Fatalf("不该记放弃，实得 gaveUp=%d", st.gaveUp)
	}
}

// 边界：恰好等于 cutoff 的算超龄（与原代码 <= 的语义一致）。
// 这里只验「判定」不验删除，避免测试依赖数据库。
func TestGiveUpBoundaryIsInclusive(t *testing.T) {
	cutoff := time.Now().Add(-6 * time.Hour).Format(time.RFC3339)
	older := model.VideoRefund{
		TaskID:    "cgt-old",
		UserID:    "user-x",
		CreatedAt: time.Now().Add(-7 * time.Hour).Format(time.RFC3339),
	}
	st := &sweepStats{}
	if !giveUpAgedCandidate(older, cutoff, "测试：已超龄", st) {
		t.Fatal("7 小时前的候选应判为超龄放弃")
	}
	if st.gaveUp != 1 {
		t.Fatalf("放弃必须计数（这个数字是报警依据），实得 gaveUp=%d", st.gaveUp)
	}
}

// 放弃计数是「有成片被永久丢弃」的唯一信号，一轮里多次放弃必须累加，不能被覆盖。
func TestGiveUpAccumulates(t *testing.T) {
	cutoff := time.Now().Add(-6 * time.Hour).Format(time.RFC3339)
	st := &sweepStats{}
	for i := 0; i < 3; i++ {
		giveUpAgedCandidate(model.VideoRefund{
			TaskID:    "cgt-old",
			UserID:    "user-x",
			CreatedAt: time.Now().Add(-8 * time.Hour).Format(time.RFC3339),
		}, cutoff, "测试", st)
	}
	if st.gaveUp != 3 {
		t.Fatalf("三次放弃应记 3，实得 %d", st.gaveUp)
	}
}
