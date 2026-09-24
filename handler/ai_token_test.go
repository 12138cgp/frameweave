package handler

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestExtractUsageFromTail 覆盖上游真实出现过的三种 usage 形态：非流式整体 JSON、流式尾 chunk、被截断的长响应尾段。
func TestExtractUsageFromTail(t *testing.T) {
	cases := []struct {
		name                                      string
		tail                                      string
		prompt, completion, total, cached, reason int
		nilExpected                               bool
	}{
		{
			name:   "non_stream_full",
			tail:   `{"id":"x","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":50,"completion_tokens":5,"total_tokens":55,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}`,
			prompt: 50, completion: 5, total: 55,
		},
		{
			name:   "stream_tail_chunk_after_null",
			tail:   "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}],\"usage\":null}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":1200,\"completion_tokens\":340,\"total_tokens\":1540,\"prompt_tokens_details\":{\"cached_tokens\":800},\"completion_tokens_details\":{\"reasoning_tokens\":120}}}\n\ndata: [DONE]\n\n",
			prompt: 1200, completion: 340, total: 1540, cached: 800, reason: 120,
		},
		{
			name:   "truncated_long_tail",
			tail:   `...gigantic completion text cut off...","total_tokens":99},"usage":{"prompt_tokens":10,"completion_tokens":2000,"total_tokens":2010,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":1900}}}`,
			prompt: 10, completion: 2000, total: 2010, cached: 4, reason: 1900,
		},
		{
			name:        "no_usage",
			tail:        `data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]`,
			nilExpected: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u := extractUsageFromTail([]byte(c.tail))
			if c.nilExpected {
				if u != nil {
					t.Fatalf("expected nil, got %+v", u)
				}
				return
			}
			if u == nil {
				t.Fatalf("expected usage, got nil")
			}
			if u.PromptTokens != c.prompt || u.CompletionTokens != c.completion || u.TotalTokens != c.total {
				t.Fatalf("token mismatch: got p=%d c=%d t=%d", u.PromptTokens, u.CompletionTokens, u.TotalTokens)
			}
			if u.PromptTokensDetails.CachedTokens != c.cached {
				t.Fatalf("cached mismatch: got %d want %d", u.PromptTokensDetails.CachedTokens, c.cached)
			}
			if u.CompletionTokensDetails.ReasoningTokens != c.reason {
				t.Fatalf("reasoning mismatch: got %d want %d", u.CompletionTokensDetails.ReasoningTokens, c.reason)
			}
		})
	}
}

// TestPrepareChatStreamBody 验证：流式请求注入 include_usage、保留原字段；非流式不动；已有 stream_options 合并不覆盖。
func TestPrepareChatStreamBody(t *testing.T) {
	t.Run("inject_into_stream", func(t *testing.T) {
		in := `{"model":"doubao-seed-2-1-pro-260628","stream":true,"messages":[{"role":"user","content":"hi"}],"temperature":0.7}`
		out, isStream := prepareChatStreamBody([]byte(in))
		if !isStream {
			t.Fatal("expected isStream=true")
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(out, &m); err != nil {
			t.Fatalf("output not valid json: %v", err)
		}
		var opts map[string]bool
		if err := json.Unmarshal(m["stream_options"], &opts); err != nil || !opts["include_usage"] {
			t.Fatalf("include_usage not injected: %s", m["stream_options"])
		}
		// 原字段保留
		if !strings.Contains(string(out), "temperature") || !strings.Contains(string(out), "doubao-seed-2-1-pro-260628") {
			t.Fatalf("original fields lost: %s", out)
		}
	})

	t.Run("non_stream_untouched", func(t *testing.T) {
		in := `{"model":"x","stream":false,"messages":[]}`
		out, isStream := prepareChatStreamBody([]byte(in))
		if isStream {
			t.Fatal("expected isStream=false")
		}
		if string(out) != in {
			t.Fatalf("body should be untouched, got %s", out)
		}
	})

	t.Run("missing_stream_untouched", func(t *testing.T) {
		in := `{"model":"x","messages":[]}`
		out, isStream := prepareChatStreamBody([]byte(in))
		if isStream || string(out) != in {
			t.Fatalf("no stream flag should leave body untouched and isStream=false, got isStream=%v out=%s", isStream, out)
		}
	})

	t.Run("merge_existing_stream_options", func(t *testing.T) {
		in := `{"model":"x","stream":true,"stream_options":{"foo":1}}`
		out, _ := prepareChatStreamBody([]byte(in))
		var m map[string]json.RawMessage
		_ = json.Unmarshal(out, &m)
		var opts map[string]json.RawMessage
		if err := json.Unmarshal(m["stream_options"], &opts); err != nil {
			t.Fatalf("bad stream_options: %v", err)
		}
		if _, ok := opts["foo"]; !ok {
			t.Fatalf("existing stream_options.foo dropped: %s", m["stream_options"])
		}
		var inc bool
		_ = json.Unmarshal(opts["include_usage"], &inc)
		if !inc {
			t.Fatalf("include_usage not merged: %s", m["stream_options"])
		}
	})
}

// TestClassifyAIKind 简单确认路径分类，避免日后改路由把 chat 误判成非文本。
func TestClassifyAIKind(t *testing.T) {
	cases := map[string]string{
		"/chat/completions":   "text",
		"/videos":             "video",
		"/images/generations": "image",
		"/images/edits":       "image",
		"/audio/speech":       "audio",
		"/whatever":           "other",
	}
	for path, want := range cases {
		if got := classifyAIKind(path); got != want {
			t.Fatalf("classifyAIKind(%q)=%q want %q", path, got, want)
		}
	}
}
