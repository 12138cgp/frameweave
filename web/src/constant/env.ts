export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev";

// APP_NAME 产品名。全站所有用户可见的品牌文案都必须从这里取，不要再写字面量。
//
// ⚠️ 这是【构建期】常量，不是运行时配置：Next 会在打包时把
// process.env.NEXT_PUBLIC_APP_NAME 的取值直接内联进产物。改名之后必须重新构建前端。
// 具体取值来源与优先级见 next.config.ts 的 readBrandName()。
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "FrameWeave";

// LOCAL_DB_NAME 浏览器本地库（IndexedDB）的库名，全站所有 localforage 实例共用。
//
// ⚠️ 必须只有这一个来源。之前它是散在 11 个文件里的字面量，
// 漏改任何一处就会变成「写进 A 库、从 B 库读」——而它是字符串，编译器一个字都抓不到，
// 表现是用户本地缓存、草稿、墓碑、媒体文件凭空消失，且没有任何报错。
// 改这个值会让所有用户的本地缓存作废（云端数据不受影响，下次同步会重新拉回来）。
export const LOCAL_DB_NAME = "aicanvas";

// STORAGE_PREFIX 本地持久化键（localStorage / zustand persist）的统一前缀。
//
// ⚠️ 必须只有这一个来源，且 cache-isolation.ts 里那份「切账号要清哪些键」的清单
// 必须与实际用到的键逐个对齐。这两者一旦脱节，切账号时漏清某个键，
// 上一个账号的本地数据会被下一个账号合并进自己的云端 —— 这是出过事的：
// 同一浏览器切号后账号之间互相吞并画布。改键名时务必全站一起改。
export const STORAGE_PREFIX = "aicanvas";
export const storageKey = (name: string) => `${STORAGE_PREFIX}:${name}`;
