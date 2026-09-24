package service

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"time"

	"aicanvas/config"
	"aicanvas/repository"
	"github.com/google/uuid"
)

// tosStorageConfig 一次上传所用的对象存储桶配置（S3 兼容）。
type tosStorageConfig struct {
	Bucket     string
	Endpoint   string
	Region     string
	AccessKey  string
	SecretKey  string
	PublicBase string
}

// complete 返回该配置是否足以完成一次「上传并生成可访问 URL」：
// 桶名/端点/AK/SK/公网域名缺一不可（Region 有默认值，不强制）。
func (cfg tosStorageConfig) complete() bool {
	return cfg.Bucket != "" && cfg.Endpoint != "" && cfg.AccessKey != "" && cfg.SecretKey != "" && cfg.PublicBase != ""
}

// errTOSNotConfigured 全局与分组均未配置可用对象存储时返回（携带用户可读消息）。
var errTOSNotConfigured = safeMessageError{message: "未配置对象存储(TOS)"}

// globalTOSConfig 读取全局 .env 的 TOS 配置（匿名/兜底路径 + 老组回退）。
func globalTOSConfig() tosStorageConfig {
	c := config.Cfg
	return tosStorageConfig{
		Bucket:     strings.TrimSpace(c.TOSBucket),
		Endpoint:   strings.TrimSpace(c.TOSEndpoint),
		Region:     strings.TrimSpace(c.TOSRegion),
		AccessKey:  strings.TrimSpace(c.TOSAccessKey),
		SecretKey:  strings.TrimSpace(c.TOSSecretKey),
		PublicBase: strings.TrimSpace(c.TOSPublicBase),
	}
}

// loadTOSConfigForUser 按用户所属分组解析该用户上传应使用的对象存储桶：
//   - 组未启用自有桶（TOSBucket 为空）：回退全局配置（兼容老组/未分组用户/匿名）。
//   - 组已启用自有桶（TOSBucket 非空）：整体使用组配置（AK/SK/PublicBase 必须齐全，
//     Endpoint/Region 留空则继承全局默认）。此时绝不借用全局 AK/SK/公共桶——
//     配置不完整直接返回错误（不静默回退全局公共桶，防跨组数据写混入）。
//
// 返回的 error 携带用户可读消息（safeMessageError），可经 FailError 透传前端。
func loadTOSConfigForUser(userID string) (tosStorageConfig, error) {
	global := globalTOSConfig()

	user, ok, err := repository.GetUserByID(userID)
	if err != nil {
		return tosStorageConfig{}, err
	}
	if ok && strings.TrimSpace(user.GroupID) != "" {
		if group, gok, gerr := repository.GetGroupByID(user.GroupID); gerr == nil && gok {
			if strings.TrimSpace(group.TOSBucket) != "" {
				// 该组启用了自有桶：整体用组凭证，Endpoint/Region 缺省继承全局默认。
				cfg := tosStorageConfig{
					Bucket:     strings.TrimSpace(group.TOSBucket),
					Endpoint:   firstNonEmpty(strings.TrimSpace(group.TOSEndpoint), global.Endpoint, "tos-s3-cn-beijing.volces.com"),
					Region:     firstNonEmpty(strings.TrimSpace(group.TOSRegion), global.Region, "cn-beijing"),
					AccessKey:  strings.TrimSpace(group.TOSAccessKey),
					SecretKey:  strings.TrimSpace(group.TOSSecretKey),
					PublicBase: strings.TrimSpace(group.TOSPublicBase),
				}
				if cfg.AccessKey == "" || cfg.SecretKey == "" || cfg.PublicBase == "" {
					return tosStorageConfig{}, safeMessageError{message: "所属分组的对象存储配置不完整（需填写桶名 / AccessKey / SecretKey / 公网访问域名），请联系管理员在后台补全"}
				}
				return cfg, nil
			}
		}
	}

	// 组未启用自有桶 → 回退全局。
	if !global.complete() {
		return tosStorageConfig{}, errTOSNotConfigured
	}
	return global, nil
}

// TOSConfiguredForUser 返回该用户（含其分组自有桶或全局兜底）是否有可用对象存储。
// 组启用了自有桶但配置不完整时返回 false（会命中 loadTOSConfigForUser 的报错分支）。
func TOSConfiguredForUser(userID string) bool {
	_, err := loadTOSConfigForUser(userID)
	return err == nil
}

// UploadToTOSForUser 按用户所属组的桶配置上传 data 到 key，返回公网 URL。
func UploadToTOSForUser(userID, key string, data []byte, contentType string) (string, error) {
	cfg, err := loadTOSConfigForUser(userID)
	if err != nil {
		return "", err
	}
	return uploadToTOSWithConfig(cfg, key, data, contentType)
}

// UploadStreamToTOSForUser 同上，但从 io.ReadSeeker 流式上传，不把整个文件读进内存。
// 大文件（视频）上传走这条，避免几百 MB 常驻内存。
func UploadStreamToTOSForUser(userID, key string, body io.ReadSeeker, size int64, contentType string) (string, error) {
	cfg, err := loadTOSConfigForUser(userID)
	if err != nil {
		return "", err
	}
	return uploadStreamToTOSWithConfig(cfg, key, body, size, contentType)
}

// FetchAndUploadToTOSForUser 按用户所属组的桶配置：服务端下载 srcURL 再转存，返回公网 URL。
func FetchAndUploadToTOSForUser(userID, srcURL, key, contentType string, maxBytes int64) (string, error) {
	saved, err := FetchAndUploadToTOSForUserDetailed(userID, srcURL, key, contentType, maxBytes)
	return saved.URL, err
}

// FetchAndUploadToTOSForUserDetailed 同上，但把字节数与实际 Content-Type 一并返回，供 sync_files 登记。
func FetchAndUploadToTOSForUserDetailed(userID, srcURL, key, contentType string, maxBytes int64) (UploadedMedia, error) {
	cfg, err := loadTOSConfigForUser(userID)
	if err != nil {
		return UploadedMedia{}, err
	}
	return fetchAndUploadWithConfig(cfg, srcURL, key, contentType, maxBytes)
}

// TestTOSStorageForInput 用后台填写的桶配置做一次连通性自检（供管理员保存前验证）：
// ① 用 AK/SK 向桶写入一个极小测试对象（验证桶名/Endpoint/Region/AK/SK 与写权限）；
// ② 再从 PublicBase 拼出的公网 URL 读回，校验内容一致（验证「公共读」与 PublicBase 是否指向该桶）。
// Endpoint/Region 留空时按运行时同样的规则继承全局默认。测试对象写在 _healthcheck/ 前缀下（几十字节）。
func TestTOSStorageForInput(bucket, endpoint, region, accessKey, secretKey, publicBase string) error {
	global := globalTOSConfig()
	cfg := tosStorageConfig{
		Bucket:     strings.TrimSpace(bucket),
		Endpoint:   firstNonEmpty(strings.TrimSpace(endpoint), global.Endpoint, "tos-s3-cn-beijing.volces.com"),
		Region:     firstNonEmpty(strings.TrimSpace(region), global.Region, "cn-beijing"),
		AccessKey:  strings.TrimSpace(accessKey),
		SecretKey:  strings.TrimSpace(secretKey),
		PublicBase: strings.TrimSpace(publicBase),
	}
	if cfg.Bucket == "" || cfg.AccessKey == "" || cfg.SecretKey == "" || cfg.PublicBase == "" {
		return safeMessageError{message: "请先填写桶名、AccessKey、SecretKey、公网访问域名后再测试"}
	}

	token := strings.ReplaceAll(uuid.NewString(), "-", "")
	key := "_healthcheck/" + token + ".txt"
	payload := []byte("aicanvas storage healthcheck " + token)

	url, err := uploadToTOSWithConfig(cfg, key, payload, "text/plain")
	if err != nil {
		return safeMessageError{message: "写入测试失败：" + shortErr(err) + "（请核对桶名 / Endpoint / Region / AccessKey / SecretKey，并确认该密钥对此桶有写权限）"}
	}

	// 读回校验（含轻量重试，兜住极少数写后读传播延迟）。
	var lastStatus int
	var body []byte
	for attempt := 0; attempt < 3; attempt++ {
		resp, gerr := SafeHTTPClient(20 * time.Second).Get(url)
		if gerr != nil {
			return safeMessageError{message: "已写入但从公网读回失败：" + shortErr(gerr) + "（请核对公网访问域名 PublicBase 是否正确、可被公网访问）"}
		}
		lastStatus = resp.StatusCode
		body, _ = io.ReadAll(io.LimitReader(resp.Body, 256))
		resp.Body.Close()
		if lastStatus == 200 {
			break
		}
		time.Sleep(800 * time.Millisecond)
	}
	if lastStatus != 200 {
		return safeMessageError{message: fmt.Sprintf("测试对象已写入，但公网读回返回 %d（请确认桶已开启「公共读」权限、且 PublicBase=%s 正确指向该桶）", lastStatus, cfg.PublicBase)}
	}
	if !bytes.Contains(body, []byte(token)) {
		return safeMessageError{message: "公网读回成功但内容不符（PublicBase 可能指向了另一个桶/路径，请核对公网访问域名）"}
	}
	return nil
}

// shortErr 把底层错误压成单行、限长，避免把冗长的桶侧报文原样抛给前端。
func shortErr(err error) string {
	msg := strings.Join(strings.Fields(strings.TrimSpace(err.Error())), " ")
	if runes := []rune(msg); len(runes) > 200 {
		msg = string(runes[:200]) + "..."
	}
	return msg
}
