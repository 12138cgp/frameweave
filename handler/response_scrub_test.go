package handler

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// 任何实现了 SafeMessage() 的错误都走 FailError 这条出口。
// 「SafeMessage」这名字只表示「允许展示」，不代表内容已经安全——
// 实际内容常是「中文前缀 + err.Error()」，而 Go 的 *url.Error 天然带完整上游 URL。
type fakeSafeError struct{ msg string }

func (e fakeSafeError) Error() string       { return e.msg }
func (e fakeSafeError) SafeMessage() string { return e.msg }

func TestFailErrorScrubsUpstreamIdentity(t *testing.T) {
	cases := []struct {
		name string
		in   string
		// 响应体里绝不能出现的片段
		forbidden []string
		// 必须保留的业务上下文
		keep string
	}{
		{
			name:      "语音合成传输失败",
			in:        `语音合成请求失败：Post "https://openspeech.example.com/api/v3/tts/unidirectional": dial tcp 203.0.113.9:443: i/o timeout`,
			forbidden: []string{"openspeech.example.com", "https://", "203.0.113.9"},
			keep:      "语音合成请求失败",
		},
		{
			// 下面这串密钥是**测试占位值**，保留 LTAI 前缀只为让裸密钥正则能命中。
			name:      "签名式接口回显凭证",
			in:        `视频接口错误[SignatureDoesNotMatch]: string to sign is:POST&%2F&AccessKeyId%3DLTAIfakeTestPlaceholder%26Action%3DSubmitJob`,
			forbidden: []string{"LTAI", "LTAIfakeTestPlaceholder"},
			keep:      "视频接口错误",
		},
		{
			name:      "对象存储桶名与内部对象路径",
			in:        `参考图转存失败：Put "https://my-private-bucket.tos-s3-cn-beijing.volces.com/media/user-abc123/x.png": dial tcp 1.2.3.4:443: i/o timeout`,
			forbidden: []string{"my-private-bucket", "volces.com", "user-abc123"},
			keep:      "参考图转存失败",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			FailError(recorder, fakeSafeError{msg: c.in})

			body := recorder.Body.String()
			for _, bad := range c.forbidden {
				if strings.Contains(body, bad) {
					t.Fatalf("响应体里漏出了 %q：\n%s", bad, body)
				}
			}

			var payload struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("响应不是合法 JSON：%v\n%s", err, body)
			}
			if payload.Code == 0 {
				t.Fatalf("失败响应的 code 不应为 0：%s", body)
			}
			if !strings.Contains(payload.Msg, c.keep) {
				t.Fatalf("业务上下文 %q 被洗掉了，用户不知道是哪步失败：%s", c.keep, payload.Msg)
			}
		})
	}
}

// 不实现 SafeMessage 的普通错误一律只回「操作失败」，绝不能把 err.Error() 透出去。
func TestFailErrorHidesUnmarkedErrors(t *testing.T) {
	recorder := httptest.NewRecorder()
	FailError(recorder, fakeUnsafeError{})
	if strings.Contains(recorder.Body.String(), "internal-host") {
		t.Fatalf("未标记的错误被透出了：%s", recorder.Body.String())
	}
}

type fakeUnsafeError struct{}

func (fakeUnsafeError) Error() string { return `dial tcp internal-host:5432: connection refused` }
