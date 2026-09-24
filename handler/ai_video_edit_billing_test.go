package handler

import (
	"errors"
	"strings"
	"testing"

	"aicanvas/service"
)

// 视频编辑(omni_reference_task_type=="edit")的计费秒数。
//
// 为什么必须有这一组断言：上游【硬性要求】视频编辑传 duration:-1，而我们的按秒计费对 -1 一律
// 钳成 0 → service 那边再把 0 换成 VideoBillingSmartDurationSeconds(15) ——
// 结果是「不管出 4 秒还是 30 秒的片，一律按 15 秒收钱」，而且全程没有任何报错或日志。
// 这类错法靠人眼 review 盯不住（代码每一行单看都正常），只能用断言钉死。
//
// ⚠️ 这里换掉 probeVideoForBilling 是为了不在单测里起 ffprobe 子进程去拉远端文件。

// withProbe 临时替换探测实现，测完还原。
func withProbe(t *testing.T, fn func(string) (service.ProbeVideoResult, error)) {
	t.Helper()
	original := probeVideoForBilling
	probeVideoForBilling = fn
	t.Cleanup(func() { probeVideoForBilling = original })
}

// videoEditBody 官方「视频编辑」请求示例的形状：顶层 omni_reference_task_type + duration:-1 +
// content[] 里 role=reference_video 的那一段就是待编辑视频。
func videoEditBody(videoURL string) []byte {
	return []byte(`{
		"model": "doubao-seedance-2-5-260628",
		"content": [
			{"type": "text", "text": "视频编辑：删除 @视频1中的所有人，除了主角。"},
			{"type": "video_url", "video_url": {"url": "` + videoURL + `"}, "role": "reference_video"}
		],
		"generate_audio": true,
		"ratio": "adaptive",
		"duration": -1,
		"resolution": "1080p",
		"omni_reference_task_type": "edit",
		"output_format": "mov"
	}`)
}

// ① 探测成功：按【源视频真实时长】扣，不是按 15 秒。
func TestVideoEditBillingUsesProbedDuration(t *testing.T) {
	withProbe(t, func(url string) (service.ProbeVideoResult, error) {
		if url != "https://example.com/a.mp4" {
			t.Fatalf("探测地址错了: %q", url)
		}
		return service.ProbeVideoResult{Width: 1920, Height: 1080, DurationMs: 12000, VideoCodec: "h264"}, nil
	})
	seconds, resolution, hasInput, err := readAIVideoBilling("u1", videoEditBody("https://example.com/a.mp4"), "application/json")
	if err != nil {
		t.Fatalf("不该报错: %v", err)
	}
	if seconds != 12 {
		t.Fatalf("应按源视频 12 秒计费，得到 %d（15 = 又退回默认值了）", seconds)
	}
	// 🔴 resolution 必须原样带出去：空值或 "adaptive" 会让计费静默落回 720p 档 = 按 720p 收 1080p 的钱。
	if resolution != "1080p" {
		t.Fatalf("resolution 被动过了: %q", resolution)
	}
	if !hasInput {
		t.Fatal("视频编辑必然带视频输入，应走「带视频输入」单价")
	}
}

// 不足 1 秒进位：向上取整到整秒。
func TestVideoEditBillingRoundsUp(t *testing.T) {
	withProbe(t, func(string) (service.ProbeVideoResult, error) {
		return service.ProbeVideoResult{DurationMs: 12340, VideoCodec: "h264"}, nil
	})
	seconds, _, _, err := readAIVideoBilling("u1", videoEditBody("https://example.com/a.mp4"), "application/json")
	if err != nil {
		t.Fatalf("不该报错: %v", err)
	}
	if seconds != 13 {
		t.Fatalf("12.34 秒应向上取整成 13，得到 %d", seconds)
	}
}

// ② 探测失败：必须报错拒绝提交，**绝不能回落到 15 秒默认值**（那是凭空收钱）。
func TestVideoEditBillingRefusesWhenProbeFails(t *testing.T) {
	withProbe(t, func(string) (service.ProbeVideoResult, error) {
		return service.ProbeVideoResult{}, errors.New("ffprobe: 404 Not Found https://bucket.internal/a.mp4")
	})
	seconds, _, _, err := readAIVideoBilling("u1", videoEditBody("https://example.com/a.mp4"), "application/json")
	if err == nil {
		t.Fatalf("探不到时长必须报错，却返回了 %d 秒", seconds)
	}
	if seconds == service.VideoBillingSmartDurationSeconds {
		t.Fatal("🔴 回落到了 15 秒默认值 —— 这正是本次要根治的凭空收钱")
	}
	if !strings.Contains(err.Error(), "无法读取待编辑视频的时长") {
		t.Fatalf("错误文案要让用户看得懂: %q", err.Error())
	}
	// 上游报错原文里带我们的桶地址，不能透给用户。
	if strings.Contains(err.Error(), "bucket.internal") {
		t.Fatalf("泄漏了上游/内部地址: %q", err.Error())
	}
}

// 探到了视频但读不出时长（无 format.duration 的流式容器）：同样拒绝，不猜。
func TestVideoEditBillingRefusesWhenDurationUnknown(t *testing.T) {
	withProbe(t, func(string) (service.ProbeVideoResult, error) {
		return service.ProbeVideoResult{Width: 1920, Height: 1080, DurationMs: 0, VideoCodec: "h264"}, nil
	})
	if _, _, _, err := readAIVideoBilling("u1", videoEditBody("https://example.com/a.mp4"), "application/json"); err == nil {
		t.Fatal("读不出时长必须报错")
	}
}

// ③ 源视频时长越界（文档硬约束 4~30 秒）：前置报错，并把实际时长告诉用户。
func TestVideoEditBillingRejectsOutOfRangeDuration(t *testing.T) {
	cases := []struct {
		name       string
		durationMs int
		want       string
	}{
		{"太短", 2500, "2.5"},
		{"太长", 45000, "45.0"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withProbe(t, func(string) (service.ProbeVideoResult, error) {
				return service.ProbeVideoResult{DurationMs: c.durationMs, VideoCodec: "h264"}, nil
			})
			_, _, _, err := readAIVideoBilling("u1", videoEditBody("https://example.com/a.mp4"), "application/json")
			if err == nil {
				t.Fatal("越界必须前置报错，而不是等上游异步失败")
			}
			if !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "4~30") {
				t.Fatalf("要告诉用户实际时长和允许区间: %q", err.Error())
			}
		})
	}
}

// 边界：刚好 4 秒、刚好 30 秒要放行；30.016 这种容器时间基带来的浮点溢出按 30 秒收，不进位到 31。
func TestVideoEditBillingBoundaries(t *testing.T) {
	cases := map[int]int{4000: 4, 30000: 30, 30016: 30}
	for durationMs, want := range cases {
		withProbe(t, func(string) (service.ProbeVideoResult, error) {
			return service.ProbeVideoResult{DurationMs: durationMs, VideoCodec: "h264"}, nil
		})
		seconds, _, _, err := readAIVideoBilling("u1", videoEditBody("https://example.com/a.mp4"), "application/json")
		if err != nil {
			t.Fatalf("%dms 应放行: %v", durationMs, err)
		}
		if seconds != want {
			t.Fatalf("%dms 应计 %d 秒，得到 %d", durationMs, want, seconds)
		}
	}
}

// 标了 edit 却没接视频：前置报错，不去扣钱也不发给上游。
func TestVideoEditBillingRequiresSourceVideo(t *testing.T) {
	withProbe(t, func(string) (service.ProbeVideoResult, error) {
		t.Fatal("没有视频就不该去探测")
		return service.ProbeVideoResult{}, nil
	})
	body := []byte(`{"content":[{"type":"text","text":"编辑视频：删除路人"}],"duration":-1,"omni_reference_task_type":"edit"}`)
	if _, _, _, err := readAIVideoBilling("u1", body, "application/json"); err == nil {
		t.Fatal("标了 edit 却没有待编辑视频，必须报错")
	}
}

// 老客户端不带 role 时，退回第一个 video_url —— 那种请求里本来也只有一段视频。
func TestVideoEditBillingFallsBackToFirstVideoURL(t *testing.T) {
	withProbe(t, func(url string) (service.ProbeVideoResult, error) {
		if url != "https://example.com/legacy.mp4" {
			t.Fatalf("探测地址错了: %q", url)
		}
		return service.ProbeVideoResult{DurationMs: 8000, VideoCodec: "h264"}, nil
	})
	body := []byte(`{"content":[{"type":"video_url","video_url":{"url":"https://example.com/legacy.mp4"}}],
		"ratio":"adaptive","duration":-1,"resolution":"720p","omni_reference_task_type":"edit"}`)
	seconds, _, _, err := readAIVideoBilling("u1", body, "application/json")
	if err != nil || seconds != 8 {
		t.Fatalf("got(%d) err=%v want 8", seconds, err)
	}
}

// 🔴 隔离性：edit 以外的所有路径一行行为都不许变，尤其不许因此去做探测。
func TestVideoBillingUntouchedForNonEditModes(t *testing.T) {
	withProbe(t, func(string) (service.ProbeVideoResult, error) {
		t.Fatal("非 edit 路径不该触发探测：多一次网络往返就是多一个失败点")
		return service.ProbeVideoResult{}, nil
	})
	// 视频延长：传的是【真实秒数】(duration:11)，走原路即可，不需要任何特殊处理。
	extend := []byte(`{"content":[{"type":"video_url","video_url":{"url":"https://example.com/a.mp4"},"role":"reference_video"}],
		"ratio":"adaptive","duration":11,"resolution":"720p","omni_reference_task_type":"extend"}`)
	seconds, resolution, hasInput, err := readAIVideoBilling("u1", extend, "application/json")
	if err != nil || seconds != 11 || resolution != "720p" || !hasInput {
		t.Fatalf("延长: got(%d,%q,%v) err=%v want(11,\"720p\",true)", seconds, resolution, hasInput, err)
	}
	// 参考生视频：ratio/duration 无特殊限制（官方示例 16:9 + 15 秒）。
	reference := []byte(`{"content":[{"type":"image_url","image_url":{"url":"https://example.com/a.png"},"role":"reference_image"}],
		"ratio":"16:9","duration":15,"resolution":"1080p","omni_reference_task_type":"reference"}`)
	if seconds, _, hasInput, err := readAIVideoBilling("u1", reference, "application/json"); err != nil || seconds != 15 || hasInput {
		t.Fatalf("参考生视频: got(%d,%v) err=%v want(15,false)", seconds, hasInput, err)
	}
	// 图生视频 / 首尾帧：不发 omni 字段，ratio 必须 adaptive，duration 是用户选的。
	firstFrame := []byte(`{"content":[{"type":"image_url","image_url":{"url":"https://example.com/a.png"},"role":"first_frame"}],
		"ratio":"adaptive","duration":5,"resolution":"1080p"}`)
	if seconds, res, hasInput, err := readAIVideoBilling("u1", firstFrame, "application/json"); err != nil || seconds != 5 || res != "1080p" || hasInput {
		t.Fatalf("图生视频: got(%d,%q,%v) err=%v want(5,\"1080p\",false)", seconds, res, hasInput, err)
	}
	// 不带 omni 字段的老请求 + 智能时长 duration:-1：仍旧返回 0 秒（由计费函数按上限预扣），
	// 这是本改动【之前】的行为，必须逐字节保持。
	legacy := []byte(`{"content":[{"type":"text","text":"一只猫"}],"duration":-1,"resolution":"720p"}`)
	if seconds, _, _, err := readAIVideoBilling("u1", legacy, "application/json"); err != nil || seconds != 0 {
		t.Fatalf("老请求: got %d err=%v want 0", seconds, err)
	}
	// multipart（OpenAI 视频方言）：那条路压根没有 omni 字段，行为不变。
	form := "--b\r\nContent-Disposition: form-data; name=\"seconds\"\r\n\r\n8\r\n" +
		"--b\r\nContent-Disposition: form-data; name=\"resolution_name\"\r\n\r\n1080P\r\n--b--\r\n"
	if seconds, resolution, _, err := readAIVideoBilling("u1", []byte(form), `multipart/form-data; boundary=b`); err != nil || seconds != 8 || resolution != "1080P" {
		t.Fatalf("multipart: got(%d,%q) err=%v want(8,\"1080P\")", seconds, resolution, err)
	}
}

// 异步报错 InvalidParameter.TaskTypeMismatch 要翻成人话：显式指定 edit/extend 后，
// 模型仍会结合提示词判断任务类型，不一致就【异步】报错 —— 那时钱已经扣了、片子没出，
// 用户只看到一句英文，不知道该改哪。必须把「往提示词里写哪些词」直接给出来。
func TestTaskTypeMismatchTranslated(t *testing.T) {
	got := aiUpstreamErrorDetail([]byte(`{"error":{"code":"InvalidParameter.TaskTypeMismatch","message":"the task type inferred from prompt does not match omni_reference_task_type"}}`))
	for _, kw := range []string{"意图", "删除", "续写", "参考生视频"} {
		if !strings.Contains(got, kw) {
			t.Fatalf("缺少关键指引 %q: %s", kw, got)
		}
	}
}
