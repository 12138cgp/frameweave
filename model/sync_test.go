package model

import "testing"

// 同步域白名单的回归测试。
//
// 为什么值得单独测：域常量和白名单切片是**两处**，只加常量不加白名单，编译照样通过，
// 前端也照样能把数据推上来——只是会被 handler 的入参校验静默拒掉（返回业务错误），
// 表现为「这个域永远同步不上去」，而且不会有任何编译期或启动期的报错提醒你。
//
// handler 的 syncDomains、repository 的快照判定、用户诊断探针全都从 SyncDomains 派生，
// 所以这一条断言覆盖了整条链路的入口。
func TestAllSyncDomainConstantsAreWhitelisted(t *testing.T) {
	cases := []struct {
		name   string
		domain string
	}{
		{"canvas", SyncDomainCanvas},
		{"assets", SyncDomainAssets},
		{"image-workbench", SyncDomainImageWorkbench},
		{"video-workbench", SyncDomainVideoWorkbench},
		{"presets", SyncDomainPresets},
		{"shortcuts", SyncDomainShortcuts},
	}
	for _, item := range cases {
		if !IsSyncDomain(item.domain) {
			t.Fatalf("域 %s(%q) 定义了常量却不在 SyncDomains 白名单里——该域的同步会被 handler 静默拒掉", item.name, item.domain)
		}
	}
	if len(SyncDomains) != len(cases) {
		t.Fatalf("SyncDomains 有 %d 项，本测试覆盖 %d 项；新增域时请一并补进这里", len(SyncDomains), len(cases))
	}
}

func TestUnknownSyncDomainRejected(t *testing.T) {
	// 反向断言：确保 IsSyncDomain 不是恒真（否则上面那条测试没有意义）。
	if IsSyncDomain("shortcut") {
		t.Fatal("拼错的域名不该被放行")
	}
	if IsSyncDomain("") {
		t.Fatal("空域名不该被放行")
	}
}
