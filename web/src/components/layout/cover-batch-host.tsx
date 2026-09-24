"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { useThemeStore } from "@/stores/use-theme-store";

// 批量封面工具是 iframe 里的自包含静态页，状态（上传的背景图、EP/样式设置）都在它的内存里。
// 若放在 /cover-batch 页内，切到别的导航 tab 会卸载该页 → iframe 被销毁 → 状态清空。
// 这里把 iframe 提到 (user) 布局层【常驻】：首次进封面页才懒挂载，之后切走只是 display:none 隐藏、
// 绝不卸载，所以再切回来上传图/设置都还在。布局在子路由切换间本就不重挂，正好托住它。
export function CoverBatchHost() {
    const pathname = usePathname();
    const isActive = pathname === "/cover-batch";
    const [mounted, setMounted] = useState(false);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const theme = useThemeStore((state) => state.theme);

    // 懒挂载：没进过封面页就不加载（省掉那份 ~400KB 字体），首次进入后保持挂载。
    useEffect(() => {
        if (isActive) setMounted(true);
    }, [isActive]);

    // 把宿主站点的明暗主题下发给 iframe（它监听 message{type:"theme"}）。
    useEffect(() => {
        if (mounted) iframeRef.current?.contentWindow?.postMessage({ type: "theme", value: theme }, "*");
    }, [theme, mounted]);

    if (!mounted) return null;

    return (
        <div className="absolute inset-0" style={{ display: isActive ? "block" : "none" }} aria-hidden={!isActive}>
            <iframe
                ref={iframeRef}
                src="/cover-batch/cover-batch.html"
                title="批量封面"
                className="h-full w-full border-0"
                onLoad={() => iframeRef.current?.contentWindow?.postMessage({ type: "theme", value: useThemeStore.getState().theme }, "*")}
            />
        </div>
    );
}
