package handler

import (
	"net/http"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
)

// projectMemberStat 项目成员使用统计项：净消耗积分（used）。
type projectMemberStat struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Used     int    `json:"used"`
}

// projectResponse 管理端项目列表项：附 ownerName + 成员信息 + 使用统计。
type projectResponse struct {
	model.Project
	OwnerName     string              `json:"ownerName"`
	MemberUserIDs []string            `json:"memberUserIds"`
	MemberCount   int                 `json:"memberCount"`
	CanvasCount   int                 `json:"canvasCount"`
	Members       []projectMemberStat `json:"members"`
}

// buildProjectResponse 组装单个项目的完整响应（ownerName + 成员统计 + 画布数）。
func buildProjectResponse(item model.Project, ownerName string) (projectResponse, error) {
	memberIDs, err := repository.ListProjectMemberUserIDs(item.ID)
	if err != nil {
		return projectResponse{}, err
	}
	usernames, err := repository.UsernamesByIDs(memberIDs)
	if err != nil {
		return projectResponse{}, err
	}
	usage, err := repository.ProjectMemberUsage(item.ID)
	if err != nil {
		return projectResponse{}, err
	}
	canvasCount, err := repository.CountProjectCanvases(item.ID)
	if err != nil {
		return projectResponse{}, err
	}
	members := make([]projectMemberStat, 0, len(memberIDs))
	for _, uid := range memberIDs {
		members = append(members, projectMemberStat{
			UserID:   uid,
			Username: usernames[uid],
			Used:     usage[uid], // 无流水默认 0
		})
	}
	return projectResponse{
		Project:       item,
		OwnerName:     ownerName,
		MemberUserIDs: memberIDs,
		MemberCount:   len(memberIDs),
		CanvasCount:   canvasCount,
		Members:       members,
	}, nil
}

// AdminProjects GET /api/admin/projects（admin_l2 只看自己拥有的）
func AdminProjects(w http.ResponseWriter, r *http.Request) {
	me, _ := service.UserFromContext(r.Context())
	var (
		items []model.Project
		err   error
	)
	if me.Role == model.UserRoleAdminL2 {
		items, err = repository.ListProjectsByOwner(me.ID)
	} else {
		items, err = repository.ListProjects()
	}
	if err != nil {
		FailError(w, err)
		return
	}
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
	result := make([]projectResponse, 0, len(items))
	for _, item := range items {
		resp, err := buildProjectResponse(item, names[item.OwnerID])
		if err != nil {
			FailError(w, err)
			return
		}
		result = append(result, resp)
	}
	OK(w, map[string]any{"items": result})
}

type saveProjectRequest struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Credits       int      `json:"credits"` // 仅新建时作初始池
	MemberUserIDs []string `json:"memberUserIds"`
	Status        string   `json:"status"`
}

// AdminSaveProject POST /api/admin/projects（新建或更新）
func AdminSaveProject(w http.ResponseWriter, r *http.Request) {
	me, _ := service.UserFromContext(r.Context())
	var request saveProjectRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		Fail(w, "项目名称不能为空")
		return
	}
	status := strings.TrimSpace(request.Status)
	if status != model.ProjectStatusDisabled {
		status = model.ProjectStatusActive
	}

	// 成员校验：admin_l2 时每个成员必须是自己的子用户；super 不限。
	if me.Role == model.UserRoleAdminL2 {
		for _, uid := range request.MemberUserIDs {
			if strings.TrimSpace(uid) == "" {
				continue
			}
			member, ok, err := repository.GetUserByID(uid)
			if err != nil {
				FailError(w, err)
				return
			}
			if !ok || member.CreatorID != me.ID {
				Fail(w, "成员必须是你创建的子用户")
				return
			}
		}
	}

	var project model.Project
	isCreate := strings.TrimSpace(request.ID) == ""
	if isCreate {
		project = model.Project{
			Name:         request.Name,
			Credits:      request.Credits,
			CreditsTotal: request.Credits,
			Status:       status,
		}
		project.OwnerID = me.ID
	} else {
		old, ok, err := repository.GetProjectByID(request.ID)
		if err != nil {
			FailError(w, err)
			return
		}
		if !ok {
			Fail(w, "项目不存在")
			return
		}
		if me.Role == model.UserRoleAdminL2 && old.OwnerID != me.ID {
			Fail(w, "无权操作该项目")
			return
		}
		// 编辑：保留 OwnerID/Credits/CreditsTotal（积分不经此改），仅更新 name/status。
		project = old
		project.Name = request.Name
		project.Status = status
	}

	saved, err := repository.SaveProject(project)
	if err != nil {
		FailError(w, err)
		return
	}
	if err := repository.SetProjectMembers(saved.ID, request.MemberUserIDs); err != nil {
		FailError(w, err)
		return
	}
	names, err := repository.UsernamesByIDs([]string{saved.OwnerID})
	if err != nil {
		FailError(w, err)
		return
	}
	resp, err := buildProjectResponse(saved, names[saved.OwnerID])
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, resp)
}

// AdminDeleteProject DELETE /api/admin/projects/:id
func AdminDeleteProject(w http.ResponseWriter, r *http.Request, id string) {
	id = strings.TrimSpace(id)
	if id == "" {
		Fail(w, "缺少项目 ID")
		return
	}
	me, _ := service.UserFromContext(r.Context())
	old, ok, err := repository.GetProjectByID(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "项目不存在")
		return
	}
	if me.Role == model.UserRoleAdminL2 && old.OwnerID != me.ID {
		Fail(w, "无权操作该项目")
		return
	}
	if err := repository.DeleteProject(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"id": id})
}

type adjustProjectCreditsRequest struct {
	Delta int `json:"delta"`
}

// AdminAdjustProjectCredits POST /api/admin/projects/:id/credits
func AdminAdjustProjectCredits(w http.ResponseWriter, r *http.Request, id string) {
	id = strings.TrimSpace(id)
	if id == "" {
		Fail(w, "缺少项目 ID")
		return
	}
	var request adjustProjectCreditsRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	me, _ := service.UserFromContext(r.Context())
	old, ok, err := repository.GetProjectByID(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "项目不存在")
		return
	}
	if me.Role == model.UserRoleAdminL2 && old.OwnerID != me.ID {
		Fail(w, "无权操作该项目")
		return
	}
	if err := repository.AdjustProjectCredits(id, request.Delta); err != nil {
		FailError(w, err)
		return
	}
	updated, _, err := repository.GetProjectByID(id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, updated)
}

type assignProjectOwnerRequest struct {
	OwnerID string `json:"ownerId"`
}

// AdminAssignProjectOwner POST /api/admin/projects/:id/owner 把项目划归某二级管理员（空 ownerId=收回到超管/无归属）。超管专用。
func AdminAssignProjectOwner(w http.ResponseWriter, r *http.Request, id string) {
	var request assignProjectOwnerRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	project, ok, err := repository.GetProjectByID(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "项目不存在")
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
	// 先取完整 project 再只改 OwnerID，SaveProject 是整条 db.Save，避免丢字段。
	project.OwnerID = ownerID
	saved, err := repository.SaveProject(project)
	if err != nil {
		FailError(w, err)
		return
	}
	names, err := repository.UsernamesByIDs([]string{ownerID})
	if err != nil {
		FailError(w, err)
		return
	}
	resp, err := buildProjectResponse(saved, names[ownerID])
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, resp)
}

type myProjectItem struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Credits      int    `json:"credits"`
	CreditsTotal int    `json:"creditsTotal"`
}

// MyProjects GET /api/projects/mine（当前用户参与且 active 的项目）
func MyProjects(w http.ResponseWriter, r *http.Request) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	projects, err := repository.ListProjectsForUser(me.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	items := make([]myProjectItem, 0, len(projects))
	for _, p := range projects {
		if p.Status != model.ProjectStatusActive {
			continue
		}
		items = append(items, myProjectItem{
			ID:           p.ID,
			Name:         p.Name,
			Credits:      p.Credits,
			CreditsTotal: p.CreditsTotal,
		})
	}
	OK(w, map[string]any{"items": items})
}
