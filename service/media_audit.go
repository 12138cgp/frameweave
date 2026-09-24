package service

import (
	"encoding/json"
	"sort"
	"strings"

	"aicanvas/repository"
)

// 素材对账：找出「画布数据引用了、但服务端没有对应文件登记」的 storageKey。
//
// 背景：客户端同步遇到本地没有字节的素材会直接跳过（不上传、不报错），所以「图片其实早就没传上来」
// 这件事在服务端是完全看不见的——只有用户换台设备打开、发现一片白框时才暴露，而那时本机那份
// 唯一副本往往也已经被清掉了。这个对账把它变成随时可查的数字。
//
// 判定口径：只统计画布里【有 content 且有 storageKey】的图片/视频/音频节点。
// 本人名下查无登记时再全局找一次——分享/取用来的画布，文件登记留在原上传者名下，那种不算丢失。

// MediaAuditUser 单个用户的素材对账结果。
type MediaAuditUser struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Group    string `json:"group"`
	// Referenced 画布引用到的去重 storageKey 总数
	Referenced int `json:"referenced"`
	// Registered 本人名下有登记的
	Registered int `json:"registered"`
	// SharedElsewhere 本人名下没有、但别的账号名下有（分享/取用，不算丢失）
	SharedElsewhere int `json:"sharedElsewhere"`
	// Missing 任何账号名下都查不到 —— 这些素材已经丢了
	Missing int `json:"missing"`
	// MissingSamples 前若干个丢失的 key，便于定位
	MissingSamples []string `json:"missingSamples"`
	// MissingByCanvas 丢失素材在各子画布的分布
	MissingByCanvas map[string]int `json:"missingByCanvas"`
}

type auditNode struct {
	Type     string `json:"type"`
	Metadata struct {
		Content    string `json:"content"`
		StorageKey string `json:"storageKey"`
	} `json:"metadata"`
}

type auditProject struct {
	Title string      `json:"title"`
	Nodes []auditNode `json:"nodes"`
}

type auditRoot struct {
	Data struct {
		Projects []auditProject `json:"projects"`
	} `json:"data"`
}

// AuditUserMedia 对单个用户做素材对账。
func AuditUserMedia(userID string, sampleLimit int) (MediaAuditUser, error) {
	out := MediaAuditUser{UserID: userID, MissingByCanvas: map[string]int{}}
	if sampleLimit <= 0 {
		sampleLimit = 20
	}
	raw, err := repository.GetSyncDataValue(userID, "canvas")
	if err != nil || strings.TrimSpace(raw) == "" {
		return out, err
	}
	var root auditRoot
	if err := json.Unmarshal([]byte(raw), &root); err != nil {
		return out, err
	}
	owned, err := repository.SyncFileKeySet(userID)
	if err != nil {
		return out, err
	}

	seen := map[string]bool{}
	for _, project := range root.Data.Projects {
		for _, node := range project.Nodes {
			if node.Type != "image" && node.Type != "video" && node.Type != "audio" {
				continue
			}
			key := strings.TrimSpace(node.Metadata.StorageKey)
			// content 为空说明节点本身就是空的（用户还没出图），不算丢失
			if key == "" || strings.TrimSpace(node.Metadata.Content) == "" || seen[key] {
				continue
			}
			seen[key] = true
			out.Referenced++
			if owned[key] {
				out.Registered++
				continue
			}
			// 本人名下没有 → 可能是分享/取用来的（登记在原上传者名下），全局再找一次
			exists, gerr := repository.SyncFileKeyExistsAnyUser(key)
			if gerr == nil && exists {
				out.SharedElsewhere++
				continue
			}
			out.Missing++
			title := project.Title
			if strings.TrimSpace(title) == "" {
				title = "(未命名)"
			}
			out.MissingByCanvas[title]++
			if len(out.MissingSamples) < sampleLimit {
				out.MissingSamples = append(out.MissingSamples, key)
			}
		}
	}
	return out, nil
}

// AuditAllUsersMedia 对全部有画布数据的用户做对账，按丢失数从多到少返回。
// 逐用户处理、只读，不改任何数据。
func AuditAllUsersMedia(sampleLimit int) ([]MediaAuditUser, error) {
	userIDs, err := repository.SyncDataUserIDs("canvas")
	if err != nil {
		return nil, err
	}
	results := make([]MediaAuditUser, 0, len(userIDs))
	for _, userID := range userIDs {
		item, aerr := AuditUserMedia(userID, sampleLimit)
		if aerr != nil || item.Referenced == 0 {
			continue
		}
		if user, ok, uerr := repository.GetUserByID(userID); uerr == nil && ok {
			item.Username = user.Username
			if group, gok, gerr := repository.GetGroupByID(user.GroupID); gerr == nil && gok {
				item.Group = group.Name
			}
		}
		results = append(results, item)
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].Missing != results[j].Missing {
			return results[i].Missing > results[j].Missing
		}
		return results[i].Referenced > results[j].Referenced
	})
	return results, nil
}
