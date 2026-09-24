package service

import (
	"log"
	"regexp"
	"strings"

	"aicanvas/model"
	"aicanvas/repository"
)

// 人像资产「换密钥即失效」的前置守卫。
//
// 背景：火山的人像资产是绑【创建它的那个账号/项目】的。分组一旦换了 volc AK/SK 或
// volc_asset_project，旧账号下建的资产在新账号里就是"不存在"——但库里那条记录
// 还写着 status=active，后台和画布上都看不出任何异常，直到生成时才被上游顶回来。
//
// 而上游的报错极难定位：
//     "无效参数参数内容[3].请求中指定的 image_url.url 无效:未找到指定的资产 asset-2026..."
// 用户开着浏览器翻译时，连 asset ID 都会被一起翻掉（asset- → 资产-），
// 更不可能想到是"管理员换了密钥"。
//
// 实际很容易反复踩到：分组的资产项目名在两个值之间来回切几趟，
// 每切一次，上一批刚重认证好的资产就全部作废。
//
// 这个守卫放在【扣费之前】调用：命中就直接报错，不是"扣了再退"，而是压根不扣。
//
// 设计原则：**守卫自己绝不能成为故障源**。查不到、配置缺失、库出错——一律放行，
// 让请求照常发出去（大不了退回到原来的行为），绝不因为守卫本身把正常请求挡掉。

// portraitAssetRefRe 匹配请求体里的人像资产引用。
// 火山的 asset id 形如 asset-20260810164850-mqxvm（asset- + 14 位时间戳 + - + 随机串）。
// 同时覆盖 asset://asset-xxx 和裸 asset-xxx 两种写法。
var portraitAssetRefRe = regexp.MustCompile(`asset-\d{14}-[A-Za-z0-9_-]+`)

// CheckPortraitAssetsFresh 校验请求体里引用的人像资产是否仍属于当前分组的火山项目。
// 返回非 nil 时调用方应直接拒绝该请求（且不要扣费）。
func CheckPortraitAssetsFresh(userID string, body []byte) error {
	if len(body) == 0 {
		return nil
	}
	// 先做一次极便宜的判断：绝大多数请求根本不带人像资产，直接放行。
	if !strings.Contains(string(body), "asset-") {
		return nil
	}
	matches := portraitAssetRefRe.FindAllString(string(body), -1)
	if len(matches) == 0 {
		return nil
	}
	// 去重，保持出现顺序（报错时按用户看到的顺序列出更好懂）。
	seen := map[string]bool{}
	ids := make([]string, 0, len(matches))
	for _, m := range matches {
		if seen[m] {
			continue
		}
		seen[m] = true
		ids = append(ids, m)
	}

	cfg, err := loadVolcAssetConfigForUser(userID)
	if err != nil {
		// 分组没配火山密钥之类：不是这个守卫该管的事，放行给后面的逻辑报它自己的错。
		return nil
	}
	current := strings.TrimSpace(cfg.ProjectName)
	if current == "" {
		return nil
	}

	records, err := repository.ListPortraitAssetsByAssetIDs(userID, ids)
	if err != nil {
		log.Printf("人像资产守卫：查库失败，放行 user=%s err=%v", userID, err)
		return nil
	}
	byAssetID := make(map[string]model.PortraitAsset, len(records))
	for _, r := range records {
		byAssetID[r.AssetID] = r
	}

	stale := make([]string, 0, 2)
	for _, id := range ids {
		record, ok := byAssetID[id]
		if !ok {
			// 库里没有这条记录：可能是别处建的、或历史数据，无从判断，放行。
			continue
		}
		if strings.TrimSpace(record.ProjectName) == "" {
			continue // 早期数据没记项目名，判断不了
		}
		if strings.TrimSpace(record.ProjectName) != current {
			name := strings.TrimSpace(record.Title)
			if name == "" {
				name = id
			}
			stale = append(stale, name)
		}
	}
	if len(stale) == 0 {
		return nil
	}

	list := strings.Join(stale, "、")
	if len(stale) > 6 {
		list = strings.Join(stale[:6], "、") + " 等 " + itoa(len(stale)) + " 张"
	}
	return safeMessageError{message: "以下参考图的肖像授权已失效（所属分组的火山密钥/项目被更换过，" +
		"旧账号下认证的资产在新账号里不存在）：" + list +
		"。请对这些图重新做一次肖像授权后再生成——画布上选中它们用「一键肖像授权」可以批量重做。" +
		"本次未扣除点数。"}
}

// itoa 避免为一个数字引入 strconv（本文件其余部分不需要它）。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}
