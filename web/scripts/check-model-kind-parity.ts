// 前端侧的模型类型对拍检查。跑法（仓库根目录）：
//     bun web/scripts/check-model-kind-parity.ts
//
// 它读的是 testdata/model-kind-fixture.json —— 和后端
// `go test ./service -run TestModelKindFixture` 【同一个文件】。
// 关键词表分别在 service/model_kind_rules.go 与 web/src/lib/model-kind-rules.ts，
// 任何一边改了而另一边没跟上，这两个检查里至少一个会失败。
//
// 之所以要有这个脚本：前后端两套关键词表分叉过，而当时没有任何东西能发现它们分叉了。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { AUDIO_AMBIGUOUS_KEYWORDS, AUDIO_KEYWORDS, IMAGE_KEYWORDS, VIDEO_EXACT_KEYWORDS, VIDEO_KEYWORDS, classifyModelKindByName, isAudioModelName, isImageModelName, isTextModelName, isVideoModelName } from "../src/lib/model-kind-rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../../testdata/model-kind-fixture.json");

type Case = { model: string; kind: string; note?: string };
type Keywords = { videoExact: string[]; video: string[]; image: string[]; audio: string[]; audioAmbiguous: string[] };
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: Case[]; keywords: Keywords };

if (!fixture.cases?.length) {
    console.error(`✗ 对拍样本是空的：${fixturePath}`);
    process.exit(1);
}

const failures: string[] = [];

// ⚠️ 先比【关键词表本身】。这比逐样本比对更关键：只比样本的话，单边【新增】一个关键词
// 永远发现不了（新词没有任何样本触发），单边删掉一个没有样本覆盖的词也发现不了。
// 后端 TestModelKindKeywordTables 对自己那四个数组做同样的比对。
for (const [label, got, want] of [
    ["VIDEO_EXACT_KEYWORDS", VIDEO_EXACT_KEYWORDS, fixture.keywords.videoExact],
    ["VIDEO_KEYWORDS", VIDEO_KEYWORDS, fixture.keywords.video],
    ["IMAGE_KEYWORDS", IMAGE_KEYWORDS, fixture.keywords.image],
    ["AUDIO_KEYWORDS", AUDIO_KEYWORDS, fixture.keywords.audio],
    ["AUDIO_AMBIGUOUS_KEYWORDS", AUDIO_AMBIGUOUS_KEYWORDS, fixture.keywords.audioAmbiguous],
] as [string, string[], string[]][]) {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
        failures.push(`  ${label} 与 fixture 的 keywords 契约不一致\n    源码: ${JSON.stringify(got)}\n    契约: ${JSON.stringify(want)}`);
    }
}

for (const c of fixture.cases) {
    const got = classifyModelKindByName(c.model);
    if (got !== c.kind) {
        failures.push(`  ${JSON.stringify(c.model)}: 期望 ${c.kind}，实得 ${got}${c.note ? `  （样本备注：${c.note}）` : ""}`);
    }
}

// 四个具名判据必须严格等价于「分类结果等于该类」，与后端
// TestModelKindPredicatesAgreeWithClassify 对应。
for (const name of ["doubao-seedance-2-0-260128", "gpt-image-2", "doubao-tts", "seed-audio-1.0", "deepseek-v4-pro-260425", "sora-2", "flux-1.1-pro", "suno-music-v1", "", "   "]) {
    const kind = classifyModelKindByName(name);
    const checks: [string, boolean, boolean][] = [
        ["isVideoModelName", isVideoModelName(name), kind === "video"],
        ["isImageModelName", isImageModelName(name), kind === "image"],
        ["isAudioModelName", isAudioModelName(name), kind === "audio"],
        ["isTextModelName", isTextModelName(name), kind === "text"],
    ];
    for (const [label, got, want] of checks) {
        if (got !== want) failures.push(`  ${JSON.stringify(name)}: ${label} 与分类不一致（分类=${kind}）`);
    }
}

if (failures.length) {
    console.error(`✗ 模型类型判据对拍失败（${failures.length} 条）：`);
    console.error(failures.join("\n"));
    console.error("\n前后端关键词表已分叉。请同时检查：");
    console.error("  service/model_kind_rules.go");
    console.error("  web/src/lib/model-kind-rules.ts");
    process.exit(1);
}

console.log(`✓ 模型类型判据对拍通过：${fixture.cases.length} 个样本，前端与 testdata/model-kind-fixture.json 一致`);
