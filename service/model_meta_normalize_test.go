package service

import (
	"testing"

	"aicanvas/model"
)

// normalizePublicSetting 是所有读写 settings 的必经之路。新字段最怕的就是死在这里——
// 这个项目已经有两个先例（creditsPerSecondWithVideo、渠道 idHistory），都是重建对象时漏了字段，
// 保存即静默清空、零报错。所以 ModelMetas 的每条规范化规则都要有测试钉着。
func TestNormalizeModelMetas(t *testing.T) {
	in := model.PublicSetting{}
	in.ModelChannel.ModelMetas = []model.ModelMeta{
		// 合法视频：档位保留，秒数保留
		{Model: " doubao-seedance-2-0-260128 ", Kind: model.ModelKindVideo, Resolutions: []string{"720p", "1080p"}, MaxSeconds: 12},
		// 非法 kind：就地按名字推断，而不是留空让下游各自猜
		{Model: "gpt-image-2", Kind: "picture", Resolutions: []string{"2k"}},
		// 图片模型混进了视频档位：非法档位要被剔掉
		{Model: "doubao-seedream-5-0-260128", Kind: model.ModelKindImage, Resolutions: []string{"1k", "720p", "4k"}},
		// 文本模型：档位与秒数都该被清空
		{Model: "deepseek-v4-pro-260425", Kind: model.ModelKindText, Resolutions: []string{"1k"}, MaxSeconds: 30},
		// 音频模型：同上
		{Model: "doubao-tts", Kind: model.ModelKindAudio, Resolutions: []string{"720p"}, MaxSeconds: 9},
		// 重复档位 + 大小写混杂 + 负秒数
		{Model: "doubao-seedance-2-5-260628", Kind: model.ModelKindVideo, Resolutions: []string{"720P", "720p", " 1080p ", "8k"}, MaxSeconds: -5},
		// 图片模型不该有秒数
		{Model: "gpt-image-2-4k", Kind: model.ModelKindImage, MaxSeconds: 20},
	}

	out := normalizePublicSetting(in).ModelChannel.ModelMetas
	get := func(name string) model.ModelMeta {
		t.Helper()
		for _, m := range out {
			if m.Model == name {
				return m
			}
		}
		t.Fatalf("规范化后找不到模型 %q", name)
		return model.ModelMeta{}
	}

	if m := get("doubao-seedance-2-0-260128"); len(m.Resolutions) != 2 || m.MaxSeconds != 12 {
		t.Errorf("模型名两端空格应被 trim、合法档位与秒数应原样保留，得到 %+v", m)
	}
	if m := get("gpt-image-2"); m.Kind != model.ModelKindImage {
		t.Errorf("非法 kind 应就地按名字推断成 image，得到 %q", m.Kind)
	}
	if m := get("doubao-seedream-5-0-260128"); len(m.Resolutions) != 2 || m.Resolutions[0] != "1k" || m.Resolutions[1] != "4k" {
		t.Errorf("图片模型里的视频档位(720p)应被剔除，只留 1k/4k，得到 %v", m.Resolutions)
	}
	if m := get("deepseek-v4-pro-260425"); len(m.Resolutions) != 0 || m.MaxSeconds != 0 {
		t.Errorf("文本模型的档位与秒数都应清空，得到 resolutions=%v maxSeconds=%d", m.Resolutions, m.MaxSeconds)
	}
	if m := get("doubao-tts"); len(m.Resolutions) != 0 || m.MaxSeconds != 0 {
		t.Errorf("音频模型的档位与秒数都应清空，得到 resolutions=%v maxSeconds=%d", m.Resolutions, m.MaxSeconds)
	}
	if m := get("doubao-seedance-2-5-260628"); len(m.Resolutions) != 2 || m.Resolutions[0] != "720p" || m.Resolutions[1] != "1080p" {
		t.Errorf("档位应大小写归一、去重、剔除非法值(8k)，得到 %v", m.Resolutions)
	}
	if m := get("doubao-seedance-2-5-260628"); m.MaxSeconds != 0 {
		t.Errorf("负秒数应归零，得到 %d", m.MaxSeconds)
	}
	if m := get("gpt-image-2-4k"); m.MaxSeconds != 0 {
		t.Errorf("非视频模型的秒数应清零（秒数只对视频有意义），得到 %d", m.MaxSeconds)
	}
}

// 规范化必须是幂等的：连跑两次结果一致。settings 会被反复读写，
// 若不幂等，配置会在每次保存时慢慢漂移。
func TestNormalizeModelMetasIdempotent(t *testing.T) {
	in := model.PublicSetting{}
	in.ModelChannel.ModelMetas = []model.ModelMeta{
		{Model: "doubao-seedance-2-0-260128", Kind: model.ModelKindVideo, Resolutions: []string{"720P", "1080p", "8k"}, MaxSeconds: 12},
		{Model: "gpt-image-2", Kind: "", Resolutions: []string{"2k", "720p"}},
	}
	once := normalizePublicSetting(in)
	twice := normalizePublicSetting(once)
	a, b := once.ModelChannel.ModelMetas, twice.ModelChannel.ModelMetas
	if len(a) != len(b) {
		t.Fatalf("两次规范化条数不同: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].Model != b[i].Model || a[i].Kind != b[i].Kind || a[i].MaxSeconds != b[i].MaxSeconds || len(a[i].Resolutions) != len(b[i].Resolutions) {
			t.Errorf("第 %d 条不幂等: %+v -> %+v", i, a[i], b[i])
		}
	}
}

// 空配置不能被规范化搞出脏数据（保存空设置是常见操作）。
func TestNormalizeModelMetasEmpty(t *testing.T) {
	out := normalizePublicSetting(model.PublicSetting{}).ModelChannel.ModelMetas
	if len(out) != 0 {
		t.Errorf("空配置规范化后应仍为空，得到 %+v", out)
	}
}
