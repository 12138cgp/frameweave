package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"aicanvas/model"
	"aicanvas/service"
)

type response struct {
	Code int    `json:"code"`
	Data any    `json:"data"`
	Msg  string `json:"msg"`
}

func OK(w http.ResponseWriter, data any) {
	writeJSON(w, response{Code: 0, Data: data, Msg: "ok"})
}

func Fail(w http.ResponseWriter, msg string) {
	writeJSON(w, response{Code: 1, Data: nil, Msg: msg})
}

// decodeJSON 解析请求体 JSON，失败时回业务错误并返回 false（调用方应直接 return），
// 避免畸形请求被静默当成零值继续执行。
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		Fail(w, "请求格式错误")
		return false
	}
	return true
}

// FailAuth 鉴权失败：发真 401 + code 401，前端全局拦截器据此立即登出（单设备登录被顶号场景）。
// 区别于 Fail 的 HTTP 200 + code 1（普通业务失败），两者不可混用。
func FailAuth(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(response{Code: 401, Data: nil, Msg: "登录已失效，请重新登录"})
}

// FailAuthWithMsg 同 FailAuth 但用自定义 msg。
// 用于"修改密码 5 次失败强制下线"场景：返回 401 让前端自动跳登录，
// 同时 msg 显示"原密码错误"——不暴露锁定状态，避免攻击者据此调整重试策略。
func FailAuthWithMsg(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(response{Code: 401, Data: nil, Msg: msg})
}

func FailError(w http.ResponseWriter, err error) {
	log.Printf("request failed: %v", err)
	if safe, ok := err.(interface{ SafeMessage() string }); ok {
		// SafeMessage 这个名字有误导：它只是「允许展示」的标记，内容常常是
		// 「中文前缀 + err.Error()」，而 Go 的 *url.Error 天然带完整上游 URL。
		// 各上游适配器、火山资产库、对象存储几条链路都走这里，是泄漏面最大的一个出口，
		// 所以在此统一脱敏。原始错误上一行已经写进服务端日志，排查能力不受影响。
		Fail(w, service.ScrubForUser(safe.SafeMessage()))
		return
	}
	Fail(w, "操作失败")
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func parseQuery(r *http.Request) model.Query {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, _ := strconv.Atoi(q.Get("pageSize"))
	return model.Query{
		Keyword:  q.Get("keyword"),
		Tags:     q["tag"],
		Category: q.Get("category"),
		Type:     q.Get("type"),
		IP:       q.Get("ip"),
		Page:     page,
		PageSize: pageSize,
	}
}
