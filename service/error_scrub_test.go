package service

import (
	"strings"
	"testing"
)

// 不能出现在给终端用户看的文案里的东西：上游/中转商域名、本平台的凭证、服务器地址。
var forbiddenFragments = []string{
	"http://", "https://",
	"openspeech.example.com", "aliyuncs.com", "open.volcengineapi.com",
	"volces.com", "openresty", "relay-node7",
	"LTAI", "AKLT", "AKIA", "sk-",
	"172.17.0", "203.0.113", "10.0.3.17",
}

func assertClean(t *testing.T, in, got string) {
	t.Helper()
	for _, bad := range forbiddenFragments {
		if strings.Contains(got, bad) {
			t.Fatalf("洗完仍含敏感片段 %q：\n  输入=%s\n  输出=%s", bad, in, got)
		}
	}
	if strings.TrimSpace(got) == "" {
		t.Fatalf("洗成空串了，用户会看到没有任何说明的失败：输入=%s", in)
	}
}

// 逐条对应一次错误文案审计确认的泄漏点。每条都是真实代码会拼出来的形态。
func TestScrubForUserBlocksAuditedLeaks(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{
			// 传输层失败的 *url.Error 天然带完整请求 URL——最典型的一条
			"gemini 传输超时",
			`Post "https://relay.example.com/v1beta/models/gemini-3-pro-image-preview:generateContent": net/http: timeout awaiting response headers`,
		},
		{
			// 语音合成类适配器：*url.Error 天然带完整请求 URL
			"语音合成请求失败",
			`语音合成请求失败：Post "https://openspeech.example.com/api/v3/tts/unidirectional": dial tcp 203.0.113.9:443: i/o timeout`,
		},
		{
			// 同时暴露本平台容器内网 IP 和上游 IP
			"语音合成断流",
			`语音合成响应读取失败：read tcp 172.17.0.3:41522->203.0.113.9:443: read: connection reset by peer`,
		},
		{
			// 最危险的一条：签名式接口回显 StringToSign，把渠道 AccessKeyId 带了出来。
			// 下面这串密钥是**测试占位值**，保留 LTAI 前缀只为让裸密钥正则能命中。
			"签名不匹配回显凭证",
			`视频接口错误[SignatureDoesNotMatch]: Specified signature is not matched with our calculation. server string to sign is:POST&%2F&AccessKeyId%3DLTAIfakeTestPlaceholder%26Action%3DSubmitJob%26SignatureNonce%3Dabc123%26Version%3D2023-08-01`,
		},
		{
			// 上游被网关拦截返回 HTML 错误页
			"返回网关错误页",
			`视频接口返回非 JSON(HTTP 502): <html><head><title>502 Bad Gateway</title></head><body><center>openresty/1.21.4.1</center><hr>upstream: "http://10.0.3.17:9000/v1/images"</body></html>`,
		},
		{
			// service/volc_asset.go:355——火山 SDK 的 RequestError 形态
			"火山资产库调用失败",
			`火山资产库 CreateAsset 调用失败：RequestError: send request failed caused by: Post "https://open.volcengineapi.com/?Action=CreateAsset&Version=2024-01-01": dial tcp 203.0.113.9:443: connect: connection refused`,
		},
		{
			// service/tos.go——暴露私有桶名与内部对象路径
			"参考图转存失败",
			`参考图转存失败，无法提交视频任务：Put "https://my-private-bucket.tos-s3-cn-beijing.volces.com/media/user-abc123/video-ref/x.png": dial tcp 203.0.113.9:443: i/o timeout`,
		},
		{
			// handler/ai.go——上游把本平台的 key 回显在错误里
			"上游回显 API Key",
			`Incorrect API key provided: sk-fakeTestPlaceholder. You can find your API key at https://relay.example.com/token`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			assertClean(t, c.in, ScrubForUser(c.in))
		})
	}
}

// 洗过头同样是 bug：该给用户看的业务信息必须原样留下。
// 尤其是火山的 Request id——用户要拿它去提工单，抹掉等于让人空手求助。
func TestScrubForUserKeepsBusinessMessages(t *testing.T) {
	keep := []string{
		"生成请求缺少提示词",
		"AI 接口请求失败（网络错误或超时），积分已退回",
		"The request failed because the input image may contain sensitive information. Request id: 0217855695095725630b2fa661ac131412e72f6bdd3759f4c495b",
		"参考图过大，请压缩后重试",
		"点数不足，请联系管理员",
	}
	for _, in := range keep {
		if got := ScrubForUser(in); got != in {
			t.Fatalf("业务文案被改写了：\n  输入=%s\n  输出=%s", in, got)
		}
	}
}

// 传输层故障要保留前面的业务前缀，否则用户连是哪个功能挂了都不知道。
func TestScrubForUserKeepsContextPrefix(t *testing.T) {
	got := ScrubForUser(`语音合成请求失败：Post "https://openspeech.example.com/api/v3/tts": dial tcp 203.0.113.9:443: i/o timeout`)
	if !strings.HasPrefix(got, "语音合成请求失败") {
		t.Fatalf("业务前缀丢了，用户不知道是哪个功能失败：%s", got)
	}
	if !strings.Contains(got, transportFailText) {
		t.Fatalf("没有给出可读的失败原因：%s", got)
	}
}

// 没有业务前缀的纯传输层错误，不能只剩一个孤零零的冒号或空串。
func TestScrubForUserBareTransportError(t *testing.T) {
	got := ScrubForUser("net/http: timeout awaiting response headers")
	if got != transportFailText {
		t.Fatalf("纯传输层错误应换成统一文案，实得：%q", got)
	}
}

// 空串是「稍后由 aiUpstreamStatusMessage 按上游响应体翻译」的约定值，
// 被改写会导致 4xx/5xx 失败丢掉上游给的具体原因（画布节点上唯一有用的诊断信息）。
func TestScrubUpstreamIdentityPreservesEmptySentinel(t *testing.T) {
	if got := scrubUpstreamIdentity(""); got != "" {
		t.Fatalf("空串哨兵被改写成了 %q，会导致上游错误原因丢失", got)
	}
}

// 生成任务那条出口的传输层故障一定伴随退款，要用带「积分已退回」的文案安抚。
func TestScrubUpstreamIdentityMentionsRefund(t *testing.T) {
	got := scrubUpstreamIdentity(`Post "https://relay.example.com/v1/images": net/http: timeout awaiting response headers`)
	if !strings.Contains(got, "积分已退回") {
		t.Fatalf("生成失败文案应说明已退款，否则用户以为钱白扣了：%s", got)
	}
}
