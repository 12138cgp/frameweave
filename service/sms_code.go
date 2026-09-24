package service

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
)

// smsCodeEntry 存储验证码记录。
type smsCodeEntry struct {
	Code     string
	ExpireAt time.Time
	Attempts int // 验证码错误次数（按手机号维度，换 IP 也无法绕过）
}

// smsAttemptEntry 存储暴力破解防护的失败计数与锁定状态。
type smsAttemptEntry struct {
	Count       int       // 连续错误次数
	FirstAt     time.Time // 首次错误时间
	LockedUntil time.Time // 锁定截止时间（零值表示未锁定）
}

var (
	smsCodesMu         sync.Map   // map[string]*smsCodeEntry
	smsAttemptMu       sync.Map   // map[string]*smsAttemptEntry，key = phone + "|" + ip
	smsAttemptLock     sync.Mutex // 保护 smsAttemptMu 的 read-modify-write 操作
	smsCodeTTL         = 5 * time.Minute
	smsCodeMinInterval = 60 * time.Second
)

// checkSmsLoginEnabled 检查后台是否开启了验证码登录注册（public.auth.smsCode）。
// 关闭时返回错误，防止绕过前端 Tab 隐藏直接调 API。
func checkSmsLoginEnabled() error {
	settings, err := repository.GetSettings()
	if err != nil {
		// 读取配置失败 fail-closed：拒绝，避免配置异常时功能默认开放
		return safeMessageError{message: "验证码登录服务暂不可用"}
	}
	normalized := normalizeSettings(settings)
	if normalized.Public.Auth.SmsCode != nil && !*normalized.Public.Auth.SmsCode {
		return safeMessageError{message: "验证码登录未开启"}
	}
	return nil
}

// SendSmsCode 发送短信验证码。
// 返回值: code(仅开发模式下返回验证码), error
func SendSmsCode(phone, ip string) (string, error) {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return "", safeMessageError{message: "手机号不能为空"}
	}
	if !isValidPhone(phone) {
		return "", safeMessageError{message: "手机号格式不正确"}
	}

	// 后台开关校验：关闭时拒绝发送验证码
	if err := checkSmsLoginEnabled(); err != nil {
		return "", err
	}

	// 加载短信服务配置（一次加载，多处使用）
	cfg, ready, err := loadSmsConfig()
	if err != nil {
		return "", err
	}

	// 暴力破解防护：检查是否因连续错误被锁定（fail-closed：配置加载成功才检查，失败已在上方返回）
	if err := checkSmsVerifyLock(phone, ip, cfg); err != nil {
		return "", err
	}

	// 检查发送频率限制
	if entry, ok := smsCodesMu.Load(phone); ok {
		e := entry.(*smsCodeEntry)
		if time.Now().Add(smsCodeMinInterval).After(e.ExpireAt.Add(-smsCodeTTL + smsCodeMinInterval)) {
			// 计算剩余等待时间
			waitTime := smsCodeMinInterval - time.Since(e.ExpireAt.Add(-smsCodeTTL))
			if waitTime > 0 {
				return "", safeMessageError{message: "验证码发送过于频繁，请稍后再试"}
			}
		}
	}

	// 每日发送上限校验。
	// 放在生成验证码之前：超限直接拒绝，不生成验证码、不存内存、不写日志（避免计数膨胀）。
	if err := checkSmsDailyLimit(cfg, phone, ip); err != nil {
		return "", err
	}

	// 生成 6 位验证码
	code, err := generateSmsCode()
	if err != nil {
		return "", err
	}

	// 存储验证码
	entry := &smsCodeEntry{
		Code:     code,
		ExpireAt: time.Now().Add(smsCodeTTL),
	}
	smsCodesMu.Store(phone, entry)

	// 发送短信：
	// - 已启用且 DevMode=true → 调用真实接口发送 + 返回验证码（便于联调）
	// - 已启用且 DevMode=false → 调用真实接口发送，不返回验证码（生产模式）
	// - 未启用时仅 DevMode=true 才允许回退（loadSmsConfig 已做 fail-closed 拦截）
	if !ready {
		if !isSmsDevMode(cfg) {
			return "", safeMessageError{message: "短信服务未启用，请联系管理员开通"}
		}
		// 开发模式：直接返回验证码，不真正发送短信
		recordSmsLog(model.SmsLogStatusSkipped, phone, ip, code, cfg, nil)
		return code, nil
	}
	result, sendErr := volcSendSms(cfg, phone, code)
	if sendErr != nil {
		// 发送失败：清除已存的验证码，避免误用
		smsCodesMu.Delete(phone)
		recordSmsLog(model.SmsLogStatusFailed, phone, ip, code, cfg, result)
		return "", sendErr
	}
	recordSmsLog(model.SmsLogStatusSuccess, phone, ip, code, cfg, result)
	if isSmsDevMode(cfg) {
		// 联调模式：真实发送后仍返回验证码
		return code, nil
	}
	// 生产模式：不返回验证码
	return "", nil
}

// smsCodeMaxAttempts 单个验证码最大尝试次数（按手机号维度，换 IP 也无法绕过）。
// 达到上限后删除验证码，要求重新获取，防止暴力枚举。
const smsCodeMaxAttempts = 5

// VerifySmsCode 校验短信验证码。
// 返回 (ok, err)：ok=true 表示验证成功；err 非 nil 表示尝试过多需重新获取验证码。
func VerifySmsCode(phone string, code string) (bool, error) {
	phone = strings.TrimSpace(phone)
	code = strings.TrimSpace(code)

	if phone == "" || code == "" {
		return false, nil
	}

	entry, ok := smsCodesMu.Load(phone)
	if !ok {
		return false, nil
	}
	e := entry.(*smsCodeEntry)
	if time.Now().After(e.ExpireAt) {
		smsCodesMu.Delete(phone)
		return false, nil
	}

	if e.Code != code {
		e.Attempts++
		if e.Attempts >= smsCodeMaxAttempts {
			// 尝试次数耗尽：删除验证码，要求重新获取
			smsCodesMu.Delete(phone)
			return false, safeMessageError{message: "验证码错误次数过多，请重新获取"}
		}
		return false, nil
	}

	// 验证成功后删除验证码（一次性使用）
	smsCodesMu.Delete(phone)
	return true, nil
}

// SmsLoginOrRegister 手机验证码登录或注册（如果用户不存在则自动注册）。
func SmsLoginOrRegister(phone, ip, code string) (model.AuthSession, error) {
	phone = strings.TrimSpace(phone)
	code = strings.TrimSpace(code)

	if phone == "" {
		return model.AuthSession{}, safeMessageError{message: "手机号不能为空"}
	}
	if !isValidPhone(phone) {
		return model.AuthSession{}, safeMessageError{message: "手机号格式不正确"}
	}
	if code == "" {
		return model.AuthSession{}, safeMessageError{message: "验证码不能为空"}
	}

	// 后台开关校验：关闭时拒绝登录，防止绕过前端 Tab 隐藏直接调 API
	if err := checkSmsLoginEnabled(); err != nil {
		return model.AuthSession{}, err
	}

	// 加载配置（含暴力破解防护参数）
	cfg, _, cfgErr := loadSmsConfig()
	if cfgErr != nil || (cfg.Enabled == nil || !*cfg.Enabled) && !isSmsDevMode(cfg) {
		return model.AuthSession{}, safeMessageError{message: "短信登录服务未启用"}
	}

	// 暴力破解防护：检查是否因连续错误被锁定
	if err := checkSmsVerifyLock(phone, ip, cfg); err != nil {
		return model.AuthSession{}, err
	}

	ok, verifyErr := VerifySmsCode(phone, code)
	if !ok {
		// 记录失败次数（按 phone|ip 维度），达到上限时返回锁定错误
		if err := recordSmsVerifyFailure(phone, ip, cfg); err != nil {
			return model.AuthSession{}, err
		}
		// verifyErr 非 nil 表示验证码尝试次数耗尽已失效，需重新获取
		if verifyErr != nil {
			return model.AuthSession{}, verifyErr
		}
		return model.AuthSession{}, safeMessageError{message: "验证码错误或已过期"}
	}

	// 验证成功：重置失败计数
	resetSmsVerifyAttempts(phone, ip)

	// 检查是否允许注册
	settings, err := repository.GetSettings()
	if err != nil {
		return model.AuthSession{}, err
	}
	normalizedSettings := normalizeSettings(settings)
	if normalizedSettings.Public.Auth.AllowRegister != nil && !*normalizedSettings.Public.Auth.AllowRegister {
		// 允许登录但不允许注册
	}

	// 查找用户
	user, ok, err := repository.GetUserByPhone(phone)
	if err != nil {
		return model.AuthSession{}, err
	}

	if !ok {
		// 新用户自动注册
		if normalizedSettings.Public.Auth.AllowRegister != nil && !*normalizedSettings.Public.Auth.AllowRegister {
			return model.AuthSession{}, safeMessageError{message: "当前未开放注册"}
		}

		username := "phone_" + phone
		// 检查用户名是否已存在
		if exists, err := repository.UsernameExistsCI(username); err != nil {
			return model.AuthSession{}, err
		} else if exists {
			return model.AuthSession{}, safeMessageError{message: "用户名已存在，请联系管理员"}
		}

		user = model.User{
			ID:          newID("user"),
			Username:    username,
			Phone:       phone,
			Role:        model.UserRoleUser,
			DisplayName: "用户" + phone[len(phone)-4:],
			AffCode:     newAffCode(),
			Status:      model.UserStatusActive,
			CreatedAt:   now(),
			UpdatedAt:   now(),
		}
	} else {
		// 检查账号状态
		if user.Status == model.UserStatusBan {
			return model.AuthSession{}, safeMessageError{message: "账号已被禁用"}
		}

		// 更新手机号
		user.Phone = phone
		normalizeUserDefaults(&user)
		user.LastLoginAt = now()
		user.UpdatedAt = now()
	}

	// 新用户整行写入初始值；已存在的用户只写登录相关列，避免覆盖 credits/session_id
	//（见 repository/user.go UpdateUserOnLogin 的说明）。
	if !ok {
		user, err = repository.SaveUser(user)
	} else {
		user, err = repository.UpdateUserOnLogin(user)
	}
	if err != nil {
		return model.AuthSession{}, err
	}

	return newSession(user)
}

// generateSmsCode 生成 6 位数字验证码。
func generateSmsCode() (string, error) {
	const digits = 6
	const max = 1 << 31
	var buf [digits]byte
	for i := range buf {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		buf[i] = byte('0' + n.Int64())
	}
	return string(buf[:]), nil
}

// isValidPhone 校验手机号格式（中国大陆手机号）。
func isValidPhone(phone string) bool {
	if len(phone) != 11 {
		return false
	}
	for _, c := range phone {
		if c < '0' || c > '9' {
			return false
		}
	}
	// 简单校验：以 1 开头
	return phone[0] == '1'
}

// smsAttemptKey 生成暴力破解防护的 key：phone + "|" + ip。
// ip 为空时用 "_" 占位。
func smsAttemptKey(phone, ip string) string {
	if ip == "" {
		ip = "_"
	}
	return phone + "|" + ip
}

// checkSmsVerifyLock 检查指定 phone+IP 是否被锁定。
// 若已锁定且未到期，返回 safeMessageError 告知剩余锁定时间。
func checkSmsVerifyLock(phone, ip string, cfg model.SmsSetting) error {
	key := smsAttemptKey(phone, ip)
	entry, ok := smsAttemptMu.Load(key)
	if !ok {
		return nil
	}
	e := entry.(*smsAttemptEntry)
	// LockedUntil 为零值表示从未锁定（只是累计了失败次数），不删除记录
	if e.LockedUntil.IsZero() {
		return nil
	}
	now := time.Now()
	if now.Before(e.LockedUntil) {
		// 仍在锁定期
		remaining := int(time.Until(e.LockedUntil).Seconds())
		minutes := remaining / 60
		seconds := remaining % 60
		var msg string
		if minutes > 0 {
			msg = fmt.Sprintf("验证码错误次数过多，请 %d 分 %d 秒后再试", minutes, seconds)
		} else {
			msg = fmt.Sprintf("验证码错误次数过多，请 %d 秒后再试", seconds)
		}
		return safeMessageError{message: msg}
	}
	// 锁已过期，删除记录，重新开始计数
	smsAttemptMu.Delete(key)
	return nil
}

// recordSmsVerifyFailure 记录一次验证码验证失败，达到上限时返回锁定错误。
// 使用 smsAttemptLock 保护 read-modify-write 操作，避免并发竞态。
func recordSmsVerifyFailure(phone, ip string, cfg model.SmsSetting) error {
	smsAttemptLock.Lock()
	defer smsAttemptLock.Unlock()

	key := smsAttemptKey(phone, ip)
	now := time.Now()
	entry, ok := smsAttemptMu.Load(key)
	if !ok {
		entry = &smsAttemptEntry{
			Count:   1,
			FirstAt: now,
		}
	} else {
		e := entry.(*smsAttemptEntry)
		e.Count++
		entry = e
	}
	e := entry.(*smsAttemptEntry)
	if e.Count >= cfg.VerifyMaxAttempts {
		e.LockedUntil = now.Add(time.Duration(cfg.VerifyLockMinutes) * time.Minute)
		smsAttemptMu.Store(key, e)
		// 达到上限：立即返回锁定错误，而非"验证码错误"
		remaining := int(time.Until(e.LockedUntil).Seconds())
		minutes := remaining / 60
		seconds := remaining % 60
		var msg string
		if minutes > 0 {
			msg = fmt.Sprintf("验证码错误次数过多，请 %d 分 %d 秒后再试", minutes, seconds)
		} else {
			msg = fmt.Sprintf("验证码错误次数过多，请 %d 秒后再试", seconds)
		}
		return safeMessageError{message: msg}
	}
	smsAttemptMu.Store(key, e)
	return nil
}

// resetSmsVerifyAttempts 重置指定 phone+IP 的失败计数（验证成功后调用）。
func resetSmsVerifyAttempts(phone, ip string) {
	smsAttemptMu.Delete(smsAttemptKey(phone, ip))
}

// 后台 GC：smsCodesMu / smsAttemptMu 的条目仅在「被访问」时按过期删除，
// 未被再次访问的过期条目会长期驻留导致内存持续增长（攻击者轮换大量手机号请求验证码但不验证即可放大）。
// 启动一个低频协程定期遍历两个 map 主动回收。与 handler.StartVideoRefundSweeper 同一后台协程范式。
const (
	smsCodeGCInterval  = 5 * time.Minute // 扫描周期
	smsAttemptStaleAge = 1 * time.Hour   // LockedUntil 零值且 FirstAt 早于此的陈旧计数视为可回收
)

// StartSmsCodeGC 启动验证码与暴力破解计数的后台回收协程。
// 安全性：仅删除已过期/陈旧条目，不影响有效条目；Delete 是原子操作，
// 与 checkSmsVerifyLock/recordSmsVerifyFailure 的 read-modify-write 无竞态
// （最坏情况：GC 删除瞬间有人 Store 重建，下一轮再清，不影响计数正确性）。
func StartSmsCodeGC() {
	go func() {
		ticker := time.NewTicker(smsCodeGCInterval)
		defer ticker.Stop()
		for range ticker.C {
			sweepSmsCodes()
		}
	}()
}

// sweepSmsCodes 单次扫描：删除过期验证码条目与陈旧/已解锁的失败计数条目。
func sweepSmsCodes() {
	now := time.Now()
	// 1) smsCodesMu：删除 ExpireAt 已过的验证码
	smsCodesMu.Range(func(key, value any) bool {
		e, ok := value.(*smsCodeEntry)
		if !ok || now.After(e.ExpireAt) {
			smsCodesMu.Delete(key)
		}
		return true
	})
	// 2) smsAttemptMu：删除「锁已过期」或「未锁定但陈旧」的计数条目
	smsAttemptMu.Range(func(key, value any) bool {
		e, ok := value.(*smsAttemptEntry)
		if !ok {
			smsAttemptMu.Delete(key)
			return true
		}
		if !e.LockedUntil.IsZero() {
			// 已锁定：锁过期即可回收（checkSmsVerifyLock 仅在被访问时删，未访问的泄漏由这里兜底）
			if now.After(e.LockedUntil) {
				smsAttemptMu.Delete(key)
			}
			return true
		}
		// 未锁定（LockedUntil 零值）：仅累计了失败次数但未达上限。
		// FirstAt 超过 smsAttemptStaleAge 视为用户已放弃，回收计数，避免长期驻留。
		if !e.FirstAt.IsZero() && now.Sub(e.FirstAt) > smsAttemptStaleAge {
			smsAttemptMu.Delete(key)
		}
		return true
	})
}
