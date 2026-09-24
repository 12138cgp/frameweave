package config

import (
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

type Config struct {
	Port               string `env:"PORT" envDefault:"8080"`
	AdminUsername      string `env:"ADMIN_USERNAME" envDefault:"admin"`
	AdminPassword      string `env:"ADMIN_PASSWORD" envDefault:""`
	JWTSecret          string `env:"JWT_SECRET" envDefault:""`
	JWTExpireHours     int    `env:"JWT_EXPIRE_HOURS" envDefault:"168"`
	StorageDriver      string `env:"STORAGE_DRIVER" envDefault:"postgres"`
	DatabaseDSN        string `env:"DATABASE_DSN" envDefault:""`
	PublicBaseURL      string `env:"PUBLIC_BASE_URL"`
	VolcAccessKey      string `env:"VOLC_ACCESS_KEY"`
	VolcSecretKey      string `env:"VOLC_SECRET_KEY"`
	VolcAssetProject   string `env:"VOLC_ASSET_PROJECT_NAME"`
	VolcAssetRegion    string `env:"VOLC_ASSET_REGION" envDefault:"cn-beijing"`
	VolcAssetGroupName string `env:"VOLC_ASSET_GROUP_NAME" envDefault:"aicanvas-portraits"`
	// 火山 TOS 对象存储：持久化生成的视频/图片/音频，避免上游临时 URL 过期丢失。
	// TOSEndpoint 用 S3 兼容端点(签名 PUT)，TOSPublicBase 用公网读取域名。
	TOSBucket     string `env:"TOS_BUCKET"`
	TOSRegion     string `env:"TOS_REGION" envDefault:"cn-beijing"`
	TOSEndpoint   string `env:"TOS_ENDPOINT" envDefault:"tos-s3-cn-beijing.volces.com"`
	TOSAccessKey  string `env:"TOS_ACCESS_KEY"`
	TOSSecretKey  string `env:"TOS_SECRET_KEY"`
	TOSPublicBase string `env:"TOS_PUBLIC_BASE"`
	// 火山引擎短信服务（登录验证码）：后台「私有配置」优先，未填项回退这些 .env。
	// 注意短信服务仅在 cn-north-1 区域可用。
	VolcSmsAccessKey  string `env:"VOLC_SMS_ACCESS_KEY"`
	VolcSmsSecretKey  string `env:"VOLC_SMS_SECRET_KEY"`
	VolcSmsRegion     string `env:"VOLC_SMS_REGION" envDefault:"cn-north-1"`
	VolcSmsAccount    string `env:"VOLC_SMS_ACCOUNT"`
	VolcSmsSign       string `env:"VOLC_SMS_SIGN"`
	VolcSmsTemplateID string `env:"VOLC_SMS_TEMPLATE_ID"`
	// 可信反向代理列表（逗号分隔，支持精确 IP 与 CIDR 网段）。仅当对端地址命中此列表时，
	// 才信任它传来的 X-Forwarded-For / X-Real-IP，防止客户端伪造 XFF 绕过 IP 限流。
	// ⚠️ 为空时默认信任「回环 + 私有网段」（容器网桥 / k8s Pod 网段），
	// 因为前后端拆容器后对端恒为前端容器的网桥地址；判据见 handler/auth.go 的 isTrustedProxy。
	// 把后端端口直接发布到公网时（不建议），必须在这里显式收紧。
	TrustedProxies string `env:"TRUSTED_PROXIES"`
}

var Cfg Config

func Load() error {
	_ = godotenv.Load()
	if err := env.Parse(&Cfg); err != nil {
		return err
	}
	normalizeDockerSQLiteDSN("/app/data")
	if strings.TrimSpace(Cfg.JWTSecret) == "" || Cfg.JWTSecret == "aicanvas" {
		secret, err := randomSecret()
		if err != nil {
			return err
		}
		Cfg.JWTSecret = secret
	}
	return nil
}

func normalizeDockerSQLiteDSN(appDataDir string) {
	driver := strings.ToLower(strings.TrimSpace(Cfg.StorageDriver))
	if driver != "" && driver != "sqlite" {
		return
	}
	dsn := strings.TrimSpace(Cfg.DatabaseDSN)
	if dsn == "" || dsn == ":memory:" || strings.HasPrefix(dsn, "file:") {
		return
	}
	pathPart, suffix := dsn, ""
	if index := strings.Index(dsn, "?"); index >= 0 {
		pathPart = dsn[:index]
		suffix = dsn[index:]
	}
	if filepath.IsAbs(pathPart) {
		return
	}
	slashPath := filepath.ToSlash(pathPart)
	if slashPath != "data" && !strings.HasPrefix(slashPath, "data/") {
		return
	}
	if _, err := os.Stat(appDataDir); err != nil {
		return
	}
	Cfg.DatabaseDSN = filepath.Join(filepath.Dir(appDataDir), filepath.FromSlash(slashPath)) + suffix
}

func randomSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// DataDir 解析应用数据目录：优先 SQLite DSN 所在目录（Docker 下为 /app/data），
// 其次 /app/data，最后回退相对 data。reference-media / sync-files / prompt-covers 都挂在其下。
func DataDir() string {
	driver := strings.ToLower(strings.TrimSpace(Cfg.StorageDriver))
	dsn := strings.TrimSpace(Cfg.DatabaseDSN)
	if (driver == "" || driver == "sqlite") && dsn != "" && dsn != ":memory:" && !strings.HasPrefix(dsn, "file:") {
		pathPart := dsn
		if index := strings.Index(dsn, "?"); index >= 0 {
			pathPart = dsn[:index]
		}
		if filepath.IsAbs(pathPart) {
			return filepath.Dir(pathPart)
		}
	}
	if _, err := os.Stat("/app/data"); err == nil {
		return "/app/data"
	}
	return "data"
}
