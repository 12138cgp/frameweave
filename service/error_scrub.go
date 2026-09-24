package service

import (
	"regexp"
	"strings"
)

// 给终端用户看的错误文案里，绝不能出现上游厂商/中转商的身份、本平台的凭证、或服务器地址。
//
// 起因：画布节点上会原样显示出这样的文案
//
//	Post "https://<中转商域名>/v1beta/models/xxx:generateContent": net/http: timeout awaiting response headers
//
// 排查后发现这不是孤例，而是一整类：Go 的 *url.Error 天然带完整请求 URL，而代码里多处
// 把上游错误按「中文前缀 + err.Error()」拼给用户，散落在语音合成、视频接口、火山资产库、
// 对象存储等多条链路上。最危险的一类是签名式接口——上游报 SignatureDoesNotMatch 时
// 会把它算出的 StringToSign 原样回显，那串里含 AccessKeyId=...，等于把渠道凭证吐给用户。
//
// 治法是在**出口**统一洗，而不是逐个调用点堵（漏一个就前功尽弃，且将来新增调用点必然再漏）。
// 目前挂了三个出口：
//   - handler.FailError        —— safeMessageError 那条路（各上游适配器/火山资产/TOS）
//   - handler.safeUpstreamText —— 翻译上游响应体那条路
//   - service.fail()           —— 生成任务写库那条路（见 generation_job.go）
//
// 原始错误在这三处之前都已经 log.Printf 过，服务端排查能力不受影响。

var (
	// Go net/http 错误前缀：Post "https://host/path": <原因>
	goHTTPOpRe = regexp.MustCompile(`(?i)\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+"[^"]*"\s*:\s*`)
	// 裸 URL（右界排除中英文标点，避免把后面的句子一起吃掉）
	urlRe = regexp.MustCompile(`(?i)\bhttps?://[^\s"'<>)\]，。；、]+`)
	// key=value 形态的凭证。注意不含 "request id"——火山的 Request id 要留给用户去提工单。
	//
	// 分隔符必须同时认字面 '=' 和 URL 编码的 '%3D'：签名式接口报 SignatureDoesNotMatch 时
	// 回显的 StringToSign 是**编码过**的规范化查询串（AccessKeyId%3D...%26Action%3D...），
	// 只认 '=' 会整条漏过去——这正是审计里最危险的那条。
	credentialRe = regexp.MustCompile(`(?i)(access[_-]?key[_-]?id|access[_-]?key[_-]?secret|secret[_-]?access[_-]?key|api[_-]?key|apikey|signature[_-]?nonce|signature|authorization|password|passwd|secret|token)\s*(?:=|:|%3[dD])\s*[^\s&,;"'）)]+`)
	// 无 key 前缀的裸密钥：OpenAI sk-、阿里云 LTAI、AWS AKIA、火山 AKLT。（保留全部前缀：洗得宽一点没坏处）
	// 刻意不加 \b 前缀：编码串里密钥紧跟在 '%3D' 的 'D' 后面，有词边界要求反而匹配不上。
	// 后面要求 6 位以上字母数字，所以不会误伤 VOLTAIC 这类普通单词。
	bareCredentialRe = regexp.MustCompile(`(?:sk-[A-Za-z0-9_\-]{8,}|LTAI[A-Za-z0-9]{6,}|AKIA[A-Za-z0-9]{8,}|AKLT[A-Za-z0-9_\-]{8,})`)
	// HTML 错误页：上游被 nginx/CDN/WAF 拦下时回的是整页 HTML，里面有网关标识、
	// 内部 upstream 地址、服务器版本。既是泄漏，显示给用户也毫无意义，整段换掉。
	htmlPageRe = regexp.MustCompile(`(?is)<\s*(?:html|head|body|title|center|hr|div|pre|span|p)\b.*`)
	// IPv4[:端口]。既挡上游出口 IP，也挡本平台容器的内网地址
	// （形如 read tcp 172.17.0.3:41522->203.0.113.9:443，两端都不该给用户看）。
	ipPortRe = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b`)
	// 纯传输层故障的特征词。命中说明后面全是对用户零信息量的英文术语，从这里截断。
	// 「RequestError: send request failed」是 volcengine/aws 风格 SDK 的固定样板，
	// 它总是包着真正的 *url.Error，一并算作噪音起点，否则用户会看到一截残留的英文夹在中文里。
	transportNoiseRe = regexp.MustCompile(`(?i)RequestError: send request failed|net/http:|dial tcp|read tcp|write tcp|context deadline exceeded|connection refused|connection reset|no such host|\bi/o timeout\b|TLS handshake|\bEOF\b`)
)

const (
	upstreamUnreachableText = "AI 接口请求失败（网络错误或超时），积分已退回"
	transportFailText       = "网络连接失败或超时，请重试"
	gatewayPageText         = "上游网关返回了错误页（通常是过载或被拦截），请稍后重试"
)

// ScrubForUser 把一段错误文本洗成可以安全显示给终端用户的形式。
//
// 保留业务信息、只去敏感项：上游回的「内容审核不通过」「参数非法」「Request id: xxx」这些
// 正是用户需要看到的，不能一并抹掉——洗过头等于让人拿着一句「操作失败」去提工单。
// 传输层噪音则连同其后内容一起换成中文，但**保留它前面的业务前缀**，
// 让「语音合成请求失败：」这样的上下文不至于丢失。
func ScrubForUser(text string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	out := goHTTPOpRe.ReplaceAllString(text, "")
	// HTML 整页先换掉：它内部的域名/IP/版本号逐项去抹是抹不干净的（网关标识、注释、
	// 内部转发地址形态各异），而且用户看一整页 HTML 也没有任何意义。
	out = htmlPageRe.ReplaceAllString(out, gatewayPageText)
	out = urlRe.ReplaceAllString(out, "[上游接口]")
	out = credentialRe.ReplaceAllString(out, "$1=[已隐藏]")
	out = bareCredentialRe.ReplaceAllString(out, "[已隐藏密钥]")
	out = ipPortRe.ReplaceAllString(out, "[地址已隐藏]")
	if loc := transportNoiseRe.FindStringIndex(out); loc != nil {
		prefix := strings.TrimSpace(out[:loc[0]])
		prefix = strings.TrimRight(prefix, " \t-")
		if prefix == "" {
			out = transportFailText
		} else {
			if !strings.HasSuffix(prefix, "：") && !strings.HasSuffix(prefix, ":") &&
				!strings.HasSuffix(prefix, "，") && !strings.HasSuffix(prefix, ",") {
				prefix += "："
			}
			out = prefix + transportFailText
		}
	}
	return strings.TrimSpace(out)
}

// scrubUpstreamIdentity 是生成任务写库出口用的版本（service/generation_job.go 的 fail()）。
//
// 与 ScrubForUser 的差别只在纯传输层故障这一种情况：那里一定伴随退款，
// 所以直接用带「积分已退回」的完整文案，省得用户以为钱白扣了。
// 空串原样返回——调用方用空串表示「稍后由 aiUpstreamStatusMessage 按上游响应体翻译」，
// 改写它会导致 4xx/5xx 失败丢掉上游给的具体原因。
func scrubUpstreamIdentity(msg string) string {
	if strings.TrimSpace(msg) == "" {
		return msg
	}
	out := ScrubForUser(msg)
	if out == transportFailText || out == "" {
		return upstreamUnreachableText
	}
	return out
}
