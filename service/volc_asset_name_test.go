package service

import "strings"
import "testing"

// TestNormalizeVolcAssetName 火山 CreateAsset 的 Name 上限是 64 个【字符】(实测按 rune 非字节)，
// 超出会 400 InvalidParameter.Name，导致用户点「肖像授权」直接失败。
func TestNormalizeVolcAssetName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want func(string) bool
		desc string
	}{
		{"空名兜底", "   ", func(s string) bool { return s == "portrait" }, "不能传空"},
		{"短名原样", "小明的正脸照", func(s string) bool { return s == "小明的正脸照" }, ""},
		{"换行压成空格", "第一行\n第二行\t第三行", func(s string) bool { return s == "第一行 第二行 第三行" }, ""},
		{"超长中文截断", strings.Repeat("字", 200), func(s string) bool { return len([]rune(s)) == volcAssetNameLimit }, ""},
		{"超长英文截断", strings.Repeat("a", 200), func(s string) bool { return len([]rune(s)) == volcAssetNameLimit }, ""},
		{"真实超长样例", "全段11s。\n[Chloe]图片1 音频1 \n[Leo]图片2 - 尾帧 该图片标注出身高175cm肩宽腿长以及其它非常多的细节描述文字",
			func(s string) bool { return len([]rune(s)) <= volcAssetNameLimit }, ""},
	}
	for _, c := range cases {
		got := normalizeVolcAssetName(c.in)
		if !c.want(got) {
			t.Fatalf("%s: 结果 %q (字符数 %d) 不符合预期", c.name, got, len([]rune(got)))
		}
		if len([]rune(got)) > 64 {
			t.Fatalf("%s: 结果 %d 字符，仍会被火山拒绝", c.name, len([]rune(got)))
		}
		if strings.TrimSpace(got) == "" {
			t.Fatalf("%s: 结果为空", c.name)
		}
	}
}
