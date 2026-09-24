package service

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"aicanvas/model"
	"aicanvas/repository"
)

const (
	gptImage2RawBase             = "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts/main"
	awesomeGptImageRawBase       = "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main"
	awesomeGpt4oImagePromptsBase = "https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main"
	youMindGptImage2RawBase      = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main"
	youMindNanoBananaProRawBase  = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main"
	davidWuGptImage2RawBase      = "https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main"
	// 指到仓库的 data 目录：cases.json 里的图片路径形如 /images/caseN.jpg，正好相对该目录解析。
	freeStyleGptImage2RawBase = "https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data"
	// 仓库根（templates.md 在 docs/ 下，不在 data/ 下，所以不能复用上面那个带 /data 的 base）。
	freeStyleRepoRawBase = "https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main"
)

var gptImage2CaseFiles = []string{"README.md", "cases/ad-creative.md", "cases/character.md", "cases/comparison.md", "cases/ecommerce.md", "cases/portrait.md", "cases/poster.md", "cases/ui.md"}

type gptImage2Data struct {
	Records []struct {
		Title    string `json:"title"`
		TweetURL string `json:"tweet_url"`
		ImageDir string `json:"image_dir"`
		Category string `json:"category"`
		AddedAt  string `json:"added_at"`
	} `json:"records"`
}

type davidWuGptImage2Prompt struct {
	ID         int    `json:"id"`
	TitleEN    string `json:"title_en"`
	TitleCN    string `json:"title_cn"`
	Category   string `json:"category"`
	CategoryCN string `json:"category_cn"`
	Prompt     string `json:"prompt"`
	Note       string `json:"note"`
	Author     string `json:"author"`
	Source     string `json:"source"`
	NeedsRef   bool   `json:"needs_ref"`
	Image      string `json:"image"`
}

type freeStyleGptImage2Case struct {
	ID          int      `json:"id"`
	Title       string   `json:"title"`
	Image       string   `json:"image"`
	SourceLabel string   `json:"sourceLabel"`
	SourceURL   string   `json:"sourceUrl"`
	GithubURL   string   `json:"githubUrl"`
	Prompt      string   `json:"prompt"`
	Category    string   `json:"category"`
	Styles      []string `json:"styles"`
	Featured    bool     `json:"featured"`
}

type freeStyleGptImage2Data struct {
	Cases []freeStyleGptImage2Case `json:"cases"`
}

// 上游 cases.json 里的分类/风格只有英文，按同仓库 style-library.json 的官方中文译名映射成标签；
// 映射表没收录的（上游新增分类）原样保留英文，不丢标签。
var freeStyleGptImage2CategoryCN = map[string]string{
	"UI & Interfaces":            "UI 与界面",
	"Charts & Infographics":      "图表与信息可视化",
	"Posters & Typography":       "海报与排版",
	"Products & E-commerce":      "商品与电商",
	"Brand & Logos":              "品牌与标志",
	"Architecture & Spaces":      "建筑与空间",
	"Photography & Realism":      "摄影与写实",
	"Illustration & Art":         "插画与艺术",
	"Characters & People":        "人物与角色",
	"Scenes & Storytelling":      "场景与叙事",
	"History & Classical Themes": "历史与古风题材",
	"Documents & Publishing":     "文档与出版物",
	"Other Use Cases":            "其他应用场景",
}

var freeStyleGptImage2StyleCN = map[string]string{
	"3D":              "3D",
	"Architecture":    "建筑",
	"Brand":           "品牌",
	"Character":       "角色",
	"Characters":      "人物",
	"Charts":          "图表",
	"Classical":       "古典",
	"Documents":       "文档",
	"History":         "历史",
	"Illustration":    "插画",
	"Infographic":     "信息图",
	"Other Use Cases": "其他应用场景",
	"Photography":     "摄影",
	"Poster":          "海报",
	"Product":         "商品",
	"Products":        "商品",
	"Realistic":       "写实",
	"Scenes":          "场景",
	"UI":              "界面",
}

// 同步会下载封面到本地，单轮可能跑数分钟；cron 默认 */5 会叠跑，手动触发也可能撞上，串行化兜底。
var promptSyncRunMu sync.Mutex

func SyncPromptCategory(category string) ([]model.PromptCategory, error) {
	if !promptSyncRunMu.TryLock() {
		return nil, safeMessageError{message: "提示词同步正在进行中，请稍后再试"}
	}
	defer promptSyncRunMu.Unlock()
	for _, item := range repository.PromptCategories() {
		if item.Category != category {
			continue
		}
		items, err := buildPromptCategory(item.Category)
		if err != nil {
			return nil, err
		}
		// 各上游的标题很多是按分类自动生成的通用词，重名率很高
		// （实测 davidwu 41%、freestylefly 30%、gpt4o 18%）——列表里连着十几张卡标题一模一样，
		// 看上去像重复条目，其实正文各不相同。这里统一兜底补序号。
		// freestylefly 的适配器会先用作者做区分，走到这儿时它已经没有重名了。
		disambiguatePromptTitles(items)
		// 空结果拒绝替换：上游/镜像异常（如代理返回 200 拦截页）解析出 0 条时，
		// ReplacePromptCategory 会先整分类 DELETE，等于把库里已有数据清空——宁可保留旧数据报错。
		if len(items) == 0 {
			return nil, safeMessageError{message: "同步结果为空，疑似上游或镜像异常，已保留现有数据"}
		}
		localizePromptCovers(items)
		if err := repository.ReplacePromptCategory(item, items); err != nil {
			return nil, err
		}
		// 同一段提示词常被多个上游各收录一份（实测 2148 条里 343 条正文重复）。
		// 放在每个分类替换【之后】立刻收尾，而不是等整轮同步跑完 ——
		// 否则从本分类写完到整轮结束之间有好几分钟，用户在列表里就能看到重复。
		// 去重会删到别的分类的行（按固定优先级留一条），这是有意的；PROMPT_DEDUPE=off 可停用。
		if !strings.EqualFold(strings.TrimSpace(os.Getenv("PROMPT_DEDUPE")), "off") {
			if removed, err := repository.DedupePrompts(); err != nil {
				log.Printf("prompt dedupe failed category=%s err=%v", item.Category, err)
			} else if removed > 0 {
				log.Printf("prompt dedupe category=%s removed=%d", item.Category, removed)
			}
		}
		return repository.ListPromptCategories()
	}
	return nil, errors.New("未知提示词分类")
}

// disambiguatePromptTitles 给同一来源内的重名标题补序号；不重名的一个字不动。
func disambiguatePromptTitles(items []model.Prompt) {
	counts := map[string]int{}
	for i := range items {
		counts[items[i].Title]++
	}
	used := map[string]bool{}
	for i := range items {
		if counts[items[i].Title] < 2 {
			used[items[i].Title] = true
			continue
		}
		base := items[i].Title
		title := base
		for n := 2; used[title]; n++ {
			title = base + " " + strconv.Itoa(n)
		}
		used[title] = true
		items[i].Title = title
	}
}

func buildPromptCategory(category string) ([]model.Prompt, error) {
	switch category {
	case "gpt-image-2-prompts":
		return buildGptImage2Prompts()
	case "awesome-gpt-image":
		return buildAwesomeGptImagePrompts()
	case "awesome-gpt4o-image-prompts":
		return buildAwesomeGpt4oImagePrompts()
	case "youmind-gpt-image-2":
		return buildYouMindGptImage2Prompts()
	case "youmind-nano-banana-pro":
		return buildYouMindNanoBananaProPrompts()
	case "davidwu-gpt-image2-prompts":
		return buildDavidWuGptImage2Prompts()
	case "freestylefly-gpt-image-2":
		return buildFreeStyleGptImage2Prompts()
	case "freestylefly-templates":
		return buildFreeStyleTemplates()
	}
	return nil, errors.New("未知提示词分类")
}

func fetchText(baseURL, file string) (string, error) {
	data, err := fetchWithMirrors(baseURL+"/"+file, promptTextMaxBytes, validatePromptText)
	if err != nil {
		return "", errors.New(file + " 拉取失败: " + err.Error())
	}
	return string(data), nil
}

func buildGptImage2Prompts() ([]model.Prompt, error) {
	cases := map[string]string{}
	raw, err := fetchText(gptImage2RawBase, "data/ingested_tweets.json")
	if err != nil {
		return nil, err
	}
	data := gptImage2Data{}
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil, err
	}
	for _, file := range gptImage2CaseFiles {
		markdown, err := fetchText(gptImage2RawBase, file)
		if err != nil {
			return nil, err
		}
		collectGptImage2Cases(cases, markdown)
	}
	items := []model.Prompt{}
	for _, item := range data.Records {
		prompt := cases[item.TweetURL]
		if prompt == "" {
			continue
		}
		image := ""
		if strings.TrimSpace(item.ImageDir) != "" {
			image = gptImage2RawBase + "/" + item.ImageDir + "/output.jpg"
		}
		items = append(items, model.Prompt{ID: "gpt-image-2-prompts-" + leftPad(len(items)+1), Title: item.Title, CoverURL: image, Prompt: prompt, Tags: tagsFromCategory(item.Category), CreatedAt: item.AddedAt, UpdatedAt: item.AddedAt, Preview: markdownPreview([]string{image})})
	}
	return items, nil
}

func collectGptImage2Cases(cases map[string]string, markdown string) {
	re := regexp.MustCompile("(?s)### Case \\d+: \\[[^\\]]+\\]\\(([^)]+)\\).*?\\*\\*Prompt:\\*\\*\\s*\\r?\\n\\s*```[\\w-]*\\r?\\n(.*?)\\r?\\n```")
	for _, match := range re.FindAllStringSubmatch(markdown, -1) {
		cases[match[1]] = strings.TrimSpace(match[2])
	}
}

func buildAwesomeGptImagePrompts() ([]model.Prompt, error) {
	markdown, err := fetchText(awesomeGptImageRawBase, "README.zh-CN.md")
	if err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	for _, section := range splitBeforeHeading(markdown, "## ") {
		tags := tagsFromHeading(firstMatch(section, `(?m)^##\s+(.+)$`))
		for _, block := range splitBeforeHeading(section, "### ") {
			title := strings.TrimSpace(regexp.MustCompile(`\[([^\]]+)]\([^)]+\)`).ReplaceAllString(firstMatch(block, `(?m)^###\s+(.+)$`), "$1"))
			prompt := strings.TrimSpace(firstMatch(block, "(?s)\\*\\*提示词:\\*\\*\\s*\\r?\\n\\s*```[\\w-]*\\r?\\n(.*?)\\r?\\n```"))
			if title == "" || prompt == "" {
				continue
			}
			images := extractMarkdownImages(awesomeGptImageRawBase, block)
			cover := ""
			if len(images) > 0 {
				cover = images[0]
			}
			items = append(items, model.Prompt{ID: "awesome-gpt-image-" + leftPad(len(items)+1), Title: title, CoverURL: cover, Prompt: prompt, Tags: tags, Preview: markdownPreview(images)})
		}
	}
	return items, nil
}

func buildAwesomeGpt4oImagePrompts() ([]model.Prompt, error) {
	markdown, err := fetchText(awesomeGpt4oImagePromptsBase, "README.zh-CN.md")
	if err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	for _, block := range splitBeforeHeading(markdown, "### ") {
		title := strings.TrimSpace(firstMatch(block, `(?m)^###\s+(.+)$`))
		prompt := strings.TrimSpace(firstMatch(block, "(?s)- \\*\\*提示词文本：\\*\\*\\s*`(.*?)`"))
		if title == "" || prompt == "" {
			continue
		}
		images := extractMarkdownImages(awesomeGpt4oImagePromptsBase, block)
		cover := ""
		if len(images) > 0 {
			cover = images[0]
		}
		items = append(items, model.Prompt{ID: "awesome-gpt4o-image-prompts-" + leftPad(len(items)+1), Title: title, CoverURL: cover, Prompt: prompt, Tags: []string{"gpt4o"}, Preview: markdownPreview(images)})
	}
	return items, nil
}

func buildYouMindGptImage2Prompts() ([]model.Prompt, error) {
	return buildYouMindPrompts(youMindGptImage2RawBase, "youmind-gpt-image-2", "gpt-image-2")
}

func buildYouMindNanoBananaProPrompts() ([]model.Prompt, error) {
	return buildYouMindPrompts(youMindNanoBananaProRawBase, "youmind-nano-banana-pro", "nano-banana-pro")
}

func buildDavidWuGptImage2Prompts() ([]model.Prompt, error) {
	raw, err := fetchText(davidWuGptImage2RawBase, "prompts.json")
	if err != nil {
		return nil, err
	}
	data := []davidWuGptImage2Prompt{}
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	for _, item := range data {
		title := strings.TrimSpace(item.TitleCN)
		if title == "" {
			title = strings.TrimSpace(item.TitleEN)
		}
		prompt := strings.TrimSpace(item.Prompt)
		if title == "" || prompt == "" {
			continue
		}
		image := absoluteImage(davidWuGptImage2RawBase, item.Image)
		items = append(items, model.Prompt{ID: "davidwu-gpt-image2-prompts-" + leftPad(item.ID), Title: title, CoverURL: image, Prompt: prompt, Tags: davidWuGptImage2Tags(item), Preview: davidWuGptImage2Preview(item, image)})
	}
	return items, nil
}

func buildFreeStyleGptImage2Prompts() ([]model.Prompt, error) {
	raw, err := fetchText(freeStyleGptImage2RawBase, "cases.json")
	if err != nil {
		return nil, err
	}
	data := freeStyleGptImage2Data{}
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	labels := []string{}
	seen := map[string]bool{}
	for _, item := range data.Cases {
		title := strings.TrimSpace(item.Title)
		prompt := strings.TrimSpace(item.Prompt)
		// id 缺失/非正就整条跳过：宁可让整批为空、由上层「空结果拒绝替换」保住旧数据，
		// 也不能靠序号兜底——那样上游改字段名时会静默写入一批错位数据。
		if title == "" || prompt == "" || item.ID <= 0 {
			continue
		}
		id := "freestylefly-gpt-image-2-" + leftPad(item.ID)
		// 整批一次性 Create，批内主键重复会让事务整体失败，先去重。
		if seen[id] {
			continue
		}
		seen[id] = true
		items = append(items, model.Prompt{
			ID:       id,
			Title:    title,
			CoverURL: absoluteImage(freeStyleGptImage2RawBase, item.Image),
			Prompt:   prompt,
			Tags:     freeStyleGptImage2Tags(item),
			Preview:  freeStyleGptImage2Preview(item),
		})
		labels = append(labels, strings.TrimSpace(item.SourceLabel))
	}
	disambiguateFreeStyleTitles(items, labels)
	return items, nil
}

// disambiguateFreeStyleTitles 给重名标题补上区分信息。
// 上游那批标题很多是按分类自动生成的通用词，实测 535 条里 24 组重名、共 161 条（30%），
// 最多的「信息图可视化设计」有 27 条同名——列表里连着 27 张卡片标题一模一样，
// 看上去像重复条目，但正文其实各不相同。
// 处置：重名的补作者（同时也把出处摆到了卡片正面）；补完仍重名的再补序号。
// 不重名的一个字都不动。
func disambiguateFreeStyleTitles(items []model.Prompt, labels []string) {
	counts := map[string]int{}
	for i := range items {
		counts[items[i].Title]++
	}
	used := map[string]bool{}
	for i := range items {
		if counts[items[i].Title] < 2 {
			used[items[i].Title] = true
			continue
		}
		base := items[i].Title
		candidate := base
		if label := freeStyleAuthorSuffix(labelAt(labels, i)); label != "" {
			candidate = base + " · " + label
		}
		title := candidate
		for n := 2; used[title]; n++ {
			title = candidate + " " + strconv.Itoa(n)
		}
		used[title] = true
		items[i].Title = title
	}
}

func labelAt(labels []string, i int) string {
	if i < len(labels) {
		return labels[i]
	}
	return ""
}

// freeStyleAuthorSuffix 从 sourceLabel 里取一个短到能放进标题的作者标识。
// 上游的 sourceLabel 有 @handle、「小红书号XXX」、公众号长句、甚至损坏的 markdown 串，
// 过长或明显不是署名的一律放弃，退回用序号区分。
func freeStyleAuthorSuffix(label string) string {
	label = strings.TrimSpace(label)
	if label == "" || label == "未提供" || strings.ContainsAny(label, "[]()<>\\") {
		return ""
	}
	if len([]rune(label)) > 16 {
		return ""
	}
	return label
}

// ── 工业级填空模板（docs/templates.md + data/style-library.json）────────────────

// freeStyleTemplateMinCount 是「解析结果可信」的下限。上游那份 markdown 靠加粗标题 + 代码围栏
// 组织，结构一变就可能解析出零星几条——那种情况下宁可整批返回空，让上层的「空结果拒绝替换」
// 保住库里旧数据，也不要用几条残缺结果把整个分类冲掉。实测正常应为 47 套。
const freeStyleTemplateMinCount = 20

// templates.md 的三级标题写法与案例分类名有细微差异（如「UI与界面」少一个空格）。
// 必须映射到案例那边已在用的规范名，否则筛选栏会出现两个几乎一样的标签。
var freeStyleTemplateCategoryCN = map[string]string{
	"UI与界面":    "UI 与界面",
	"图表与信息可视化": "图表与信息可视化",
	"海报与排版":    "海报与排版",
	"商品与电商":    "商品与电商",
	"品牌与标志":    "品牌与标志",
	"建筑与空间":    "建筑与空间",
	"摄影与写实":    "摄影与写实",
	"插画与艺术":    "插画与艺术",
	"人物与角色":    "人物与角色",
	"场景与叙事":    "场景与叙事",
	"历史与古风题材":  "历史与古风题材",
	"文档与出版物":   "文档与出版物",
	"其他应用场景":   "其他应用场景",
}

type freeStyleTemplateMeta struct {
	Category string `json:"category"`
	Cover    string `json:"cover"`
	UseWhen  struct {
		ZH string `json:"zh"`
	} `json:"useWhen"`
	Guidance struct {
		ZH []string `json:"zh"`
	} `json:"guidance"`
	Pitfalls struct {
		ZH []string `json:"zh"`
	} `json:"pitfalls"`
}

type freeStyleStyleLibrary struct {
	Templates []freeStyleTemplateMeta `json:"templates"`
}

func buildFreeStyleTemplates() ([]model.Prompt, error) {
	markdown, err := fetchText(freeStyleRepoRawBase, "docs/templates.md")
	if err != nil {
		return nil, err
	}
	// style-library.json 只提供封面与说明，拿不到不算致命：降级成无封面无说明，正文照常入库。
	metas := map[string][]freeStyleTemplateMeta{}
	if raw, metaErr := fetchText(freeStyleGptImage2RawBase, "style-library.json"); metaErr == nil {
		library := freeStyleStyleLibrary{}
		if json.Unmarshal([]byte(raw), &library) == nil {
			for _, item := range library.Templates {
				cn := freeStyleGptImage2Label(freeStyleGptImage2CategoryCN, item.Category)
				metas[cn] = append(metas[cn], item)
			}
		}
	}

	// 封面：直接复用【已入库案例】里同题材的图（按标签归拢），一是不用再拉一次上游、
	// 二是拿到的本来就是已本地化的地址。⚠️ 不能像先前那样用 style-library 的 cover 轮换 ——
	// 多数分类在 style-library 里只有 1 条元数据，i%1 恒为 0，同一分类下所有模板会共用同一张图。
	coverPool, _ := repository.PromptCoversGroupedByTag("freestylefly-gpt-image-2")

	items := []model.Prompt{}
	for _, section := range splitBeforeHeading(markdown, "### ") {
		heading := strings.TrimSpace(firstMatch(section, `(?m)^###\s+(.+)$`))
		category := freeStyleTemplateCategoryCN[heading]
		if category == "" {
			continue
		}
		guide := freeStyleTemplateGuide(section)
		for i, tpl := range freeStyleTemplateBlocks(section) {
			cover := ""
			if pool := coverPool[category]; len(pool) > 0 {
				cover = pool[i%len(pool)]
			} else if list := metas[category]; len(list) > 0 {
				cover = absoluteImage(freeStyleGptImage2RawBase, list[i%len(list)].Cover)
			}
			items = append(items, model.Prompt{
				ID:       "freestylefly-templates-" + leftPad(len(items)+1),
				Title:    category + " · " + tpl.name,
				CoverURL: cover,
				Prompt:   tpl.body,
				Tags:     freeStyleTemplateTags(category, tpl),
				Preview:  freeStyleTemplatePreview(metas[category], i, guide),
			})
		}
	}
	if len(items) < freeStyleTemplateMinCount {
		return nil, safeMessageError{message: "模板解析结果只有 " + strconv.Itoa(len(items)) + " 条，疑似上游排版变化，已保留现有数据"}
	}
	return items, nil
}

type freeStyleTemplateBlock struct {
	name string
	body string
	json bool
}

// freeStyleTemplateBlocks 从一个分类段里取出全部「**模板名** + 紧随其后的代码块」。
// ⚠️ 上游 markdown 存在【未闭合的代码围栏】（实测：签名练习拆解图模板那块开了不关），
// 所以【绝对不能】按顺序把 ``` 两两配对——那样会从出错处开始整篇错位，而且不报错、照样入库，
// 只能逐条肉眼核对才发现。这里改成：先用「下一个加粗标题」把每块的边界框死，
// 再在块内找围栏，块内找不到闭合就一直取到块尾。上游再犯同类错也只会影响那一条。
func freeStyleTemplateBlocks(section string) []freeStyleTemplateBlock {
	titleRe := regexp.MustCompile(`(?m)^\*\*([^*\n]*模板[^*\n]*)\*\*\s*$`)
	locs := titleRe.FindAllStringSubmatchIndex(section, -1)
	blocks := []freeStyleTemplateBlock{}
	for i, loc := range locs {
		name := strings.TrimSpace(section[loc[2]:loc[3]])
		end := len(section)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		body, isJSON := freeStyleFirstFence(section[loc[1]:end])
		if name == "" || body == "" {
			continue
		}
		blocks = append(blocks, freeStyleTemplateBlock{name: name, body: body, json: isJSON})
	}
	return blocks
}

// freeStyleFirstFence 取 seg 里第一个代码围栏的内容；没有闭合围栏时取到 seg 结尾。
func freeStyleFirstFence(seg string) (string, bool) {
	lines := strings.Split(seg, "\n")
	start := -1
	isJSON := false
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			start = i
			isJSON = strings.Contains(strings.ToLower(line), "json")
			break
		}
	}
	if start < 0 {
		return "", false
	}
	body := []string{}
	for _, line := range lines[start+1:] {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			break
		}
		body = append(body, line)
	}
	return strings.TrimSpace(strings.Join(body, "\n")), isJSON
}

// freeStyleTemplateGuide 取该分类末尾那段「避坑指南」的条目（每类一段，是这份文档里信噪比最高的部分）。
func freeStyleTemplateGuide(section string) []string {
	i := strings.Index(section, "避坑指南")
	if i < 0 {
		i = strings.Index(section, "防坑指南")
	}
	if i < 0 {
		return nil
	}
	tips := []string{}
	for _, line := range strings.Split(section[i:], "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "- ") {
			continue
		}
		tip := strings.TrimSpace(strings.TrimPrefix(line, "- "))
		tip = strings.ReplaceAll(tip, "**", "")
		if tip != "" {
			tips = append(tips, tip)
		}
	}
	return tips
}

func freeStyleTemplateTags(category string, tpl freeStyleTemplateBlock) []string {
	tags := []string{"模板", category}
	if tpl.json {
		tags = append(tags, "JSON 结构")
	}
	return tags
}

// freeStyleTemplatePreview 组说明文字。详情弹窗把 preview 塞进 <pre> 纯文本直出、
// 容器只有约 300px 宽且高度受限，所以要点与避坑各截前 3 条，不要把整段灌进去。
func freeStyleTemplatePreview(metas []freeStyleTemplateMeta, index int, guide []string) string {
	lines := []string{}
	if len(metas) > 0 {
		meta := metas[index%len(metas)]
		if use := strings.TrimSpace(meta.UseWhen.ZH); use != "" {
			lines = append(lines, "什么时候用："+use)
		}
		if len(meta.Guidance.ZH) > 0 {
			lines = append(lines, "", "要点：")
			for _, g := range meta.Guidance.ZH[:min(len(meta.Guidance.ZH), 3)] {
				lines = append(lines, "· "+g)
			}
		}
	}
	if len(guide) > 0 {
		lines = append(lines, "", "避坑：")
		for _, g := range guide[:min(len(guide), 3)] {
			lines = append(lines, "· "+g)
		}
	}
	// 模板本身没有配图，封面借的是同题材案例的成图。必须说清楚，
	// 否则用户会以为「照这个模板生成就能得到封面那张图」。
	lines = append(lines, "", "※ 封面取自同题材案例，只表示这类模板大致用在什么画面上，不是本模板的输出结果。")
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func freeStyleGptImage2Tags(item freeStyleGptImage2Case) []string {
	tags := []string{}
	seen := map[string]bool{}
	add := func(value string) {
		if value = strings.TrimSpace(value); value != "" && !seen[value] {
			seen[value] = true
			tags = append(tags, value)
		}
	}
	add(freeStyleGptImage2Label(freeStyleGptImage2CategoryCN, item.Category))
	for _, style := range item.Styles {
		add(freeStyleGptImage2Label(freeStyleGptImage2StyleCN, style))
	}
	if item.Featured {
		add("精选")
	}
	return tags
}

func freeStyleGptImage2Label(dict map[string]string, value string) string {
	value = strings.TrimSpace(value)
	if label := dict[value]; label != "" {
		return label
	}
	return value
}

// freeStyleGptImage2Preview 只放纯文本出处：详情弹窗是把 preview 塞进 <pre> 直出的，
// 写 markdown 图片语法只会原样显示成一串 ![](...)。
func freeStyleGptImage2Preview(item freeStyleGptImage2Case) string {
	lines := []string{}
	if label := strings.TrimSpace(item.SourceLabel); label != "" {
		lines = append(lines, "作者："+label)
	}
	if link := strings.TrimSpace(item.SourceURL); link != "" {
		lines = append(lines, "原帖："+link)
	}
	if link := strings.TrimSpace(item.GithubURL); link != "" {
		lines = append(lines, "案例页："+link)
	}
	return strings.Join(lines, "\n")
}

func buildYouMindPrompts(baseURL, idPrefix, modelTag string) ([]model.Prompt, error) {
	markdown, err := fetchText(baseURL, "README_zh.md")
	if err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	for _, block := range splitBeforeHeading(markdown, "### ") {
		title := strings.TrimSpace(firstMatch(block, `(?m)^###\s+No\.\s*\d+:\s*(.+)$`))
		prompt := strings.TrimSpace(firstMatch(block, "(?s)#### .*?提示词\\s*\\r?\\n\\s*```[\\w-]*\\r?\\n(.*?)\\r?\\n```"))
		if title == "" || prompt == "" {
			continue
		}
		images := extractMarkdownImages(baseURL, block)
		cover := ""
		if len(images) > 0 {
			cover = images[0]
		}
		items = append(items, model.Prompt{ID: idPrefix + "-" + leftPad(len(items)+1), Title: title, CoverURL: cover, Prompt: prompt, Tags: youMindTags(title, modelTag), Preview: markdownPreview(images)})
	}
	return items, nil
}

func splitBeforeHeading(markdown string, prefix string) []string {
	blocks := []string{}
	lines := strings.Split(markdown, "\n")
	current := []string{}
	for _, line := range lines {
		if strings.HasPrefix(line, prefix) && len(current) > 0 {
			blocks = append(blocks, strings.Join(current, "\n"))
			current = []string{}
		}
		current = append(current, line)
	}
	return append(blocks, strings.Join(current, "\n"))
}

func firstMatch(value string, pattern string) string {
	match := regexp.MustCompile(pattern).FindStringSubmatch(value)
	if len(match) > 1 {
		return match[1]
	}
	return ""
}

func tagsFromCategory(category string) []string {
	return splitTags(regexp.MustCompile(`(?i)\s+Cases$`).ReplaceAllString(category, ""), `\s*(&|and)\s*`)
}

func tagsFromHeading(heading string) []string {
	return splitTags(regexp.MustCompile(`[^\p{L}\p{N}/&、与 ]`).ReplaceAllString(heading, ""), `\s*(/|&|、|与)\s*`)
}

func youMindTags(title, modelTag string) []string {
	tags := []string{modelTag}
	parts := strings.SplitN(title, " - ", 2)
	if len(parts) > 1 {
		tags = append(tags, tagsFromHeading(parts[0])...)
	}
	return tags
}

func davidWuGptImage2Tags(item davidWuGptImage2Prompt) []string {
	tags := splitTags(strings.Join([]string{item.CategoryCN, item.Category, item.Author, item.Source}, "/"), `/`)
	if item.NeedsRef {
		tags = append(tags, "需要参考图")
	}
	return tags
}

func davidWuGptImage2Preview(item davidWuGptImage2Prompt, image string) string {
	lines := []string{}
	if item.TitleEN != "" {
		lines = append(lines, item.TitleEN)
	}
	if item.Note != "" {
		lines = append(lines, item.Note)
	}
	if image != "" {
		lines = append(lines, "![]("+image+")")
	}
	return strings.Join(lines, "\n\n")
}

func splitTags(value string, pattern string) []string {
	tags := []string{}
	for _, tag := range regexp.MustCompile(pattern).Split(value, -1) {
		if tag = strings.ToLower(strings.TrimSpace(tag)); tag != "" {
			tags = append(tags, tag)
		}
	}
	return tags
}

func markdownPreview(images []string) string {
	lines := []string{}
	for _, image := range images {
		if image != "" {
			lines = append(lines, "![]("+image+")")
		}
	}
	return strings.Join(lines, "\n\n")
}

func extractMarkdownImages(baseURL string, block string) []string {
	seen := map[string]bool{}
	images := []string{}
	for _, pattern := range []string{`<img[^>]+src="([^"]+)"`, `!\[[^\]]*]\(([^)]+)\)`} {
		for _, match := range regexp.MustCompile(pattern).FindAllStringSubmatch(block, -1) {
			image := absoluteImage(baseURL, match[1])
			if image != "" && !seen[image] {
				seen[image] = true
				images = append(images, image)
			}
		}
	}
	return images
}

func absoluteImage(baseURL, image string) string {
	if image == "" || strings.HasPrefix(image, "http://") || strings.HasPrefix(image, "https://") {
		return image
	}
	return baseURL + "/" + strings.TrimLeft(strings.TrimPrefix(image, "."), "/")
}

func leftPad(value int) string {
	if value >= 1000 {
		return strconv.Itoa(value)
	}
	text := "000" + strconv.Itoa(value)
	return text[len(text)-3:]
}
