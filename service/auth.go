package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"aicanvas/config"
	"aicanvas/model"
	"aicanvas/repository"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type TokenClaims struct {
	SessionID string         `json:"sessionId,omitempty"`
	UserID    string         `json:"userId"`
	Username  string         `json:"username"`
	Role      model.UserRole `json:"role"`
	jwt.RegisteredClaims
}

// EnsureDefaultAdmin 首次启动时按 ADMIN_USERNAME / ADMIN_PASSWORD 创建初始管理员。
//
// ⚠️ WarnDefaultSecurityConfig 必须在下面那个 early return 之【前】调用。
// 漏填 ADMIN_PASSWORD 正是它要警告的那个故障：这里直接 return nil，服务照常启动
// （端口在听、健康检查通过、登录页也打得开），但库里一个管理员都没有，谁都进不了后台。
// 一旦警告被 return 跳过，日志里连一个字的线索都没有 —— 这条顺序本身就是修复。
func EnsureDefaultAdmin() error {
	WarnDefaultSecurityConfig()
	if strings.TrimSpace(config.Cfg.AdminUsername) == "" || strings.TrimSpace(config.Cfg.AdminPassword) == "" {
		return nil
	}
	hasAdmin, err := repository.HasAdmin()
	if err != nil || hasAdmin {
		return err
	}
	hash, err := hashPassword(config.Cfg.AdminPassword)
	if err != nil {
		return err
	}
	_, err = repository.SaveUser(model.User{
		ID:        newID("user"),
		Username:  strings.TrimSpace(config.Cfg.AdminUsername),
		Password:  hash,
		Role:      model.UserRoleAdmin,
		AffCode:   newAffCode(),
		Status:    model.UserStatusActive,
		CreatedAt: now(),
		UpdatedAt: now(),
	})
	return err
}

func Register(username string, password string) (model.AuthSession, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.AuthSession{}, err
	}
	normalizedSettings := normalizeSettings(settings)
	if normalizedSettings.Public.Auth.AllowRegister != nil && !*normalizedSettings.Public.Auth.AllowRegister {
		return model.AuthSession{}, safeMessageError{message: "当前未开放注册"}
	}
	username = strings.TrimSpace(username)
	if strings.ContainsAny(username, " \t\r\n") {
		return model.AuthSession{}, safeMessageError{message: "用户名不能包含空格"}
	}
	if username == "" {
		return model.AuthSession{}, safeMessageError{message: "用户名不能为空"}
	}
	if err := validatePassword(password); err != nil {
		return model.AuthSession{}, err
	}
	// 重名检查不区分大小写：Alice/alice/ALICE 视为同名，避免近似账号；提示用户改名。
	if exists, err := repository.UsernameExistsCI(username); err != nil {
		return model.AuthSession{}, err
	} else if exists {
		return model.AuthSession{}, safeMessageError{message: "用户名已存在，请换一个"}
	}
	hash, err := hashPassword(password)
	if err != nil {
		return model.AuthSession{}, err
	}
	user, err := repository.SaveUser(model.User{
		ID:        newID("user"),
		Username:  username,
		Password:  hash,
		Role:      model.UserRoleUser,
		AffCode:   newAffCode(),
		Status:    model.UserStatusActive,
		CreatedAt: now(),
		UpdatedAt: now(),
	})
	if err != nil {
		return model.AuthSession{}, err
	}
	return newSession(user)
}

func Login(username string, password string, ip string) (model.AuthSession, error) {
	// 登录失败锁定：连续错误达上限后直接拒绝，避免公网后台被无限次爆破。
	if err := checkLoginLock(username, ip); err != nil {
		return model.AuthSession{}, err
	}
	user, ok, err := repository.GetUserByUsername(strings.TrimSpace(username))
	if err != nil {
		return model.AuthSession{}, err
	}
	if !ok || bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(password)) != nil {
		// 密码错误或用户不存在：记一次失败，达上限时返回锁定提示。
		if lockErr := recordLoginFailure(username, ip); lockErr != nil {
			return model.AuthSession{}, lockErr
		}
		return model.AuthSession{}, safeMessageError{message: "用户名或密码错误"}
	}
	// 密码正确即重置失败计数，无论账号是否被禁用（避免禁用账号被旁人卡死）。
	resetLoginAttempts(username, ip)
	if user.Status == model.UserStatusBan {
		return model.AuthSession{}, safeMessageError{message: "账号已被禁用"}
	}
	normalizeUserDefaults(&user)
	user.LastLoginAt = now()
	user.UpdatedAt = now()
	// 登录只写登录相关列：以前这里是整行 db.Save，等于每次登录都拿一份刚读出来的
	// 快照覆盖 credits/session_id（见 repository/user.go UpdateUserOnLogin 的说明）。
	user, err = repository.UpdateUserOnLogin(user)
	if err != nil {
		return model.AuthSession{}, err
	}
	return newSession(user)
}

func ParseToken(tokenText string) (TokenClaims, error) {
	claims := TokenClaims{}
	token, err := jwt.ParseWithClaims(tokenText, &claims, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("登录状态无效")
		}
		return []byte(config.Cfg.JWTSecret), nil
	})
	if err != nil || !token.Valid {
		return TokenClaims{}, errors.New("登录状态无效")
	}
	return claims, nil
}

func CurrentAuthUser(tokenText string) (model.AuthUser, bool) {
	claims, err := ParseToken(tokenText)
	if err != nil {
		return model.AuthUser{}, false
	}
	user, ok, err := repository.GetUserByID(claims.UserID)
	if err != nil || !ok {
		return model.AuthUser{}, false
	}
	if user.Status == model.UserStatusBan {
		return model.AuthUser{}, false
	}
	// 单设备登录：会话 ID 不匹配说明账号已在其他设备登录（空 SessionID 为升级前的存量用户，放行）。
	if user.SessionID != "" && claims.SessionID != user.SessionID {
		return model.AuthUser{}, false
	}
	return model.PublicUser(user), true
}

func ListUsers(q model.Query) (model.UserList, error) {
	users, total, err := repository.ListUsers(q)
	if err != nil {
		return model.UserList{}, err
	}
	for i := range users {
		users[i].Password = ""
		normalizeUserDefaults(&users[i])
	}
	return model.UserList{Items: users, Total: int(total)}, nil
}

func SaveUser(user model.User, password string) (model.User, error) {
	user.Username = strings.TrimSpace(user.Username)
	if strings.ContainsAny(user.Username, " \t\r\n") {
		return user, safeMessageError{message: "用户名不能包含空格"}
	}
	if user.Username == "" {
		return user, safeMessageError{message: "用户名不能为空"}
	}
	if user.Role == "" || user.Role == model.UserRoleGuest {
		user.Role = model.UserRoleUser
	}
	if user.Status == "" {
		user.Status = model.UserStatusActive
	}
	if saved, ok, err := repository.GetUserByUsername(user.Username); err != nil {
		return user, err
	} else if ok && saved.ID != user.ID {
		return user, safeMessageError{message: "用户名已存在"}
	}
	isCreate := user.ID == ""
	if isCreate {
		user.ID = newID("user")
		user.AffCode = newAffCode()
		user.CreatedAt = now()
	} else if saved, ok, err := repository.GetUserByID(user.ID); err != nil {
		return user, err
	} else if ok {
		user.CreatedAt = saved.CreatedAt
		user.Password = saved.Password
		user.AvatarURL = saved.AvatarURL
		user.Credits = saved.Credits
		user.Extra = saved.Extra
		user.SessionID = saved.SessionID
		// PriceOverride 编辑时保留旧值：只能经超管专用「分级定价」端点改，用户表单保存不碰它。
		user.PriceOverride = saved.PriceOverride
		// CreatorID 编辑时保留旧值：禁止被请求体清空/篡改（数据隔离归属字段）。
		user.CreatorID = saved.CreatorID
		if user.AffCode == "" {
			user.AffCode = saved.AffCode
		}
		if user.AffCode == "" {
			user.AffCode = newAffCode()
		}
		user.LastLoginAt = saved.LastLoginAt
	}
	if password != "" {
		if err := validatePassword(password); err != nil {
			return user, err
		}
		hash, err := hashPassword(password)
		if err != nil {
			return user, err
		}
		user.Password = hash
	}
	if isCreate && user.Password == "" {
		return user, safeMessageError{message: "密码不能为空"}
	}
	user.UpdatedAt = now()
	// 新建走整行写（credits 等列要写入初始值）；编辑走 UpdateUserForm——
	// 它在 SQL 层就跳过 credits/price_override/session_id/last_login_at。
	// 上面那段「从 DB 读回旧值再塞进结构体」保不住这些字段：读在事务外，
	// 读与写之间发生的调额会被这次整行写回抹掉（一次就能丢掉上千点数，
	// 详见 repository/user.go 里 userFormProtectedColumns 的说明）。那段保留逻辑现在只是双保险。
	var err error
	if isCreate {
		user, err = repository.SaveUser(user)
	} else {
		user, err = repository.UpdateUserForm(user)
	}
	user.Password = ""
	return user, err
}

func AdjustUserCredits(id string, credits int, operatorID string) (model.User, error) {
	// 原子调额：在单事务内更新 credits 并记流水（Amount/Balance 由仓库读事务内旧值算）。
	// 不再用「事务外 GetUserByID → 改内存 → SaveUser 全行写回」——那会用旧快照覆盖期间并发的扣费/退款。
	ts := now()
	user, found, err := repository.AdjustUserCreditsTx(id, credits, ts, model.CreditLog{
		ID:         newID("credit"),
		UserID:     id,
		Type:       model.CreditLogTypeAdminAdjust,
		OperatorID: operatorID,
		Remark:     "后台手动调整",
		CreatedAt:  ts,
	})
	if err != nil {
		return model.User{}, err
	}
	if !found {
		return model.User{}, safeMessageError{message: "用户不存在"}
	}
	user.Password = ""
	return user, nil
}

func ConsumeUserCredits(userID string, modelName string, credits int, path string) error {
	if credits <= 0 {
		return nil
	}
	extra, _ := json.Marshal(map[string]string{"model": modelName, "path": path})
	// 扣费与流水写入同事务，避免「扣了钱却没流水」的对不上账
	ok, err := repository.ConsumeUserCreditsTx(userID, credits, now(), model.CreditLog{
		ID:        newID("credit"),
		UserID:    userID,
		Type:      model.CreditLogTypeAIConsume,
		Amount:    -credits,
		Remark:    "调用模型 " + modelName,
		Extra:     string(extra),
		CreatedAt: now(),
	})
	if err != nil {
		return err
	}
	if !ok {
		return safeMessageError{message: "点数不足"}
	}
	return nil
}

// SettleRefundUserCredits 结算退款（按秒计价的「多退」那一半）。
//
// 与 RefundUserCredits 的唯一区别是**流水备注**：那个函数的备注写死「模型调用失败返还」，
// 而结算退的是「预扣多了的差额」，生成本身是成功的。沿用它会让用户在「点数日志」和
// 「我的消耗」里看到一连串「模型调用失败返还」，以为音频一直在失败——实际每条都成功了。
// 备注要能自证是哪一类动账，这是对账的最低要求。
func SettleRefundUserCredits(userID string, modelName string, credits int, path string) error {
	if credits <= 0 {
		return nil
	}
	extra, _ := json.Marshal(map[string]string{"model": modelName, "path": path, "settle": "1"})
	ok, err := repository.RefundUserCreditsTx(userID, credits, now(), model.CreditLog{
		ID:        newID("credit"),
		UserID:    userID,
		Type:      model.CreditLogTypeAIRefund,
		Amount:    credits,
		Remark:    "按实际时长结算返还 " + modelName,
		Extra:     string(extra),
		CreatedAt: now(),
	})
	if err != nil {
		return err
	}
	if !ok {
		return safeMessageError{message: "用户不存在"}
	}
	return nil
}

// SettleConsumeUserCredits 结算补扣（按秒计价的「少补」那一半）。
// 与 ConsumeUserCredits 的区别只有一个：**余额不足也照扣，允许扣成负数**。
//
// 音频已经交付给用户了，此时「余额不够就放弃扣费」等于白送，而且可被反复利用
// （目标时长选 1 秒预扣、提示词里要 120 秒）。让余额变负是唯一诚实的记法：
// 账面如实反映欠账，下一次生成会被 ConsumeUserCredits 的余额校验自然挡住。
func SettleConsumeUserCredits(userID string, modelName string, credits int, path string) error {
	if credits <= 0 {
		return nil
	}
	extra, _ := json.Marshal(map[string]string{"model": modelName, "path": path, "settle": "1"})
	return repository.SettleConsumeUserCreditsTx(userID, credits, now(), model.CreditLog{
		ID:        newID("credit"),
		UserID:    userID,
		Type:      model.CreditLogTypeAIConsume,
		Amount:    -credits,
		Remark:    "按实际时长结算 " + modelName,
		Extra:     string(extra),
		CreatedAt: now(),
	})
}

func RefundUserCredits(userID string, modelName string, credits int, path string) error {
	if credits <= 0 {
		return nil
	}
	extra, _ := json.Marshal(map[string]string{"model": modelName, "path": path})
	// 退款与流水写入同事务
	ok, err := repository.RefundUserCreditsTx(userID, credits, now(), model.CreditLog{
		ID:        newID("credit"),
		UserID:    userID,
		Type:      model.CreditLogTypeAIRefund,
		Amount:    credits,
		Remark:    "模型调用失败返还 " + modelName,
		Extra:     string(extra),
		CreatedAt: now(),
	})
	if err != nil {
		return err
	}
	if !ok {
		return safeMessageError{message: "用户不存在"}
	}
	return nil
}

// RefundVideoAtomic 视频任务失败时按当初扣费来源退款，mark + 退款 + 记账同一事务、幂等只退一次。
// 替代旧的「MarkVideoRefunded 先置位 → 再独立退款」两段式（标记成功但退款失败会永久漏退）。
// 返回 did=true 表示本次执行了退款；false=已退过 / 无候选。
func RefundVideoAtomic(taskID, path string) (bool, error) {
	vr, ok, err := repository.GetVideoRefund(taskID)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil // 无候选（非本应用扣费的任务）
	}
	remark := "模型调用失败返还 " + vr.Model
	if vr.ChargedToProject {
		remark = "项目模型调用失败返还 " + vr.Model
	}
	extra, _ := json.Marshal(map[string]string{"model": vr.Model, "path": path})
	return repository.RefundVideoTx(taskID, now(), model.CreditLog{
		ID:        newID("credit"),
		Type:      model.CreditLogTypeAIRefund,
		Remark:    remark,
		Extra:     string(extra),
		CreatedAt: now(),
	})
}

func ListCreditLogs(q model.Query) (model.CreditLogList, error) {
	logs, total, err := repository.ListCreditLogs(q)
	if err != nil {
		return model.CreditLogList{}, err
	}
	return model.CreditLogList{Items: logs, Total: int(total)}, nil
}

// ListAllCreditLogs 导出用：不分页返回筛选后的全部流水（上限见 repository.maxCreditLogExport）。
func ListAllCreditLogs(q model.Query) ([]model.CreditLog, error) {
	return repository.ListCreditLogsAll(q)
}

// SummarizeCreditLogs 当前筛选下的总汇总（顶部总数）+ 按成员逐人汇总 + 按模型汇总。
func SummarizeCreditLogs(q model.Query) (model.CreditLogSummary, []model.CreditLogMemberStat, []model.CreditLogModelStat, error) {
	return repository.SummarizeCreditLogs(q)
}

func SaveCreditLog(log model.CreditLog) (model.CreditLog, error) {
	if log.ID == "" {
		log.ID = newID("credit")
		log.CreatedAt = now()
	}
	return repository.SaveCreditLog(log)
}

func DeleteCreditLog(id string) error {
	return repository.DeleteCreditLog(id)
}

func DeleteUser(id string) error {
	return repository.DeleteUser(id)
}

func GuestUser() model.AuthUser {
	return model.AuthUser{ID: "", Username: "guest", Role: model.UserRoleGuest}
}

func newSession(user model.User) (model.AuthSession, error) {
	// 每次登录旋转会话 ID：同一账号在新设备登录后，旧设备的 token 立即失效。
	sessionID := uuid.NewString()
	if err := repository.UpdateUserSessionID(user.ID, sessionID); err != nil {
		return model.AuthSession{}, err
	}
	user.SessionID = sessionID
	token, err := newToken(user)
	if err != nil {
		return model.AuthSession{}, err
	}
	return model.AuthSession{Token: token, User: model.PublicUser(user)}, nil
}

func newToken(user model.User) (string, error) {
	expireHours := config.Cfg.JWTExpireHours
	if expireHours <= 0 {
		expireHours = 168
	}
	claims := TokenClaims{
		SessionID: user.SessionID,
		UserID:    user.ID,
		Username:  user.Username,
		Role:      user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Duration(expireHours) * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Subject:   user.ID,
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(config.Cfg.JWTSecret))
}

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}

func now() string {
	return time.Now().Format(time.RFC3339)
}

func newID(prefix string) string {
	return prefix + "-" + uuid.NewString()
}

func newAffCode() string {
	return strings.ToUpper(strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
}

func normalizeUserDefaults(user *model.User) {
	if user.Status == "" {
		user.Status = model.UserStatusActive
	}
	if user.AffCode == "" {
		user.AffCode = newAffCode()
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// WarnDefaultSecurityConfig 检查初始管理员配置，缺项时在启动日志里明确报出来。
//
// ADMIN_USERNAME / ADMIN_PASSWORD 任一为空 → 不会创建任何管理员账号，而服务照常启动，
// 唯一的症状是「谁都登不进后台」。这条日志是排查那个故障的唯一线索，
// 所以调用点必须在任何提前返回之前（见 EnsureDefaultAdmin）。
func WarnDefaultSecurityConfig() {
	missing := make([]string, 0, 2)
	if strings.TrimSpace(config.Cfg.AdminUsername) == "" {
		missing = append(missing, "ADMIN_USERNAME")
	}
	if strings.TrimSpace(config.Cfg.AdminPassword) == "" {
		missing = append(missing, "ADMIN_PASSWORD")
	}
	if len(missing) == 0 {
		return
	}
	names := strings.Join(missing, " / ")
	log.Printf("⚠️ 警告：%s 未配置，【未创建初始管理员】，没有任何账号能登录后台。"+
		"请在运行时环境变量文件里填好 ADMIN_USERNAME 与 ADMIN_PASSWORD 后重启容器"+
		"（模板见 deploy/env/prod.runtime.env.example）。"+
		" [WARNING: %s not set; the initial administrator account was NOT created.]", names, names)
}

const (
	passwordMinLength = 8
	// passwordMaxLength 取 bcrypt 的 72 字节硬上限：超出部分会被静默截断，
	// 用户以为整段密码都生效但实际只有前 72 字节管用——是隐性安全风险。
	// 用 len() 字节数对比，与 bcrypt 内部实现一致（UTF-8 多字节字符按字节计数）。
	passwordMaxLength = 72
)

// validatePassword 校验密码长度：至少 8 位、不超过 72 字节。
// Register / SaveUser / ChangePassword 三处统一复用，避免注册允许 1 位密码、改密却要 ≥8 位的体验矛盾。
func validatePassword(password string) error {
	if password == "" {
		return safeMessageError{message: "密码不能为空"}
	}
	if len(password) < passwordMinLength {
		return safeMessageError{message: "密码至少 8 位"}
	}
	if len(password) > passwordMaxLength {
		return safeMessageError{message: "密码长度不能超过 72 字节"}
	}
	return nil
}

// ForceLogoutError 表示 service 已主动旋转 SessionID 强制当前 token 立即失效，
// handler 应返回 HTTP 401 让前端 apiRequest 触发 notifySessionExpired 跳转登录页。
// Message 仍会展示给用户（用于"原密码错误"等不暴露锁定状态的提示）。
type ForceLogoutError struct {
	Message string
}

func (e *ForceLogoutError) Error() string { return e.Message }

// ChangePassword 修改当前登录用户密码。
// 校验旧密码 + 新密码长度，密码仍走 bcrypt；不改 SessionID，当前 token 保持有效。
// 复用 Login 的爆破防护：token 被盗（XSS、共享设备）后旧密码不能被无限次尝试，
// 同样按 username|ip 维度计 5 次失败锁定 15 分钟，成功即清零。
func ChangePassword(userID, oldPassword, newPassword, ip string) error {
	user, ok, err := repository.GetUserByID(userID)
	if err != nil {
		return err
	}
	if !ok {
		return safeMessageError{message: "用户不存在"}
	}
	if err := checkLoginLock(user.Username, ip); err != nil {
		return err
	}
	// 新密码格式校验放在 bcrypt 比对之前：避免无效新密码白消耗 bcrypt 算力并触发失败计数。
	if err := validatePassword(newPassword); err != nil {
		return err
	}
	if strings.TrimSpace(oldPassword) == "" || bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(oldPassword)) != nil {
		lockErr := recordLoginFailure(user.Username, ip)
		if lockErr != nil {
			// 第 5 次失败触发锁定：旋转 SessionID 让当前 token 立即失效。
			// 合法用户察觉异常后会用新密码重新登录；攻击者盗用的 token 同时作废。
			// 不向调用方暴露锁定状态——攻击者看到的是普通"原密码错误"，无法据此调整等待重试策略。
			// handler 检测到 ForceLogoutError 后返回 HTTP 401，前端 apiRequest 会触发
			// notifySessionExpired 跳登录 + 把 Message 显示在弹窗里。
			_ = repository.UpdateUserSessionID(user.ID, uuid.NewString())
			return &ForceLogoutError{Message: "原密码错误"}
		}
		return safeMessageError{message: "原密码错误"}
	}
	// 旧密码校验通过即清空失败计数，无论后续新密码是否通过校验——
	// 防止有人挂着已盗 token 反复试新密码长度把合法用户卡死。
	resetLoginAttempts(user.Username, ip)
	if newPassword == oldPassword {
		return safeMessageError{message: "新密码不能与原密码相同"}
	}
	hash, err := hashPassword(newPassword)
	if err != nil {
		return err
	}
	// 只更新 password/updated_at 两列，绝不走 SaveUser 全行写回——
	// 否则事务外旧快照会覆盖并发扣费/会话旋转/登录时间等变更（见 repository.UpdateUserPassword 注释）。
	return repository.UpdateUserPassword(user.ID, hash, now())
}

// ── 登录失败锁定 ────────────────────────────────────────────────────
// 公网后台默认口令 + 无限次尝试可被暴力破解，这里按 username|ip 维度累计失败次数，
// 达上限后锁定一段时间。设计参照 sms_code.go 的验证码暴力破解防护：
// sync.Map 存条目 + sync.Mutex 保护 read-modify-write，GC 协程回收陈旧条目。

type loginAttemptEntry struct {
	Count       int       // 连续错误次数
	FirstAt     time.Time // 首次错误时间
	LockedUntil time.Time // 锁定截止时间（零值表示未锁定）
}

var (
	loginAttempts    sync.Map // map[string]*loginAttemptEntry，key = username|ip
	loginAttemptLock sync.Mutex
)

const (
	loginMaxAttempts       = 5                // 连续失败上限
	loginLockDuration      = 15 * time.Minute // 达上限后锁定时长
	loginAttemptStaleAge   = 1 * time.Hour    // 未锁定但陈旧的计数条目回收阈值
	loginAttemptGCInterval = 5 * time.Minute  // GC 扫描周期
)

// loginAttemptKey 生成锁定键：username 转小写 + ip（ip 为空用 "_" 占位）。
// username 小写化保证 Alice/alice 同一账号；ip 占位避免空值与其它组合串冲突。
func loginAttemptKey(username, ip string) string {
	username = strings.ToLower(strings.TrimSpace(username))
	if strings.TrimSpace(ip) == "" {
		ip = "_"
	}
	return username + "|" + ip
}

// checkLoginLock 检查是否被锁定，仍在锁定期返回带剩余时间的错误。
func checkLoginLock(username, ip string) error {
	entry, ok := loginAttempts.Load(loginAttemptKey(username, ip))
	if !ok {
		return nil
	}
	e := entry.(*loginAttemptEntry)
	if e.LockedUntil.IsZero() {
		return nil
	}
	if time.Now().Before(e.LockedUntil) {
		return safeMessageError{message: loginLockRemainingMsg(e.LockedUntil)}
	}
	// 锁已过期，回收后重新计数。
	loginAttempts.Delete(loginAttemptKey(username, ip))
	return nil
}

// recordLoginFailure 记一次失败，达上限时返回锁定错误。
func recordLoginFailure(username, ip string) error {
	loginAttemptLock.Lock()
	defer loginAttemptLock.Unlock()

	key := loginAttemptKey(username, ip)
	now := time.Now()
	entry, ok := loginAttempts.Load(key)
	if !ok {
		entry = &loginAttemptEntry{Count: 1, FirstAt: now}
	} else {
		e := entry.(*loginAttemptEntry)
		e.Count++
		entry = e
	}
	e := entry.(*loginAttemptEntry)
	if e.Count >= loginMaxAttempts {
		e.LockedUntil = now.Add(loginLockDuration)
		loginAttempts.Store(key, e)
		return safeMessageError{message: loginLockRemainingMsg(e.LockedUntil)}
	}
	loginAttempts.Store(key, e)
	return nil
}

// resetLoginAttempts 密码校验通过后清空失败计数。
func resetLoginAttempts(username, ip string) {
	loginAttempts.Delete(loginAttemptKey(username, ip))
}

func loginLockRemainingMsg(until time.Time) string {
	remaining := int(time.Until(until).Seconds())
	if remaining < 0 {
		remaining = 0
	}
	minutes := remaining / 60
	seconds := remaining % 60
	if minutes > 0 {
		return fmt.Sprintf("登录失败次数过多，请 %d 分 %d 秒后再试", minutes, seconds)
	}
	return fmt.Sprintf("登录失败次数过多，请 %d 秒后再试", seconds)
}

// StartLoginGuardGC 启动登录失败计数的后台回收协程。
// 与 StartSmsCodeGC 同范式：仅删除已过期/陈旧条目，Delete 与 read-modify-write 无竞态。
func StartLoginGuardGC() {
	go func() {
		ticker := time.NewTicker(loginAttemptGCInterval)
		defer ticker.Stop()
		for range ticker.C {
			sweepLoginAttempts()
		}
	}()
}

func sweepLoginAttempts() {
	now := time.Now()
	loginAttempts.Range(func(key, value any) bool {
		e, ok := value.(*loginAttemptEntry)
		if !ok {
			loginAttempts.Delete(key)
			return true
		}
		if !e.LockedUntil.IsZero() {
			if now.After(e.LockedUntil) {
				loginAttempts.Delete(key)
			}
			return true
		}
		if !e.FirstAt.IsZero() && now.Sub(e.FirstAt) > loginAttemptStaleAge {
			loginAttempts.Delete(key)
		}
		return true
	})
}
