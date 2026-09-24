package repository

import (
	"crypto/sha256"
	"errors"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"aicanvas/model"
	"gorm.io/gorm"
)

// PromptCategories 返回内置提示词分类的副本。
func PromptCategories() []model.PromptCategory {
	result := make([]model.PromptCategory, len(promptCategories))
	copy(result, promptCategories)
	return result
}

// PromptCategoryByCode 根据分类编码查找内置提示词分类。
func PromptCategoryByCode(category string) (model.PromptCategory, bool) {
	for _, item := range promptCategories {
		if item.Category == category {
			return item, true
		}
	}
	return model.PromptCategory{}, false
}

// ListPromptCategories 返回内置提示词分类。
func ListPromptCategories() ([]model.PromptCategory, error) {
	return PromptCategories(), nil
}

// ListPrompts 按查询条件返回提示词分页列表。
func ListPrompts(q model.Query) ([]model.Prompt, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := applyPromptFilters(db.Model(&model.Prompt{}), q)

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var items []model.Prompt
	// 有封面的排前面：上游存在一批无图条目，按时间排序时会霸占列表头部，视觉上像整页加载失败。
	// ⚠️ 末尾的 id 是【必须的】唯一兜底键，不能删：多数来源不带 updated_at（空串），
	// 前两个排序键在上千行里大面积相等，没有唯一键时数据库每次返回的顺序可以不同，
	// 前端是 offset 无限滚动 —— 结果就是同一条在两页里各出现一次、另一条永远刷不到。
	// 实测：缺了唯一兜底键时，前 5 页 120 条里会有 19 条重复、19 条被吞。
	// 第一排序键是来源优先级，复用 promptDedupePriority（同一份表，避免两处发散）。
	// 不加它的话，唯一带 updated_at 的来源会整体霸占列表头部：实测在 1805 条的库上，
	// 第 1~581 位【全部】是上游已删除的 gpt-image-2-prompts，还在更新的 freestylefly
	// 要滚到第 896 位（约第 45 页）才出现，首页「精选模板」取前 48 条也 100% 来自死来源。
	if err := tx.Order(promptCategoryOrderExpr()).Order("(cover_url IS NULL OR cover_url = '') asc").Order("updated_at desc").Order("id asc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error; err != nil {
		return nil, 0, err
	}
	categories, _ := ListPromptCategories()
	githubURLs := map[string]string{}
	for _, item := range categories {
		githubURLs[item.Category] = item.GithubURL
	}
	for i := range items {
		items[i].GithubURL = githubURLs[items[i].Category]
	}
	return items, total, nil
}

// ListPromptTags 返回当前提示词查询条件下的全部标签。
func ListPromptTags(q model.Query) ([]string, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	q.Normalize()
	q.Tags = nil
	tx := applyPromptFilters(db.Model(&model.Prompt{}), q)

	var items []model.Prompt
	if err := tx.Select("tags").Find(&items).Error; err != nil {
		return nil, err
	}
	return promptTagsFromItems(items), nil
}

// CountPromptsByCategory 统计各分类的实际条数。用于把「一条都没有」的分类从筛选栏里摘掉
// （例如内置的 system 分类，库里从来没有行，却一直占着一个芯片位）。
func CountPromptsByCategory() (map[string]int, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	type row struct {
		Category string
		Total    int
	}
	rows := []row{}
	if err := db.Model(&model.Prompt{}).Select("category, count(*) as total").Group("category").Scan(&rows).Error; err != nil {
		return nil, err
	}
	result := map[string]int{}
	for _, r := range rows {
		result[r.Category] = r.Total
	}
	return result, nil
}

// PromptCoversGroupedByTag 把某个分类里已本地化的封面按标签归拢。
// 用途：给「填空模板」这类本身没有配图的条目挑一张同题材的封面 ——
// 直接复用已入库案例的封面，既不用再拉一次上游、又保证是本地可用的地址。
func PromptCoversGroupedByTag(category string) (map[string][]string, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := []model.Prompt{}
	if err := db.Select("tags", "cover_url").Where("category = ?", category).Order("id asc").Find(&items).Error; err != nil {
		return nil, err
	}
	result := map[string][]string{}
	for _, item := range items {
		cover := strings.TrimSpace(item.CoverURL)
		if cover == "" {
			continue
		}
		for _, tag := range item.Tags {
			result[tag] = append(result[tag], cover)
		}
	}
	return result, nil
}

// SavePrompt 保存提示词，并在更新时保留原创建时间。
func SavePrompt(item model.Prompt) (model.Prompt, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	if saved, ok, err := findPrompt(db, item.ID); err != nil {
		return item, err
	} else if ok && item.CreatedAt == "" {
		item.CreatedAt = saved.CreatedAt
	}
	item.GithubURL = ""
	return item, db.Save(&item).Error
}

// DeletePrompt 删除指定提示词。
func DeletePrompt(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.Prompt{}, "id = ?", id).Error
}

// DeletePrompts 批量删除提示词。
func DeletePrompts(ids []string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.Prompt{}, "id IN ?", ids).Error
}

// promptDedupePriority 决定同一段正文在多个来源里重复时保留哪一条，越靠前越优先。
// freestylefly 排最前：它是唯一还在更新、且带中文标题与作者出处的结构化来源；
// gpt-image-2-prompts 排最后：上游仓库 2026-07 已删除，永远不会再更新。
// 不在表里的来源排在所有已知来源之后（按名字定序，保证结果确定）。
var promptDedupePriority = []string{
	"freestylefly-gpt-image-2",
	"freestylefly-templates",
	"davidwu-gpt-image2-prompts",
	"youmind-gpt-image-2",
	"youmind-nano-banana-pro",
	"awesome-gpt-image",
	"awesome-gpt4o-image-prompts",
	"gpt-image-2-prompts",
}

// promptCategoryOrderExpr 把 promptDedupePriority 编译成一段 CASE 排序表达式，
// 让列表按来源优先级排（越靠前越先展示），表里没有的来源统一排在最后。
// 分类编码全部来自本文件的常量数组、不含用户输入，因此直接拼进 SQL 是安全的；
// 但仍然只允许 [a-z0-9-] 通过，防止将来有人往那张表里加带引号的编码。
func promptCategoryOrderExpr() string {
	var b strings.Builder
	b.WriteString("CASE category")
	n := 0
	for i, category := range promptDedupePriority {
		if !isSafePromptCategoryCode(category) {
			continue
		}
		b.WriteString(" WHEN '" + category + "' THEN " + strconv.Itoa(i))
		n++
	}
	if n == 0 {
		// 整张表都不合法时退化成常量，避免拼出语法错误的 SQL 把整个列表打挂。
		return "1"
	}
	b.WriteString(" ELSE " + strconv.Itoa(len(promptDedupePriority)) + " END asc")
	return b.String()
}

func isSafePromptCategoryCode(category string) bool {
	if category == "" {
		return false
	}
	for _, r := range category {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			continue
		}
		return false
	}
	return true
}

// promptDedupeMaxRatio 是一次去重最多允许删掉的比例。正常重复率约 16%，
// 一旦超过这个数说明「判定相同」的逻辑出了问题（比如正文被清空导致全部撞成同一个 key），
// 这时宁可一条不删也不能把整个词库删空。
const promptDedupeMaxRatio = 0.4

// promptBodyKey 把正文归一化成比较用的键：去掉全部空白 + 转小写。
// 同一段提示词在不同来源里常有换行、缩进、全角空格的差异，直接比字符串会漏掉大量重复。
func promptBodyKey(prompt string) [32]byte {
	var b strings.Builder
	b.Grow(len(prompt))
	for _, r := range prompt {
		if unicode.IsSpace(r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return sha256.Sum256([]byte(b.String()))
}

// DedupePrompts 删除正文重复的提示词，每组只保留一条，返回删除条数。
// 保留顺序：来源优先级 → 有封面的优先 → id 小的优先，三级都定死，所以反复跑结果稳定、
// 不会出现「这轮删 A 下轮删 B」的来回抖动。每轮同步后调用，属于幂等收尾。
func DedupePrompts() (int, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	priority := map[string]int{}
	for i, category := range promptDedupePriority {
		priority[category] = i
	}
	rank := func(category string) int {
		if i, ok := priority[category]; ok {
			return i
		}
		return len(promptDedupePriority)
	}

	var items []model.Prompt
	if err := db.Select("id", "category", "cover_url", "prompt").Find(&items).Error; err != nil {
		return 0, err
	}
	groups := map[[32]byte][]int{}
	for i := range items {
		key := promptBodyKey(items[i].Prompt)
		groups[key] = append(groups[key], i)
	}

	victims := []string{}
	for _, idxs := range groups {
		if len(idxs) < 2 {
			continue
		}
		sort.SliceStable(idxs, func(a, b int) bool {
			x, y := items[idxs[a]], items[idxs[b]]
			if rx, ry := rank(x.Category), rank(y.Category); rx != ry {
				return rx < ry
			}
			hx, hy := strings.TrimSpace(x.CoverURL) != "", strings.TrimSpace(y.CoverURL) != ""
			if hx != hy {
				return hx
			}
			return x.ID < y.ID
		})
		for _, idx := range idxs[1:] {
			victims = append(victims, items[idx].ID)
		}
	}
	if len(victims) == 0 {
		return 0, nil
	}
	if len(items) > 0 && float64(len(victims))/float64(len(items)) > promptDedupeMaxRatio {
		return 0, errors.New("提示词去重命中比例异常偏高，已中止（疑似归一化逻辑出错）")
	}
	// 分批删，避免超长 IN 列表
	for start := 0; start < len(victims); start += 500 {
		end := start + 500
		if end > len(victims) {
			end = len(victims)
		}
		if err := db.Delete(&model.Prompt{}, "id IN ?", victims[start:end]).Error; err != nil {
			return 0, err
		}
	}
	return len(victims), nil
}

// ReplacePromptCategory 用远程同步结果替换整个提示词分类。
func ReplacePromptCategory(category model.PromptCategory, items []model.Prompt) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("category = ?", category.Category).Delete(&model.Prompt{}).Error; err != nil {
			return err
		}
		if len(items) == 0 {
			return nil
		}
		for i := range items {
			items[i].Category = category.Category
			items[i].GithubURL = ""
		}
		return tx.Create(&items).Error
	})
}

// applyPromptFilters 应用提示词列表的搜索条件。
func applyPromptFilters(tx *gorm.DB, q model.Query) *gorm.DB {
	if q.Keyword != "" {
		like := "%" + q.Keyword + "%"
		tx = tx.Where("title LIKE ? OR prompt LIKE ?", like, like)
	}
	if isActivePromptOption(q.Category) {
		tx = tx.Where("category = ?", q.Category)
	}
	return applyPromptTagsFilter(tx, q.Tags)
}

// findPrompt 根据 ID 查询提示词。
func findPrompt(db *gorm.DB, id string) (model.Prompt, bool, error) {
	item := model.Prompt{}
	err := db.Where("id = ?", id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Prompt{}, false, nil
	}
	return item, err == nil, err
}

// applyPromptTagsFilter 应用 JSON 标签条件。
func applyPromptTagsFilter(tx *gorm.DB, tags []string) *gorm.DB {
	if len(tags) == 0 {
		return tx
	}
	condition := tx.Session(&gorm.Session{NewDB: true})
	for _, tag := range tags {
		condition = condition.Or(promptJSONTagsContains(tx), tag)
	}
	return tx.Where(condition)
}

func promptTagsFromItems(items []model.Prompt) []string {
	seen := map[string]bool{}
	tags := []string{}
	for _, item := range items {
		for _, tag := range item.Tags {
			if tag != "" && !seen[tag] {
				seen[tag] = true
				tags = append(tags, tag)
			}
		}
	}
	return tags
}

// promptJSONTagsContains 返回提示词 tags 的 JSON 包含条件。
func promptJSONTagsContains(tx *gorm.DB) string {
	switch tx.Dialector.Name() {
	case "mysql":
		return "JSON_CONTAINS(tags, JSON_QUOTE(?))"
	case "postgres":
		return "jsonb_exists(tags::jsonb, ?)"
	default:
		return "EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)"
	}
}

// isActivePromptOption 判断提示词筛选项有效状态。
func isActivePromptOption(value string) bool {
	return value != "" && value != "全部" && value != "all"
}
