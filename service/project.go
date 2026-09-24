package service

import (
	"encoding/json"
	"errors"

	"aicanvas/model"
	"aicanvas/repository"
)

// ConsumeProjectCredits 尝试从项目积分池扣费。
//   - 项目不存在 / 非 active / 调用者非成员 → charged=false, err=nil（表示「应走个人积分」，不报错）。
//   - 命中项目但池不足 → err="项目积分不足"（拦截，不回退个人）。
//   - 扣费成功 → charged=true。
func ConsumeProjectCredits(userID, projectID, modelName string, credits int, path string) (bool, error) {
	if projectID == "" {
		return false, nil
	}
	project, ok, err := repository.GetProjectByID(projectID)
	if err != nil {
		return false, err
	}
	if !ok || project.Status != model.ProjectStatusActive {
		return false, nil
	}
	member, err := repository.IsProjectMember(projectID, userID)
	if err != nil {
		return false, err
	}
	if !member {
		return false, nil
	}
	extra, _ := json.Marshal(map[string]string{"model": modelName, "path": path})
	charged, err := repository.ConsumeProjectCreditsTx(projectID, userID, credits, now(), model.CreditLog{
		ID:        newID("credit"),
		UserID:    userID,
		ProjectID: projectID,
		Type:      model.CreditLogTypeAIConsume,
		Amount:    -credits,
		Remark:    "项目调用模型 " + modelName,
		Extra:     string(extra),
		CreatedAt: now(),
	})
	if err != nil {
		return false, err
	}
	if !charged {
		return false, errors.New("项目积分不足")
	}
	return true, nil
}

// SettleRefundProjectCredits 项目池的结算退款。理由同 SettleRefundUserCredits：
// 复用失败退款会把「结算退差额」记成「调用失败」，对账时分不清。
func SettleRefundProjectCredits(projectID, userID, modelName string, credits int, path string) error {
	if projectID == "" || credits <= 0 {
		return nil
	}
	extra, _ := json.Marshal(map[string]string{"model": modelName, "path": path, "settle": "1"})
	return repository.RefundProjectCreditsTx(projectID, userID, credits, now(), model.CreditLog{
		ID:        newID("credit"),
		UserID:    userID,
		ProjectID: projectID,
		Type:      model.CreditLogTypeAIRefund,
		Amount:    credits,
		Remark:    "项目按实际时长结算返还 " + modelName,
		Extra:     string(extra),
		CreatedAt: now(),
	})
}

// SettleConsumeProjectCredits 项目池的结算补扣：池子不够也照扣，允许扣成负数。
// 理由同 SettleConsumeUserCredits。注意这里不再校验成员身份/项目状态——
// 预扣发生时已经校验过了，结算只是把同一笔账补齐，中途退组不该变成平台白送。
func SettleConsumeProjectCredits(projectID, userID, modelName string, credits int, path string) error {
	if projectID == "" || credits <= 0 {
		return nil
	}
	extra, _ := json.Marshal(map[string]string{"model": modelName, "path": path, "settle": "1"})
	return repository.SettleConsumeProjectCreditsTx(projectID, userID, credits, now(), model.CreditLog{
		ID:        newID("credit"),
		UserID:    userID,
		ProjectID: projectID,
		Type:      model.CreditLogTypeAIConsume,
		Amount:    -credits,
		Remark:    "按实际时长结算 " + modelName,
		Extra:     string(extra),
		CreatedAt: now(),
	})
}

// RefundProjectCredits 把一次项目扣费退回项目积分池。
func RefundProjectCredits(projectID, userID, modelName string, credits int, path string) error {
	if projectID == "" || credits <= 0 {
		return nil
	}
	extra, _ := json.Marshal(map[string]string{"model": modelName, "path": path})
	return repository.RefundProjectCreditsTx(projectID, userID, credits, now(), model.CreditLog{
		ID:        newID("credit"),
		UserID:    userID,
		ProjectID: projectID,
		Type:      model.CreditLogTypeAIRefund,
		Amount:    credits,
		Remark:    "项目模型调用失败返还 " + modelName,
		Extra:     string(extra),
		CreatedAt: now(),
	})
}
