package service

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"syscall"
	"time"
)

// 出站 HTTP 安全工具：
//   - SafeHTTPClient：下载「用户/上游给的任意 URL」时用，禁连内网、限重定向、带超时，防 SSRF。
//   - UpstreamHTTPClient：调 AI 上游用，Transport 级超时（连接/TLS/响应头），不设总超时以兼容流式与长生成。

// isBlockedIP 拦截内网/本地/链路本地（含云元数据 169.254.169.254）等非公网地址。
func isBlockedIP(ip net.IP) bool {
	return ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

// safeDialControl 在 DNS 解析后、建连前校验真实目标 IP；内网地址直接拒。
// 因为校验的是实际拨号 IP，且每次重定向都会再次经过，可防 DNS rebinding 与重定向绕过。
func safeDialControl(_ string, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if isBlockedIP(net.ParseIP(host)) {
		return fmt.Errorf("拒绝访问内网/本地地址: %s", host)
	}
	return nil
}

// SafeHTTPClient 用于下载外部任意 URL（媒体转存等），带 SSRF 防护。
func SafeHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second, Control: safeDialControl}
	return &http.Client{
		Timeout:   timeout,
		Transport: &http.Transport{DialContext: dialer.DialContext, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 60 * time.Second},
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("重定向次数过多")
			}
			return nil // 重定向目标会再次经过 safeDialControl 校验
		},
	}
}

// UpstreamHTTPClient 调用 AI 上游用：只在 Transport 层设超时，避免总超时砍断流式响应或长时生成。
var UpstreamHTTPClient = &http.Client{
	Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 300 * time.Second, // 某些中转上游出图慢/过载,常 180s 才回响应头,放宽到 300s 减少超时失败
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	},
}

// IsPublicHTTPURL 轻量校验：必须 http/https（深度内网防护由 SafeHTTPClient 的拨号控制完成）。
func IsPublicHTTPURL(raw string) bool {
	raw = strings.TrimSpace(raw)
	return strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://")
}
