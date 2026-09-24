package repository

import (
	"strings"
	"time"

	"aicanvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ListUnrefundedVideoRefunds 取「尚未退款且创建于 createdBefore 之前」的候选（供后台兜底扫描用）。
// 用于：客户端提交视频后未持续轮询（关页/掉线）导致失败任务永不触发退款——后台据此主动查上游状态补退。
// createdBefore 为 RFC3339 时间串（与 CreatedAt 同格式，字符串比较即时间比较）。
func ListUnrefundedVideoRefunds(createdBefore string, limit int) ([]model.VideoRefund, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.VideoRefund
	q := db.Where("(refunded_at IS NULL OR refunded_at = '') AND created_at <= ?", createdBefore).
		Order("created_at asc")
	if limit > 0 {
		q = q.Limit(limit)
	}
	if err := q.Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

// DeleteVideoRefund 删除一条退款候选（成功/放弃扫描时清理、避免无限重扫）。
func DeleteVideoRefund(taskID string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("task_id = ?", taskID).Delete(&model.VideoRefund{}).Error
}

// RefundVideoTx 在单事务内原子完成视频失败退款，杜绝「先标记后退款、退款步失败=永久漏退」：
// ① 幂等闸：标记 refunded_at（已退/无候选则 did=false、调用方跳过）；
// ② 按当初扣费来源给用户或项目加回积分；③ 记退款流水。
// 任一步出错整体回滚（refunded_at 不置位、可后续重试）。
// 入参 log 由调用方预置 ID/Type/Remark/Extra/CreatedAt；本函数在事务内据权威候选填 UserID/ProjectID/Amount/Balance。
// did=true 表示本次成功标记退款（含「账户已不存在/无金额可退」的已标记态）。
func RefundVideoTx(taskID, now string, log model.CreditLog) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	did := false
	err = db.Transaction(func(tx *gorm.DB) error {
		gate := tx.Model(&model.VideoRefund{}).
			Where("task_id = ? AND (refunded_at IS NULL OR refunded_at = '')", taskID).
			Update("refunded_at", now)
		if gate.Error != nil {
			return gate.Error
		}
		if gate.RowsAffected != 1 {
			return nil // 已退过 / 无候选 → did=false
		}
		var vr model.VideoRefund
		if e := tx.Where("task_id = ?", taskID).First(&vr).Error; e != nil {
			return e
		}
		did = true
		if vr.Credits <= 0 {
			return nil // 已标记、无金额可退
		}
		log.UserID = vr.UserID
		log.Amount = vr.Credits
		if vr.ChargedToProject {
			log.ProjectID = vr.ProjectID
			res := tx.Model(&model.Project{}).Where("id = ?", vr.ProjectID).Updates(map[string]any{
				"credits":    gorm.Expr("credits + ?", vr.Credits),
				"updated_at": now,
			})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				return nil // 项目已不存在：保持已标记、不记账（与 RefundProjectCreditsTx 一致）
			}
			var p model.Project
			if e := tx.Where("id = ?", vr.ProjectID).First(&p).Error; e != nil {
				return e
			}
			log.Balance = p.Credits
		} else {
			res := tx.Model(&model.User{}).Where("id = ?", vr.UserID).Updates(map[string]any{
				"credits":    gorm.Expr("credits + ?", vr.Credits),
				"updated_at": now,
			})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				return nil // 用户已不存在
			}
			var u model.User
			if e := tx.Where("id = ?", vr.UserID).First(&u).Error; e != nil {
				return e
			}
			log.Balance = u.Credits
		}
		return tx.Save(&log).Error
	})
	if err != nil {
		return false, err
	}
	return did, nil
}

// SaveVideoRefundCandidate 提交阶段按 task id 落退款候选。
// 幂等：TaskID 冲突时 DoNothing（同 task id 重复提交不报错、不覆盖）。
// CreatedAt 为空时补 time.Now().Format(time.RFC3339)。TaskID 为空则不存、直接返回 nil。
func SaveVideoRefundCandidate(vr model.VideoRefund) error {
	if vr.TaskID == "" {
		return nil
	}
	db, err := DB()
	if err != nil {
		return err
	}
	if vr.CreatedAt == "" {
		vr.CreatedAt = time.Now().Format(time.RFC3339)
	}
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "task_id"}},
		DoNothing: true,
	}).Create(&vr).Error
}

// GetVideoRefund 按 task id 取退款记录，返回 (数据, 是否存在, error)。
func GetVideoRefund(taskID string) (model.VideoRefund, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoRefund{}, false, err
	}
	var item model.VideoRefund
	err = db.Where("task_id = ?", taskID).Limit(1).Find(&item).Error
	if err != nil {
		return model.VideoRefund{}, false, err
	}
	return item, item.TaskID != "", nil
}

// MarkVideoRefunded 幂等闸：原子标记该 task id 已退款。
// 返回 (true,nil)=本次成功标记（此前未退，调用方应执行退款）；
// (false,nil)=已退过或无此记录（调用方跳过）。用 RowsAffected==1 判定。
func MarkVideoRefunded(taskID string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	now := time.Now().Format(time.RFC3339)
	res := db.Model(&model.VideoRefund{}).
		Where("task_id = ? AND (refunded_at IS NULL OR refunded_at = '')", taskID).
		Update("refunded_at", now)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// RefundedTaskIDs 批量查这些任务号里哪些已退费。供后台任务日志判定「真实结局」用：
// 上游 HTTP 200 只代表【提交被受理】，视频是异步生成的，之后可能因内容审核不过等原因失败。
// 只显示 200 会让人以为生成成功了——用户据此来要视频，而实际上根本没有成片。
func RefundedTaskIDs(taskIDs []string) (map[string]bool, error) {
	out := make(map[string]bool, len(taskIDs))
	if len(taskIDs) == 0 {
		return out, nil
	}
	db, err := DB()
	if err != nil {
		return out, err
	}
	var rows []model.VideoRefund
	if err := db.Where("task_id IN ?", taskIDs).Find(&rows).Error; err != nil {
		return out, err
	}
	for _, r := range rows {
		// refunded_at 非空才算真的退过；只是候选（还没退）的不算
		out[r.TaskID] = strings.TrimSpace(r.RefundedAt) != ""
	}
	return out, nil
}

// ListPendingVideoTasksForCanvas 取这个用户在某块画布上「还没结案」的视频任务候选。
//
// 供画布载入时把任务号补回节点用（见 handler.MyPendingVideoTasks）。客户端本地那份
// videoTaskId 会因为持久化被吞、或用户在提交返回前就刷新而丢失，一旦丢了，前端就把
// 明明还在跑的节点判成「页面刷新后生成已中断」。服务端在提交那一刻记下了 canvas_id +
// node_id，这里按它反查回来。
//
// 三条过滤各有各的道理：
//   - refunded_at 为空：已退款=任务确实失败过、钱已还，不该再让节点转回 loading；
//   - node_id 非空：老候选没记节点上下文，补回去也不知道补给谁；
//   - limit：正常同时在途不过个位数，设上限只为防异常数据撑爆响应。
//
// 不按时间过滤：候选超过 6 小时会被兜底扫描判超龄删掉（videoSweepMaxAge），
// 所以留在表里的本来就都是新鲜的，这里再卡一道反而可能把该接的漏掉。
func ListPendingVideoTasksForCanvas(userID string, canvasID string, limit int) ([]model.VideoRefund, error) {
	userID = strings.TrimSpace(userID)
	canvasID = strings.TrimSpace(canvasID)
	if userID == "" || canvasID == "" {
		return nil, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 200
	}
	var items []model.VideoRefund
	err = db.Where(
		"user_id = ? AND canvas_id = ? AND node_id <> '' AND (refunded_at IS NULL OR refunded_at = '')",
		userID, canvasID,
	).Order("created_at asc").Limit(limit).Find(&items).Error
	if err != nil {
		return nil, err
	}
	return items, nil
}
