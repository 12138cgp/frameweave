package service

import (
	"fmt"
	"strings"

	"aicanvas/config"
	"aicanvas/repository"
	"github.com/volcengine/volcengine-go-sdk/volcengine"
	"github.com/volcengine/volcengine-go-sdk/volcengine/credentials"
	"github.com/volcengine/volcengine-go-sdk/volcengine/session"
	"github.com/volcengine/volcengine-go-sdk/volcengine/universal"
)

// 火山方舟「私域人像素材资产库」Assets API 封装。
// 鉴权使用火山引擎 IAM 的 AK/SK（universal client，ServiceName=ark, Version=2024-01-01）。
const (
	volcAssetServiceName = "ark"
	volcAssetVersion     = "2024-01-01"
	volcAssetGroupType   = "AIGC"
)

type volcAssetConfig struct {
	AccessKey   string
	SecretKey   string
	Region      string
	ProjectName string
	GroupName   string
}

type volcAssetInfo struct {
	Status  string
	URL     string
	GroupID string
}

// loadVolcAssetConfigForUser 按用户分组读取火山资产库凭证：
// 未分组或分组未配置密钥的用户直接拒绝；Region/素材组名沿用全局配置。
func loadVolcAssetConfigForUser(userID string) (volcAssetConfig, error) {
	user, ok, err := repository.GetUserByID(userID)
	if err != nil {
		return volcAssetConfig{}, err
	}
	if !ok || strings.TrimSpace(user.GroupID) == "" {
		return volcAssetConfig{}, safeMessageError{message: "你还没有被分配到分组，无法使用人像资产能力，请联系管理员"}
	}
	group, ok, err := repository.GetGroupByID(user.GroupID)
	if err != nil {
		return volcAssetConfig{}, err
	}
	if !ok {
		return volcAssetConfig{}, safeMessageError{message: "所属分组不存在，请联系管理员重新分配"}
	}
	if strings.TrimSpace(group.VolcAccessKey) == "" || strings.TrimSpace(group.VolcSecretKey) == "" {
		return volcAssetConfig{}, safeMessageError{message: "所属分组未配置火山方舟密钥，请联系管理员"}
	}
	cfg, err := loadVolcAssetConfig()
	if err != nil {
		// 全局未配置不影响分组使用：仅借用全局的 Region/素材组名默认值
		cfg.Region = strings.TrimSpace(cfg.Region)
	}
	cfg.AccessKey = strings.TrimSpace(group.VolcAccessKey)
	cfg.SecretKey = strings.TrimSpace(group.VolcSecretKey)
	if project := strings.TrimSpace(group.VolcAssetProject); project != "" {
		cfg.ProjectName = project
	}
	// Region/素材组名按组配置优先，留空回退全局/默认值
	if region := strings.TrimSpace(group.VolcRegion); region != "" {
		cfg.Region = region
	}
	if groupName := strings.TrimSpace(group.VolcGroupName); groupName != "" {
		cfg.GroupName = groupName
	}
	if cfg.Region == "" {
		cfg.Region = "cn-beijing"
	}
	if cfg.ProjectName == "" {
		cfg.ProjectName = "default"
	}
	if cfg.GroupName == "" {
		cfg.GroupName = "aicanvas-portraits"
	}
	return cfg, nil
}

// loadVolcAssetConfig 读取火山资产库配置：后台「私有配置」优先，未填项回退 .env。
func loadVolcAssetConfig() (volcAssetConfig, error) {
	cfg := volcAssetConfig{
		AccessKey:   strings.TrimSpace(config.Cfg.VolcAccessKey),
		SecretKey:   strings.TrimSpace(config.Cfg.VolcSecretKey),
		Region:      strings.TrimSpace(config.Cfg.VolcAssetRegion),
		ProjectName: strings.TrimSpace(config.Cfg.VolcAssetProject),
		GroupName:   strings.TrimSpace(config.Cfg.VolcAssetGroupName),
	}
	if settings, err := repository.GetSettings(); err == nil {
		p := settings.Private.PortraitAsset
		if v := strings.TrimSpace(p.AccessKey); v != "" {
			cfg.AccessKey = v
		}
		if v := strings.TrimSpace(p.SecretKey); v != "" {
			cfg.SecretKey = v
		}
		if v := strings.TrimSpace(p.ProjectName); v != "" {
			cfg.ProjectName = v
		}
		if v := strings.TrimSpace(p.Region); v != "" {
			cfg.Region = v
		}
		if v := strings.TrimSpace(p.GroupName); v != "" {
			cfg.GroupName = v
		}
	}
	if cfg.Region == "" {
		cfg.Region = "cn-beijing"
	}
	if cfg.ProjectName == "" {
		cfg.ProjectName = "default"
	}
	if cfg.GroupName == "" {
		cfg.GroupName = "aicanvas-portraits"
	}
	if cfg.AccessKey == "" || cfg.SecretKey == "" {
		return cfg, safeMessageError{message: "未配置火山资产库密钥，请在服务端设置 VOLC_ACCESS_KEY 和 VOLC_SECRET_KEY"}
	}
	return cfg, nil
}

// volcAssetConfigured 返回火山资产库是否已配置可用：
// 全局私有配置可用，或任意一个分组配置了方舟凭证（v0.3.0 起凭证按分组管理）。
func volcAssetConfigured() bool {
	if _, err := loadVolcAssetConfig(); err == nil {
		return true
	}
	groups, err := repository.ListGroups()
	if err != nil {
		return false
	}
	for _, group := range groups {
		if strings.TrimSpace(group.VolcAccessKey) != "" && strings.TrimSpace(group.VolcSecretKey) != "" {
			return true
		}
	}
	return false
}

func volcAssetCall(cfg volcAssetConfig, action string, body map[string]any) (map[string]any, error) {
	vcfg := volcengine.NewConfig().
		WithCredentials(credentials.NewStaticCredentials(cfg.AccessKey, cfg.SecretKey, "")).
		WithRegion(cfg.Region)
	sess, err := session.NewSession(vcfg)
	if err != nil {
		return nil, volcAssetError(action, err)
	}
	resp, err := universal.New(sess).DoCall(
		universal.RequestUniversal{
			ServiceName: volcAssetServiceName,
			Action:      action,
			Version:     volcAssetVersion,
			HttpMethod:  universal.POST,
			ContentType: universal.ApplicationJSON,
		},
		&body,
	)
	if err != nil {
		return nil, volcAssetError(action, err)
	}
	if resp == nil {
		return nil, safeMessageError{message: fmt.Sprintf("火山资产库 %s 无响应", action)}
	}
	return *resp, nil
}

// ensureVolcAssetGroup 查找或创建用于存放人设图的素材组，返回 GroupId。
func ensureVolcAssetGroup(cfg volcAssetConfig) (string, error) {
	if resp, err := volcAssetCall(cfg, "ListAssetGroups", map[string]any{
		"Filter": map[string]any{
			"Name":      cfg.GroupName,
			"GroupType": volcAssetGroupType,
		},
		"PageNumber":  1,
		"PageSize":    50,
		"ProjectName": cfg.ProjectName,
	}); err == nil {
		if id := firstMatchingGroupID(resp, cfg.GroupName); id != "" {
			return id, nil
		}
	}
	created, err := volcAssetCall(cfg, "CreateAssetGroup", map[string]any{
		"Name":        cfg.GroupName,
		"Description": "aicanvas portrait assets",
		"GroupType":   volcAssetGroupType,
		"ProjectName": cfg.ProjectName,
	})
	if err != nil {
		return "", err
	}
	id := volcString(volcResult(created), "Id")
	if id == "" {
		return "", safeMessageError{message: "创建火山素材组失败：未返回 GroupId（首次需在火山方舟控制台签署授权函）"}
	}
	return id, nil
}

// volcAssetNameLimit 火山素材名上限：超出即 400 InvalidParameter.Name「Name must be no more than 64 characters」。
// 实测按【字符(rune)】而非字节计（库里有 64 字符/128 字节的中文名成功入库）。留 4 个余量防边界。
const volcAssetNameLimit = 60

// normalizeVolcAssetName 归一化素材名：压掉换行/多余空白、按字符截断、空名兜底。
//
// 名字来自节点名或提示词，中文长句极易超过 64 字符——用户点「肖像授权」就会收到一句看不懂的
// 英文 400 报错，且资产根本没建成。这里统一收口，所有 CreateAsset 调用点都受保护。
func normalizeVolcAssetName(raw string) string {
	name := strings.Join(strings.Fields(strings.TrimSpace(raw)), " ") // 换行/制表压成单空格
	if name == "" {
		return "portrait" // 火山要求 Name 非空
	}
	if runes := []rune(name); len(runes) > volcAssetNameLimit {
		return string(runes[:volcAssetNameLimit])
	}
	return name
}

// createVolcAsset 把素材公网 URL 提交到指定素材组入库（异步），返回 AssetId。
// assetType 为火山要求的字面量 Image / Video / Audio（由 model.PortraitAssetKind.VolcAssetType() 给出）。
func createVolcAsset(cfg volcAssetConfig, groupID string, mediaURL string, name string, assetType string) (string, error) {
	if strings.TrimSpace(assetType) == "" {
		assetType = "Image"
	}
	resp, err := volcAssetCall(cfg, "CreateAsset", map[string]any{
		"GroupId":     groupID,
		"URL":         mediaURL,
		"AssetType":   assetType,
		"Name":        normalizeVolcAssetName(name),
		"ProjectName": cfg.ProjectName,
	})
	if err != nil {
		return "", err
	}
	id := volcString(volcResult(resp), "Id")
	if id == "" {
		return "", safeMessageError{message: "上传火山素材失败：未返回 AssetId"}
	}
	return id, nil
}

// listVolcAssets 列出指定项目下的素材（用于核对火山侧实际入库情况）。
func listVolcAssets(cfg volcAssetConfig) ([]map[string]any, error) {
	resp, err := volcAssetCall(cfg, "ListAssets", map[string]any{
		"Filter": map[string]any{
			"GroupType": volcAssetGroupType,
			"Statuses":  []string{"Active", "Processing", "Failed"},
		},
		"PageNumber":  1,
		"PageSize":    50,
		"ProjectName": cfg.ProjectName,
	})
	if err != nil {
		return nil, err
	}
	rawItems, _ := volcResult(resp)["Items"].([]any)
	items := make([]map[string]any, 0, len(rawItems))
	for _, raw := range rawItems {
		if entry, ok := raw.(map[string]any); ok {
			items = append(items, entry)
		}
	}
	return items, nil
}

// getVolcAsset 查询素材当前状态（Processing/Active/Failed）。
func getVolcAsset(cfg volcAssetConfig, assetID string) (volcAssetInfo, error) {
	resp, err := volcAssetCall(cfg, "GetAsset", map[string]any{
		"Id":          assetID,
		"ProjectName": cfg.ProjectName,
	})
	if err != nil {
		return volcAssetInfo{}, err
	}
	result := volcResult(resp)
	return volcAssetInfo{
		Status:  volcString(result, "Status"),
		URL:     volcString(result, "URL"),
		GroupID: volcString(result, "GroupId"),
	}, nil
}

// volcResult 兼容火山响应可能带 Result 包裹的两种结构。
func volcResult(resp map[string]any) map[string]any {
	if result, ok := resp["Result"].(map[string]any); ok {
		return result
	}
	return resp
}

func volcString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func firstMatchingGroupID(resp map[string]any, name string) string {
	items, _ := volcResult(resp)["Items"].([]any)
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if volcString(entry, "Name") == name {
			return volcString(entry, "Id")
		}
	}
	return ""
}

// volcAssetHint 把火山素材入库的常见 400 翻译成能直接照做的中文。
//
// 原始报错是英文错误码 + 英文说明（如 InvalidParameter.AspectRatioTooLarge:
// Aspect ratio must be between 0.4 and 2.5），用户看不出该怎么改。这里给出具体规格与动作建议。
// 匹配不到就返回空串，由调用方沿用原始信息（宁可原样透出，也不要猜错方向误导人）。
func volcAssetHint(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "aspectratiotoolarge"), strings.Contains(lower, "aspect ratio"):
		return "图片宽高比超出火山要求的 0.4~2.5（三视图/长条人设图最容易踩到，如 6057×2265 = 2.67）。请裁成单人图或补白边后再认证。"
	case strings.Contains(lower, "invalidparameter.name"), strings.Contains(lower, "no more than 64"):
		return "素材名超过 64 个字符（名字取自节点名或提示词，中文长句极易超限）。请把节点改成短名后重试。"
	case strings.Contains(lower, "resolution"), strings.Contains(lower, "too small"), strings.Contains(lower, "too large"):
		return "图片边长超出火山要求的 300~6000 像素。请调整尺寸后重试。"
	case strings.Contains(lower, "size"), strings.Contains(lower, "exceed"):
		return "素材体积超出火山上限（图片 30MB、视频 200MB、音频 15MB）。请压缩后重试。"
	case strings.Contains(lower, "format"), strings.Contains(lower, "unsupported"):
		return "素材格式不受支持（图片 jpeg/png/webp/bmp/tiff/gif/heic/heif、视频 mp4/mov、音频 wav/mp3）。"
	case strings.Contains(lower, "forbidden"), strings.Contains(lower, "ram"), strings.Contains(lower, "permission"):
		return "火山账号权限不足或未签署授权函，请在火山方舟控制台确认后重试。"
	}
	return ""
}

func volcAssetError(action string, err error) error {
	message := strings.Join(strings.Fields(strings.TrimSpace(err.Error())), " ")
	if message == "" {
		message = "请求失败"
	}
	if runes := []rune(message); len(runes) > 300 {
		message = string(runes[:300]) + "..."
	}
	// 有对得上的规格提示就放在最前面——用户先看到「该怎么改」，原始英文留在后面供排查。
	if hint := volcAssetHint(message); hint != "" {
		return safeMessageError{message: fmt.Sprintf("%s（原始错误：火山资产库 %s 调用失败：%s）", hint, action, message)}
	}
	return safeMessageError{message: fmt.Sprintf("火山资产库 %s 调用失败：%s", action, message)}
}
