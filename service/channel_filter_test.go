package service

import (
	"testing"

	"aicanvas/model"
)

// 渠道筛选对 BaseURL 的要求必须分协议。
// 火山音频(volc-audio)允许留空（适配器回退 openspeech 官方域名，后台表单也按可留空校验）；
// 一刀切要求非空的话，这种渠道会被【静默跳过】——管理员按界面提示留空保存成功，
// 用户却只看到「所属分组没有可用的 X 模型渠道」，完全看不出是 BaseURL 的问题。
// 2026-09-20 部署实测时踩到，故钉死。
func TestModelChannelsForModelBaseURLByProtocol(t *testing.T) {
	cases := []struct {
		name  string
		proto string
		base  string
		want  int
	}{
		{"火山音频 + 空 BaseURL 应命中", "volc-audio", "", 1},
		{"火山音频 + 显式 BaseURL 应命中", "volc-audio", "https://openspeech.bytedance.com", 1},
		{"OpenAI + 空 BaseURL 不该命中", "openai", "", 0},
		{"OpenAI + 正常 BaseURL 应命中", "openai", "https://api.example.com/v1", 1},
	}
	for _, c := range cases {
		ch := model.ModelChannel{Protocol: c.proto, BaseURL: c.base, APIKey: "k", Enabled: true, Models: []string{"m1"}}
		if got := len(modelChannelsForModel([]model.ModelChannel{ch}, "m1")); got != c.want {
			t.Errorf("%s：命中 %d 条，期望 %d", c.name, got, c.want)
		}
	}
}
