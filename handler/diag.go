package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"aicanvas/service"
)

// diagMaxIDs 单条上报最多接受的节点 id 数，防止日志被刷爆。
const diagMaxIDs = 10

// diagMaxLen 每个字符串字段的最大长度，超出截断——上报内容来自客户端，不可信任。
const diagMaxLen = 80

// ReportPersistSwallow 诊断上报：画布持久化被 skipNextPersistRef 吞掉了一次。
//
// 【为什么需要它】canvas-client-page 的持久化 effect 里有一个一次性标志：
// 任何一次画布重载（restore）都会置起它，随后【第一次】持久化不论内容是什么都会被跳过。
// 这个标志本意是「不要把 restore 自己那次 setNodes 又写回去」，但它是盲吞下一次，
// 于是恰好落在那一拍的真实用户改动会被整个丢掉：store 没有、IndexedDB 没有、云端更没有。
// 已确认拖动落点会撞上（那个入口已单独修掉），怀疑肖像授权的写回也会撞上
// （表现是「认证完显示未认证，反复点好几次」）。
//
// 但这只是推断。与其凭猜改核心机制，先让客户端把每次「吞掉了什么」报上来，
// 跑一两天看真实分布，再决定怎么根治。
//
// 纯观测：不落库、不影响任何行为，只打一行日志。
func ReportPersistSwallow(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录")
		return
	}
	var payload struct {
		ProjectID string   `json:"projectId"`
		Reason    string   `json:"reason"`
		NodeCount int      `json:"nodeCount"`
		Changed   []string `json:"changed"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "格式不正确")
		return
	}
	clip := func(s string) string {
		s = strings.Map(func(c rune) rune {
			// 日志注入防护：换行/回车会被伪造成额外日志行
			if c == '\n' || c == '\r' {
				return ' '
			}
			return c
		}, strings.TrimSpace(s))
		if len(s) > diagMaxLen {
			return s[:diagMaxLen]
		}
		return s
	}
	changed := payload.Changed
	if len(changed) > diagMaxIDs {
		changed = changed[:diagMaxIDs]
	}
	for i := range changed {
		changed[i] = clip(changed[i])
	}
	log.Printf("[diag] 持久化被吞 user=%s project=%s reason=%s nodes=%d changed=%d %v",
		user.ID, clip(payload.ProjectID), clip(payload.Reason), payload.NodeCount, len(payload.Changed), changed)
	OK(w, map[string]any{"ok": true})
}
