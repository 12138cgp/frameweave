package service

import (
	"strings"
	"testing"
)

// 音频生成这条路是【动钱】的（按秒计价、多退少补），而秒数的来源又是上游返回值，
// 所以下面这些边界必须钉死。0916 那批交付的教训：动钱代码零测试覆盖，口径错了没人发现。

func TestNormalizeAudioBillingSeconds(t *testing.T) {
	cases := []struct {
		in   int
		want int
		why  string
	}{
		{0, AudioBillingDefaultSeconds, "没给目标时长 → 用默认预扣秒数"},
		{-5, AudioBillingDefaultSeconds, "负数当没给，绝不能变成负的点数"},
		{1, 1, "1 秒照收"},
		{15, 15, "常规值原样"},
		{120, 120, "正好到上限"},
		{121, AudioBillingMaxSeconds, "超上限钳到 120——上游出片就不可能超过它"},
		{99999, AudioBillingMaxSeconds, "离谱值也钳住，别让前端传个大数就扣爆"},
	}
	for _, c := range cases {
		if got := NormalizeAudioBillingSeconds(c.in); got != c.want {
			t.Errorf("NormalizeAudioBillingSeconds(%d)=%d want %d（%s）", c.in, got, c.want, c.why)
		}
	}
}

func TestIsDoubaoAudioGenModel(t *testing.T) {
	// ⚠️ 这个判据前端 lib/audio-generation.ts 里有一份同源实现，改这里必须同步改那边。
	cases := []struct {
		model string
		want  bool
	}{
		{"seed-audio-1.0", true},
		{"Seed-Audio-1.0", true},
		{"  seed-audio-1.0  ", true},
		{"doubao-seed-audio-2.0", true},
		{"doubao-tts", false},     // 老的 TTS，必须继续走原路
		{"doubao-tts-icl", false}, // 声音复刻，同上
		{"seedance-2-0", false},   // 视频模型，名字里也有 seed，别误伤
		{"doubao-seedream-5-0", false},
		{"", false},
	}
	for _, c := range cases {
		if got := IsDoubaoAudioGenModel(c.model); got != c.want {
			t.Errorf("IsDoubaoAudioGenModel(%q)=%v want %v", c.model, got, c.want)
		}
	}
}

func TestValidateDoubaoAudioReferences(t *testing.T) {
	audio := func() DoubaoAudioReference { return DoubaoAudioReference{AudioData: []byte("a")} }
	image := func() DoubaoAudioReference { return DoubaoAudioReference{ImageData: []byte("i")} }

	if err := ValidateDoubaoAudioReferences(nil); err != nil {
		t.Errorf("纯文本生成（无参考）应当放行，却报错：%v", err)
	}
	if err := ValidateDoubaoAudioReferences([]DoubaoAudioReference{audio(), audio(), audio()}); err != nil {
		t.Errorf("3 条参考音频是上限内，应放行，却报错：%v", err)
	}
	if err := ValidateDoubaoAudioReferences([]DoubaoAudioReference{audio(), audio(), audio(), audio()}); err == nil {
		t.Error("4 条参考音频超上限，应当拦住")
	}
	if err := ValidateDoubaoAudioReferences([]DoubaoAudioReference{image(), image()}); err == nil {
		t.Error("2 张参考图超上限，应当拦住")
	}
	// 上游硬约束：图片参考不能和音频参考混用。混用请求会被上游直接拒掉，而那时钱已经扣了。
	if err := ValidateDoubaoAudioReferences([]DoubaoAudioReference{image(), audio()}); err == nil {
		t.Error("图片参考与音频参考混用，应当在发出去之前就拦住")
	}
	// speaker 也算音频侧，同样不能和图片混用。
	if err := ValidateDoubaoAudioReferences([]DoubaoAudioReference{image(), {Speaker: "zh_female_cancan_mars_bigtts"}}); err == nil {
		t.Error("图片参考与 speaker 混用，应当拦住")
	}
	big := DoubaoAudioReference{AudioData: make([]byte, DoubaoAudioMaxRefBytes+1)}
	err := ValidateDoubaoAudioReferences([]DoubaoAudioReference{big})
	if err == nil {
		t.Fatal("超过 10MB 的参考音频应当拦住")
	}
	if !strings.Contains(err.Error(), "10MB") {
		t.Errorf("超限提示应当说清楚上限是多少，实际：%v", err)
	}
}

// 上游错误码 45000030 = 账号没开通「音频生成」资源。这条如果不单独翻译，
// 用户只会看到一串内部资源号（volc.service_type.10074），根本不知道该去开通什么。
func TestDoubaoAudioGenErrorText(t *testing.T) {
	got := doubaoAudioGenErrorText(45000030, "[resource_id=volc.service_type.10074] requested resource not granted")
	if !strings.Contains(got, "音频生成") {
		t.Errorf("未开通的提示应当点明是「音频生成」没开通，实际：%s", got)
	}
	if strings.Contains(got, "volc.service_type") {
		t.Errorf("不该把上游内部资源号原样吐给用户：%s", got)
	}
	// 其它错误码保留码值，便于排查。
	other := doubaoAudioGenErrorText(55000000, "speaker not found")
	if !strings.Contains(other, "55000000") {
		t.Errorf("其它错误码应当保留码值，实际：%s", other)
	}
	// 超长上游文案要截断，别让它把界面撑爆（同 handler/ai.go volcAssetError 的 300 rune 口径）。
	long := doubaoAudioGenErrorText(12345, strings.Repeat("错", 500))
	if len([]rune(long)) > 360 {
		t.Errorf("超长上游文案应当截断，实际长度 %d", len([]rune(long)))
	}
}

func TestClampInt(t *testing.T) {
	// 语速/音量 [-50,100]、音调 [-12,12]：越界值必须钳住，否则上游直接拒掉整个请求。
	if got := clampInt(200, -50, 100); got != 100 {
		t.Errorf("clampInt(200)=%d want 100", got)
	}
	if got := clampInt(-200, -50, 100); got != -50 {
		t.Errorf("clampInt(-200)=%d want -50", got)
	}
	if got := clampInt(0, -12, 12); got != 0 {
		t.Errorf("clampInt(0)=%d want 0", got)
	}
}

// 0 字节参考素材必须报错，绝不能静默丢弃。
//
// 上游的 @音频N 是按 references 下标编号的：中途少一条，后面所有参考的编号整体前移，
// 用户写的 @音频2 会拿到他标为「音频3」的那条，而且前后端都没有任何提示。
// 本项目对 0 字节媒体有实证（库里标「已完成」、桶里是空文件），所以这条必须钉死。
func TestRunDoubaoAudioGenRejectsEmptyReference(t *testing.T) {
	cfg := DoubaoTTSConfig{APIKey: "x", Endpoint: "https://example.invalid"}
	_, err := RunDoubaoAudioGen(cfg, DoubaoAudioGenParams{
		TextPrompt: "请用 @音频1 的声音说话",
		References: []DoubaoAudioReference{{AudioData: []byte{}}},
	})
	if err == nil {
		t.Fatal("0 字节参考应当整条请求失败，而不是被默默丢掉")
	}
	if !strings.Contains(err.Error(), "空") {
		t.Errorf("报错要说清是空文件，实际：%v", err)
	}
	// 关键：必须在发请求之前就失败（Endpoint 是无效域名，走到网络层会是另一种错）。
	if strings.Contains(err.Error(), "请求失败") {
		t.Errorf("应当在组装阶段就拦住，而不是发出去才失败：%v", err)
	}
}

// assertNonEmptyMedia 是「取到 0 字节不报错」这个隐患的唯一闸门。
func TestAssertNonEmptyMedia(t *testing.T) {
	if _, err := assertNonEmptyMedia([]byte{}, nil); err == nil {
		t.Error("空字节 + nil error 必须被判为失败（os.ReadFile 读 0 字节文件、桶回 200 空 body 都是这个形状）")
	}
	if _, err := assertNonEmptyMedia(nil, nil); err == nil {
		t.Error("nil 字节同上")
	}
	data, err := assertNonEmptyMedia([]byte{1, 2, 3}, nil)
	if err != nil || len(data) != 3 {
		t.Errorf("正常字节应原样放行，得到 %v / %v", data, err)
	}
}

// 采样率必须按格式归一：非法值落到该格式的官方默认值，而不是原样发给上游被拒。
// ⚠️ 这张表在前端 lib/audio-generation.ts 里有同源的一份，改一处要同步另一处。
func TestNormalizeAudioSampleRate(t *testing.T) {
	cases := []struct {
		format string
		in     int
		want   int
		why    string
	}{
		{"mp3", 0, 0, "0=不指定，交给上游默认（字段 omitempty 不发）"},
		{"mp3", 44100, 44100, "合法值原样"},
		{"mp3", 24000, 24000, "合法值原样"},
		{"mp3", 40000, 44100, "40000 是 wav/pcm 才有的档，mp3 没有 → 落 mp3 默认 44100"},
		{"wav", 40000, 40000, "wav 有 40000"},
		{"ogg_opus", 48000, 48000, "opus 只支持 48000"},
		{"ogg_opus", 24000, 48000, "opus 其它档一律落 48000"},
		{"mp3", 12345, 44100, "离谱值落默认"},
		{"aac", 44100, 0, "不认识的格式 → 不指定，别瞎发"},
	}
	for _, c := range cases {
		if got := normalizeAudioSampleRate(c.format, c.in); got != c.want {
			t.Errorf("normalizeAudioSampleRate(%q,%d)=%d want %d（%s）", c.format, c.in, got, c.want, c.why)
		}
	}
}

// 按字数计价的档位换算：不足 100 字按 100 字算。
// 这是【动钱】的取整逻辑，差一档用户就多付/少付一份钱。
func TestAudioCharUnits(t *testing.T) {
	cases := []struct {
		chars int
		want  int
		why   string
	}{
		{0, 0, "空文本不收费（空提示词本来也发不出去）"},
		{-5, 0, "负数当空"},
		{1, 1, "1 个字也算一整档"},
		{99, 1, "不足 100 按 100"},
		{100, 1, "正好 100 = 1 档"},
		{101, 2, "超一个字就进第二档"},
		{200, 2, "正好 200 = 2 档"},
		{2000, 20, "上限 2000 字 = 20 档"},
	}
	for _, c := range cases {
		if got := AudioCharUnits(c.chars); got != c.want {
			t.Errorf("AudioCharUnits(%d)=%d want %d（%s）", c.chars, got, c.want, c.why)
		}
	}
}

// 文本上限：产品定 2000，上游硬限 3000。超限必须在发出去之前拦住。
func TestRunDoubaoAudioGenRejectsOverlongText(t *testing.T) {
	cfg := DoubaoTTSConfig{APIKey: "x", Endpoint: "https://example.invalid"}
	long := strings.Repeat("字", DoubaoAudioMaxTextPrompt+1)
	_, err := RunDoubaoAudioGen(cfg, DoubaoAudioGenParams{TextPrompt: long})
	if err == nil {
		t.Fatal("超过上限的文本应当在组装阶段被拦住")
	}
	if strings.Contains(err.Error(), "请求失败") {
		t.Errorf("应当在发请求之前就失败，而不是发出去才被上游拒：%v", err)
	}
	// 数的必须是字符不是字节：2000 个中文字 = 6000 字节，按字节判会误拦。
	ok := strings.Repeat("字", DoubaoAudioMaxTextPrompt)
	if _, err := RunDoubaoAudioGen(cfg, DoubaoAudioGenParams{TextPrompt: ok}); err != nil && !strings.Contains(err.Error(), "请求失败") {
		t.Errorf("正好 %d 个中文字应当放行到发请求那一步（数字符不数字节），实际：%v", DoubaoAudioMaxTextPrompt, err)
	}
}

// 上游 40000020 = 文本太长、读完会超 120 秒出片上限。必须翻成能指导用户删字的话。
func TestDurationOutOfRangeMessage(t *testing.T) {
	got := doubaoAudioGenErrorText(40000020, "InvalidPayload:DurationOutOfRange")
	if !strings.Contains(got, "太长") || !strings.Contains(got, "120") {
		t.Errorf("应当说清是文本太长、超了 120 秒上限，实际：%s", got)
	}
	if strings.Contains(got, "InvalidPayload") {
		t.Errorf("不该把上游英文原文吐给用户：%s", got)
	}
}
