package service

import (
	"testing"

	"aicanvas/model"
	"aicanvas/repository"
)

// 「已送达」的定义：用户自己的数据里能找到这个成片，而不是「字节进了桶」。
//
// 这条锁的是一个很隐蔽的判据缺陷：把「upstream_logs.result_url 非空」当成「已送达」，
// 可 result_url 只证明 /media/persist 成功、字节进了桶，而转存发生在写回画布【之前】。
// 客户端在那之后挂掉，视频就永远停在桶里、用户一个都看不见——
// 而兜底扫描据此认定「已送达」转身就走，唯一能救他的机制自己关掉了。
// 典型表现是某个用户的成片全军覆没：桶里有、数据库有地址，画布和素材里一个都没有。
func TestVideoDeliveredRequiresPresenceInUserData(t *testing.T) {
	const uid = "u-deliver"
	const url = "https://tos-x.tos-cn-beijing.volces.com/media/u-deliver/video/abc123def456.mp4"

	// 云端画布为空 = 用户那边什么都没有
	if _, err := repository.SaveSyncData(uid, model.SyncDomainCanvas, `{"data":{"projects":[]}}`); err != nil {
		t.Fatalf("准备画布失败: %v", err)
	}
	if got, err := userDataContainsMediaURL(uid, url); err != nil || got {
		t.Fatalf("用户数据里没有这个成片，必须判为【未送达】才会触发救援；实得 found=%v err=%v", got, err)
	}

	// 成片出现在画布里 → 才算送达
	if _, err := repository.SaveSyncData(uid, model.SyncDomainCanvas,
		`{"data":{"projects":[{"nodes":[{"type":"video","metadata":{"content":"`+url+`"}}]}]}}`); err != nil {
		t.Fatalf("写入画布失败: %v", err)
	}
	if got, err := userDataContainsMediaURL(uid, url); err != nil || !got {
		t.Fatalf("成片已在画布里，应判为已送达；实得 found=%v err=%v", got, err)
	}
}

// 工作台生成的视频不进画布，那是正常用法——只查画布会把它们全误判成孤儿、反复重复救援。
func TestVideoDeliveredCountsWorkbench(t *testing.T) {
	const uid = "u-deliver-wb"
	const url = "https://tos-x.tos-cn-beijing.volces.com/media/u-deliver-wb/video/wb999888.mp4"

	if _, err := repository.SaveSyncData(uid, model.SyncDomainCanvas, `{"data":{"projects":[]}}`); err != nil {
		t.Fatalf("准备画布失败: %v", err)
	}
	if _, err := repository.SaveSyncData(uid, model.SyncDomainVideoWorkbench,
		`{"data":{"logs":[{"url":"`+url+`"}]}}`); err != nil {
		t.Fatalf("准备工作台失败: %v", err)
	}
	if got, err := userDataContainsMediaURL(uid, url); err != nil || !got {
		t.Fatalf("成片在视频生成里，同样算送达；实得 found=%v err=%v", got, err)
	}
}

// 带签名参数的地址要能匹配上：同一个对象在不同地方可能带不同 query，整串比对会漏。
func TestVideoDeliveredIgnoresQueryString(t *testing.T) {
	const uid = "u-deliver-q"
	const stored = "https://tos-x.tos-cn-beijing.volces.com/media/u-deliver-q/video/q777.mp4"

	if _, err := repository.SaveSyncData(uid, model.SyncDomainCanvas,
		`{"data":{"projects":[{"nodes":[{"metadata":{"content":"`+stored+`"}}]}]}}`); err != nil {
		t.Fatalf("准备画布失败: %v", err)
	}
	if got, err := userDataContainsMediaURL(uid, stored+"?X-Amz-Signature=deadbeef&X-Amz-Expires=3600"); err != nil || !got {
		t.Fatalf("同一对象只是带了签名参数，应判为已送达；实得 found=%v err=%v", got, err)
	}
}
