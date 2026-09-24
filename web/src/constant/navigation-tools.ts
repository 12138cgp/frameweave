import { FileText, ImagePlus, Images, Stamp, Video, type IconComponent } from "@/components/icons";

export type NavigationTool = {
    slug: "canvas" | "image" | "video" | "prompts" | "assets" | "cover-batch";
    label: string;
    icon: IconComponent;
    // 自定义图片图标（放在 web/public/nav-icons/ 下）。留空则用上面的矢量图标。
    iconSrc?: string;
};

export const navigationTools: NavigationTool[] = [
    {
        slug: "image",
        label: "图片生成",
        icon: ImagePlus,
    },
    {
        slug: "video",
        label: "视频生成",
        icon: Video,
    },
    {
        slug: "prompts",
        label: "提示词模板",
        icon: FileText,
    },
    {
        slug: "assets",
        label: "我的素材",
        icon: Images,
    },
    {
        slug: "cover-batch",
        label: "批量封面",
        icon: Stamp,
    },
];

// 左上角的品牌图标。图标旁边的文字取 APP_NAME，见 layout/app-top-nav.tsx。
export const brandIconSrc = "/logo-mark.svg";

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
