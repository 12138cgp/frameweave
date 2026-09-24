package service

import "strings"
import "testing"

// 火山素材入库的英文 400 必须翻译成能照做的中文。
// 用户实际遇到的是三视图长条图（6057×2265 = 2.67）被 AspectRatioTooLarge 拒掉，
// 而报错只有英文码，看不出该怎么改。
func TestVolcAssetHintAspectRatio(t *testing.T) {
	raw := "InvalidParameter.AspectRatioTooLarge: Aspect ratio must be between 0.4 and 2.5. status code: 400, request id: 20260730204156F459540B57F82D1ED60F"
	hint := volcAssetHint(raw)
	if hint == "" {
		t.Fatal("宽高比超限必须给出提示")
	}
	for _, want := range []string{"宽高比", "0.4~2.5", "白边"} {
		if !strings.Contains(hint, want) {
			t.Errorf("提示里缺少 %q: %s", want, hint)
		}
	}
	// 完整错误里应同时保留原始英文供排查
	full := volcAssetError("CreateAsset", errString(raw)).Error()
	if !strings.Contains(full, "宽高比") || !strings.Contains(full, "AspectRatioTooLarge") {
		t.Errorf("完整错误应同时含中文提示与原始英文: %s", full)
	}
}

func TestVolcAssetHintOthers(t *testing.T) {
	cases := map[string]string{
		"InvalidParameter.Name: Name must be no more than 64 characters": "64",
		"image resolution too large":                                     "300~6000",
		"Forbidden.RAM: no permission":                                   "权限",
	}
	for raw, want := range cases {
		if hint := volcAssetHint(raw); !strings.Contains(hint, want) {
			t.Errorf("volcAssetHint(%q) = %q, 应含 %q", raw, hint, want)
		}
	}
}

// 匹配不到的错误必须原样透出，不能瞎猜方向误导人。
func TestVolcAssetHintUnknownStaysRaw(t *testing.T) {
	if hint := volcAssetHint("SomethingCompletelyDifferent: boom"); hint != "" {
		t.Errorf("未知错误不该给提示，得到 %q", hint)
	}
}

type errString string

func (e errString) Error() string { return string(e) }
