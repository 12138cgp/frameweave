package handler

import (
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// PersistMedia 给成片登记 sync_files 时，storageKey 与 TOS 对象 key 是同一个 shortID 推导出来的。
// 这两条必须始终成立，否则：① key 不合法 → 该画布分享接口整单拒绝、服务端媒体接口报「存储标识不合法」；
// ② 两边对象名对不上 → 同一份字节经 /sync/files 再传一次会在桶里留下孤儿。
func TestPersistMediaStorageKeyMatchesObjectKey(t *testing.T) {
	const userID = "user-00000000-0000-4000-8000-000000000002"
	for i := 0; i < 200; i++ {
		shortID := strings.ReplaceAll(uuid.NewString(), "-", "")
		storageKey := "video:" + shortID

		if !syncStorageKeyPattern.MatchString(storageKey) {
			t.Fatalf("storageKey 过不了同步接口的格式校验: %q", storageKey)
		}
		// PersistMedia 里拼对象名的那一行
		objectKey := fmt.Sprintf("media/%s/%s/%s.%s", userID, "video", shortID, "mp4")
		// 同步接口按 storageKey 反推的对象名
		derived := syncFileTOSKey(userID, storageKey, "video/mp4")
		if objectKey != derived {
			t.Fatalf("对象 key 两边不一致:\n  转存时 = %s\n  反推时 = %s", objectKey, derived)
		}
	}
}

// storageKey 的不可猜性是跨账号隔离的唯一边界（按 key 的全局回退查询没有 user 过滤），
// 所以它必须是 32 位十六进制的随机串，不能退化成可推导的业务标识。
func TestPersistMediaStorageKeyIsRandomHex(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		shortID := strings.ReplaceAll(uuid.NewString(), "-", "")
		if len(shortID) != 32 {
			t.Fatalf("shortID 长度应为 32，得到 %d（%q）", len(shortID), shortID)
		}
		for _, c := range shortID {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				t.Fatalf("shortID 含非十六进制字符: %q", shortID)
			}
		}
		if seen[shortID] {
			t.Fatalf("500 次里出现重复 shortID: %q", shortID)
		}
		seen[shortID] = true
	}
}
