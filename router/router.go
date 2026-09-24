package router

import (
	"net/http"
	"strings"

	"aicanvas/handler"
	"aicanvas/middleware"

	"github.com/gin-gonic/gin"
)

// skipAccessLog 决定某条请求要不要写访问日志。
//
// 为什么需要它：gin.Default() 无条件挂 Logger，把每一条请求都打一行。
// 实测在一个 21 小时的窗口里，访问日志的构成是：
//
//	/api/v1/sync/manifest    39%
//	/api/v1/sync/files/:key  28%
//
// 这两个都是客户端固定周期轮询的接口，两者合计 67%——真正的报错就埋在底下，
// 而且容器日志 20MB×5 的轮转窗口被它们吃掉，出事时往前翻不了多久。
//
// ⚠️ 只静音「高频轮询 + 结果正常」这一种组合。状态码一旦 >=400 照样记，
// 否则排查时连「它到底有没有被调用过、是不是一直在 401」都看不出来——
// 那就从「日志太吵」换成了「日志说谎」，是更坏的结果。
func skipAccessLog(c *gin.Context) bool {
	if c.Writer.Status() >= http.StatusBadRequest {
		return false
	}
	path := c.Request.URL.Path
	if path == "/api/health" {
		return true
	}
	return strings.HasPrefix(path, "/api/v1/sync/manifest") ||
		strings.HasPrefix(path, "/api/v1/sync/files/")
}

func New() *gin.Engine {
	// 不用 gin.Default()：它固定挂上无条件记录的 Logger（见 skipAccessLog）。
	// 这里手工挂 Logger+Recovery，行为与 Default 一致，只多一个跳过判据。
	router := gin.New()
	router.Use(gin.LoggerWithConfig(gin.LoggerConfig{Skip: skipAccessLog}))
	router.Use(gin.Recovery())
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)
	api := router.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	api.POST("/auth/register", gin.WrapF(handler.Register))
	api.POST("/auth/login", gin.WrapF(handler.Login))
	api.POST("/auth/sms/send-code", gin.WrapF(handler.SendSmsCode))
	api.POST("/auth/sms/login", gin.WrapF(handler.SmsLogin))
	api.POST("/auth/change-password", middleware.UserAuth, gin.WrapF(handler.ChangePassword))
	api.GET("/auth/me", middleware.OptionalAuth, gin.WrapF(handler.CurrentUser))
	api.GET("/settings", middleware.OptionalAuth, gin.WrapF(handler.Settings))
	api.GET("/version", gin.WrapF(handler.AppVersion))
	api.GET("/media/references/:id", func(c *gin.Context) {
		handler.ReferenceMedia(c.Writer, c.Request, c.Param("id"))
	})
	api.HEAD("/media/references/:id", func(c *gin.Context) {
		handler.ReferenceMedia(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/media/prompt-covers/:id", func(c *gin.Context) {
		handler.PromptCover(c.Writer, c.Request, c.Param("id"))
	})
	api.HEAD("/media/prompt-covers/:id", func(c *gin.Context) {
		handler.PromptCover(c.Writer, c.Request, c.Param("id"))
	})
	v1 := api.Group("/v1", middleware.UserAuth)
	v1.POST("/images/generations", gin.WrapF(handler.AIImagesGenerations))
	v1.POST("/images/edits", gin.WrapF(handler.AIImagesEdits))
	v1.POST("/chat/completions", gin.WrapF(handler.AIChatCompletions))
	v1.POST("/audio/speech", gin.WrapF(handler.AIAudioSpeech))
	v1.POST("/videos", gin.WrapF(handler.AIVideos))
	v1.POST("/media/references", gin.WrapF(handler.UploadReferenceMedia))
	v1.POST("/media/persist", gin.WrapF(handler.PersistMedia))
	v1.POST("/media/probe", gin.WrapF(handler.ProbeMedia))
	v1.POST("/media/transcode", gin.WrapF(handler.SubmitMediaTranscode))
	v1.GET("/media/transcode/:id", func(c *gin.Context) {
		handler.GetMediaTranscode(c.Writer, c.Request, c.Param("id"))
	})
	// 按 trace_id 查这次生成对应的火山 cgt 任务号（视频节点把「追踪码」换成 cgt 显示）。
	v1.GET("/trace-cgt/:traceId", func(c *gin.Context) {
		handler.TraceCgt(c.Writer, c.Request, c.Param("traceId"))
	})
	v1.GET("/videos/:id", func(c *gin.Context) {
		handler.AIVideo(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id/content", func(c *gin.Context) {
		handler.AIVideoContent(c.Writer, c.Request, c.Param("id"))
	})
	// 客户端确认视频已成功保存到本地/桶：删掉退款候选，让兜底扫描知道「这个不用救了」。
	v1.POST("/videos/:id/claimed", func(c *gin.Context) {
		handler.ClaimVideoTask(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/generation-jobs", gin.WrapF(handler.CreateGenerationJob))
	v1.GET("/generation-jobs/:id", func(c *gin.Context) {
		handler.GetGenerationJob(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/sync/manifest", gin.WrapF(handler.GetSyncManifest))
	v1.POST("/sync/manifest", gin.WrapF(handler.SaveSyncManifest))
	v1.GET("/sync/files", gin.WrapF(handler.ListSyncFiles))
	v1.POST("/sync/files", gin.WrapF(handler.UploadSyncFile))
	v1.GET("/sync/files/:key", func(c *gin.Context) {
		handler.GetSyncFileContent(c.Writer, c.Request, c.Param("key"))
	})
	v1.GET("/group-assets", gin.WrapF(handler.ListGroupAssets))
	v1.POST("/group-assets", gin.WrapF(handler.UploadGroupAsset))
	v1.GET("/group-assets/:id/content", func(c *gin.Context) {
		handler.GetGroupAssetContent(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/group-assets/:id", func(c *gin.Context) {
		handler.DeleteGroupAsset(c.Writer, c.Request, c.Param("id"))
	})

	// 团队共享风格：同组成员都能用，分享者本人或管理员可取消共享。
	v1.GET("/group-styles", gin.WrapF(handler.ListGroupStyles))
	v1.POST("/group-styles", gin.WrapF(handler.ShareGroupStyle))
	v1.GET("/group-styles/:id/preview", func(c *gin.Context) {
		handler.GetGroupStylePreview(c.Writer, c.Request, c.Param("id"))
	})
	v1.DELETE("/group-styles/:id", func(c *gin.Context) {
		handler.DeleteGroupStyle(c.Writer, c.Request, c.Param("id"))
	})
	// 收藏提示词：一条收藏 = 这次生成的完整输入（提示词 + 配置 + 风格快照 + 参考素材副本 + 成品副本）。
	v1.GET("/prompt-favorites", gin.WrapF(handler.ListMyPromptFavorites))
	v1.POST("/prompt-favorites", gin.WrapF(handler.CreatePromptFavorite))
	// 「某画布里哪些节点已收藏」故意用独立路径而不是 /prompt-favorites/nodes：
	// 后者会和下面的 /prompt-favorites/:id 在同一层级形成静态段与通配段冲突。
	v1.GET("/prompt-favorite-nodes", gin.WrapF(handler.ListMyPromptFavoriteNodes))
	v1.DELETE("/prompt-favorites/:id", func(c *gin.Context) {
		handler.DeleteMyPromptFavorite(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/prompt-favorites/:id/files/:key", func(c *gin.Context) {
		handler.GetMyPromptFavoriteFile(c.Writer, c.Request, c.Param("id"), c.Param("key"))
	})
	v1.POST("/canvas/share", gin.WrapF(handler.CreateCanvasShare))
	v1.POST("/canvas/share/:code/fork", func(c *gin.Context) {
		handler.ForkCanvasShare(c.Writer, c.Request, c.Param("code"))
	})
	api.GET("/canvas/share/:code", func(c *gin.Context) {
		handler.SharedCanvas(c.Writer, c.Request, c.Param("code"))
	})
	api.GET("/canvas/share/:code/files/:key", func(c *gin.Context) {
		handler.SharedCanvasFile(c.Writer, c.Request, c.Param("code"), c.Param("key"))
	})

	portraitAssets := api.Group("/portrait-assets", middleware.UserAuth)
	portraitAssets.GET("", gin.WrapF(handler.PortraitAssets))
	portraitAssets.POST("", gin.WrapF(handler.CreatePortraitAsset))
	api.GET("/portrait-assets-remote", middleware.UserAuth, gin.WrapF(handler.RemotePortraitAssets))
	portraitAssets.GET("/:id", func(c *gin.Context) {
		handler.GetPortraitAsset(c.Writer, c.Request, c.Param("id"))
	})
	portraitAssets.DELETE("/:id", func(c *gin.Context) {
		handler.DeletePortraitAsset(c.Writer, c.Request, c.Param("id"))
	})

	api.GET("/projects/mine", middleware.UserAuth, gin.WrapF(handler.MyProjects))

	// 「我的消耗」:普通用户看自己的任务日志/点数日志(出参白名单脱敏,SQL 层锁死本人)。
	api.GET("/my/task-logs", middleware.UserAuth, gin.WrapF(handler.MyTaskLogs))
	api.GET("/my/credit-logs", middleware.UserAuth, gin.WrapF(handler.MyCreditLogs))
	// 画布载入时问「这块画布还有哪些视频任务在等交付」：本地任务号丢了也能把节点接回来，
	// 不再把还在正常生成的任务误判成「页面刷新后生成已中断」（见 handler/my_pending_video.go）。
	api.GET("/my/pending-video-tasks", middleware.UserAuth, gin.WrapF(handler.MyPendingVideoTasks))
	// 纯观测诊断：客户端上报「画布持久化被吞了一次」，只打日志、不落库（见 handler/diag.go）
	api.POST("/diag/persist-swallow", middleware.UserAuth, gin.WrapF(handler.ReportPersistSwallow))
	// 「问题反馈」：用户在头像下拉里提问题，连同操作日志和现场快照一起发给管理员。
	api.POST("/my/reports", middleware.UserAuth, gin.WrapF(handler.SubmitMyReport))
	api.GET("/my/reports", middleware.UserAuth, gin.WrapF(handler.MyReports))

	api.GET("/prompts", middleware.OptionalAuth, gin.WrapF(handler.Prompts))
	api.GET("/assets", middleware.OptionalAuth, gin.WrapF(handler.Assets))
	api.POST("/admin/login", gin.WrapF(handler.AdminLogin))

	// anyAdmin：超管 + 二级管理员共用（handler 内部按角色做数据隔离）。
	anyAdmin := api.Group("/admin", middleware.AnyAdminAuth)
	anyAdmin.GET("/groups", gin.WrapF(handler.AdminGroups))
	anyAdmin.POST("/groups", gin.WrapF(handler.AdminSaveGroup))
	anyAdmin.POST("/groups/test-storage", gin.WrapF(handler.AdminTestGroupStorage))
	anyAdmin.DELETE("/groups/:id", func(c *gin.Context) {
		handler.AdminDeleteGroup(c.Writer, c.Request, c.Param("id"))
	})
	// 用户反馈：挂 anyAdmin，二级管理员在 handler 里被限定为「只看自己下辖用户」。
	// 反馈里带的是诊断元信息（不含提示词正文和媒体内容），下辖范围内可见是合理的——
	// 出问题的用户往往就归他管，让他能自己先看一眼比什么都拦住要有用。
	anyAdmin.GET("/reports", gin.WrapF(handler.AdminReports))
	anyAdmin.GET("/reports/:id", func(c *gin.Context) {
		handler.AdminReportDetail(c.Writer, c.Request, c.Param("id"))
	})
	anyAdmin.POST("/reports/:id", func(c *gin.Context) {
		handler.AdminUpdateReport(c.Writer, c.Request, c.Param("id"))
	})
	anyAdmin.GET("/reports/:id/log", func(c *gin.Context) {
		handler.AdminReportLogDownload(c.Writer, c.Request, c.Param("id"))
	})
	anyAdmin.GET("/users", gin.WrapF(handler.AdminUsers))
	anyAdmin.POST("/users", gin.WrapF(handler.AdminSaveUser))
	anyAdmin.POST("/users/:id/credits", func(c *gin.Context) {
		handler.AdminAdjustUserCredits(c.Writer, c.Request, c.Param("id"))
	})
	anyAdmin.DELETE("/users/:id", func(c *gin.Context) {
		handler.AdminDeleteUser(c.Writer, c.Request, c.Param("id"))
	})
	// credit-logs 仅 GET 共用；POST/DELETE 留超管专用。
	anyAdmin.GET("/projects", gin.WrapF(handler.AdminProjects))
	anyAdmin.POST("/projects", gin.WrapF(handler.AdminSaveProject))
	anyAdmin.DELETE("/projects/:id", func(c *gin.Context) {
		handler.AdminDeleteProject(c.Writer, c.Request, c.Param("id"))
	})
	anyAdmin.POST("/projects/:id/credits", func(c *gin.Context) {
		handler.AdminAdjustProjectCredits(c.Writer, c.Request, c.Param("id"))
	})
	anyAdmin.GET("/credit-logs", gin.WrapF(handler.AdminCreditLogs))
	anyAdmin.GET("/credit-logs/summary", gin.WrapF(handler.AdminCreditLogsSummary))
	// 生成情况统计：超管查任意二级管理员下辖、二级管理员查自己下辖（handler 内按角色隔离 ownerId）。
	anyAdmin.GET("/generation-stats", gin.WrapF(handler.AdminGenerationStats))
	anyAdmin.GET("/task-logs", gin.WrapF(handler.AdminTaskLogs))
	// 渠道探测/测试共用：二级管理员要测自己渠道（handler 内禁止其借 index 回退全局密钥）。
	anyAdmin.POST("/settings/channel-models", gin.WrapF(handler.AdminChannelModels))
	anyAdmin.POST("/settings/channel-test", gin.WrapF(handler.AdminTestChannelModel))

	// admin：超管专用。
	admin := api.Group("/admin", middleware.AdminAuth)
	admin.GET("/managers", gin.WrapF(handler.AdminManagers))
	// 素材对账（只读）：列出各用户「画布引用了、但服务端无任何登记」的素材，用于主动发现静默丢失。
	admin.GET("/media-audit", gin.WrapF(handler.AdminMediaAudit))
	// 收藏提示词（仅超管）：能读到全平台任意用户的提示词原文与素材副本，L2 无业务理由，fail-closed。
	admin.GET("/prompt-favorites", gin.WrapF(handler.AdminPromptFavorites))
	// 跨用户下发收藏副本，供后台 ZIP 批量导出；用户侧的同步文件接口按账号隔离，超管拿不到别人的。
	admin.GET("/prompt-favorites/:id/files/:key", func(c *gin.Context) {
		handler.AdminPromptFavoriteFile(c.Writer, c.Request, c.Param("id"), c.Param("key"))
	})
	// 短信记录读取仅超管：含全平台手机号与短信内容，属隐私敏感数据；
	// 且 sms-logs 无 user_id 无法按下辖用户隔离，故挂超管专用组（fail-closed）。
	admin.GET("/sms-logs", gin.WrapF(handler.AdminSmsLogs))
	// 分级定价（仅超管）：给某二级管理员设置/查看价格覆盖（其本人及下辖用户生效，未覆盖模型按全局默认）。
	admin.GET("/managers/:id/prices", func(c *gin.Context) {
		handler.AdminGetManagerPrices(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/managers/:id/prices", func(c *gin.Context) {
		handler.AdminSetManagerPrices(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/groups/:id/owner", func(c *gin.Context) {
		handler.AdminAssignGroupOwner(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/projects/:id/owner", func(c *gin.Context) {
		handler.AdminAssignProjectOwner(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/users/:id/creator", func(c *gin.Context) {
		handler.AdminAssignUserCreator(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/credit-logs", gin.WrapF(handler.AdminSaveCreditLog))
	admin.DELETE("/credit-logs/:id", func(c *gin.Context) {
		handler.AdminDeleteCreditLog(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.GET("/user-audit-logs", gin.WrapF(handler.AdminUserAuditLogs))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.GET("/prompt-categories", gin.WrapF(handler.AdminPromptCategories))
	admin.POST("/prompt-categories/sync", gin.WrapF(handler.AdminSyncPromptCategories))
	admin.GET("/prompts", gin.WrapF(handler.AdminPrompts))
	admin.POST("/prompts", gin.WrapF(handler.AdminSavePrompt))
	admin.POST("/prompts/batch-delete", gin.WrapF(handler.AdminDeletePrompts))
	admin.DELETE("/prompts/:id", func(c *gin.Context) {
		handler.AdminDeletePrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})
	// 画布历史版本快照：列表 / 单份详情 / 恢复（恢复他人数据为超管专用）。
	admin.GET("/users/:id/canvas-snapshots", func(c *gin.Context) {
		handler.AdminListCanvasSnapshots(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/canvas-snapshots/:snapId", func(c *gin.Context) {
		handler.AdminGetCanvasSnapshot(c.Writer, c.Request, c.Param("snapId"))
	})
	admin.POST("/users/:id/canvas-snapshots/:snapId/restore", func(c *gin.Context) {
		handler.AdminRestoreCanvasSnapshot(c.Writer, c.Request, c.Param("id"), c.Param("snapId"))
	})

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
