package service

import (
	"strconv"
	"strings"
	"testing"
)

// Seedream 面积上限夹取：超上限的必须缩到 <= 4624220 且为正偶数；未超/无法解析的原样返回。
func TestClampSeedreamSize(t *testing.T) {
	cases := []struct {
		in       string
		wantSame bool
	}{
		{"1024x1024", true},  // 1.05M，未超
		{"2048x2048", true},  // 4.19M，未超
		{"", true},           // 空
		{"16:9", true},       // 比例串，非像素
		{"abcxdef", true},    // 无法解析
		{"3840x2160", false}, // 4K，8.29M，超
		{"2560x2560", false}, // 6.55M，超
		{"4096x4096", false}, // 16.7M，超
	}
	for _, c := range cases {
		got := clampSeedreamSize(c.in)
		if c.wantSame {
			if got != c.in {
				t.Errorf("clampSeedreamSize(%q)=%q，应原样返回", c.in, got)
			}
			continue
		}
		w, h, ok := parseWH(got)
		if !ok {
			t.Errorf("clampSeedreamSize(%q)=%q 无法解析", c.in, got)
			continue
		}
		if w*h > seedreamMaxPixels {
			t.Errorf("clampSeedreamSize(%q)=%q 面积 %d 仍超上限 %d", c.in, got, w*h, seedreamMaxPixels)
		}
		if w <= 0 || h <= 0 || w%2 != 0 || h%2 != 0 {
			t.Errorf("clampSeedreamSize(%q)=%q 尺寸应为正偶数", c.in, got)
		}
	}
}

func TestIsSeedreamModel(t *testing.T) {
	for _, m := range []string{"doubao-seedream-5-0-pro-260628", "SEEDREAM", "seedream"} {
		if !isSeedreamModel(m) {
			t.Errorf("isSeedreamModel(%q) 应为 true", m)
		}
	}
	for _, m := range []string{"gpt-image-2-4k", "gemini-3-pro-image-preview", ""} {
		if isSeedreamModel(m) {
			t.Errorf("isSeedreamModel(%q) 应为 false", m)
		}
	}
}

func parseWH(s string) (int, int, bool) {
	parts := strings.Split(s, "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	w, e1 := strconv.Atoi(parts[0])
	h, e2 := strconv.Atoi(parts[1])
	if e1 != nil || e2 != nil {
		return 0, 0, false
	}
	return w, h, true
}
