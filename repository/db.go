package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"aicanvas/config"
	"aicanvas/model"
	"github.com/glebarez/sqlite"
	mysqldriver "github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	gormmysql "gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
	"gorm.io/plugin/dbresolver"
)

var promptCategories = []model.PromptCategory{
	{Category: "system", Name: "系统", Description: "系统提示词分类"},
	// 上游仓库 EvoLinkAI/awesome-gpt-image-2-API-and-Prompts 已于 2026-07 被删除（主页 404），
	// 定时同步会永久失败刷告警。改为 Remote:false 停止同步，已入库的 736 条提示词保持可用；
	// 若上游恢复或换到镜像地址，把 Remote 改回 true 即可，buildGptImage2Prompts 逻辑原样保留。
	{Category: "gpt-image-2-prompts", Name: "GPT Image 2 案例（已停更）", Description: "EvoLinkAI 的 GPT Image 2 案例提示词（上游仓库 2026-07 已删除，停止同步；同一脉络的续作见「GPT Image 2 案例库」）", GithubURL: "https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts", Remote: false},
	// 上面那个来源的活着的续作：同一批案例的延续，带结构化 cases.json（无需爬 markdown）与中文标题。
	{Category: "freestylefly-gpt-image-2", Name: "GPT Image 2 案例库", Description: "freestylefly 整理的 GPT Image 2 案例提示词（中文标题，附作者与原帖出处）", GithubURL: "https://github.com/freestylefly/awesome-gpt-image-2", Remote: true},
	// 同一仓库的另一份资产：13 类 47 套【带占位符的填空骨架】+ 每类一段避坑指南。
	// 与上面那 535 条「成品案例」是互补品类——案例照抄只能得到别人那张图，模板是可复用结构。
	{Category: "freestylefly-templates", Name: "填空模板", Description: "带[方括号]占位符的可复用骨架，填空即可用；每条附「什么时候用/要点/避坑」。与其它分类的成品案例不同——案例照抄只能得到别人那张图，模板是拿来改成你自己要的。⚠️ 本分类卡片的封面取自同题材案例，只表示题材，不是该模板的输出结果", GithubURL: "https://github.com/freestylefly/awesome-gpt-image-2/blob/main/docs/templates.md", Remote: true},
	{Category: "awesome-gpt-image", Name: "中文提示词精选", Description: "ZeroLu 的中文 GPT Image 提示词分类", GithubURL: "https://github.com/ZeroLu/awesome-gpt-image", Remote: true},
	{Category: "awesome-gpt4o-image-prompts", Name: "GPT-4o 图像提示词", Description: "ImgEdify 的 GPT-4o 图像提示词分类", GithubURL: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts", Remote: true},
	{Category: "youmind-gpt-image-2", Name: "YouMind · GPT Image 2", Description: "YouMind OpenLab 的 GPT Image 2 中文提示词分类", GithubURL: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", Remote: true},
	{Category: "youmind-nano-banana-pro", Name: "YouMind · Nano Banana Pro", Description: "YouMind OpenLab 的 Nano Banana Pro 中文提示词分类", GithubURL: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", Remote: true},
	{Category: "davidwu-gpt-image2-prompts", Name: "GPT Image 2 分类合集", Description: "davidwuw0811-boop 整理的 GPT Image 2 提示词分类", GithubURL: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts", Remote: true},
}

var (
	db     *gorm.DB
	dbOnce sync.Once
	dbErr  error
)

// DB 初始化并返回全局数据库连接。
func DB() (*gorm.DB, error) {
	dbOnce.Do(func() {
		driver := strings.ToLower(strings.TrimSpace(config.Cfg.StorageDriver))
		if driver == "" {
			driver = "sqlite"
		}
		dsn := strings.TrimSpace(config.Cfg.DatabaseDSN)
		// DSN 缺失的两种处理，分驱动区别对待：
		//
		// · postgres / mysql 缺 DSN → 直接报错。这类部署不可能「没有连接串还能跑」，
		//   带病启动的后果是：进程正常监听、健康检查通过、页面打得开，只有每个真实
		//   请求在后台失败——最难排查的一种故障形态。宁可起不来。
		// · sqlite 缺 DSN → 落到默认文件路径。早先这里不做处理，空 DSN 会被下面的
		//   PRAGMA 拼接变成 "?_pragma=busy_timeout(5000)&..." 当文件路径用，于是在当前
		//   工作目录建出一个文件名就是 DSN 片段的库（跑一次 go test 就往源码目录扔一个，
		//   而且这种文件名在 Windows 上非法、压缩包解不开）。
		if dsn == "" {
			if driver == "sqlite" {
				dsn = filepath.Join("data", "aicanvas.db")
			} else {
				dbErr = fmt.Errorf("DATABASE_DSN 未配置：请在 deploy/runtime/<env>.env 里填写数据库连接串")
				return
			}
		}
		openDSN := dsn
		if driver == "sqlite" && dsn != ":memory:" {
			_ = os.MkdirAll(filepath.Dir(dsn), 0755)
			// PRAGMA 经 DSN 设置，确保连接池里【每个】连接都带上 busy_timeout/WAL/synchronous。
			// （db.Exec("PRAGMA …") 只作用于当时取到的那一个连接；放开连接数后，其余连接若不带 busy_timeout，
			//  在写冲突时会立即返回「database is locked」。WAL 本身是库级持久设置，但 busy_timeout 是每连接的。）
			sep := "?"
			if strings.Contains(dsn, "?") {
				sep = "&"
			}
			openDSN = dsn + sep + "_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
		}
		if isPostgresDriver(driver) {
			dbErr = ensurePostgresDatabase(dsn)
			if dbErr != nil {
				return
			}
		}
		if driver == "mysql" {
			dbErr = ensureMySQLDatabase(dsn)
			if dbErr != nil {
				return
			}
		}
		// ⚠️ 必须显式配置日志器：GORM 默认的慢查询日志会把 SQL【连同参数值】一起打出来，
		// 而 sync_data.data 这一列装的是几 MB 的画布 JSON（还是格式化过的）——
		// 一条超过 200ms 的 UPDATE 就往日志里灌几十 MB。实测在有真实画布负载时，
		// 单是 repository/sync.go 的 SaveSyncDataIfUnchanged 这一条慢查询，5 分钟就能打出 58 万行 / 30MB。
		//
		// 三重危害：① 容器日志上限 20m×5，十几分钟就轮转一整轮，真出事时现场已经没了；
		// ② 被打进日志的画布 JSON 里含历史 errorDetails，日志告警会当成新故障误报；
		// ③ 用户的提示词与内容进了日志。
		//
		// ParameterizedQueries 让它打 ? 占位符而不是真实值：慢查询这个信号仍然保留，
		// 但绝不会再把负载写进日志。
		db, dbErr = gorm.Open(dialector(driver, openDSN), &gorm.Config{
			Logger: gormlogger.New(
				log.New(os.Stdout, "\r\n", log.LstdFlags),
				gormlogger.Config{
					SlowThreshold:             time.Second,
					LogLevel:                  gormlogger.Warn,
					IgnoreRecordNotFoundError: true,
					ParameterizedQueries:      true,
					Colorful:                  false,
				},
			),
		})
		if dbErr != nil {
			return
		}
		if driver == "sqlite" {
			// 读/写连接池分离（dbresolver）的【写池=source】：设为 1 条连接 → 所有写操作在 Go 的连接池层
			// 串行排队，永不在 sqlite 层两个写者撞「database is locked」（此前 v0.9.19 把池放到 20 解了
			// 读被写堵死的主病，但极端写突发/部署切换瞬间仍会冒锁错——根因是多条连接同时抢 WAL 单写锁）。
			// 只读查询走下面注册的 replica 读池（同一 WAL 文件、N 条连接），不受写串行影响、也不被慢写阻塞。
			// 每连接的 busy_timeout/WAL/synchronous 由上面的 DSN 设置；写冲突等待而非立即报错。
			// AutoMigrate 也在此单连接上串行跑（安全）。replica 在 AutoMigrate 之后注册。
			if sqlDB, err := db.DB(); err == nil {
				sqlDB.SetMaxOpenConns(1)
				sqlDB.SetMaxIdleConns(1)
			}
			// 兜底再跑一遍（WAL 是库级持久设置）。
			_ = db.Exec("PRAGMA journal_mode=WAL").Error
			_ = db.Exec("PRAGMA synchronous=NORMAL").Error
		}
		dbErr = db.AutoMigrate(
			&model.User{},
			&model.CreditLog{},
			&model.Prompt{},
			&model.Asset{},
			&model.Setting{},
			&model.PortraitAsset{},
			&model.SyncData{},
			&model.SyncSnapshot{},
			&model.SyncFile{},
			&model.CanvasShare{},
			&model.Group{},
			&model.GenerationJob{},
			&model.GroupAsset{},
			&model.GroupStyle{},
			&model.Project{},
			&model.ProjectMember{},
			&model.UpstreamLog{},
			&model.VideoRefund{},
			&model.MediaTranscodeJob{},
			&model.TokenLog{},
			&model.SmsLog{},
			&model.UserReport{},
			&model.PromptFavorite{},
			&model.UserAuditLog{},
		)
		if dbErr != nil {
			return
		}
		if driver == "sqlite" {
			// 读/写连接池分离：注册同一 WAL 文件的【只读 replica 池】（N 条连接）。
			// dbresolver 自动路由：SELECT/First/Find/Count/Pluck/Raw → replica；
			// Create/Save/Updates/Delete/Exec/Transaction → source（上面的单写连接）。
			// 实测（glebarez/sqlite + dbresolver）：写串行 0 锁错、跨池「写后立刻读」0 stale
			//（modernc WAL 读连接立刻可见已提交写）、读不被慢写阻塞；对照「单池多写连接」会冒锁错+丢更新。
			dbErr = db.Use(dbresolver.Register(dbresolver.Config{
				Replicas: []gorm.Dialector{dialector(driver, openDSN)},
				Policy:   dbresolver.RandomPolicy{},
			}).SetMaxOpenConns(20).SetMaxIdleConns(20))
			if dbErr != nil {
				return
			}
			// 再次把 source 写池钉回 1（dbresolver 的链式 SetMaxOpenConns 只配 replica，
			// 但放在 Use 之后重设可确保写池恒为单连接、写永远串行）。
			if sqlDB, err := db.DB(); err == nil {
				sqlDB.SetMaxOpenConns(1)
				sqlDB.SetMaxIdleConns(1)
			}
		}
	})
	return db, dbErr
}

func dialector(driver string, dsn string) gorm.Dialector {
	switch driver {
	case "mysql":
		return gormmysql.Open(dsn)
	case "postgres", "postgresql":
		return postgres.Open(dsn)
	default:
		return sqlite.Open(dsn)
	}
}

func isPostgresDriver(driver string) bool {
	return driver == "postgres" || driver == "postgresql"
}

func ensureMySQLDatabase(dsn string) error {
	cfg, err := mysqldriver.ParseDSN(dsn)
	if err != nil {
		return err
	}
	target := strings.TrimSpace(cfg.DBName)
	if target == "" {
		return nil
	}
	ctx := context.Background()
	targetDB, err := sql.Open("mysql", dsn)
	if err != nil {
		return err
	}
	err = targetDB.PingContext(ctx)
	_ = targetDB.Close()
	if err == nil {
		return nil
	}
	if !isMySQLError(err, 1049) {
		return err
	}

	maintenance := cfg.Clone()
	maintenance.DBName = ""
	serverDB, err := sql.Open("mysql", maintenance.FormatDSN())
	if err != nil {
		return err
	}
	defer serverDB.Close()

	_, err = serverDB.ExecContext(ctx, "CREATE DATABASE "+quoteMySQLIdentifier(target)+" CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
	if isMySQLError(err, 1007) {
		return nil
	}
	return err
}

func ensurePostgresDatabase(dsn string) error {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return err
	}
	target := strings.TrimSpace(cfg.Database)
	if target == "" {
		return nil
	}
	ctx := context.Background()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err == nil {
		_ = conn.Close(ctx)
		return nil
	}
	if !isPostgresError(err, "3D000") {
		return err
	}

	maintenance := cfg.Copy()
	maintenance.Database = "postgres"
	if strings.EqualFold(target, "postgres") {
		maintenance.Database = "template1"
	}
	conn, err = pgx.ConnectConfig(ctx, maintenance)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	_, err = conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{target}.Sanitize(), pgx.QueryExecModeExec)
	if isPostgresError(err, "42P04") {
		return nil
	}
	return err
}

func isMySQLError(err error, number uint16) bool {
	var mysqlErr *mysqldriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == number
}

func isPostgresError(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}

func quoteMySQLIdentifier(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}
