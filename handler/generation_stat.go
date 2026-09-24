package handler

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
	"aicanvas/service"
)

// beijingZone 北京时间（UTC+8）：统计的日期边界按北京时间切分，再换算成 UTC 与 created_at（UTC RFC3339）比较。
var beijingZone = time.FixedZone("CST", 8*3600)

// beijingDayRangeUTC 把北京时间的日期范围 [startDate, endDate]（YYYY-MM-DD，含端点）转成 UTC RFC3339 半开区间 [startUTC, endUTC)。
func beijingDayRangeUTC(startDate, endDate string) (string, string, bool) {
	s, err1 := time.ParseInLocation("2006-01-02", strings.TrimSpace(startDate), beijingZone)
	e, err2 := time.ParseInLocation("2006-01-02", strings.TrimSpace(endDate), beijingZone)
	if err1 != nil || err2 != nil {
		return "", "", false
	}
	if e.Before(s) {
		s, e = e, s
	}
	startUTC := s.UTC().Format("2006-01-02T15:04:05Z")
	endUTC := e.AddDate(0, 0, 1).UTC().Format("2006-01-02T15:04:05Z")
	return startUTC, endUTC, true
}

// sortBreakdown 把明细 map 转成有序切片：视频→图片→音频，组内按（成功+失败次数）降序、其次时长降序。
func sortBreakdown(m map[string]*model.GenStatBreakdownRow) []model.GenStatBreakdownRow {
	if len(m) == 0 {
		return nil
	}
	rows := make([]model.GenStatBreakdownRow, 0, len(m))
	for _, r := range m {
		rows = append(rows, *r)
	}
	order := map[string]int{"video": 0, "image": 1, "audio": 2}
	sort.SliceStable(rows, func(i, j int) bool {
		if oi, oj := order[rows[i].Kind], order[rows[j].Kind]; oi != oj {
			return oi < oj
		}
		if ti, tj := rows[i].Count+rows[i].Fail, rows[j].Count+rows[j].Fail; ti != tj {
			return ti > tj
		}
		return rows[i].Seconds > rows[j].Seconds
	})
	return rows
}

// AdminGenerationStats GET /api/admin/generation-stats?start=YYYY-MM-DD&end=YYYY-MM-DD&ownerId=
// 按「二级管理员（ownerId=creator_id）」汇总其下辖用户在指定北京时间日期范围内的生成情况。
// 超管可查任意 ownerId（前端下拉选二级管理员）；二级管理员一律只能看自己下辖（ownerId 强制为自己）。
func AdminGenerationStats(w http.ResponseWriter, r *http.Request) {
	me, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	q := r.URL.Query()
	startUTC, endUTC, valid := beijingDayRangeUTC(q.Get("start"), q.Get("end"))
	if !valid {
		Fail(w, "日期格式不正确（应为 YYYY-MM-DD）")
		return
	}

	ownerID := strings.TrimSpace(q.Get("ownerId"))
	if me.Role == model.UserRoleAdminL2 {
		// 二级管理员只能看自己下辖，忽略传入的 ownerId。
		ownerID = me.ID
	}

	users, err := repository.SubordinateUsers(ownerID)
	if err != nil {
		FailError(w, err)
		return
	}
	userIDs := make([]string, 0, len(users))
	for _, u := range users {
		userIDs = append(userIDs, u.ID)
	}

	metrics, err := repository.SummarizeGenerationStats(userIDs, startUTC, endUTC)
	if err != nil {
		FailError(w, err)
		return
	}

	groups, _ := repository.ListGroups()
	groupName := make(map[string]string, len(groups))
	for _, g := range groups {
		groupName[g.ID] = g.Name
	}

	members := make([]model.GenerationStatMember, 0, len(users))
	idle := make([]string, 0)
	var total model.GenerationStatMember
	for _, u := range users {
		row := model.GenerationStatMember{
			UserID:    u.ID,
			UserName:  u.Username,
			GroupName: groupName[u.GroupID],
		}
		if m := metrics[u.ID]; m != nil {
			row.VideoOK, row.VideoOKSeconds = m.VideoOK, m.VideoOKSeconds
			row.VideoFail, row.VideoFailSeconds = m.VideoFail, m.VideoFailSeconds
			row.ImageCount, row.AudioCount, row.CreditsUsed = m.ImageCount, m.AudioCount, m.CreditsUsed
			row.Breakdown = sortBreakdown(m.Breakdown)
		}
		if row.VideoOK+row.VideoFail+row.ImageCount+row.AudioCount+row.CreditsUsed > 0 {
			members = append(members, row)
			total.VideoOK += row.VideoOK
			total.VideoOKSeconds += row.VideoOKSeconds
			total.VideoFail += row.VideoFail
			total.VideoFailSeconds += row.VideoFailSeconds
			total.ImageCount += row.ImageCount
			total.AudioCount += row.AudioCount
			total.CreditsUsed += row.CreditsUsed
		} else {
			idle = append(idle, row.UserName)
		}
	}
	// 排序：成功视频秒数降序，其次图片数降序（与手工汇总一致）。
	sort.SliceStable(members, func(i, j int) bool {
		if members[i].VideoOKSeconds != members[j].VideoOKSeconds {
			return members[i].VideoOKSeconds > members[j].VideoOKSeconds
		}
		return members[i].ImageCount > members[j].ImageCount
	})

	ownerName := ""
	if ownerID != "" {
		if o, ok, _ := repository.GetUserByID(ownerID); ok {
			ownerName = o.Username
		}
	}

	OK(w, model.GenerationStatResult{
		OwnerID:   ownerID,
		OwnerName: ownerName,
		Members:   members,
		Total:     total,
		IdleUsers: idle,
	})
}
