package handler

import (
	"strings"
	"testing"
)

func TestAIUpstreamErrorDetail(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InvalidParameter","message":"reference video fps is invalid"}}`))
	if got != "InvalidParameter reference video fps is invalid" {
		t.Fatalf("detail = %q", got)
	}
}

func TestAIUpstreamErrorDetailExplainsSensitiveVideo(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InputVideoSensitiveContentDetected.PrivacyInformation","message":"The request failed because the input video may contain real person."}}`))
	if !strings.Contains(got, "参考视频疑似包含真人") || !strings.Contains(got, "asset://") {
		t.Fatalf("detail = %q", got)
	}
}

// 被拒的是参考视频时，必须提示去认证【视频】并带上视频规格——
// 早期一律提示「给人设图做肖像授权」，用户反复认证图片（其实早已全部通过）而真正被拒的是视频，
// 于是表现为「一直跳要人脸验证」。这条锁死区分逻辑。
func TestAIUpstreamErrorDetailPointsAtVideoNotImage(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InputVideoSensitiveContentDetected.PrivacyInformation","message":"The request failed because the input video 'content[7]' may contain real person."}}`))
	if !strings.Contains(got, "参考视频") {
		t.Fatalf("应指向参考视频: %q", got)
	}
	if strings.Contains(got, "人设图") {
		t.Fatalf("不应把用户引向认证人设图: %q", got)
	}
	if !strings.Contains(got, "第 7 个参考素材") {
		t.Fatalf("应定位到 content[7]: %q", got)
	}
	if !strings.Contains(got, "2~15 秒") {
		t.Fatalf("应带上视频规格便于自查: %q", got)
	}
}

// 被拒的是参考图时仍指向图片，不能反过来误导。
func TestAIUpstreamErrorDetailPointsAtImage(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InputVideoSensitiveContentDetected.PrivacyInformation","message":"The request failed because the input image 'content[2]' may contain real person."}}`))
	if !strings.Contains(got, "参考图") {
		t.Fatalf("应指向参考图: %q", got)
	}
	if strings.Contains(got, "2~15 秒") {
		t.Fatalf("参考图不该出现视频规格: %q", got)
	}
}

func TestVolcContentSlot(t *testing.T) {
	cases := map[string]int{
		"input video 'content[7]' may contain": 7,
		"content[0] 文本":                        0, // 0 是提示词本身，不作为参考素材定位
		"没有下标":                                 0,
		"content[12] 混在长句里":                    12,
	}
	for input, want := range cases {
		if got := volcContentSlot(input); got != want {
			t.Errorf("volcContentSlot(%q) = %d, want %d", input, got, want)
		}
	}
}

func TestSafeUpstreamTextTruncates(t *testing.T) {
	got := safeUpstreamText(strings.Repeat("错", 320))
	if len([]rune(got)) != 303 {
		t.Fatalf("truncated rune length = %d", len([]rune(got)))
	}
}
