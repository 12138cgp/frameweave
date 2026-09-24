package service

import (
	"testing"

	"aicanvas/model"
)

// 用真实调用数据钉死类型推断。
//
// 期望值不是拍脑袋写的：除标注了来源的几个之外，都来自 upstream_logs 里
// model → kind 的实际分布（同一模型的全部调用都落在同一个 kind 上，没有例外），
// 也就是「系统自己按请求路径判定出来的真实用途」。迁移就是靠这个函数给存量模型定类型，
// 推错一个，那个模型在用户下拉里就会出现在错误的分类下。
func TestInferModelKindAgainstRealCallData(t *testing.T) {
	cases := []struct {
		model  string
		want   model.ModelKind
		source string
	}{
		// video —— upstream_logs 实测
		{"doubao-seedance-2-0-260128", model.ModelKindVideo, "seedance 主力视频模型"},
		{"doubao-seedance-2-0-fast-260128", model.ModelKindVideo, "fast 变体"},
		{"doubao-seedance-2-0-mini-260615", model.ModelKindVideo, "mini 变体"},
		{"doubao-seedance-2-5-260628", model.ModelKindVideo, "2.5 版本"},
		// image —— upstream_logs 实测
		{"doubao-seedream-5-0-260128", model.ModelKindImage, "seedream 基础版"},
		{"doubao-seedream-5-0-pro-260628", model.ModelKindImage, "seedream pro"},
		{"gpt-image-2", model.ModelKindImage, "基础版"},
		{"gpt-image-2-4k", model.ModelKindImage, "4k 变体"},
		{"gpt-image-2-34", model.ModelKindImage, "数字后缀变体"},
		{"gpt-image-2-cc", model.ModelKindImage, "字母后缀变体"},
		{"gpt-image-2-stable", model.ModelKindImage, "stable 变体"},
		{"vidu/vidu-image_reference2image", model.ModelKindImage, "带斜杠前缀的第三方模型名"},
		{"GPT Image 2", model.ModelKindImage, "带空格的历史写法，同样要认对"},
		{"gemini-3.1-flash-image-preview", model.ModelKindImage, "在 modelCosts 里，12 点/次"},
		// text —— upstream_logs 实测
		{"doubao-seed-2-0-pro-260215", model.ModelKindText, "seed 系文本模型"},
		{"doubao-seed-2-1-pro-260628", model.ModelKindText, "seed 系文本模型"},
		{"deepseek-v4-pro-260425", model.ModelKindText, "deepseek 文本模型"},
		// audio —— 靠名字里的 tts/audio/speech/voice 关键词判定
		{"doubao-tts", model.ModelKindAudio, "名字含 tts"},
		{"doubao-tts-icl", model.ModelKindAudio, "名字含 tts"},
	}
	for _, c := range cases {
		if got := inferModelKind(c.model); got != c.want {
			t.Errorf("inferModelKind(%q) = %q，期望 %q（依据：%s）", c.model, got, c.want, c.source)
		}
	}
}

// seed 系文本模型不能被 seedream/seedance 的关键词误伤——它们共享 "seed" 前缀。
func TestInferModelKindSeedPrefixNotConfused(t *testing.T) {
	for _, name := range []string{"doubao-seed-2-0-pro-260215", "doubao-seed-2-1-pro-260628"} {
		if got := inferModelKind(name); got != model.ModelKindText {
			t.Errorf("%q 被判成 %q，它是文本模型；seedream/seedance 的关键词匹配伤到了 seed 前缀", name, got)
		}
	}
	if got := inferModelKind("doubao-seedream-5-0-260128"); got != model.ModelKindImage {
		t.Errorf("seedream 应判 image，得到 %q", got)
	}
	if got := inferModelKind("doubao-seedance-2-0-260128"); got != model.ModelKindVideo {
		t.Errorf("seedance 应判 video，得到 %q", got)
	}
}

func TestValidModelKind(t *testing.T) {
	for _, k := range []model.ModelKind{model.ModelKindText, model.ModelKindImage, model.ModelKindVideo, model.ModelKindAudio} {
		if !model.ValidModelKind(k) {
			t.Errorf("%q 应该是合法类型", k)
		}
	}
	for _, k := range []model.ModelKind{"", "picture", "movie", "TEXT"} {
		if model.ValidModelKind(k) {
			t.Errorf("%q 不该被当成合法类型（大小写/近义词都不认，避免脏值混进配置）", k)
		}
	}
}
