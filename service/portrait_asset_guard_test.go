package service

import (
	"strings"
	"testing"
)

// 正则要认得出请求体里的资产引用（两种写法都有：asset://asset-xxx 和裸 asset-xxx）。
func TestPortraitAssetRefRegex(t *testing.T) {
	body := `{"content":[{"image_url":{"url":"asset://asset-20260810164850-mqxvm"}},` +
		`{"image_url":{"url":"asset-20260811134635-cgbvn"}},` +
		`{"text":"随便写点东西，里面没有资产"}]}`
	got := portraitAssetRefRe.FindAllString(body, -1)
	want := []string{"asset-20260810164850-mqxvm", "asset-20260811134635-cgbvn"}
	if len(got) != len(want) {
		t.Fatalf("应匹配到 %d 个，实得 %d 个: %v", len(want), len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("第 %d 个应为 %s，实得 %s", i, want[i], got[i])
		}
	}
}

// 不该误伤：普通 URL 里的 asset 字样、以及格式不符的串，都不能当成资产引用。
func TestPortraitAssetRefRegexNoFalsePositive(t *testing.T) {
	for _, s := range []string{
		"https://bucket.tos-cn-beijing.volces.com/media/user-x/asset-image.png",
		"asset-2026-mqxvm",      // 时间戳位数不对
		"asset-2026081016485-m", // 13 位
		"my-asset-file",
	} {
		if m := portraitAssetRefRe.FindAllString(s, -1); len(m) != 0 {
			t.Errorf("%q 不该被当成资产引用，实得 %v", s, m)
		}
	}
}

// 请求体里没有资产引用时必须立刻放行，连库都不查——绝大多数请求走这条路。
func TestCheckPortraitAssetsFreshSkipsWhenNoRefs(t *testing.T) {
	if err := CheckPortraitAssetsFresh("user-any", []byte(`{"prompt":"一只猫"}`)); err != nil {
		t.Fatalf("无资产引用应放行，实得 %v", err)
	}
	if err := CheckPortraitAssetsFresh("user-any", nil); err != nil {
		t.Fatalf("空请求体应放行，实得 %v", err)
	}
}

// 守卫自己绝不能成为故障源：用户/分组查不到时必须放行，让后面的逻辑报它自己的错。
func TestCheckPortraitAssetsFreshFailsOpen(t *testing.T) {
	err := CheckPortraitAssetsFresh("user-does-not-exist-"+strings.Repeat("x", 8),
		[]byte(`{"url":"asset://asset-20260810164850-mqxvm"}`))
	if err != nil {
		t.Fatalf("查不到用户/分组时应放行（守卫不能成为故障源），实得 %v", err)
	}
}
