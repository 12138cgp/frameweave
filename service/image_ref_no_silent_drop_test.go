package service

import (
	"bytes"
	"mime/multipart"
	"strings"
	"testing"
)

// 0 字节参考图必须当场报错，不能被当成一张正常图往上游发。
//
// 为什么盯这个：前端 web/src/lib/image-utils.ts 的 dataUrlToFile 对非 data: 开头的地址
// （空串、asset:// 这类）取不到逗号后半段 → atob("") 不抛错、产出一个 0 字节 File。
// 这张空图一旦被放行，提示词最前面那行「参考图片编号：图片1、图片2…」就和实际可用的图对不上，
// 模型按错的图作画，全程没有任何报错。错法本身是静默的，只能用断言钉死。
func buildEditsForm(t *testing.T, images [][]byte) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	if err := writer.WriteField("model", "doubao-seedream-4-0-250828"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("prompt", "参考图片编号：图片1、图片2。把图片1的人物放进图片2的场景。"); err != nil {
		t.Fatal(err)
	}
	for _, data := range images {
		part, err := writer.CreateFormFile("image", "ref.png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), writer.FormDataContentType()
}

func TestArkImageEditsRejectsEmptyReference(t *testing.T) {
	payload, contentType := buildEditsForm(t, [][]byte{[]byte("\x89PNG\r\n\x1a\n-fake"), {}})
	if _, err := arkImageEditsToGenerations(payload, contentType); err == nil {
		t.Fatal("0 字节参考图必须报错，不能静默发一张空图上去")
	} else if !strings.Contains(err.Error(), "参考图") {
		t.Fatalf("文案要说清是参考图的问题: %q", err.Error())
	}
}

// 正常多图不受影响：两张都要原样带进 image 数组。
func TestArkImageEditsKeepsAllReferences(t *testing.T) {
	payload, contentType := buildEditsForm(t, [][]byte{[]byte("first-bytes"), []byte("second-bytes")})
	out, err := arkImageEditsToGenerations(payload, contentType)
	if err != nil {
		t.Fatalf("正常参考图不该报错: %v", err)
	}
	if n := strings.Count(string(out), "data:"); n != 2 {
		t.Fatalf("应带 2 张参考图，实际 %d 张: %s", n, out)
	}
}

func TestRelayGptImageEditRejectsEmptyReference(t *testing.T) {
	payload, contentType := buildEditsForm(t, [][]byte{[]byte("first-bytes"), {}})
	if _, _, err := adaptRelayGptImageEditPayload(payload, contentType, "gpt-image-2"); err == nil {
		t.Fatal("0 字节参考图必须报错，不能原样转发成一个空 part")
	}
}
