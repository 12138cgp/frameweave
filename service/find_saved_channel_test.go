package service

import (
	"testing"

	"aicanvas/model"
)

// 后台「拉取模型 / 测试连通」时 API Key 还没填、也匹配不到已存渠道：
// 以 -1 调用必须返回「没找到」，不能越界 panic（部署测试时在全新环境实际触发过）。
func TestFindSavedChannelNegativeIndexDoesNotPanic(t *testing.T) {
	channel := model.ModelChannel{Name: "新渠道", BaseURL: "https://example.com/v1"}
	for _, saved := range [][]model.ModelChannel{nil, {{Name: "旧渠道", BaseURL: "https://old.example.com/v1", APIKey: "k"}}} {
		if got, ok := findSavedChannel(channel, saved, -1); ok {
			t.Fatalf("匹配不到时应返回 false，实得 %+v", got)
		}
	}
	saved := []model.ModelChannel{{Name: "新渠道", BaseURL: "https://example.com/v1", APIKey: "k"}}
	if got, ok := findSavedChannel(channel, saved, -1); !ok || got.APIKey != "k" {
		t.Fatalf("名称 + 地址一致时应找到已存渠道，实得 ok=%v %+v", ok, got)
	}
	if got, ok := findSavedChannel(model.ModelChannel{Name: "别的"}, saved, 0); !ok || got.APIKey != "k" {
		t.Fatalf("合法序号应按序号兜底，实得 ok=%v %+v", ok, got)
	}
}
