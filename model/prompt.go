package model

// Prompt 提示词记录。
type Prompt struct {
	ID        string   `json:"id" gorm:"primaryKey"`
	Title     string   `json:"title"`
	CoverURL  string   `json:"coverUrl"`
	Prompt    string   `json:"prompt"`
	Tags      []string `json:"tags" gorm:"serializer:json"`
	Category  string   `json:"category" gorm:"index"`
	GithubURL string   `json:"githubUrl" gorm:"-"`
	Preview   string   `json:"preview"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
}

// PromptCategoryOption 是筛选栏用的分类选项：category 给接口用，name/description 给用户看。
// 早先只回 []string 的分类编码，用户端筛选栏于是显示成 freestylefly-gpt-image-2 这种原始 slug。
type PromptCategoryOption struct {
	Category    string `json:"category"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Count       int    `json:"count"`
}

// PromptList 提示词分页结果。
type PromptList struct {
	Items      []Prompt               `json:"items"`
	Tags       []string               `json:"tags"`
	Categories []string               `json:"categories"`
	Options    []PromptCategoryOption `json:"categoryOptions"`
	Total      int                    `json:"total"`
}

// PromptCategory 提示词分类。
type PromptCategory struct {
	Category    string `json:"category" gorm:"primaryKey"`
	Name        string `json:"name"`
	Description string `json:"description"`
	GithubURL   string `json:"githubUrl"`
	Remote      bool   `json:"remote"`
	UpdatedAt   string `json:"updatedAt"`
}
