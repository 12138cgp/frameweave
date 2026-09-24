package service

import (
	"log"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
)

// 模型类型与支持档位的唯一读取口。
//
// 背景：这个项目里「一个模型是什么类型」历史上有 8 套并行判据（前端名字启发式、后端名字启发式、
// HTTP 请求路径、定价表里有没有这一行、渠道 protocol、baseURL 域名、厂商代次能力表、用户手选的
// generationMode）。加一个新模型要在 6~12 处分别登记，漏一处就是「下拉里看不到」或「按错口径计费」。
//
// 现在把「类型」变成一份可在后台编辑的数据（PublicModelChannelSetting.ModelMetas），这里是读取它的
// 唯一入口。配置里查得到就以配置为准；查不到才回落到名字启发式——这样存量模型在管理员补齐之前
// 行为完全不变，不会因为「还没配」就突然失灵。

// inferModelKind 名字启发式，仅用于「后台还没给这个模型标类型」时的兜底。
// 实现在 model_kind_rules.go（关键词表的唯一数据源），这里只留个别名方便阅读调用点。
func inferModelKind(modelName string) model.ModelKind {
	return classifyModelKindByName(modelName)
}

// isAudioModelName 音频模型名判据。委托给 model_kind_rules.go。
func isAudioModelName(modelName string) bool {
	return classifyModelKindByName(modelName) == model.ModelKindAudio
}

// BackfillModelMetas 一次性迁移：给还没有元信息的模型补上推断出来的类型与档位。
//
// 只增不改：已经有 meta 的模型原样保留（管理员手工改过的绝不覆盖）。
// 返回新补了几条，供启动日志观察。
func BackfillModelMetas() (int, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return 0, err
	}
	public := normalizePublicSetting(settings.Public)

	known := make(map[string]bool, len(public.ModelChannel.ModelMetas))
	for _, meta := range public.ModelChannel.ModelMetas {
		known[strings.TrimSpace(meta.Model)] = true
	}

	// 收集所有露过面的模型名：可用清单 + 两张定价表 + 各分组渠道里配的。
	// 用有序切片而不是直接遍历 map，保证每次迁移产出的顺序稳定、便于比对。
	seen := make(map[string]bool)
	names := make([]string, 0, 32)
	add := func(raw string) {
		name := strings.TrimSpace(raw)
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		names = append(names, name)
	}
	for _, m := range public.ModelChannel.AvailableModels {
		add(m)
	}
	for _, c := range public.ModelChannel.ModelCosts {
		add(c.Model)
	}
	for _, c := range public.ModelChannel.VideoModelCosts {
		add(c.Model)
	}
	groups, err := repository.ListGroups()
	if err == nil {
		for _, g := range groups {
			for _, ch := range GroupModelChannels(g) {
				for _, m := range ch.Models {
					add(m)
				}
			}
		}
	}

	added := 0
	for _, name := range names {
		if known[name] {
			continue
		}
		// ⚠️ 一个关键词都没命中（只是落到了 text 默认分支）就【不写】。
		// 以前无条件写，等于把一次猜测固化成配置：metas 的优先级高于所有名字启发式，
		// 而 backfill 又是「只增不改」，于是以后补全了关键词表也再救不回来。
		// 不写的后果只是继续走各读取点的名字兜底，而兜底现在前后端同源，结论一致。
		if !modelKindMatchedByName(name) {
			continue
		}
		meta := model.ModelMeta{Model: name, Kind: inferModelKind(name)}
		// 视频模型的支持档位从定价表反推：已经配了价的档位就是实际在用的档位。
		// 其它类型一律留空 = 不限制，避免迁移当天用户突然发现某些档位不能选了。
		if meta.Kind == model.ModelKindVideo {
			for _, item := range public.ModelChannel.VideoModelCosts {
				if strings.TrimSpace(item.Model) != name {
					continue
				}
				for _, rate := range item.Rates {
					if r := strings.TrimSpace(rate.Resolution); r != "" {
						meta.Resolutions = append(meta.Resolutions, r)
					}
				}
			}
		}
		public.ModelChannel.ModelMetas = append(public.ModelChannel.ModelMetas, meta)
		added++
	}
	warnStaleModelMetas(public.ModelChannel.ModelMetas)

	if added == 0 {
		return 0, nil
	}
	settings.Public = public
	if _, err := repository.SaveSettings(settings, now()); err != nil {
		return 0, err
	}
	return added, nil
}

// warnStaleModelMetas 把「存的类型」和「名字明确命中的类型」不一致的 meta 打到启动日志里。
//
// 为什么只告警不自动改：这两种情况在数据上长得一模一样，无法区分——
//
//	① 历史遗留：早年 backfill 用当时更窄的关键词表猜错并固化了（modelMetas 是「只增不改」，永不自愈）；
//	② 管理员故意：他就是要把某个名字像视频的模型标成文本。
//
// 自动覆盖会把 ② 打回去，而且管理员在后台改回来、下次重启又被覆盖，变成死循环。
// 所以这里只负责让 ① 可见，改由人去后台「模型类型与可用档位」表里点一下。
func warnStaleModelMetas(metas []model.ModelMeta) {
	for _, meta := range metas {
		name := strings.TrimSpace(meta.Model)
		if name == "" || !modelKindMatchedByName(name) {
			continue
		}
		if inferred := inferModelKind(name); inferred != meta.Kind {
			log.Printf("模型类型存疑: %q 在 modelMetas 里存的是 %s，但名字明确命中 %s。"+
				"若是早年回填猜错的，去后台「模型类型与可用档位」改成 %s；若是有意为之，忽略本行。",
				name, meta.Kind, inferred, inferred)
		}
	}
}
