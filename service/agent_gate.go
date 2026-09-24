package service

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// 画布助手的服务端闸门。
//
// 为什么必须在服务端：助手是一个【会自己循环调用模型】的东西。
// 前端 agent-loop 里那道 MAX_ROUNDS=8 只是 UX —— 用户改改前端、或者直接拿 token 打接口，
// 那道闸就没了，而每一轮都在烧 token、扣点数。
// 「配置缺失静默回退」「漏传项目头错扣到个人」这类计费问题本来就容易发生，
// 循环调用会把它们成倍放大，所以闸必须落在这条链上。
//
// 设计要点：
//   · **服务端自己数轮次，不信前端传来的 X-Agent-Round**。那个头只当回合标识的一部分用。
//   · 纯内存 + TTL，不落库：闸门是防失控，不是审计；审计走 upstream_logs / credit_logs。
//     重启后计数清零可以接受（最坏是让某个正在跑的回合多跑几轮）。
//   · 每个用户同时在跑的回合数也要限，否则换个 turnId 就能绕过轮次上限。

const (
	// agentMaxRounds 一个回合最多问几轮模型。与前端 agent-loop.ts 的 MAX_ROUNDS 保持一致。
	agentMaxRounds = 8
	// agentTurnTTL 一个回合的记账保留多久。超过就当它结束了。
	agentTurnTTL = 10 * time.Minute
	// agentMaxLiveTurns 单个用户同时存活的回合数上限。防止「每轮换一个 turnId」绕过轮次闸。
	agentMaxLiveTurns = 4
	// agentMaxTurnCredits 一个回合最多花多少点数。
	//
	// 助手是个会自己循环调用的东西：模型一旦绕圈子或者理解错意图，几十张图就出去了。
	// 前端的轮次上限只是 UX（用户改改前端就没了），这道才是真闸。
	// 取 200 的依据：一张图 1~8 点、一条视频十几点，200 点够一个回合出十几张图，
	// 正常用不到，失控时能兜住。
	agentMaxTurnCredits = 200
)

type agentTurnState struct {
	rounds  int
	credits int
	firstAt time.Time
	lastAt  time.Time
}

var (
	agentGateMu sync.Mutex
	agentTurns  = map[string]*agentTurnState{}
)

func agentTurnKey(userID, turnID string) string {
	return userID + "\x1f" + turnID
}

// agentGateSweep 清掉过期回合。调用方必须已持锁。
func agentGateSweep(now time.Time) {
	for k, v := range agentTurns {
		if now.Sub(v.lastAt) > agentTurnTTL {
			delete(agentTurns, k)
		}
	}
}

// AgentTurnAdmit 放行这一轮吗。
//
// turnID 为空表示这不是助手请求（普通对话/生图等），一律放行、不记账。
// 返回 (放行, 这是第几轮, 拒绝理由)。
func AgentTurnAdmit(userID, turnID string) (bool, int, string) {
	turnID = strings.TrimSpace(turnID)
	if turnID == "" || userID == "" {
		return true, 0, ""
	}
	// 头是用户可控的，长度要卡死，别让它把 map 的 key 撑爆
	if len(turnID) > 64 {
		turnID = turnID[:64]
	}

	now := time.Now()
	agentGateMu.Lock()
	defer agentGateMu.Unlock()
	agentGateSweep(now)

	key := agentTurnKey(userID, turnID)
	state, exists := agentTurns[key]
	if !exists {
		// 新回合：先看这个用户是不是已经有太多回合在跑
		live := 0
		for k := range agentTurns {
			if strings.HasPrefix(k, userID+"\x1f") {
				live++
			}
		}
		if live >= agentMaxLiveTurns {
			return false, 0, "助手正在处理的请求太多，请等前面的跑完再说"
		}
		state = &agentTurnState{firstAt: now}
		agentTurns[key] = state
	}

	if state.rounds >= agentMaxRounds {
		return false, state.rounds, "本次助手对话已达轮次上限，请重新发起一次"
	}
	state.rounds++
	state.lastAt = now
	return true, state.rounds, ""
}

// AgentTurnSpend 记一笔花费并判断是否超预算。
//
// turnID 为空（不是助手发的请求）一律放行、不记账。
// 调用时机：算完这一单要花多少点数之后、真正扣费之前——超了就一分钱不花地拒掉。
// 返回 (放行, 这个回合已花, 拒绝理由)。
func AgentTurnSpend(userID, turnID string, credits int) (bool, int, string) {
	turnID = strings.TrimSpace(turnID)
	if turnID == "" || userID == "" {
		return true, 0, ""
	}
	if len(turnID) > 64 {
		turnID = turnID[:64]
	}
	if credits < 0 {
		credits = 0
	}

	now := time.Now()
	agentGateMu.Lock()
	defer agentGateMu.Unlock()
	agentGateSweep(now)

	key := agentTurnKey(userID, turnID)
	state, exists := agentTurns[key]
	if !exists {
		state = &agentTurnState{firstAt: now}
		agentTurns[key] = state
	}
	if state.credits+credits > agentMaxTurnCredits {
		return false, state.credits, fmt.Sprintf(
			"助手这一轮已经花了 %d 点，再做这一步会超过单次上限 %d 点。请分几次来，或者自己手动生成。",
			state.credits, agentMaxTurnCredits)
	}
	state.credits += credits
	state.lastAt = now
	return true, state.credits, ""
}
