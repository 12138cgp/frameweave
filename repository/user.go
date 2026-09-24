package repository

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"aicanvas/model"
	"gorm.io/gorm"
)

// ListUsers 分页查询用户。
func ListUsers(q model.Query) ([]model.User, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.User{})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("username LIKE ? OR display_name LIKE ? OR email LIKE ?", like, like, like)
	}
	if creatorID := strings.TrimSpace(q.CreatorID); creatorID != "" {
		tx = tx.Where("creator_id = ?", creatorID)
	}

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var users []model.User
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&users).Error
	return users, total, err
}

// HasAdmin 判断系统中是否存在管理员。
func HasAdmin() (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var total int64
	err = db.Model(&model.User{}).Where("role = ?", model.UserRoleAdmin).Count(&total).Error
	return total > 0, err
}

// ListUsersByRole 返回指定角色的全部用户（按创建时间升序），用于超管列出二级管理员下拉。
func ListUsersByRole(role model.UserRole) ([]model.User, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var users []model.User
	err = db.Where("role = ?", role).Order("created_at asc").Find(&users).Error
	return users, err
}

// GetUserByID 根据 ID 查询用户。
func GetUserByID(id string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	return findUser(db, "id = ?", id)
}

// GetUserByUsername 根据用户名查询用户。
func GetUserByUsername(username string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	return findUser(db, "username = ?", username)
}

// UsernameExistsCI 判断用户名是否已被占用，不区分大小写（Alice/alice/ALICE 视为同名）。
// 仅注册查重用，避免仅大小写不同的近似账号；登录仍按精确用户名匹配（不影响老用户）。
// LOWER() 兼容 sqlite/postgres，无需 DB 迁移；现有大小写敏感唯一索引仍作精确并发兜底。
func UsernameExistsCI(username string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	if err := db.Model(&model.User{}).Where("LOWER(username) = LOWER(?)", strings.TrimSpace(username)).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

// SaveUser 保存用户信息。
func SaveUser(user model.User) (model.User, error) {
	db, err := DB()
	if err != nil {
		return user, err
	}
	return user, db.Save(&user).Error
}

// ⚠️ 下面两个「整行写回但跳过若干列」的函数，是为了堵住一类会丢钱的竞态。
//
// 背景：后台好几处都是「先 GetUserByID 取出完整 user → 只改自己关心的那一个字段 →
// repository.SaveUser 整行 db.Save 写回」。这个写法默认「其余字段照原样写回去 = 没动过」，
// 但那个读发生在事务外 —— 读到写之间只要有别的原子端点提交了变更，就会被这次整行写回抹掉。
//
// 典型的丢失序列（两次操作相隔十几秒就足够）：
//     T+0s   后台调额 34 → 1034（AdjustUserCreditsTx 单事务提交成功，流水已落库）
//     T+18s  同一个用户的表单被保存了一次
//            → 它在事务外读到的还是调额【之前】的 34，整行写回把 credits 写成 34
//            → 1000 点数凭空消失，而流水还留着：余额少了、账目反而多记一笔
// 事后特征是 users.updated_at 停在那次表单保存的时刻，而那一刻没有任何对应流水。
//
// 靠 service 层「再 GetUserByID 一次、把旧值塞回结构体」是保不住的（那是最容易写成的写法），
// 因为丢失更新的窗口就在那次读和这次写之间。唯一可靠的做法是让这些列在 SQL 语句里根本不出现。

// 各列的「唯一合法写入方」：
//
//	credits           AdjustUserCreditsTx / ConsumeUserCreditsTx / RefundUserCredits
//	                  / SettleConsumeUserCreditsTx（音频按秒计价的结算补扣，允许扣成负数）
//	session_id        UpdateUserSessionID（被旧值覆盖会把另一台设备踢下线）
//	last_login_at     登录流程
//	price_override    超管「分级定价」端点
//
// 下面三个函数按调用场景，把「本场景不该写的列」从 SQL 里摘掉。
var (
	// 任何场景都不该被整行写回覆盖的两列。
	userNeverOverwrite = []string{"credits", "session_id"}
	// 后台用户表单：额外不碰定价/登录时间。
	userFormProtectedColumns = append(append([]string{}, userNeverOverwrite...), "price_override", "last_login_at")
	// 只改单个字段的后台端点：额外不碰登录时间。
	userKeepLiveColumns = append(append([]string{}, userNeverOverwrite...), "last_login_at")
	// 登录路径：要写 last_login_at，但不碰定价。
	userLoginProtectedColumns = append(append([]string{}, userNeverOverwrite...), "price_override")
)

// UpdateUserForm 保存后台「用户表单」的编辑结果。仅用于【已存在】的用户；
// 新建用户仍走 SaveUser —— 那时 credits 等列必须能写入初始值。
func UpdateUserForm(user model.User) (model.User, error) {
	db, err := DB()
	if err != nil {
		return user, err
	}
	return user, db.Omit(userFormProtectedColumns...).Save(&user).Error
}

// UpdateUserKeepingLive 给「只想改某一个字段、其余原样写回」的后台端点用
// （分级定价 / 指派创建者）。各自要写的那一列不在跳过名单里。
func UpdateUserKeepingLive(user model.User) (model.User, error) {
	db, err := DB()
	if err != nil {
		return user, err
	}
	return user, db.Omit(userKeepLiveColumns...).Save(&user).Error
}

// UpdateUserOnLogin 登录成功后写回用户行（登录时间、以及 normalizeUserDefaults 补上的
// status/aff_code 等），但绝不碰 credits。
//
// ⚠️ 这条路的风险最高：登录是高频操作，而以前它是整行 db.Save。
// 用户在 A 设备生成（扣费/退款不断提交），同时在 B 设备登录 —— 登录那一下就会用
// 「几毫秒前读到的」credits 把中间的变动抹掉。session_id 同理：写回旧值会把 A 设备踢下线。
func UpdateUserOnLogin(user model.User) (model.User, error) {
	db, err := DB()
	if err != nil {
		return user, err
	}
	return user, db.Omit(userLoginProtectedColumns...).Save(&user).Error
}

func ConsumeUserCredits(id string, credits int, now string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	if credits <= 0 {
		user, ok, err := GetUserByID(id)
		return user, ok, err
	}
	tx := db.Model(&model.User{}).Where("id = ? AND credits >= ?", id, credits).Updates(map[string]any{
		"credits":    gorm.Expr("credits - ?", credits),
		"updated_at": now,
	})
	if tx.Error != nil {
		return model.User{}, false, tx.Error
	}
	user, ok, err := GetUserByID(id)
	return user, ok && tx.RowsAffected > 0, err
}

func RefundUserCredits(id string, credits int, now string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	if credits <= 0 {
		user, ok, err := GetUserByID(id)
		return user, ok, err
	}
	tx := db.Model(&model.User{}).Where("id = ?", id).Updates(map[string]any{
		"credits":    gorm.Expr("credits + ?", credits),
		"updated_at": now,
	})
	if tx.Error != nil {
		return model.User{}, false, tx.Error
	}
	user, ok, err := GetUserByID(id)
	return user, ok && tx.RowsAffected > 0, err
}

// ConsumeUserCreditsTx 扣费与流水写入在同一事务里完成（任一失败整体回滚）。
// 余额不足时返回 ok=false 且不写日志。log.Balance 由本函数按扣后余额填充。
// SettleConsumeUserCreditsTx 结算补扣：与 ConsumeUserCreditsTx 唯一的区别是**不校验余额**，
// 允许把余额扣成负数。
//
// 为什么需要这么一个口子：音频按秒计价时，提交时只能按默认秒数预扣，真实秒数要等上游出片才知道
// （上游没有时长参数）。产物已经交付到用户手里了，这时候「余额不够就不扣」等于平台白送，
// 而且可被反复利用。让余额变负是唯一诚实的记法：账面如实反映欠账，而扣费入口
// ConsumeUserCreditsTx 的 `credits >= ?` 会自然把后续生成挡住，直到充值补平。
//
// ⚠️ 只给结算用。任何「先付费后交付」的路径都必须继续走 ConsumeUserCreditsTx。
// （注：当前默认配置走【按字数计价】，字数提交时已知、一次扣准，不会用到这条路径。）
func SettleConsumeUserCreditsTx(id string, credits int, now string, log model.CreditLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	if credits <= 0 {
		return nil
	}
	return db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.User{}).Where("id = ?", id).Updates(map[string]any{
			"credits":    gorm.Expr("credits - ?", credits),
			"updated_at": now,
		})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errors.New("用户不存在")
		}
		var user model.User
		if err := tx.Where("id = ?", id).First(&user).Error; err != nil {
			return err
		}
		log.Balance = user.Credits
		return tx.Save(&log).Error
	})
}

func ConsumeUserCreditsTx(id string, credits int, now string, log model.CreditLog) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	ok := false
	err = db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.User{}).Where("id = ? AND credits >= ?", id, credits).Updates(map[string]any{
			"credits":    gorm.Expr("credits - ?", credits),
			"updated_at": now,
		})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil // 余额不足：不扣不记
		}
		ok = true
		var user model.User
		if err := tx.Where("id = ?", id).First(&user).Error; err != nil {
			return err
		}
		log.Balance = user.Credits
		return tx.Save(&log).Error
	})
	if err != nil {
		return false, err
	}
	return ok, nil
}

// RefundUserCreditsTx 退款与流水写入在同一事务里完成。
func RefundUserCreditsTx(id string, credits int, now string, log model.CreditLog) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	ok := false
	err = db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.User{}).Where("id = ?", id).Updates(map[string]any{
			"credits":    gorm.Expr("credits + ?", credits),
			"updated_at": now,
		})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil // 用户不存在
		}
		ok = true
		var user model.User
		if err := tx.Where("id = ?", id).First(&user).Error; err != nil {
			return err
		}
		log.Balance = user.Credits
		return tx.Save(&log).Error
	})
	if err != nil {
		return false, err
	}
	return ok, nil
}

// AdjustUserCreditsTx 把用户点数原子地设为绝对值 credits（后台手动调整）。
// 在单事务内：① 读事务内当前余额算出 CreditLog.Amount/Balance；② 仅更新 credits/updated_at 两列
// （绝不用 SaveUser 全行写回事务外旧快照——否则会覆盖期间并发发生的扣费/退款，丢更新且对不上账）；
// ③ 余额无变化则不记流水。found=false 表示用户不存在。返回更新后的用户。
func AdjustUserCreditsTx(id string, credits int, now string, log model.CreditLog) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	var updated model.User
	found := false
	err = db.Transaction(func(tx *gorm.DB) error {
		var current model.User
		if e := tx.Where("id = ?", id).First(&current).Error; e != nil {
			if errors.Is(e, gorm.ErrRecordNotFound) {
				return nil
			}
			return e
		}
		found = true
		old := current.Credits
		res := tx.Model(&model.User{}).Where("id = ?", id).Updates(map[string]any{
			"credits":    credits,
			"updated_at": now,
		})
		if res.Error != nil {
			return res.Error
		}
		if old != credits {
			log.UserID = id
			log.Amount = credits - old
			log.Balance = credits
			if e := tx.Save(&log).Error; e != nil {
				return e
			}
		}
		return tx.Where("id = ?", id).First(&updated).Error
	})
	if err != nil {
		return model.User{}, false, err
	}
	return updated, found, nil
}

// SaveCreditLog 保存点数变更流水。
func SaveCreditLog(log model.CreditLog) (model.CreditLog, error) {
	db, err := DB()
	if err != nil {
		return log, err
	}
	return log, db.Save(&log).Error
}

// creditLogFilteredTx 按筛选条件构造 credit_logs 查询；列表 / 导出 / 汇总三处共用，保证筛选口径完全一致。
func creditLogFilteredTx(db *gorm.DB, q model.Query) *gorm.DB {
	tx := db.Model(&model.CreditLog{})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("user_id LIKE ? OR type LIKE ? OR remark LIKE ? OR related_id LIKE ?", like, like, like, like)
	}
	if q.UserIDs != nil {
		// 二级管理员只看自己子用户的流水；子用户为空时 UserIDs 为非 nil 空切片，IN () 命中 0 条。
		tx = tx.Where("user_id IN (?)", q.UserIDs)
	}
	if t := strings.TrimSpace(q.Type); t != "" {
		tx = tx.Where("type = ?", t)
	}
	if m := strings.TrimSpace(q.Model); m != "" {
		// 模型名记在 extra JSON（{"model":"...","path":"..."}）与 remark（"调用模型 X"）里。
		tx = tx.Where("extra LIKE ? OR remark LIKE ?", "%\"model\":\""+m+"%", "%"+m+"%")
	}
	if s := strings.TrimSpace(q.Start); s != "" {
		tx = tx.Where("created_at >= ?", s)
	}
	if e := strings.TrimSpace(q.End); e != "" {
		tx = tx.Where("created_at <= ?", e)
	}
	if mem := strings.TrimSpace(q.Member); mem != "" {
		like := "%" + mem + "%"
		sub := db.Model(&model.User{}).Select("id").Where("username LIKE ? OR id LIKE ?", like, like)
		tx = tx.Where("user_id IN (?)", sub)
	}
	// 来源筛选：个人积分（project_id 空）或某具体项目积分池。
	if src := strings.TrimSpace(q.Source); src != "" {
		if src == "__personal__" {
			tx = tx.Where("project_id = '' OR project_id IS NULL")
		} else {
			tx = tx.Where("project_id = ?", src)
		}
	}
	return tx
}

func ListCreditLogs(q model.Query) ([]model.CreditLog, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := creditLogFilteredTx(db, q)
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var logs []model.CreditLog
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&logs).Error
	return logs, total, err
}

// maxCreditLogExport 导出全量流水的硬上限，防 OOM。
const maxCreditLogExport = 100000

// ListCreditLogsAll 不分页返回筛选后的全部流水（导出用），上限 maxCreditLogExport。
func ListCreditLogsAll(q model.Query) ([]model.CreditLog, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var logs []model.CreditLog
	err = creditLogFilteredTx(db, q).Order("created_at desc").Limit(maxCreditLogExport).Find(&logs).Error
	return logs, err
}

// creditLogModelFromExtra 从流水 extra JSON（{"model":"...","path":"..."}）解析模型名，空 extra（如后台调整）返回空串。
func creditLogModelFromExtra(extra string) string {
	if strings.TrimSpace(extra) == "" {
		return ""
	}
	var e struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal([]byte(extra), &e)
	return e.Model
}

// SummarizeCreditLogs 返回当前筛选下的总汇总（顶部总数）+ 按成员逐人汇总 + 按模型汇总。
func SummarizeCreditLogs(q model.Query) (model.CreditLogSummary, []model.CreditLogMemberStat, []model.CreditLogModelStat, error) {
	db, err := DB()
	if err != nil {
		return model.CreditLogSummary{}, nil, nil, err
	}
	const sums = "COALESCE(SUM(CASE WHEN type = 'ai_consume' THEN -amount ELSE 0 END),0) AS consume, " +
		"COALESCE(SUM(CASE WHEN type = 'ai_refund' THEN amount ELSE 0 END),0) AS refund, " +
		"COALESCE(SUM(CASE WHEN type = 'admin_adjust' THEN amount ELSE 0 END),0) AS adjust, " +
		"COUNT(*) AS count"
	var overall model.CreditLogSummary
	if err := creditLogFilteredTx(db, q).Select(sums).Scan(&overall).Error; err != nil {
		return model.CreditLogSummary{}, nil, nil, err
	}
	overall.Net = overall.Consume - overall.Refund
	var members []model.CreditLogMemberStat
	if err := creditLogFilteredTx(db, q).Select("user_id AS user_id, " + sums).Group("user_id").Order("consume desc").Scan(&members).Error; err != nil {
		return model.CreditLogSummary{}, nil, nil, err
	}
	for i := range members {
		members[i].Net = members[i].Consume - members[i].Refund
	}
	// 按模型：模型名在 extra JSON 里、非独立列，拉最小列（type/amount/extra）在 Go 层聚合，兼容各 DB 驱动、不依赖 JSON 函数。
	type modelRow struct {
		Type   string
		Amount int
		Extra  string
	}
	var rows []modelRow
	if err := creditLogFilteredTx(db, q).Select("type, amount, extra").Limit(maxCreditLogExport).Scan(&rows).Error; err != nil {
		return model.CreditLogSummary{}, nil, nil, err
	}
	statByModel := map[string]*model.CreditLogModelStat{}
	order := make([]string, 0)
	for _, r := range rows {
		name := creditLogModelFromExtra(r.Extra)
		st := statByModel[name]
		if st == nil {
			st = &model.CreditLogModelStat{Model: name}
			statByModel[name] = st
			order = append(order, name)
		}
		switch r.Type {
		case string(model.CreditLogTypeAIConsume):
			st.Consume += -r.Amount
		case string(model.CreditLogTypeAIRefund):
			st.Refund += r.Amount
		case string(model.CreditLogTypeAdminAdjust):
			st.Adjust += r.Amount
		}
		st.Count++
	}
	models := make([]model.CreditLogModelStat, 0, len(order))
	for _, name := range order {
		st := statByModel[name]
		st.Net = st.Consume - st.Refund
		models = append(models, *st)
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Consume > models[j].Consume })
	return overall, members, models, nil
}

func DeleteCreditLog(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.CreditLog{}, "id = ?", id).Error
}

// DeleteUser 删除指定用户。
func DeleteUser(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.User{}, "id = ?", id).Error
}

// UsernamesByIDs 返回 id→username 映射，用于在列表里附带归属人姓名。空 ids 返回空映射。
func UsernamesByIDs(ids []string) (map[string]string, error) {
	result := map[string]string{}
	if len(ids) == 0 {
		return result, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var rows []model.User
	if err := db.Model(&model.User{}).Select("id", "username").Where("id IN (?)", ids).Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[row.ID] = row.Username
	}
	return result, nil
}

// UserIDsByCreator 返回某二级管理员创建的全部子用户 ID（用于流水按子用户过滤）。
func UserIDsByCreator(creatorID string) ([]string, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var rows []model.User
	if err := db.Model(&model.User{}).Select("id").Where("creator_id = ?", creatorID).Find(&rows).Error; err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids, nil
}

// GetUserByPhone 根据手机号查询用户。
func GetUserByPhone(phone string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	return findUser(db, "phone = ?", phone)
}

// findUser 查询单个用户，并将未命中转换为 ok=false。
func findUser(db *gorm.DB, query string, args ...any) (model.User, bool, error) {
	user := model.User{}
	err := db.Where(query, args...).First(&user).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.User{}, false, nil
	}
	return user, err == nil, err
}

// UpdateUserSessionID 旋转用户当前会话 ID（单设备登录）。
func UpdateUserSessionID(id, sessionID string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.User{}).Where("id = ?", id).Update("session_id", sessionID).Error
}

// UpdateUserPassword 仅更新 password/updated_at 两列。
// 绝不用 SaveUser 全行写回事务外旧快照——否则会覆盖期间并发发生的扣费/退款/会话旋转/登录时间，
// 造成丢更新、新 token 失效等（与 AdjustUserCreditsTx 同一红线）。
func UpdateUserPassword(id, hashedPassword, now string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.User{}).Where("id = ?", id).Updates(map[string]any{
		"password":   hashedPassword,
		"updated_at": now,
	}).Error
}
