package service

import (
	"log"
	"sync"
	"time"

	"aicanvas/model"
	"aicanvas/repository"

	"github.com/robfig/cron/v3"
)

// 每 5 分钟扫一遍，代价很小：只按 updated_at 与最新快照的 created_at 比时间，不读 data 大字段。
const snapshotBackfillCron = "*/5 * * * *"

var snapshotBackfillOnce sync.Once

// StartSnapshotBackfillScheduler 补写「有新内容却没进快照历史」的数据域。
//
// 【为什么需要它】
// 快照原本只在推送成功时写，且带 10 分钟节流（挡住 8 秒防抖造成的刷屏）。
// 于是「用户连续编辑一阵、然后停手」这种最常见的节奏会留下一个洞：
//
//	10:00 推送 A → 写快照 A
//	10:03 推送 B → 距 A 仅 3 分钟，被节流挡掉，B 没有快照
//	10:03 之后用户停手，B 就是最终内容
//
// 以前这个洞是被【心跳的冗余重推】偶然堵上的：客户端每 90 秒把同一份 B 原样再推一次，
// 等节流窗过去，服务端就补上了快照 B。也就是说，「最后一版能不能进历史」依赖的是
// 客户端的推送频率——这是个巧合，不是设计。
//
// 客户端一旦改成「内容没变就不推」（为省带宽，见 app-sync.ts 的 sameAsRemote），
// 这个巧合立刻消失，最终版本将永远拿不到快照——而那恰恰是出事时最想恢复的一版。
//
// 所以把快照的触发条件从「有没有推送」改成「数据是不是真的比历史新」，
// 由这个定时任务兜底。它与推送频率彻底解耦，比原先的机制更可靠。
func StartSnapshotBackfillScheduler() {
	snapshotBackfillOnce.Do(func() {
		c := cron.New(cron.WithChain(cron.SkipIfStillRunning(cron.DiscardLogger), cron.Recover(cron.DefaultLogger)))
		if _, err := c.AddFunc(snapshotBackfillCron, runSnapshotBackfill); err != nil {
			log.Printf("快照补写定时器注册失败: %v", err)
			return
		}
		c.Start()
	})
}

// sweepEvery 每隔多少轮做一次「全量哈希核对」。5 分钟一轮 × 12 = 每小时一次。
const sweepEvery = 12

var backfillRound int

func runSnapshotBackfill() {
	started := time.Now()
	backfillRound++
	// 常规轮：只比时间戳筛候选，不碰 data 大字段，几百行的表毫秒级完成。
	//
	// 但时间戳有个盲区：【绕过应用直接改库】的内容不会 bump updated_at，
	// 于是它永远进不了候选、永远拿不到快照。典型场景是手工修一条畸形预设——
	// 那份内容可以几十小时都没有回滚点，而且不会有任何地方报错。
	// 所以每小时补一轮全量哈希核对：代价是读一遍 data（几百 MB 量级），
	// 一小时一次可以接受，换来的是「无论内容怎么变的，都不会漏掉」。
	full := backfillRound%sweepEvery == 1
	var stale []model.SyncData
	var err error
	if full {
		stale, err = repository.ListAllSyncDataForSnapshotCheck()
	} else {
		stale, err = repository.ListSyncDataNeedingSnapshot()
	}
	if err != nil {
		log.Printf("快照补写：筛选候选失败 %v", err)
		return
	}
	if len(stale) == 0 {
		return
	}
	written := 0
	for _, it := range stale {
		// 走 ForceCanvasSnapshot 而不是 CaptureCanvasSnapshot：这里【必须绕开 10 分钟节流】，
		// 否则又会被同一个节流挡住，等于什么都没做。hash 去重仍由下面这层保证。
		latest, ok, lerr := repository.LatestSnapshot(it.UserID, it.Domain)
		if lerr != nil {
			continue
		}
		if ok && latest.Hash == repository.HashSyncData(it.Data) {
			continue // 内容与最新快照相同，无需重复留存
		}
		if _, ferr := repository.ForceCanvasSnapshot(it.UserID, it.Domain, it.Data); ferr != nil {
			log.Printf("快照补写失败 user=%s domain=%s err=%v", it.UserID, it.Domain, ferr)
			continue
		}
		written++
	}
	if written > 0 {
		log.Printf("快照补写完成（%s）：候选 %d，新增 %d 份，耗时 %s", map[bool]string{true: "全量核对", false: "增量"}[full], len(stale), written, time.Since(started).Round(time.Millisecond))
	}
}
