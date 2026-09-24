package service

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"aicanvas/model"
)

// TestModelKindFixture 用 testdata/model-kind-fixture.json 钉死名字判据的分类结果。
//
// 前端 web/scripts/check-model-kind-parity.ts 读【同一个文件】做同样的断言。
// 两边的关键词表（service/model_kind_rules.go 与 web/src/lib/model-kind-rules.ts）
// 一旦分叉，这两个检查里至少一个会失败。
//
// 两边分叉的后果：后端把模型判成 text 并写进 modelMetas，而 metas 优先级高于名字启发式，
// 于是那个模型「加的当天正常、下次重启后从本类下拉里消失」，管理员看不出原因。
func TestModelKindFixture(t *testing.T) {
	raw, err := os.ReadFile("../testdata/model-kind-fixture.json")
	if err != nil {
		t.Fatalf("读不到对拍样本（前端也读同一个文件，别挪走）: %v", err)
	}
	var fixture struct {
		Cases []struct {
			Model string `json:"model"`
			Kind  string `json:"kind"`
			Note  string `json:"note"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("样本不是合法 JSON: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("样本是空的——大概率是文件被覆盖了")
	}
	for _, c := range fixture.Cases {
		got := classifyModelKindByName(c.Model)
		if string(got) != c.Kind {
			t.Errorf("%q: 期望 %s，实得 %s%s", c.Model, c.Kind, got, noteSuffix(c.Note))
		}
	}
}

// TestModelKindKeywordTables 把【关键词表本身】与 fixture 里的 keywords 契约逐项比对。
//
// ⚠️ 这条比 TestModelKindFixture 更关键：只比 cases 的话，护栏强度等于样本集的判别力——
// 单边【新增】一个关键词永远不会被发现（新词没有任何样本触发），单边【删除】一个没有样本
// 覆盖的词也发现不了。实测过：只删掉后端 videoKeywords 里的 "video"，光跑 cases 两边全绿。
// 前端 web/scripts/check-model-kind-parity.ts 对自己的四个数组做同样的比对。
func TestModelKindKeywordTables(t *testing.T) {
	raw, err := os.ReadFile("../testdata/model-kind-fixture.json")
	if err != nil {
		t.Fatalf("读不到对拍样本: %v", err)
	}
	var fixture struct {
		Keywords struct {
			VideoExact []string `json:"videoExact"`
			Video      []string `json:"video"`
			Image      []string `json:"image"`
			Audio      []string `json:"audio"`
			AudioAmbiguous []string `json:"audioAmbiguous"`
		} `json:"keywords"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("样本不是合法 JSON: %v", err)
	}
	for _, c := range []struct {
		name string
		got  []string
		want []string
	}{
		{"videoExactKeywords", videoExactKeywords, fixture.Keywords.VideoExact},
		{"videoKeywords", videoKeywords, fixture.Keywords.Video},
		{"imageKeywords", imageKeywords, fixture.Keywords.Image},
		{"audioKeywords", audioKeywords, fixture.Keywords.Audio},
		{"audioAmbiguousKeywords", audioAmbiguousKeywords, fixture.Keywords.AudioAmbiguous},
	} {
		if len(c.want) == 0 && len(c.got) == 0 {
			continue
		}
		if !reflect.DeepEqual(c.got, c.want) {
			t.Errorf("%s 与 testdata/model-kind-fixture.json 的 keywords 契约不一致\n  源码: %v\n  契约: %v\n"+
				"改关键词要三处同时改：service/model_kind_rules.go、web/src/lib/model-kind-rules.ts、本 fixture。",
				c.name, c.got, c.want)
		}
	}
}

func noteSuffix(note string) string {
	if note == "" {
		return ""
	}
	return "  （样本备注：" + note + "）"
}

// TestModelKindPredicatesAgreeWithClassify 四个具名判据必须严格等价于「分类结果等于该类」。
// 前端 model-kind-rules.ts 里那四个也是这么定义的；谁要是在某个判据上单独加排除条件，
// 前后端就又分叉了。
func TestModelKindPredicatesAgreeWithClassify(t *testing.T) {
	names := []string{
		"doubao-seedance-2-0-260128", "gpt-image-2", "doubao-tts", "seed-audio-1.0",
		"deepseek-v4-pro-260425", "sora-2",
		"flux-1.1-pro", "suno-music-v1", "", "   ",
	}
	for _, n := range names {
		kind := classifyModelKindByName(n)
		if isVideoModelName(n) != (kind == model.ModelKindVideo) {
			t.Errorf("%q: isVideoModelName 与分类不一致（分类=%s）", n, kind)
		}
		if isImageModelName(n) != (kind == model.ModelKindImage) {
			t.Errorf("%q: isImageModelName 与分类不一致（分类=%s）", n, kind)
		}
		if isAudioModelName(n) != (kind == model.ModelKindAudio) {
			t.Errorf("%q: isAudioModelName 与分类不一致（分类=%s）", n, kind)
		}
		if isTextModelName(n) != (kind == model.ModelKindText) {
			t.Errorf("%q: isTextModelName 与分类不一致（分类=%s）", n, kind)
		}
	}
}

// TestBackfillDoesNotPersistUnmatchedGuess 落到 text 默认分支（一个关键词都没命中）的名字
// 不该被当成「已确定的类型」写进 modelMetas —— 否则以后补全关键词表也救不回来。
func TestBackfillDoesNotPersistUnmatchedGuess(t *testing.T) {
	if modelKindMatchedByName("deepseek-v4-pro-260425") {
		t.Error("纯文本模型不该被认为命中了关键词")
	}
	for _, n := range []string{"sora-2", "flux-1.1-pro", "doubao-tts", "doubao-seedance-2-0-260128"} {
		if !modelKindMatchedByName(n) {
			t.Errorf("%q 应当命中关键词", n)
		}
	}
}
