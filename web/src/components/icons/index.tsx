// 全站图标统一出口。业务代码一律从这里取图标，换图标库只需要改这一个文件。
//
// 图标来自 Remix Icon（https://remixicon.com），许可证为 Remix Icon License v1.0：
// 允许在应用里作为界面元素使用、随产品一起分发；禁止单独售卖图标包、禁止拿图标当 logo 或商标。
// 所以产品 logo（public/logo*.svg）是单独绘制的，不要用这里的图标去拼。
//
// 导出名沿用各页面原有的叫法（例如 X、ChevronDown、PlusOutlined），调用处不用改。
import type { CSSProperties, HTMLAttributes } from "react";
import {
    RiAddLine,
    RiAlertLine,
    RiAlignItemBottomLine,
    RiAlignItemHorizontalCenterLine,
    RiAlignItemLeftLine,
    RiAlignItemRightLine,
    RiAlignItemTopLine,
    RiAlignItemVerticalCenterLine,
    RiArrowDownSLine,
    RiArrowGoBackLine,
    RiArrowGoForwardLine,
    RiArrowLeftLine,
    RiArrowRightLine,
    RiArrowRightSLine,
    RiArrowRightUpLine,
    RiArrowUpDownLine,
    RiArrowUpLine,
    RiArrowUpSLine,
    RiArticleLine,
    RiBarChart2Line,
    RiBillLine,
    RiBookOpenLine,
    RiBox3Line,
    RiBrushLine,
    RiCameraLine,
    RiCheckLine,
    RiCheckboxBlankCircleLine,
    RiCheckboxBlankLine,
    RiCheckboxCircleLine,
    RiCheckboxLine,
    RiClapperboardLine,
    RiClipboardLine,
    RiCloseLine,
    RiCompass3Line,
    RiCpuLine,
    RiCursorLine,
    RiDeleteBinLine,
    RiDownload2Line,
    RiDownloadCloud2Line,
    RiEdit2Line,
    RiEqualizerLine,
    RiEraserLine,
    RiEyeLine,
    RiFileCopyLine,
    RiFileSearchLine,
    RiFileShield2Line,
    RiFileTextLine,
    RiFileUploadLine,
    RiFilmLine,
    RiFlashlightLine,
    RiFocus3Line,
    RiFolder3Line,
    RiFolderAddLine,
    RiFolderChartLine,
    RiFullscreenExitLine,
    RiFullscreenLine,
    RiGalleryLine,
    RiGridLine,
    RiGroupLine,
    RiHistoryLine,
    RiHome5Line,
    RiImageAddLine,
    RiImageCircleLine,
    RiImageEditLine,
    RiImageLine,
    RiInformationLine,
    RiKey2Line,
    RiKeyboardLine,
    RiLayoutColumnLine,
    RiLayoutGrid2Line,
    RiLayoutGridLine,
    RiLayoutLeftLine,
    RiLayoutMasonryLine,
    RiLayoutRightLine,
    RiLayoutRowLine,
    RiLifebuoyLine,
    RiLinkM,
    RiListUnordered,
    RiLoader4Line,
    RiLockLine,
    RiLockUnlockLine,
    RiLoginBoxLine,
    RiLogoutBoxRLine,
    RiLoopRightLine,
    RiMagicLine,
    RiMap2Line,
    RiMenuLine,
    RiMessage2Line,
    RiMoonLine,
    RiMoreLine,
    RiMusic2Line,
    RiPaintBrushLine,
    RiPaletteLine,
    RiPauseLine,
    RiPenNibLine,
    RiPencilLine,
    RiPlayLine,
    RiQuestionLine,
    RiRadioButtonLine,
    RiRefreshLine,
    RiResetLeftLine,
    RiRobot2Line,
    RiSave3Line,
    RiScan2Line,
    RiScanLine,
    RiScissorsLine,
    RiSearchLine,
    RiSettings3Line,
    RiShareBoxLine,
    RiShareLine,
    RiShieldCheckLine,
    RiShieldLine,
    RiShieldUserLine,
    RiSmartphoneLine,
    RiSparkling2Line,
    RiStackLine,
    RiStarLine,
    RiSubtractLine,
    RiSunLine,
    RiTeamLine,
    RiText,
    RiToolsLine,
    RiUpload2Line,
    RiUploadCloud2Line,
    RiUser3Line,
    RiVerifiedBadgeLine,
    RiVideoLine,
    type RemixiconComponentType,
} from "@remixicon/react";

import { cn } from "@/lib/utils";

export type IconComponent = RemixiconComponentType;

// 线性图标：直接导出组件，尺寸由调用处的 className（size-4 等）或 size 属性决定。
export {
    RiAlignItemHorizontalCenterLine as AlignCenterHorizontal,
    RiAlignItemVerticalCenterLine as AlignCenterVertical,
    RiAlignItemBottomLine as AlignEndHorizontal,
    RiAlignItemRightLine as AlignEndVertical,
    RiLayoutColumnLine as AlignHorizontalDistributeCenter,
    RiAlignItemTopLine as AlignStartHorizontal,
    RiAlignItemLeftLine as AlignStartVertical,
    RiLayoutRowLine as AlignVerticalDistributeCenter,
    RiArrowUpDownLine as ArrowDownUp,
    RiArrowLeftLine as ArrowLeft,
    RiArrowRightLine as ArrowRight,
    RiArrowUpLine as ArrowUp,
    RiArrowRightUpLine as ArrowUpRight,
    RiVerifiedBadgeLine as BadgeCheck,
    RiBookOpenLine as BookOpen,
    RiRobot2Line as Bot,
    RiBox3Line as Box,
    RiBrushLine as Brush,
    RiCameraLine as Camera,
    RiCheckLine as Check,
    RiCheckboxCircleLine as CheckCircle2,
    RiCheckLine as CheckIcon,
    RiCheckboxLine as CheckSquare,
    RiArrowDownSLine as ChevronDown,
    RiArrowDownSLine as ChevronDownIcon,
    RiArrowRightSLine as ChevronRight,
    RiArrowUpSLine as ChevronUp,
    RiArrowUpSLine as ChevronUpIcon,
    RiCheckboxBlankCircleLine as Circle,
    RiRadioButtonLine as CircleDot,
    RiClapperboardLine as Clapperboard,
    RiClipboardLine as ClipboardPaste,
    RiUploadCloud2Line as CloudUpload,
    RiCompass3Line as Compass,
    RiFileCopyLine as Copy,
    RiCpuLine as Cpu,
    RiDownload2Line as Download,
    RiMoreLine as Ellipsis,
    RiEraserLine as Eraser,
    RiFileSearchLine as FileSearch,
    RiFileTextLine as FileText,
    RiFileUploadLine as FileUp,
    RiFilmLine as Film,
    RiFocus3Line as Focus,
    RiFolderChartLine as FolderKanban,
    RiFolderAddLine as FolderPlus,
    RiLayoutGrid2Line as Grid2x2,
    RiGridLine as Grid3x3,
    RiQuestionLine as HelpCircle,
    RiHistoryLine as History,
    RiHome5Line as Home,
    RiImageLine as Image,
    RiImageLine as ImageIcon,
    RiImageCircleLine as ImageOff,
    RiImageAddLine as ImagePlus,
    RiGalleryLine as Images,
    RiInformationLine as Info,
    RiKey2Line as KeyRound,
    RiKeyboardLine as Keyboard,
    RiStackLine as Layers,
    RiLayoutGridLine as LayoutGrid,
    RiLayoutLeftLine as LayoutPanelLeft,
    RiLayoutMasonryLine as LayoutTemplate,
    RiLifebuoyLine as LifeBuoy,
    RiLinkM as Link2,
    RiListUnordered as List,
    RiLoader4Line as Loader2,
    RiLoader4Line as LoaderCircle,
    RiLockLine as Lock,
    RiLockUnlockLine as LockOpen,
    RiLoginBoxLine as LogIn,
    RiLogoutBoxRLine as LogOut,
    RiMap2Line as Map,
    RiFullscreenLine as Maximize2,
    RiMenuLine as Menu,
    RiMessage2Line as MessageSquare,
    RiFullscreenExitLine as Minimize2,
    RiSubtractLine as Minus,
    RiMoonLine as Moon,
    RiCursorLine as MousePointer2,
    RiMusic2Line as Music2,
    RiPaletteLine as Palette,
    RiLayoutRightLine as PanelRightClose,
    RiPauseLine as Pause,
    RiPenNibLine as PenLine,
    RiPencilLine as Pencil,
    RiEdit2Line as PencilLine,
    RiPlayLine as Play,
    RiAddLine as Plus,
    RiBillLine as ReceiptText,
    RiArrowGoForwardLine as Redo2,
    RiRefreshLine as RefreshCw,
    RiResetLeftLine as RotateCcw,
    RiScan2Line as ScanEye,
    RiShieldUserLine as ScanFace,
    RiScanLine as ScanLine,
    RiScissorsLine as Scissors,
    RiArticleLine as ScrollText,
    RiSearchLine as Search,
    RiSettings3Line as Settings2,
    RiShareLine as Share2,
    RiShieldLine as Shield,
    RiShieldCheckLine as ShieldCheck,
    RiEqualizerLine as SlidersHorizontal,
    RiSparkling2Line as Sparkles,
    RiCheckboxBlankLine as Square,
    RiImageEditLine as Stamp,
    RiStarLine as Star,
    RiSunLine as Sun,
    RiDeleteBinLine as Trash2,
    RiAlertLine as TriangleAlert,
    RiText as Type,
    RiArrowGoBackLine as Undo2,
    RiUpload2Line as Upload,
    RiGroupLine as Users,
    RiVideoLine as Video,
    RiVideoLine as VideoIcon,
    RiMagicLine as WandSparkles,
    RiToolsLine as Wrench,
    RiCloseLine as X,
    RiFlashlightLine as Zap,
};

// 用在 antd 组件里的图标：套一层 span.anticon，尺寸跟随字号（1em），
// 这样 antd 的按钮、菜单、输入框给图标留的间距和对齐方式照常生效。
type AntdSlotIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & { spin?: boolean; style?: CSSProperties };

function antdSlot(Icon: RemixiconComponentType, alwaysSpin = false) {
    function AntdSlotIcon({ className, style, spin, ...rest }: AntdSlotIconProps) {
        return (
            <span
                role="img"
                aria-hidden="true"
                {...rest}
                className={cn("anticon", className)}
                style={{ display: "inline-flex", alignItems: "center", lineHeight: 0, verticalAlign: "-0.125em", ...style }}
            >
                <Icon size="1em" className={spin || alwaysSpin ? "animate-spin" : undefined} />
            </span>
        );
    }
    return AntdSlotIcon;
}

export const AuditOutlined = antdSlot(RiFileShield2Line);
export const BarChartOutlined = antdSlot(RiBarChart2Line);
export const CheckCircleOutlined = antdSlot(RiCheckboxCircleLine);
export const CloudDownloadOutlined = antdSlot(RiDownloadCloud2Line);
export const CopyOutlined = antdSlot(RiFileCopyLine);
export const DeleteOutlined = antdSlot(RiDeleteBinLine);
export const DownloadOutlined = antdSlot(RiDownload2Line);
export const EditOutlined = antdSlot(RiEdit2Line);
export const ExportOutlined = antdSlot(RiShareBoxLine);
export const EyeOutlined = antdSlot(RiEyeLine);
export const FormatPainterOutlined = antdSlot(RiPaintBrushLine);
export const HistoryOutlined = antdSlot(RiHistoryLine);
export const HomeOutlined = antdSlot(RiHome5Line);
export const LoadingOutlined = antdSlot(RiLoader4Line, true);
export const LockOutlined = antdSlot(RiLockLine);
export const LogoutOutlined = antdSlot(RiLogoutBoxRLine);
export const MessageOutlined = antdSlot(RiMessage2Line);
export const MobileOutlined = antdSlot(RiSmartphoneLine);
export const PictureOutlined = antdSlot(RiImageLine);
export const PlusOutlined = antdSlot(RiAddLine);
export const ProjectOutlined = antdSlot(RiFolder3Line);
export const QuestionCircleOutlined = antdSlot(RiQuestionLine);
export const ReloadOutlined = antdSlot(RiRefreshLine);
export const SaveOutlined = antdSlot(RiSave3Line);
export const SearchOutlined = antdSlot(RiSearchLine);
export const SettingOutlined = antdSlot(RiSettings3Line);
export const SyncOutlined = antdSlot(RiLoopRightLine);
export const TeamOutlined = antdSlot(RiTeamLine);
export const UserOutlined = antdSlot(RiUser3Line);
