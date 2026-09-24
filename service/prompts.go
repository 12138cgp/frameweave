package service

import (
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
)

func ListPrompts(q model.Query) (model.PromptList, error) {
	items, total, err := repository.ListPrompts(q)
	if err != nil {
		return model.PromptList{}, err
	}
	tags, err := repository.ListPromptTags(q)
	if err != nil {
		return model.PromptList{}, err
	}
	all := ListPromptCategories()
	options := buildPromptCategoryOptions(all)
	// Categories 保留原样（老客户端仍在读它），新客户端读 Options。
	return model.PromptList{Items: items, Tags: tags, Categories: promptCategoryCodes(all), Options: options, Total: int(total)}, nil
}

// buildPromptCategoryOptions 只保留【库里真有条目】的分类，并带上中文名与说明。
// 计数失败时降级成「全部保留、计数为 0」，绝不让筛选栏因为一次统计出错而整个空掉。
func buildPromptCategoryOptions(categories []model.PromptCategory) []model.PromptCategoryOption {
	counts, err := repository.CountPromptsByCategory()
	options := []model.PromptCategoryOption{}
	for _, item := range categories {
		count := 0
		if counts != nil {
			count = counts[item.Category]
		}
		if err == nil && count == 0 {
			continue
		}
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = item.Category
		}
		options = append(options, model.PromptCategoryOption{Category: item.Category, Name: name, Description: item.Description, Count: count})
	}
	return options
}

func ListPromptCategories() []model.PromptCategory {
	categories, _ := repository.ListPromptCategories()
	return categories
}

func SavePrompt(item model.Prompt) (model.Prompt, error) {
	now := time.Now().Format(time.RFC3339)
	if item.Category == "" {
		item.Category = repository.PromptCategories()[0].Category
	}
	if item.ID == "" {
		item.ID = newID(item.Category)
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	category, ok := repository.PromptCategoryByCode(item.Category)
	if !ok {
		category = repository.PromptCategories()[0]
		item.Category = category.Category
	}
	item.GithubURL = ""
	return repository.SavePrompt(item)
}

func DeletePrompt(id string) error {
	return repository.DeletePrompt(id)
}

func DeletePrompts(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	return repository.DeletePrompts(ids)
}

func promptCategoryCodes(items []model.PromptCategory) []string {
	codes := []string{}
	for _, item := range items {
		if item.Category != "" {
			codes = append(codes, item.Category)
		}
	}
	return codes
}
