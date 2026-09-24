package service

import (
	"strings"

	"aicanvas/repository"
)

// volcAssetURIPrefix 火山方舟资产库的专有引用协议前缀。
// 素材做过「素材授权」后，前端会把节点地址从公网 URL 换成 asset://<AssetID>
// （真人素材必须以它引用，否则会被火山的内容审核以 PrivacyInformation 顶回来）。
const volcAssetURIPrefix = "asset://"

// ResolveVolcAssetSourceURL 把 asset://<AssetID> 翻回「认证时登记的那个公网地址」。
//
// 用在哪：handler/ai.go 给【视频编辑】探源视频时长之前。ffprobe 只认 http/https，
// 不翻这一手，结果就是「认证过的视频不能做编辑」—— 一个功能被悄悄砍掉，
// 而用户看到的只是一句「无法读取待编辑视频的时长」，完全对不上他眼前那个好好的视频节点。
//
// ⚠️ 已知边界：只按【本人】查。repository.ListPortraitAssetsByAssetIDs 是本层现有的唯一一个
// 按 AssetID 的查询，它本身就带 user_id 条件。于是「素材是别人认证的、经团队素材 / 分享画布
// 传到我这儿」这一种 asset:// 翻不出来，用户会得到一句「无法读取待编辑视频的时长」。
// 要补的话是在 repository 加一个不限归属的 ListPortraitAssetsByAssetIDsAny（照着上面那个写，
// 去掉 user_id 条件即可），在本函数里作为查不到时的第二跳；本次没加是为了不扩大改动面。
// 注意那不构成越权读：AssetID 是请求方自己在请求体里带上来的，查出的地址也只交给 ffprobe，
// 任何情况下都不会回显给用户（探测失败的文案是固定的，不拼上游原文）。
//
// 翻不出来一律返回空串（不是 asset:// 协议、库里查无此条、登记的地址不是公网地址），
// 由调用方决定怎么办。**绝不返回一个猜出来的地址**：探错了片子就等于按错误的时长扣钱。
func ResolveVolcAssetSourceURL(userID string, raw string) string {
	value := strings.TrimSpace(raw)
	if !strings.HasPrefix(value, volcAssetURIPrefix) {
		return ""
	}
	assetID := strings.TrimSpace(strings.TrimPrefix(value, volcAssetURIPrefix))
	if assetID == "" {
		return ""
	}
	items, err := repository.ListPortraitAssetsByAssetIDs(userID, []string{assetID})
	if err != nil {
		return ""
	}
	for _, item := range items {
		if item.AssetID != assetID {
			continue
		}
		// 必须是公网可达地址才有意义：ffprobe 要自己去 GET 它，
		// 内网地址/相对路径拿到手也是白探一次。
		if source := strings.TrimSpace(item.SourceURL); IsPublicHTTPURL(source) {
			return source
		}
	}
	return ""
}
