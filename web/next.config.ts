import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseChangelog } from "@/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// 产品名。默认「FrameWeave」，部署方可以改成自己的名字。
//
// ⚠️ NEXT_PUBLIC_* 是【构建期内联】的：Next 在打包时把 process.env.NEXT_PUBLIC_APP_NAME
// 的取值直接写进产物，运行时再改环境变量不会有任何效果。改完名字必须按部署文档
// 重新构建前端，页面上的名字才会变。
//
// 取值优先级（就近覆盖）：
//   ① 构建环境变量 NEXT_PUBLIC_APP_NAME —— 适合 CI；容器构建需要把它作为 build arg 透进来。
//   ② web/APP_NAME 文件 —— 改一个文本文件就行，不依赖构建参数，容器构建时随源码一起进镜像。
//   ③ 默认值「FrameWeave」。
function readBrandName(): string {
    const fromEnv = (process.env.NEXT_PUBLIC_APP_NAME || "").trim();
    if (fromEnv) return fromEnv;
    try {
        const fromFile = readFileSync(resolve(webDir, "APP_NAME"), "utf8").trim();
        if (fromFile) return fromFile;
    } catch {
        // 没有 APP_NAME 文件属于正常情况，落到默认值即可。
    }
    return "FrameWeave";
}

export default function nextConfig(phase: string): NextConfig {
    const isDev = phase === PHASE_DEVELOPMENT_SERVER;
    const releases = parseChangelog(localChangelog);

    return {
        output: "standalone",
        allowedDevOrigins: isDev ? ["*.*.*.*"] : [],
        typescript: {
            ignoreBuildErrors: true,
        },
        // 优化大库的 barrel import（按需引入、减小首屏 chunk 与构建体积）；Next 原生、安全。
        experimental: {
            optimizePackageImports: ["antd", "@remixicon/react", "@ant-design/icons"],
        },
        env: {
            NEXT_PUBLIC_APP_NAME: readBrandName(),
            NEXT_PUBLIC_APP_VERSION: localVersion,
            NEXT_PUBLIC_APP_RELEASES: JSON.stringify(releases),
        },
    };
}
