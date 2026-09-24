package service

import (
	"log"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
)

// pendingSubmitPrefix 「已扣费、尚未拿到上游 task id」这一小段窗口的占位任务号前缀。
//
// video_refunds 整张表都是按 task_id 索引的，可这段窗口里根本还没有 task id——
// 于是这段时间进程一死，那笔扣费就成了无主孤儿：没有任务、没人退、后台也查不到。
// 用 trace id 造一个带前缀的临时键先占住位置，拿到真 task id 后立刻换掉。
const pendingSubmitPrefix = "pending:"

// pendingSubmitStale 超过这个时长仍是占位状态，判定为「进程中断没跑完」。
// 视频提交是同步转发、秒级返回，2 分钟已经远超正常耗时；给足余量避免误伤正在进行中的提交。
const pendingSubmitStale = 2 * time.Minute

// PendingSubmitKey 由 trace id 生成占位键。
func PendingSubmitKey(traceID string) string { return pendingSubmitPrefix + traceID }

// MarkVideoSubmitPending 扣费成功、发出上游请求【之前】落一条占位退费候选。
//
// 这是「先记账再做事」：万一进程在转发途中被杀（部署、OOM、宿主机重启），
// 下次启动时 RecoverInterruptedVideoSubmits 能凭这条记录把钱退回去。
// best-effort：写失败只记日志，不能因为这条辅助记录挡住用户正常生成。
func MarkVideoSubmitPending(traceID, userID, projectID, modelName string, credits int, chargedToProject bool) {
	if strings.TrimSpace(traceID) == "" || credits <= 0 {
		return
	}
	if err := repository.SaveVideoRefundCandidate(model.VideoRefund{
		TaskID: PendingSubmitKey(traceID), UserID: userID, ProjectID: projectID,
		Model: modelName, Credits: credits, ChargedToProject: chargedToProject,
	}); err != nil {
		log.Printf("视频提交占位记录写入失败（不影响生成）trace=%s err=%v", traceID, err)
	}
}

// ClearVideoSubmitPending 提交已有明确结局（拿到 task id，或已经同步退过费）→ 清掉占位。
func ClearVideoSubmitPending(traceID string) {
	if strings.TrimSpace(traceID) == "" {
		return
	}
	_ = repository.DeleteVideoRefund(PendingSubmitKey(traceID))
}

// RecoverInterruptedVideoSubmits 启动时清理上次被中断的视频提交：把钱退回去。
//
// 与图片侧的 generation job recover 是同一个思路——图片侧一直有，视频侧靠这里补齐：
// 部署只要正好打断一次提交，就是白扣一笔点数、且后台查无此事。
func RecoverInterruptedVideoSubmits() {
	// ⚠️ cutoff 必须传真实时间：ListUnrefundedVideoRefunds 的条件是 created_at <= ?，
	// 传空串永远匹配不到任何行（任何 RFC3339 串都大于 ""），整个恢复会变成静默空转。
	// 这个坑是被 TestListUnrefundedIncludesPendingKeys 当场抓出来的。
	cutoff := time.Now().Add(-pendingSubmitStale).Format(time.RFC3339)
	rows, err := repository.ListUnrefundedVideoRefunds(cutoff, 500)
	if err != nil {
		log.Printf("视频提交中断恢复：读取候选失败 %v", err)
		return
	}
	recovered, credits := 0, 0
	for _, vr := range rows {
		if !strings.HasPrefix(vr.TaskID, pendingSubmitPrefix) {
			continue // 有真 task id 的走原有的 sweeper 轮询判定，不归这里管
		}
		ok, rerr := RefundVideoAtomic(vr.TaskID, "/videos/submit-interrupted")
		if rerr != nil {
			log.Printf("视频提交中断恢复：退费失败 key=%s err=%v", vr.TaskID, rerr)
			continue
		}
		if ok {
			recovered++
			credits += vr.Credits
			log.Printf("视频提交中断恢复：已退还 user=%s 积分=%d（上次进程中断于提交途中）", vr.UserID, vr.Credits)
		}
		_ = repository.DeleteVideoRefund(vr.TaskID)
	}
	if recovered > 0 {
		log.Printf("视频提交中断恢复完成：%d 笔，共退还 %d 积分", recovered, credits)
	}
}
