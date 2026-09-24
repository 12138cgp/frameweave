package handler

import (
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"

	"aicanvas/config"
	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type registerRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type sendSmsCodeRequest struct {
	Phone string `json:"phone"`
}

type smsLoginRequest struct {
	Phone string `json:"phone"`
	Code  string `json:"code"`
}

type saveUserRequest struct {
	ID          string           `json:"id"`
	Username    string           `json:"username"`
	Password    string           `json:"password"`
	Email       string           `json:"email"`
	DisplayName string           `json:"displayName"`
	Role        model.UserRole   `json:"role"`
	Status      model.UserStatus `json:"status"`
	GroupID     string           `json:"groupId"`
	ChannelKeys string           `json:"channelKeys"`
}

type adjustUserCreditsRequest struct {
	Credits int `json:"credits"`
}

func Register(w http.ResponseWriter, r *http.Request) {
	var request registerRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	session, err := service.Register(request.Username, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, session)
}

func Login(w http.ResponseWriter, r *http.Request) {
	var request loginRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	session, err := service.Login(request.Username, request.Password, clientIPFromRequest(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, session)
}

// clientIPFromRequest 提取客户端真实 IP。
// 安全策略：仅当 RemoteAddr 在 TrustedProxies 列表时才信任 X-Forwarded-For/X-Real-IP，
// 否则直接使用 RemoteAddr——防止客户端伪造 XFF 绕过 IP 限流。
// 放 handler 层而非 service，避免 service 依赖 http 包（分层规范）。
func clientIPFromRequest(r *http.Request) string {
	// 先提取直连 IP（TCP 连接的实际对端，无法伪造）
	remoteHost := r.RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		remoteHost = host
	}

	// 仅在可信代理之后才解析 X-Real-IP/XFF
	if isTrustedProxy(remoteHost) {
		// ① X-Real-IP 优先：nginx 用 `proxy_set_header X-Real-IP $remote_addr` 覆写，
		//    是它自己看到的对端地址，客户端就算自带这个头也会被覆盖掉，最可信。
		if ip := r.Header.Get("X-Real-IP"); strings.TrimSpace(ip) != "" {
			return strings.TrimSpace(ip)
		}
		// ② 退回 XFF，但必须取【最右】而不是最左。
		//    nginx 的 `$proxy_add_x_forwarded_for` 是【追加】语义：客户端自带的值留在左边、
		//    nginx 把真实对端追加到最右。取最左等于直接采信攻击者填的字符串，限流形同虚设。
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			parts := strings.Split(xff, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				if v := strings.TrimSpace(parts[i]); v != "" {
					return v
				}
			}
		}
	}
	return remoteHost
}

// isTrustedProxy 判断「直接连上来的那一跳」是不是本部署自己的反代/前端容器。
// 只有可信时才采信它传来的 X-Real-IP / X-Forwarded-For（见 clientIPFromRequest）。
//
// ⚠️ 这里的默认值是有意放宽的，不要改回「只信回环」：
//
// 原先默认「只信回环」，理由是「Go 只可能被回环调用：Next 用 fetch("http://127.0.0.1:8080")
// 转发 /api/*，所以 RemoteAddr 恒为 127.0.0.1」。前后端拆成两个容器之后这个前提没了——
// 前端改走 Docker DNS（API_BASE_URL=http://backend:8080），RemoteAddr 变成前端容器的
// 网桥地址（如 172.18.0.2），默认分支于是【恒为 false】，nginx 传进来的真实 IP 被整个丢掉，
// 全站用户的 clientIP 塌缩成同一个值。后果是具体的：
//
//	· 登录失败锁定键是 username|ip（5 次错密码锁 15 分钟，见 service/auth.go）——
//	  ip 维度作废后，任何人只要知道别人的用户名就能把该账号锁死，而且可以一直续；
//	· 短信「单 IP 每日 100 条」变成全平台每天 100 条，100 个请求就能让当天所有人收不到验证码；
//	· 审计日志与短信记录里所有人的 IP 都一样，出事无法追溯。
//
// 所以空配置时的默认信任范围放宽到【回环 + 私有网段】：容器网桥、k8s Pod 网段都落在其中。
// 这是安全的——compose 里后端只 expose 不 publish，公网打不到它，能直接连上来的那一跳
// 必然是同一宿主机上本部署自己的容器。⚠️ 如果你把后端端口直接发布到公网（不建议），
// 请显式配置 TRUSTED_PROXIES 收紧。
func isTrustedProxy(remoteHost string) bool {
	host := strings.TrimSpace(remoteHost)
	ip := net.ParseIP(host)
	trusted := strings.TrimSpace(config.Cfg.TrustedProxies)
	if trusted == "" {
		if ip == nil {
			return false
		}
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
	}
	for _, item := range strings.Split(trusted, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		// 支持 CIDR 写法。容器 IP 由 docker 动态分配，只写死单个地址的话，
		// 容器重建顺序一变这份名单就【静默失效】、IP 再次塌缩且没有任何报错。
		// 写网段（例如 172.16.0.0/12）才是稳的。
		if strings.Contains(item, "/") {
			if _, subnet, err := net.ParseCIDR(item); err == nil && ip != nil && subnet.Contains(ip) {
				return true
			}
			continue
		}
		if item == host {
			return true
		}
	}
	return false
}

func SendSmsCode(w http.ResponseWriter, r *http.Request) {
	var request sendSmsCodeRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	ip := clientIPFromRequest(r)
	_, err := service.SendSmsCode(request.Phone, ip)
	if err != nil {
		FailError(w, err)
		return
	}
	// 恒定返回空 code，不在响应中泄露验证码
	OK(w, map[string]string{"code": ""})
}

func SmsLogin(w http.ResponseWriter, r *http.Request) {
	var request smsLoginRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	ip := clientIPFromRequest(r)
	session, err := service.SmsLoginOrRegister(request.Phone, ip, request.Code)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, session)
}

func AdminLogin(w http.ResponseWriter, r *http.Request) {
	var request loginRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	session, err := service.Login(request.Username, request.Password, clientIPFromRequest(r))
	if err != nil {
		FailError(w, err)
		return
	}
	if session.User.Role != model.UserRoleAdmin && session.User.Role != model.UserRoleAdminL2 {
		Fail(w, "需要管理员权限")
		return
	}
	OK(w, session)
}

type changePasswordRequest struct {
	OldPassword string `json:"oldPassword"`
	NewPassword string `json:"newPassword"`
}

// ChangePassword 当前登录用户修改自己的密码。
// 走 UserAuth 中间件，普通用户与管理员均可调用。
func ChangePassword(w http.ResponseWriter, r *http.Request) {
	var request changePasswordRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		FailAuth(w)
		return
	}
	if err := service.ChangePassword(user.ID, request.OldPassword, request.NewPassword, clientIPFromRequest(r)); err != nil {
		var fle *service.ForceLogoutError
		if errors.As(err, &fle) {
			// service 已旋转 SessionID 强制下线：返回 401 让前端 apiRequest 触发
			// notifySessionExpired 跳登录 + 把"原密码错误"显示在弹窗里。
			FailAuthWithMsg(w, fle.Error())
			return
		}
		FailError(w, err)
		return
	}
	OK(w, true)
}

// currentUserResponse 在 model.User 之外附带按分组算出来的功能开关，供前端决定要不要显示入口。
// 只放"能不能用"的布尔量，不放分组配置本身——渠道、密钥这些绝不出后端。
type currentUserResponse struct {
	model.AuthUser
}

func CurrentUser(w http.ResponseWriter, r *http.Request) {
	if user, ok := service.UserFromContext(r.Context()); ok {
		OK(w, currentUserResponse{AuthUser: user})
		return
	}
	// 未登录：保持原来的游客结构，能力一律 false。
	OK(w, currentUserResponse{AuthUser: service.GuestUser()})
}

// userResponse 在 model.User 基础上附带创建者姓名（creatorName），方便超管查看子用户归属。
type userResponse struct {
	model.User
	CreatorName string `json:"creatorName"`
}

type userListResponse struct {
	Items []userResponse `json:"items"`
	Total int            `json:"total"`
}

func AdminUsers(w http.ResponseWriter, r *http.Request) {
	me, _ := service.UserFromContext(r.Context())
	q := parseQuery(r)
	if me.Role == model.UserRoleAdminL2 {
		// 二级管理员只看自己创建的子用户。
		q.CreatorID = me.ID
	}
	users, err := service.ListUsers(q)
	if err != nil {
		FailError(w, err)
		return
	}
	// 对所有 admin 附带 creatorName：构造 creator id→username 映射。
	creatorIDs := make([]string, 0, len(users.Items))
	for _, item := range users.Items {
		if strings.TrimSpace(item.CreatorID) != "" {
			creatorIDs = append(creatorIDs, item.CreatorID)
		}
	}
	names, err := repository.UsernamesByIDs(creatorIDs)
	if err != nil {
		FailError(w, err)
		return
	}
	items := make([]userResponse, 0, len(users.Items))
	for _, item := range users.Items {
		items = append(items, userResponse{User: item, CreatorName: names[item.CreatorID]})
	}
	OK(w, userListResponse{Items: items, Total: users.Total})
}

// managerItem 二级管理员下拉项：仅暴露 id+username。
type managerItem struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

type managerListResponse struct {
	Items []managerItem `json:"items"`
}

// AdminManagers GET /api/admin/managers 列出所有二级管理员（超管专用，给前端下拉用）。
func AdminManagers(w http.ResponseWriter, r *http.Request) {
	users, err := repository.ListUsersByRole(model.UserRoleAdminL2)
	if err != nil {
		FailError(w, err)
		return
	}
	items := make([]managerItem, 0, len(users))
	for _, u := range users {
		items = append(items, managerItem{ID: u.ID, Username: u.Username})
	}
	OK(w, managerListResponse{Items: items})
}

type assignUserCreatorRequest struct {
	CreatorID string `json:"creatorId"`
}

// AdminAssignUserCreator POST /api/admin/users/:id/creator 把普通成员划归某二级管理员（或收回）。超管专用。
func AdminAssignUserCreator(w http.ResponseWriter, r *http.Request, id string) {
	var request assignUserCreatorRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	user, ok, err := repository.GetUserByID(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if !ok {
		Fail(w, "用户不存在")
		return
	}
	// 只能分配普通成员，不能把管理员（含二级管理员）分给别人管。
	if user.Role != model.UserRoleUser {
		Fail(w, "只能分配普通成员")
		return
	}
	creatorID := strings.TrimSpace(request.CreatorID)
	if creatorID != "" {
		creator, ok, err := repository.GetUserByID(creatorID)
		if err != nil {
			FailError(w, err)
			return
		}
		if !ok || creator.Role != model.UserRoleAdminL2 {
			Fail(w, "目标不是二级管理员")
			return
		}
	}
	// 先取完整 user 再只改 CreatorID，其余原样写回；不走 service.SaveUser 以免触发密码/积分逻辑。
	// 用 UpdateUserKeepingLive：跳过 credits 等由专用原子端点维护的列，
	// 避免整行写回覆盖并发提交的调额（见 repository/user.go userKeepLiveColumns）。
	user.CreatorID = creatorID
	saved, err := repository.UpdateUserKeepingLive(user)
	if err != nil {
		FailError(w, err)
		return
	}
	names, err := repository.UsernamesByIDs([]string{creatorID})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, userResponse{User: saved, CreatorName: names[creatorID]})
}

func AdminSaveUser(w http.ResponseWriter, r *http.Request) {
	var request saveUserRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	me, _ := service.UserFromContext(r.Context())
	user := model.User{
		ID:          request.ID,
		Username:    request.Username,
		Email:       request.Email,
		DisplayName: request.DisplayName,
		Role:        request.Role,
		Status:      request.Status,
		GroupID:     request.GroupID,
		ChannelKeys: strings.TrimSpace(request.ChannelKeys),
	}
	if me.Role == model.UserRoleAdminL2 {
		if !applyL2SaveUserRules(w, me, &user) {
			return
		}
	}
	// 审计要对比改动前后，所以必须在保存【之前】把旧值读出来。
	// 读失败不阻断保存——审计是旁路，见 service/user_audit.go 的三条红线。
	var old model.User
	hadOld := false
	if strings.TrimSpace(request.ID) != "" {
		if existing, ok, err := repository.GetUserByID(request.ID); err != nil {
			log.Printf("用户审计取旧值失败(已忽略) id=%s err=%v", request.ID, err)
		} else if ok {
			old, hadOld = existing, true
		}
	}
	saved, err := service.SaveUser(user, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	// 谁在什么时候改了哪个用户的什么字段。密码与渠道 Key 只记「改过」，绝不记值。
	service.RecordUserAudit(me, old, hadOld, saved, strings.TrimSpace(request.Password) != "", clientIPFromRequest(r))
	OK(w, saved)
}

// applyL2SaveUserRules 对二级管理员保存子用户施加隔离限制；通过返回 true，否则已写响应返回 false。
func applyL2SaveUserRules(w http.ResponseWriter, me model.AuthUser, user *model.User) bool {
	// 二级管理员只能产出普通用户，禁止铸造任何管理员。
	user.Role = model.UserRoleUser
	isCreate := strings.TrimSpace(user.ID) == ""
	if isCreate {
		user.CreatorID = me.ID
		// 必须分配到自己拥有的分组（若指定了分组）。
		if !l2OwnsGroup(w, me, user.GroupID) {
			return false
		}
		return true
	}
	old, ok, err := repository.GetUserByID(user.ID)
	if err != nil {
		FailError(w, err)
		return false
	}
	if !ok {
		Fail(w, "用户不存在")
		return false
	}
	if old.CreatorID != me.ID {
		Fail(w, "无权操作该用户")
		return false
	}
	// CreatorID 由 service.SaveUser 编辑分支从 DB 保留，这里无需再设。
	// GroupID 若变更必须仍是自己拥有的分组。
	if strings.TrimSpace(user.GroupID) != strings.TrimSpace(old.GroupID) {
		if !l2OwnsGroup(w, me, user.GroupID) {
			return false
		}
	}
	return true
}

// l2OwnsGroup 校验 groupID 归属于该二级管理员（空 groupID=未分组，放行）；不通过已写响应返回 false。
func l2OwnsGroup(w http.ResponseWriter, me model.AuthUser, groupID string) bool {
	if strings.TrimSpace(groupID) == "" {
		return true
	}
	group, ok, err := repository.GetGroupByID(groupID)
	if err != nil {
		FailError(w, err)
		return false
	}
	if !ok || group.OwnerID != me.ID {
		Fail(w, "无权使用该分组")
		return false
	}
	return true
}

func AdminAdjustUserCredits(w http.ResponseWriter, r *http.Request, id string) {
	var request adjustUserCreditsRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	me, _ := service.UserFromContext(r.Context())
	// 二级管理员可调整自己账号(id==me.ID)或自己创建的子用户的积分；其它用户一律拒绝。
	if me.Role == model.UserRoleAdminL2 && id != me.ID && !l2OwnsUser(w, me, id) {
		return
	}
	user, err := service.AdjustUserCredits(id, request.Credits, me.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, user)
}

type creditLogItem struct {
	model.CreditLog
	UserName     string `json:"userName"`
	OperatorName string `json:"operatorName"`
	ModelName    string `json:"model"`
	// ProjectName 该笔流水来源项目名（ProjectID 非空时补；个人流水为空）。
	ProjectName string `json:"projectName"`
}

// creditLogModelName 从流水 extra JSON（{"model":"...","path":"..."}）取模型名，供后台按模型展示/导出。
func creditLogModelName(extra string) string {
	if strings.TrimSpace(extra) == "" {
		return ""
	}
	var e struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal([]byte(extra), &e)
	return e.Model
}

// enrichCreditLogs 给流水批量补「被操作用户名 / 操作管理员名 / 模型名」，供列表与导出共用。
func enrichCreditLogs(logs []model.CreditLog) ([]creditLogItem, error) {
	idSet := make(map[string]struct{}, len(logs)*2)
	for _, log := range logs {
		if log.UserID != "" {
			idSet[log.UserID] = struct{}{}
		}
		if log.OperatorID != "" {
			idSet[log.OperatorID] = struct{}{}
		}
	}
	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	names, err := repository.UsernamesByIDs(ids)
	if err != nil {
		return nil, err
	}
	// 项目 id → 项目名（供「来源」列展示）。项目数量少，直接全量拉一次建映射。
	projectNames := map[string]string{}
	if projects, perr := repository.ListProjects(); perr == nil {
		for _, p := range projects {
			projectNames[p.ID] = p.Name
		}
	}
	items := make([]creditLogItem, 0, len(logs))
	for _, log := range logs {
		items = append(items, creditLogItem{
			CreditLog:    log,
			UserName:     names[log.UserID],
			OperatorName: names[log.OperatorID],
			ModelName:    creditLogModelName(log.Extra),
			ProjectName:  projectNames[log.ProjectID],
		})
	}
	return items, nil
}

// creditLogQuery 解析积分流水的筛选参数（关键词/类型/模型/成员/时间范围）并套用二级管理员范围限制。
// 返回 ok=false 表示已写错误响应，调用方直接 return。
func creditLogQuery(w http.ResponseWriter, r *http.Request) (model.Query, bool) {
	me, _ := service.UserFromContext(r.Context())
	q := parseQuery(r) // keyword/type/page/pageSize
	query := r.URL.Query()
	q.Model = query.Get("model")
	q.Member = query.Get("member")
	q.Start = query.Get("start")
	q.End = query.Get("end")
	q.Source = query.Get("source") // 来源筛选：__personal__ / 项目 id / 空=全部
	if me.Role == model.UserRoleAdminL2 {
		// 二级管理员看「自己子用户 + 本人账号」的流水：把本人 ID 一并纳入，让 L2 也能查看自己的积分消耗
		// （此前只含子用户、漏了本人）。append 会处理 nil：无子用户时得到 [me.ID]（非 nil），L2 至少能看到自己的消耗。
		ids, err := repository.UserIDsByCreator(me.ID)
		if err != nil {
			FailError(w, err)
			return q, false
		}
		q.UserIDs = append(ids, me.ID)
	}
	return q, true
}

func AdminCreditLogs(w http.ResponseWriter, r *http.Request) {
	q, ok := creditLogQuery(w, r)
	if !ok {
		return
	}
	// all=1：导出用，不分页返回筛选后的全部流水。
	if r.URL.Query().Get("all") == "1" {
		logs, err := service.ListAllCreditLogs(q)
		if err != nil {
			FailError(w, err)
			return
		}
		items, err := enrichCreditLogs(logs)
		if err != nil {
			FailError(w, err)
			return
		}
		OK(w, map[string]any{"items": items, "total": len(items)})
		return
	}
	logs, err := service.ListCreditLogs(q)
	if err != nil {
		FailError(w, err)
		return
	}
	items, err := enrichCreditLogs(logs.Items)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"items": items, "total": logs.Total})
}

// AdminCreditLogsSummary 当前筛选下的总汇总（顶部总数）+ 按成员逐人汇总。
func AdminCreditLogsSummary(w http.ResponseWriter, r *http.Request) {
	q, ok := creditLogQuery(w, r)
	if !ok {
		return
	}
	overall, members, models, err := service.SummarizeCreditLogs(q)
	if err != nil {
		FailError(w, err)
		return
	}
	ids := make([]string, 0, len(members))
	for _, m := range members {
		if m.UserID != "" {
			ids = append(ids, m.UserID)
		}
	}
	names, err := repository.UsernamesByIDs(ids)
	if err != nil {
		FailError(w, err)
		return
	}
	for i := range members {
		members[i].UserName = names[members[i].UserID]
	}
	OK(w, map[string]any{"overall": overall, "byMember": members, "byModel": models})
}

// l2OwnsUser 校验目标用户由该二级管理员创建；不通过已写响应返回 false。
func l2OwnsUser(w http.ResponseWriter, me model.AuthUser, id string) bool {
	target, ok, err := repository.GetUserByID(id)
	if err != nil {
		FailError(w, err)
		return false
	}
	if !ok {
		Fail(w, "用户不存在")
		return false
	}
	if target.CreatorID != me.ID {
		Fail(w, "无权操作该用户")
		return false
	}
	return true
}

func AdminSaveCreditLog(w http.ResponseWriter, r *http.Request) {
	var log model.CreditLog
	if !decodeJSON(w, r, &log) {
		return
	}
	result, err := service.SaveCreditLog(log)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminDeleteCreditLog(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteCreditLog(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminDeleteUser(w http.ResponseWriter, r *http.Request, id string) {
	me, _ := service.UserFromContext(r.Context())
	if me.Role == model.UserRoleAdminL2 && !l2OwnsUser(w, me, id) {
		return
	}
	if err := service.DeleteUser(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}
