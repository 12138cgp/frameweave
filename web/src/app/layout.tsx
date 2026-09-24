import type { Metadata } from "next";
import Script from "next/script";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { AppProviders } from "@/components/layout/app-providers";
import "antd/dist/reset.css";
import "./globals.css";
import React from "react";
import { APP_NAME, STORAGE_PREFIX } from "@/constant/env";

export const metadata: Metadata = {
    title: APP_NAME,
    description: `${APP_NAME} · 开源的节点式 AI 图像与视频创作画布`,
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="zh-CN" suppressHydrationWarning className="font-sans">
            <body
                className="bg-background text-foreground antialiased"
                style={{
                    fontFamily: '"Inter","SF Pro Text",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
                }}
            >
                <Script
                    id="theme-script"
                    strategy="beforeInteractive"
                    dangerouslySetInnerHTML={{
                        // ⚠️ 这段内联脚本在 React 水合之前跑，用来避免暗色主题闪白，
                    // 所以它只能直接读 localStorage、不能走 store。键名必须与
                    // use-theme-store.ts 的 persist name 逐字一致——这里用 STORAGE_PREFIX
                    // 插值就是为了让两边不可能脱节。
                    __html: `try{var s=JSON.parse(localStorage.getItem("${STORAGE_PREFIX}:theme_store")||"{}");var t=s.state&&s.state.theme==="dark"?"dark":"light";document.documentElement.classList.toggle("dark",t==="dark");document.documentElement.style.colorScheme=t}catch(e){}`,
                    }}
                />
                <AntdRegistry>
                    <AppProviders>{children}</AppProviders>
                </AntdRegistry>
            </body>
        </html>
    );
}
