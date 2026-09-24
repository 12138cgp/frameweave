package service

import (
	"log"
	"sync"

	"aicanvas/model"
	"aicanvas/repository"
	"github.com/robfig/cron/v3"
)

const defaultPromptSyncCron = "*/5 * * * *"

var (
	promptSyncCron *cron.Cron
	promptSyncOnce sync.Once
	promptSyncMu   sync.Mutex
)

func StartPromptSyncScheduler() {
	promptSyncOnce.Do(func() {
		// 首轮全量下载封面可能超过 cron 间隔，跳过仍在运行的任务避免叠跑
		promptSyncCron = cron.New(cron.WithChain(cron.SkipIfStillRunning(cron.DiscardLogger), cron.Recover(cron.DefaultLogger)))
		promptSyncCron.Start()
	})
	RefreshPromptSyncScheduler()
}

func RefreshPromptSyncScheduler() {
	promptSyncMu.Lock()
	defer promptSyncMu.Unlock()
	if promptSyncCron == nil {
		return
	}
	for _, entry := range promptSyncCron.Entries() {
		promptSyncCron.Remove(entry.ID)
	}
	settings, err := repository.GetSettings()
	if err != nil {
		log.Printf("load prompt sync setting failed err=%v", err)
		return
	}
	setting := normalizePromptSyncSetting(settings.Private.PromptSync)
	if setting.Enabled == nil || !*setting.Enabled {
		return
	}
	if _, err := promptSyncCron.AddFunc(setting.Cron, SyncRemotePromptCategories); err != nil {
		log.Printf("add prompt sync cron failed cron=%s err=%v", setting.Cron, err)
	}
}

func SyncRemotePromptCategories() {
	for _, category := range repository.PromptCategories() {
		if !category.Remote {
			continue
		}
		log.Printf("scheduled prompt sync start category=%s", category.Category)
		if _, err := SyncPromptCategory(category.Category); err != nil {
			log.Printf("scheduled prompt sync failed category=%s err=%v", category.Category, err)
			continue
		}
		log.Printf("scheduled prompt sync done category=%s", category.Category)
	}
}

func normalizePromptSyncSetting(setting model.PromptSyncSetting) model.PromptSyncSetting {
	if setting.Cron == "" {
		setting.Cron = defaultPromptSyncCron
	}
	if setting.Enabled == nil {
		// 出厂默认【关闭】。这个定时任务会按 cron 去拉一批第三方 GitHub 提示词仓库、
		// 并把封面图下载到本地磁盘（首次全量约数百 MB）。对一个刚部署、还没配好
		// 对象存储和网络出口的实例来说，默认开启只会带来无意义的外网请求与磁盘占用，
		// 而且部分仓库不可达时每轮都会有固定数量的失败。
		// 需要用的话到「系统 → 系统设置」里打开。
		enabled := false
		setting.Enabled = &enabled
	}
	return setting
}
