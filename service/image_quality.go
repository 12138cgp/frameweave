package service

import (
	"strconv"
	"strings"

	"aicanvas/model"
)

// 图片「画质档」的唯一判据。
//
// 背景：画布上用户选的是 1K/2K/4K 三个档，但请求发出去时前端已经把档折算成了 `2048x2048`
// 这样的像素串（services/api/image.ts 的 resolveSize）。所幸 quality 字段本身也一起发了出来
// （JSON 的 "quality" / multipart 的 quality 字段，取值 low/medium/high），所以计费**优先直接读
// quality**，不必去反解像素——反解等于再造一份必须和前端逐字对齐的映射，这个项目已经在
// 「前端算一套、后端算另一套」上翻过车（视频 4K 那次：显示 150 点、实扣 750 点）。
//
// 只有请求里根本没带 quality（非画布来源/直连 API）时才退回按像素面积估档，阈值取前端
// QUALITY_BASE（1k=1440² / 2k=1920² / 4k=2880²）相邻档的几何中点。
const (
	// 分界取相邻两档像素基准的几何中点，正好是整数：
	//   1K(1440²=2,073,600) 与 2K(1920²=3,686,400) 的中点 = 1440×1920 = 2,764,800
	//   2K 与 4K(2880²=8,294,400) 的中点 = 1920×2880 = 5,529,600
	// 「恰好等于中点」归到高的那一档（>=），省得 1440×1920 这种整齐尺寸落在下一档让人费解。
	imageQuality2KMinArea = 2_764_800
	imageQuality4KMinArea = 5_529_600
	// DefaultImageQualityTier 既没 quality 也没有可解析尺寸时的档位。
	// 与前端 normalizeQuality 的兜底（未知/空 → medium=2K）一致，否则用户看到的价和实扣会差一档。
	DefaultImageQualityTier = "2k"
)

// ImageQualityTierFor 把请求里的 quality/size 归一成 1k / 2k / 4k 档位。
//
// ⚠️ 改这里必须同步改前端 constant/credits.tsx 的 normalizeImageQualityTier，两边差一档，
// 用户看到的预估价和实际扣费就对不上。
func ImageQualityTierFor(quality, size string) string {
	switch strings.ToLower(strings.TrimSpace(quality)) {
	case "low", "1k", "standard":
		return "1k"
	case "medium", "2k", "hd":
		return "2k"
	case "high", "4k":
		return "4k"
	}
	if w, h := parseWxH(size); w > 0 && h > 0 {
		switch area := w * h; {
		case area >= imageQuality4KMinArea:
			return "4k"
		case area >= imageQuality2KMinArea:
			return "2k"
		default:
			return "1k"
		}
	}
	return DefaultImageQualityTier
}

// PickImageQualityCredits 按画质档取单价：命中该档且价 > 0 用档价，否则回落一口价 Credits。
//
// 「档价为 0」刻意等同于「这档没单独定价」而不是「这档免费」：定价页保存时就会把 0 的档整行丢掉，
// 若这里把 0 当成免费，管理员少填一档就变成白送。要真免费，把一口价也设成 0。
func PickImageQualityCredits(cost model.ModelCost, tier string) int {
	tier = strings.ToLower(strings.TrimSpace(tier))
	if tier != "" {
		for _, rate := range cost.QualityRates {
			if strings.EqualFold(strings.TrimSpace(rate.Quality), tier) && rate.Credits > 0 {
				return rate.Credits
			}
		}
	}
	return cost.Credits
}

// parseWxH 解析 "1024x1024" 这类尺寸串；解析不出来返回 0,0 由调用方兜底。
func parseWxH(size string) (int, int) {
	v := strings.ToLower(strings.TrimSpace(size))
	if !strings.Contains(v, "x") {
		return 0, 0
	}
	parts := strings.SplitN(v, "x", 2)
	w, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
	h, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
	return w, h
}
