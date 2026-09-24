package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
	"github.com/google/uuid"
)

// groupResponse 在 model.Group 基础上附带归属人姓名（ownerName），方便超管查看分组归属。
type groupResponse struct {
	model.Group
	OwnerName string `json:"ownerName"`
}

// AdminGroups GET /api/admin/groups
func AdminGroups(w http.ResponseWriter, r *http.Request) {
	me, _ := service.UserFromContext(r.Context())
	var (
		items []model.Group
		err   error
	)
	if me.Role == model.UserRoleAdminL2 {
		// 二级管理员只看自己拥有的分组。
		items, err = repository.ListGroupsByOwner(me.ID)
	} else {
		items, err = repository.ListGroups()
	}
	if err != nil {
		FailError(w, err)
		return
	}
	// 对所有 admin 附带 ownerName：构造 owner id→username 映射。
	ownerIDs := make([]string, 0, len(items))
	for _, item := range items {
		if strings.TrimSpace(item.OwnerID) != "" {
			ownerIDs = append(ownerIDs, item.OwnerID)
		}
	}
	names, err := repository.UsernamesByIDs(ownerIDs)
	if err != nil {
		FailError(w, err)
		return
	}
	result := make([]groupResponse, 0, len(items))
	for _, item := range items {
		// 渠道级隐藏:对二级管理员剥掉标了 hidden 的渠道(含 apiKey),从根上不出后端而非前端遮挡。
		if me.Role == model.UserRoleAdminL2 {
			item.Channels = visibleChannelsJSON(item.Channels)
		}
		result = append(result, groupResponse{Group: item, OwnerName: names[item.OwnerID]})
	}
	OK(w, result)
}

// parseChannels 解析 group.channels 的 JSON 数组;空串/非法返回空切片。
func parseChannels(raw string) []model.ModelChannel {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var list []model.ModelChannel
	if json.Unmarshal([]byte(raw), &list) != nil {
		return nil
	}
	return list
}

// visibleChannelsJSON 返回剔除 hidden 渠道后的 channels JSON(供二级管理员看)。解析失败时返回空数组,宁可少显示也不泄漏。
func visibleChannelsJSON(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return raw
	}
	list := parseChannels(raw)
	visible := make([]model.ModelChannel, 0, len(list))
	for _, c := range list {
		if !c.Hidden {
			visible = append(visible, c)
		}
	}
	out, err := json.Marshal(visible)
	if err != nil {
		return "[]"
	}
	return string(out)
}

// ensureChannelIDs 给缺 ID 的渠道补稳定 ID(保存时统一过一遍);已有 ID 原样保留。
// 渠道 ID 是按渠道归集用量的前提——改名/调序不变。
//
// oldRaw 传该组在 DB 里的旧 channels(新建时传空)。缺 ID 时【先按同名渠道复用旧 ID】,只有真找不到才铸新的。
// 这一层是服务端兜底:后台表单一旦漏给 id 注册 Form.Item,提交时 id 就会被 antd 丢掉,
// 于是每保存一次分组就给全组渠道重铸 uuid,按渠道归集的历史用量当场断掉(往月报表一片空白)。
// 表单侧可以修,但只要有任何一个客户端忘了带 id,同样的钱账问题就会再来一次——所以服务端也必须自己认得回来。
// 同名匹配只在【旧配置里该名字唯一、且该旧 ID 没被本次其它渠道占用】时才生效,避免同名渠道之间串号。
func ensureChannelIDs(raw string, oldRaw string) string {
	list := parseChannels(raw)
	if len(list) == 0 {
		return raw
	}
	// 旧配置:名字 → 旧 ID(名字重复的一律不参与复用,宁可铸新的也不串号)
	reusable := map[string]string{}
	dupName := map[string]bool{}
	for _, c := range parseChannels(oldRaw) {
		name := strings.TrimSpace(c.Name)
		id := strings.TrimSpace(c.ID)
		if name == "" || id == "" {
			continue
		}
		if _, seen := reusable[name]; seen {
			dupName[name] = true
			continue
		}
		reusable[name] = id
	}
	// 本次已经带了 ID 的渠道,占住这些 ID,不许再被同名复用抢走
	taken := map[string]bool{}
	for i := range list {
		if id := strings.TrimSpace(list[i].ID); id != "" {
			taken[id] = true
		}
	}
	changed := false
	for i := range list {
		if strings.TrimSpace(list[i].ID) != "" {
			continue
		}
		name := strings.TrimSpace(list[i].Name)
		if old := reusable[name]; old != "" && !dupName[name] && !taken[old] {
			list[i].ID = old
			taken[old] = true
			changed = true
			continue
		}
		list[i].ID = uuid.NewString()
		changed = true
	}
	if !changed {
		return raw
	}
	out, err := json.Marshal(list)
	if err != nil {
		return raw
	}
	return string(out)
}

// clearChannelPrivileged 清掉仅超管可设的渠道字段(hidden),二级管理员新建分组时用。
func clearChannelPrivileged(raw string) string {
	list := parseChannels(raw)
	if len(list) == 0 {
		return raw
	}
	for i := range list {
		list[i].Hidden = false
	}
	out, err := json.Marshal(list)
	if err != nil {
		return raw
	}
	return string(out)
}

// mergeL2SavedChannels 二级管理员保存时的渠道合并:L2 只看得到、只能改「可见渠道」的常规配置,
// 但仅超管可设的字段(hidden)一律以 DB 原值为准——按渠道 ID 还原,防其查看/篡改。
// 结果 = L2 提交的可见渠道(privileged 字段按 ID 还原成 DB 值) + DB 原有的 hidden 渠道(原样保留)。
func mergeL2SavedChannels(reqRaw, dbRaw string) string {
	dbByID := map[string]model.ModelChannel{}
	var dbHidden []model.ModelChannel
	for _, c := range parseChannels(dbRaw) {
		if strings.TrimSpace(c.ID) != "" {
			dbByID[c.ID] = c
		}
		if c.Hidden {
			dbHidden = append(dbHidden, c)
		}
	}
	req := parseChannels(reqRaw)
	for i := range req {
		// privileged 字段一律不接受 L2 提交值:有 DB 原值按 ID 还原,新渠道则清零。
		if src, ok := dbByID[strings.TrimSpace(req[i].ID)]; ok && req[i].ID != "" {
			req[i].Hidden = src.Hidden
		} else {
			req[i].Hidden = false
		}
	}
	req = append(req, dbHidden...)
	if len(req) == 0 {
		return ""
	}
	out, err := json.Marshal(req)
	if err != nil {
		return dbRaw // 合并异常时保守回退 DB 原值,绝不丢隐藏渠道
	}
	return string(out)
}

// AdminSaveGroup POST /api/admin/groups（新建或更新）
func AdminSaveGroup(w http.ResponseWriter, r *http.Request) {
	me, _ := service.UserFromContext(r.Context())
	var request model.Group
	_ = json.NewDecoder(r.Body).Decode(&request)
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		Fail(w, "分组名称不能为空")
		return
	}
	isCreate := strings.TrimSpace(request.ID) == ""
	if isCreate {
		if me.Role == model.UserRoleAdminL2 {
			// 二级管理员新建的分组强制归属自己;仅超管可设的渠道字段(hidden+计费字段)一律清空。
			request.OwnerID = me.ID
			request.Channels = clearChannelPrivileged(request.Channels)
		}
	} else {
		// 编辑：从 DB 取旧组校验归属，并保留旧 OwnerID（不被请求体覆盖）。
		old, ok, err := repository.GetGroupByID(request.ID)
		if err != nil {
			FailError(w, err)
			return
		}
		if !ok {
			Fail(w, "分组不存在")
			return
		}
		if me.Role == model.UserRoleAdminL2 && old.OwnerID != me.ID {
			Fail(w, "无权操作该分组")
			return
		}
		request.OwnerID = old.OwnerID
		// 渠道级隐藏/计费字段:二级管理员只能改可见渠道的常规配置,privileged 字段按 DB 原值还原、hidden 渠道原样合并回。
		if me.Role == model.UserRoleAdminL2 {
			request.Channels = mergeL2SavedChannels(request.Channels, old.Channels)
		}
	}
	// 统一给缺 ID 的渠道补稳定 ID(按渠道归集用量的前提)。
	// 编辑时把旧 channels 一起交进去:缺 ID 的渠道优先复用同名旧 ID,而不是铸新的(见 ensureChannelIDs 注释)。
	oldChannels := ""
	if !isCreate {
		if prev, ok, err := repository.GetGroupByID(request.ID); err == nil && ok {
			oldChannels = prev.Channels
		}
	}
	request.Channels = ensureChannelIDs(request.Channels, oldChannels)
	group, err := repository.SaveGroup(request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, group)
}

// AdminTestGroupStorage POST /api/admin/groups/test-storage
// 用后台表单里填写的桶配置做一次连通性自检（写一个极小测试对象并从公网读回校验），
// 供管理员在保存前验证桶名/密钥/公共读/PublicBase 是否正确。任何管理员可测（含二级管理员测自己的组桶）。
func AdminTestGroupStorage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TOSBucket     string `json:"tosBucket"`
		TOSEndpoint   string `json:"tosEndpoint"`
		TOSRegion     string `json:"tosRegion"`
		TOSAccessKey  string `json:"tosAccessKey"`
		TOSSecretKey  string `json:"tosSecretKey"`
		TOSPublicBase string `json:"tosPublicBase"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := service.TestTOSStorageForInput(req.TOSBucket, req.TOSEndpoint, req.TOSRegion, req.TOSAccessKey, req.TOSSecretKey, req.TOSPublicBase); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"ok": true, "message": "连通正常：测试对象已成功写入该桶并从公网读回"})
}

type assignGroupOwnerRequest struct {
	OwnerID string `json:"ownerId"`
}

// AdminAssignGroupOwner POST /api/admin/groups/:id/owner 把分组划归某二级管理员（空 ownerId=收回）。超管专用。
func AdminAssignGroupOwner(w http.ResponseWriter, r *http.Request, id string) {
	var request assignGroupOwnerRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	group, ok, err := repository.GetGroupByID(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "分组不存在")
		return
	}
	ownerID := strings.TrimSpace(request.OwnerID)
	if ownerID != "" {
		owner, ok, err := repository.GetUserByID(ownerID)
		if err != nil {
			FailError(w, err)
			return
		}
		if !ok || owner.Role != model.UserRoleAdminL2 {
			Fail(w, "目标不是二级管理员")
			return
		}
	}
	// 先取完整 group 再只改 OwnerID，SaveGroup 是整条 db.Save，避免丢字段。
	group.OwnerID = ownerID
	saved, err := repository.SaveGroup(group)
	if err != nil {
		FailError(w, err)
		return
	}
	names, err := repository.UsernamesByIDs([]string{ownerID})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, groupResponse{Group: saved, OwnerName: names[ownerID]})
}

// AdminDeleteGroup DELETE /api/admin/groups/:id（该组用户自动变为未分组）
func AdminDeleteGroup(w http.ResponseWriter, r *http.Request, id string) {
	if strings.TrimSpace(id) == "" {
		Fail(w, "缺少分组 ID")
		return
	}
	me, _ := service.UserFromContext(r.Context())
	if me.Role == model.UserRoleAdminL2 {
		old, ok, err := repository.GetGroupByID(id)
		if err != nil {
			FailError(w, err)
			return
		}
		if !ok {
			Fail(w, "分组不存在")
			return
		}
		if old.OwnerID != me.ID {
			Fail(w, "无权操作该分组")
			return
		}
	}
	if err := repository.DeleteGroup(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"id": id})
}
