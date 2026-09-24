package service

import (
	"testing"

	"aicanvas/model"
)

// 档位判据必须与前端 constant/credits.tsx 的 normalizeImageQualityTier 逐分支对齐。
// 两边差一档，用户看到的预估价和实扣就分叉——档位差一级，在视频 4K 上就是 5 倍价差。
func TestImageQualityTierFromQualityField(t *testing.T) {
	cases := map[string]string{
		// 前端实际发出去的取值（services/api/image.ts 的 normalizeQuality 会把 1k/2k/4k 折成这三个）
		"low":    "1k",
		"medium": "2k",
		"high":   "4k",
		// UI 档名本身也要认（有历史数据直接存着 1k/2k/4k）
		"1k": "1k",
		"2k": "2k",
		"4k": "4k",
		// legacy 别名
		"standard": "1k",
		"hd":       "2k",
		// 大小写与空白不该影响判档
		" HIGH ": "4k",
	}
	for input, want := range cases {
		if got := ImageQualityTierFor(input, ""); got != want {
			t.Fatalf("quality=%q 判成 %q，应为 %q", input, got, want)
		}
	}
}

// 没带 quality 的请求（非画布来源/直连 API）才按像素面积估档。
func TestImageQualityTierFallsBackToPixels(t *testing.T) {
	cases := []struct {
		size string
		want string
	}{
		{"1024x1024", "1k"},               // 1.05M 像素
		{"1920x1920", "2k"},               // 3.69M，越过 2K 线
		{"2880x2880", "4k"},               // 8.29M，越过 4K 线
		{"3840x2160", "4k"},               // 8.29M
		{"1440x1920", "2k"},               // 2.76M，刚好压在 2K 线上
		{"", DefaultImageQualityTier},     // 什么都没有 → 与前端兜底一致（2K）
		{"不是尺寸", DefaultImageQualityTier}, // 解析不出来也走兜底，绝不 panic
	}
	for _, c := range cases {
		if got := ImageQualityTierFor("", c.size); got != c.want {
			t.Fatalf("size=%q 判成 %q，应为 %q", c.size, got, c.want)
		}
	}
}

// quality 一旦有值就以它为准，不能被 size 反超——前端两者都发，档位是用户真选的那个。
func TestImageQualityTierPrefersQualityOverSize(t *testing.T) {
	if got := ImageQualityTierFor("low", "3840x2160"); got != "1k" {
		t.Fatalf("quality 应优先于 size，得到 %q", got)
	}
}

func TestPickImageQualityCredits(t *testing.T) {
	cost := model.ModelCost{
		Model:   "gpt-image-2",
		Credits: 10,
		QualityRates: []model.ImageQualityRate{
			{Quality: "1k", Credits: 5},
			{Quality: "4k", Credits: 40},
		},
	}
	if got := PickImageQualityCredits(cost, "1k"); got != 5 {
		t.Fatalf("1k 应取档价 5，得到 %d", got)
	}
	if got := PickImageQualityCredits(cost, "4k"); got != 40 {
		t.Fatalf("4k 应取档价 40，得到 %d", got)
	}
	// 2k 没配档价 → 回落一口价，而不是免费
	if got := PickImageQualityCredits(cost, "2k"); got != 10 {
		t.Fatalf("未配档应回落一口价 10，得到 %d", got)
	}
	// 不分档（tier 为空，音频等按次模型）→ 一口价
	if got := PickImageQualityCredits(cost, ""); got != 10 {
		t.Fatalf("空档应取一口价 10，得到 %d", got)
	}
	// 档价为 0 = 这档没单独定价，必须回落一口价；当成「免费」就是白送
	zero := model.ModelCost{Model: "m", Credits: 8, QualityRates: []model.ImageQualityRate{{Quality: "2k", Credits: 0}}}
	if got := PickImageQualityCredits(zero, "2k"); got != 8 {
		t.Fatalf("档价 0 应视作未配置并回落 8，得到 %d", got)
	}
}

func TestNormalizeImageQualityRates(t *testing.T) {
	out := NormalizeImageQualityRates([]model.ImageQualityRate{
		{Quality: " 1K ", Credits: 5}, // 归一化大小写与空白
		{Quality: "8k", Credits: 99},  // 非法档丢弃
		{Quality: "2k", Credits: 0},   // 0 价丢弃
		{Quality: "4k", Credits: -3},  // 负数丢弃
		{Quality: "1k", Credits: 7},   // 同档去重，后写覆盖先写
	})
	if len(out) != 1 {
		t.Fatalf("应只剩 1 条，得到 %+v", out)
	}
	if out[0].Quality != "1k" || out[0].Credits != 7 {
		t.Fatalf("同档后写应覆盖先写，得到 %+v", out[0])
	}
	if NormalizeImageQualityRates(nil) != nil {
		t.Fatalf("空输入应返回 nil")
	}
}
