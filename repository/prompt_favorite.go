package repository

import (
	"strings"
	"time"

	"aicanvas/model"
	"github.com/google/uuid"
)

// 收藏提示词的仓储层。
//
// 时间一律存 RFC3339（2026-08-14T06:12:00Z），与全库其它表保持一致。
// ⚠️ 运维手写 SQL 查这张表时，时间条件必须用 julianday() 而不是文本比较：
// created_at 是 RFC3339（带 T），而 SQLite 的 datetime('now') 返回空格分隔，
// 文本比较下 'T'(0x54) > ' '(0x20)，当天所有行都会无条件通过过滤
// （历史上因此产生过一次与实际不符的统计）。

func nowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// FindPromptFavoriteByNode 查某个画布节点是否已被本人收藏过。
// 用于两处：收藏时的幂等判断、画布加载时校正前端的「已收藏」标记。
// 查无返回空结构体而不是错误——「没收藏过」是正常情况，不是异常。
func FindPromptFavoriteByNode(userID, canvasID, nodeID string) (model.PromptFavorite, error) {
	var item model.PromptFavorite
	db, err := DB()
	if err != nil {
		return item, err
	}
	err = db.Where("user_id = ? AND canvas_id = ? AND source_node_id = ?", userID, canvasID, nodeID).
		Limit(1).Find(&item).Error
	return item, err
}

// SavePromptFavorite 落一条收藏，幂等。
//
// 同一用户在同一画布同一节点上重复收藏＝更新那条，不新增。
// 幂等在这里不是锦上添花：前端把「已收藏」标记写在节点 metadata 上，
// 而节点 metadata 的写入存在被 skipNextPersist 吞掉的可能，标记一丢用户就会再点一次。
// 返回落库后的完整记录（含 ID 与时间戳），调用方直接回给前端。
func SavePromptFavorite(item model.PromptFavorite) (model.PromptFavorite, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	existing, err := FindPromptFavoriteByNode(item.UserID, item.CanvasID, item.SourceNodeID)
	if err != nil {
		return item, err
	}
	now := nowRFC3339()
	item.UpdatedAt = now
	if existing.ID != "" {
		// 保留首次收藏时间，其余字段整体覆盖为本次提交的内容。
		item.ID = existing.ID
		item.CreatedAt = existing.CreatedAt
		if err := db.Save(&item).Error; err != nil {
			return item, err
		}
		return item, nil
	}
	item.ID = uuid.NewString()
	item.CreatedAt = now
	if err := db.Create(&item).Error; err != nil {
		return item, err
	}
	return item, nil
}

// GetPromptFavorite 按 id 取单条。媒体下发前用它校验归属，别省。
func GetPromptFavorite(id string) (model.PromptFavorite, error) {
	var item model.PromptFavorite
	db, err := DB()
	if err != nil {
		return item, err
	}
	err = db.Where("id = ?", strings.TrimSpace(id)).Limit(1).Find(&item).Error
	return item, err
}

// DeletePromptFavorite 删除本人的一条收藏。
//
// ⚠️ 条件里必须同时带 user_id：只按 id 删等于任何登录用户都能删别人的收藏。
// 返回受影响行数，调用方据此区分「删掉了」和「不是你的/不存在」。
//
// 转存副本文件不在这里删——文件清理交给调用方，
// 保持仓储层只做库操作，避免「库删了文件没删」和「文件删了库回滚了」两种半途状态。
func DeletePromptFavorite(userID, id string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	tx := db.Where("user_id = ? AND id = ?", userID, strings.TrimSpace(id)).Delete(&model.PromptFavorite{})
	return tx.RowsAffected, tx.Error
}

// ListPromptFavoriteNodeRefs 取某个画布里本人已收藏的 (收藏 id, 节点 id) 对。
//
// 画布加载时拉一次，用来校正节点 metadata 上的「已收藏」标记——
// 那个标记会被 B7 的「持久化被吞」吃掉，光靠它会出现「明明收藏了按钮却没亮」。
// 只取两列，一块画布几百个节点也不过几 KB。
//
// ⚠️ 必须连收藏 id 一起返回：那个 id 就是前端「取消收藏」要用的东西，
// 只回节点 id 的话校正完就没法取消了。
func ListPromptFavoriteNodeRefs(userID, canvasID string) ([]model.PromptFavoriteNodeRef, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var rows []model.PromptFavoriteNodeRef
	err = db.Model(&model.PromptFavorite{}).
		Select("id", "source_node_id").
		Where("user_id = ? AND canvas_id = ?", userID, canvasID).
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// ListPromptFavorites 查收藏，分页。
//
// userID 留空＝不限用户（管理员全站查）；非空＝只看这个人的（用户端必须传）。
// groupID / kind / keyword 都可留空。结果按收藏时间倒序。
func ListPromptFavorites(userID, groupID, kind, keyword string, page, pageSize int) ([]model.PromptFavorite, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	tx := db.Model(&model.PromptFavorite{})
	if v := strings.TrimSpace(userID); v != "" {
		tx = tx.Where("user_id = ?", v)
	}
	if v := strings.TrimSpace(groupID); v != "" {
		tx = tx.Where("group_id = ?", v)
	}
	if v := strings.TrimSpace(kind); v != "" {
		tx = tx.Where("kind = ?", v)
	}
	if v := strings.TrimSpace(keyword); v != "" {
		like := "%" + v + "%"
		tx = tx.Where("prompt LIKE ? OR prompt_draft LIKE ? OR title LIKE ? OR username LIKE ? OR canvas_title LIKE ?", like, like, like, like, like)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	// 上限 500 与全库其它列表接口一致（model.MaxPageSize）。
	// 管理员导出全量走 all=1，由 handler 把 pageSize 顶到上限后分批拉。
	if pageSize <= 0 || pageSize > 500 {
		pageSize = 50
	}
	if page <= 0 {
		page = 1
	}
	var items []model.PromptFavorite
	err = tx.Order("created_at desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&items).Error
	if err != nil {
		return nil, 0, err
	}
	return items, total, nil
}
