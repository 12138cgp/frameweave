package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"aicanvas/config"
	"aicanvas/handler"
	"aicanvas/router"
	"aicanvas/service"
)

// shutdownGrace 收到停止信号后，留给在途请求跑完的时间。
//
// 取 40 秒的依据：这里要等的是【已经扣了费、正在转发给上游】的请求。
// 视频提交本身是同步转发（拿到 task id 就返回），实测这一步在秒级；
// 真正耗时的轮询是客户端后续独立发起的，不在本次请求里。
// 40 秒足够覆盖提交阶段，又不会让部署等太久。docker compose 默认 SIGTERM 后 10 秒强杀，
// 所以部署脚本要配合 --timeout 才能吃满这个窗口（见 DEPLOY 说明）。
const shutdownGrace = 40 * time.Second

// bootStep 给启动流程的每一步计时并打点。
//
// 为什么需要：HTTP 服务要等下面所有步骤跑完才开始监听，中间任何一步变慢
// 都表现为「用户看到 502、日志一片安静」，只能靠猜。
// 典型场景：一条全表 UPDATE 落在启动路径上，
// 服务连续几分钟只回 502，日志里什么线索都没有，最后只能回滚。
// 现在每一步都有起止和耗时，卡住时一眼就能看出卡在哪。
func bootStep(name string, fn func()) {
	started := time.Now()
	log.Printf("启动[%s] 开始", name)
	fn()
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		log.Printf("启动[%s] 完成，耗时 %s  ⚠️ 这一步阻塞了服务监听", name, elapsed.Round(time.Millisecond))
	} else {
		log.Printf("启动[%s] 完成，耗时 %s", name, elapsed.Round(time.Millisecond))
	}
}

func main() {
	bootAt := time.Now()
	// 第一件事：把日志同时落盘。启动阶段的日志恰恰最需要留证，
	// 而容器一重建 docker logs 就没了（见 applog.go）。
	setupFileLogging()
	bootStep("配置与数据库迁移", func() {
		if err := config.Load(); err != nil {
			log.Fatal(err)
		}
		log.Printf("数据库: driver=%s dsn=%s", config.Cfg.StorageDriver, summarizeDatabaseDSN(config.Cfg.StorageDriver, config.Cfg.DatabaseDSN))
	})
	bootStep("默认管理员", func() {
		if err := service.EnsureDefaultAdmin(); err != nil {
			log.Fatal(err)
		}
	})
	bootStep("渠道迁移", service.MigrateGroupChannels)
	// 模型类型回填：给还没有元信息的模型按名字启发式补上 kind（+ 视频的支持档位从定价表反推）。
	// 只增不改，管理员在后台手工标过的绝不覆盖；补完之后类型就以数据为准，不再靠猜。
	bootStep("模型类型回填", func() {
		added, err := service.BackfillModelMetas()
		if err != nil {
			// 回填失败不该挡住启动：所有读取点在查不到元信息时都会回落到原来的名字启发式，
			// 也就是退回改造前的行为，不影响任何既有功能。
			log.Printf("模型类型回填失败(不影响启动，读取点会回落名字启发式): %v", err)
			return
		}
		if added > 0 {
			log.Printf("模型类型回填: 新补 %d 个模型", added)
		}
	})
	bootStep("后台定时任务", func() {
		service.StartPromptSyncScheduler()
		service.StartPortraitAssetScheduler()
		service.StartSnapshotBackfillScheduler()
		service.StartGenerationJobWorker()
		service.StartSmsCodeGC()
		service.StartLoginGuardGC()
		handler.StartVideoRefundSweeper()
		service.ResumeMediaTranscodeJobs()
	})

	// 视频提交中断恢复：上次进程被杀时，可能有「已扣费、还没拿到 task id」的视频卡在半路——
	// 那笔钱既没换来任务、也没有任何东西负责退（退费是按 task id 索引的）。
	// 部署重建容器时只要正好打断一次提交，用户就会白扣一笔点数，
	// 而后台连记录都查不到。图片侧本来就有同款恢复（generation job recover），视频侧靠这一条补齐。
	bootStep("恢复中断的视频提交", service.RecoverInterruptedVideoSubmits)

	// ── 优雅停机 ────────────────────────────────────────────────────────
	// 以前是 router.New().Run(...)，进程收到 SIGTERM 直接死：正在转发的请求连同它的
	// 退费回调一起消失。部署=打断用户，且打断得无声无息。
	srv := &http.Server{Addr: ":" + config.Cfg.Port, Handler: router.New()}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务启动失败: %v", err)
		}
	}()
	log.Printf("服务已启动，监听 :%s（启动共耗时 %s，优雅停机窗口 %s）", config.Cfg.Port, time.Since(bootAt).Round(time.Millisecond), shutdownGrace)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop
	log.Printf("收到停止信号，不再接受新请求，最多等待 %s 让在途请求完成…", shutdownGrace)

	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		// 超时说明确实有请求没跑完；它们会被强行中断，恢复逻辑下次启动时兜底。
		log.Printf("仍有在途请求未完成即被中断: %v", err)
	} else {
		log.Printf("在途请求已全部完成，正常退出")
	}
}

// summarizeDatabaseDSN 把 DSN 中的密码替换为 ***，避免启动日志泄露口令。
// postgres: postgres://user:pass@host:port/db?params → postgres://user:***@host:port/db
// mysql:    user:pass@tcp(host:port)/db?params        → user:***@tcp(host:port)/db
// sqlite:   原样返回（只是文件路径，无敏感信息）
func summarizeDatabaseDSN(driver, dsn string) string {
	driver = strings.ToLower(strings.TrimSpace(driver))
	switch driver {
	case "postgres", "postgresql":
		// pgx 也支持 key=value 形式 DSN，但本项目只用 URL 形式（见 config 默认值）。
		u, err := url.Parse(dsn)
		if err != nil {
			return "postgres://*** (dsn 解析失败)"
		}
		if u.User != nil {
			if _, hasPwd := u.User.Password(); hasPwd {
				u.User = url.UserPassword(u.User.Username(), "***")
			}
		}
		// 去掉 query 保留 host:port/db，更简短易读。
		u.RawQuery = ""
		return u.String()
	case "mysql":
		// mysql DSN 不是标准 URL，无法用 url.Parse。直接在 @ 处切一刀。
		at := strings.Index(dsn, "@")
		if at < 0 {
			return dsn
		}
		userPart := dsn[:at]
		rest := dsn[at:]
		if colon := strings.Index(userPart, ":"); colon >= 0 {
			userPart = userPart[:colon]
		}
		// 去掉 query。
		if q := strings.Index(rest, "?"); q >= 0 {
			rest = rest[:q]
		}
		return userPart + ":***" + rest
	default:
		return dsn
	}
}
