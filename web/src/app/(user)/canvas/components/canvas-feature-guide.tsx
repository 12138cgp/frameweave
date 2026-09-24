"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Modal } from "antd";
import { Check, Clapperboard, Star } from "@/components/icons";
import { APP_NAME, storageKey } from "@/constant/env";

import { UpdateBanner } from "@/components/layout/update-banner";

// 新功能引导：底部一条横幅 →（用户想看才）图文弹窗 → 每个功能一个「去试试」直接把他带到位。
//
// 为什么不是一上来就弹窗：项目对「打断」有明确态度（见 update-banner.tsx 顶部那段）——
// 居中弹窗会抢焦点，打断正在拖节点、写提示词、等出图的人。所以先出一条不抢焦点的细横幅，
// 想了解的人点开才看详细内容。
//
// 为什么「去试试」是**直接执行动作**而不是高亮按钮：这两个功能的入口都是动态渲染的——
// 收藏按钮只在鼠标 hover 到节点时才存在（还要求那个节点已经有图），场景台入口藏在
// 双击空白弹出的菜单里。做成 spotlight 高亮的话，target 经常拿不到元素、或者画布一平移就错位。
// 与其教用户「你去点那个按钮」，不如直接替他打开。
//
// ⭐ 按功能分别记「试过没」，而不是一个总开关。
// 最早的版本是点任意一个「去试试」就把整个引导永久关掉——于是用户试了收藏，
// 就再也不会被告知还有个 3D 场景台。现在两个功能各记各的，都试过了才彻底消失。

const GUIDE_STATE_KEY = storageKey("feature-guide-v2");

type FeatureId = "favorite" | "stage";
type GuideState = { tried: FeatureId[]; muted: boolean };

const FEATURES: { id: FeatureId; icon: ReactNode; title: string; desc: string; actionLabel: string }[] = [
    {
        id: "favorite",
        icon: <Star className="size-4 fill-[#F59E0B] text-[#F59E0B]" />,
        title: "收藏提示词",
        desc: "觉得这次生成得好，就把鼠标移到图片或视频节点上，点工具栏里的「收藏」。提示词、用到的参考素材和成品会一起存下来，之后在「我的素材 → 收藏提示词」里随时取回、一键填回画布。",
        actionLabel: "带我去看",
    },
    {
        id: "stage",
        icon: <Clapperboard className="size-4" />,
        title: "3D 场景台",
        desc: "双击画布空白处，在菜单里选「3D 场景台」，就能摆人物道具、走位掌镜。机位截图和整段运镜视频都可以直接回到画布，当参考图或成片素材接着用。",
        actionLabel: "建一个试试",
    },
];

function readGuideState(): GuideState {
    if (typeof window === "undefined") return { tried: [], muted: true };
    try {
        const raw = window.localStorage.getItem(GUIDE_STATE_KEY);
        if (!raw) return { tried: [], muted: false };
        const parsed = JSON.parse(raw) as Partial<GuideState>;
        const known = new Set(FEATURES.map((item) => item.id));
        const tried: FeatureId[] = [];
        if (Array.isArray(parsed.tried)) {
            for (const id of parsed.tried) {
                // 只认当前还存在的功能：以后加了新功能、或删了旧的，老记录不会让引导错乱。
                if (typeof id === "string" && known.has(id as FeatureId) && !tried.includes(id as FeatureId)) tried.push(id as FeatureId);
            }
        }
        return { tried, muted: parsed.muted === true };
    } catch {
        // 隐私模式下 localStorage 可能直接抛。读不到就当已看完——
        // 宁可少打扰一次，也不要每次进画布都弹。
        return { tried: [], muted: true };
    }
}

function writeGuideState(state: GuideState) {
    try {
        window.localStorage.setItem(GUIDE_STATE_KEY, JSON.stringify(state));
    } catch {
        // 存不下就算了，绝不能因为记不住偏好而报错。
    }
}

function isAllTried(state: GuideState) {
    return FEATURES.every((item) => state.tried.includes(item.id));
}

// 系统横幅（管理员公告 / 版本更新）在不在？
//
// 这两件事比「有个新功能可以试」重要得多——尤其版本更新，用户看不到就会一直卡在旧客户端。
// 它们由 client-root-init 独立渲染，**不会**检查别人占没占位；所以必须由本组件单方面让路。
function hasSystemBanner() {
    if (typeof document === "undefined") return false;
    return Boolean(document.querySelector('[data-app-banner="system"]'));
}

// 现在方便出横幅吗？三个条件都要满足。
//
// ① 没有系统横幅——见上。
// ② 没有弹窗开着：横幅是 z-index 1200，比 antd Modal 还高。用户点完「建一个试试」、
//    场景台全屏弹窗刚开，这时候冒出来就是糊在人家脸上。
// ③ 底部那一格空着（--app-banner-h 为 0）。
function isBannerSlotFree() {
    if (typeof document === "undefined") return false;
    if (hasSystemBanner()) return false;
    const modalOpen = document.querySelector(".ant-modal-wrap:not([style*='display: none'])");
    if (modalOpen) return false;
    const occupied = getComputedStyle(document.documentElement).getPropertyValue("--app-banner-h").trim();
    return !occupied || occupied === "0px";
}

export function CanvasFeatureGuide({ onTryFavorite, onTryStage }: { onTryFavorite: () => void; onTryStage: () => void }) {
    const [state, setState] = useState<GuideState>({ tried: [], muted: true });
    const [bannerOpen, setBannerOpen] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const returnTimerRef = useRef<number | null>(null);

    const clearReturnTimer = () => {
        if (returnTimerRef.current) {
            window.clearTimeout(returnTimerRef.current);
            returnTimerRef.current = null;
        }
    };

    // 组件卸载（切画布、退出）时把待触发的定时器清掉，否则会对着已卸载的组件 setState。
    useEffect(() => clearReturnTimer, []);

    // ⭐ 挂着的时候也要盯：版本更新是 60 秒心跳检测出来的，随时可能在引导显示期间冒出来。
    //
    // 系统横幅由 client-root-init 独立渲染，它不看别人占没占位——真叠上了，两条都在
    // fixed bottom-0 / z-1200，用户十有八九只看到我们这条，于是错过「有新版本，请刷新」。
    // 所以只要发现系统横幅出现，立刻把自己撤下去；等它被处理掉，横幅位空出来时再回来。
    useEffect(() => {
        if (!bannerOpen) return;
        const timer = window.setInterval(() => {
            if (hasSystemBanner()) setBannerOpen(false);
        }, 2000);
        return () => window.clearInterval(timer);
    }, [bannerOpen]);

    // 让位之后别就此消失：系统横幅被用户处理掉（点了「知道了」或刷新过）之后，
    // 位置空出来就把引导放回去——否则一次版本更新会让还没试过的功能永远没人再提。
    useEffect(() => {
        if (bannerOpen || modalOpen) return;
        if (state.muted || isAllTried(state)) return;
        // 有待回归的定时器在跑就别插手，交给它
        if (returnTimerRef.current) return;
        const timer = window.setInterval(() => {
            if (isBannerSlotFree()) setBannerOpen(true);
        }, 5000);
        return () => window.clearInterval(timer);
    }, [bannerOpen, modalOpen, state]);

    useEffect(() => {
        const saved = readGuideState();
        setState(saved);
        if (saved.muted || isAllTried(saved)) return;
        // 优先级最低：横幅位被公告/版本更新占着就这次不出，等下次进画布再说。
        if (!isBannerSlotFree()) return;
        setBannerOpen(true);
    }, []);

    const closeAll = () => {
        setBannerOpen(false);
        setModalOpen(false);
    };

    // 试完一个之后，把「还剩哪个没试」的横幅自己送回来——不该逼用户刷新页面才看得到。
    //
    // 但要等一个不碍事的时机：刚点完「建一个试试」，场景台全屏弹窗正开着，
    // 而横幅 z-index 比弹窗高，这会儿冒出来就是挡在人家脸上。所以先等 4 秒
    // （刚好错开 revealFavoriteEntry 弹的那条 message），条件不满足就每 5 秒再看一次，
    // 直到弹窗关了、横幅位也空了。最多盯 5 分钟，之后就算了——下次进画布自然还会提醒。
    const scheduleBannerReturn = (next: GuideState) => {
        clearReturnTimer();
        if (next.muted || isAllTried(next)) return;
        let attempts = 0;
        const tick = () => {
            attempts += 1;
            if (isBannerSlotFree()) {
                setBannerOpen(true);
                returnTimerRef.current = null;
                return;
            }
            if (attempts >= 60) {
                returnTimerRef.current = null;
                return;
            }
            returnTimerRef.current = window.setTimeout(tick, 5000);
        };
        returnTimerRef.current = window.setTimeout(tick, 4000);
    };

    // 点「去试试」：记下这个功能已经试过，先把引导收起来（不然弹窗盖着，看不到刚为他打开的东西），
    // 执行动作，然后安排横幅稍后带着「还剩哪个」回来。两个都试过就真的不再出现了。
    const handleTry = (id: FeatureId) => {
        const next: GuideState = { tried: state.tried.includes(id) ? state.tried : [...state.tried, id], muted: state.muted };
        setState(next);
        writeGuideState(next);
        closeAll();
        if (id === "favorite") onTryFavorite();
        else onTryStage();
        scheduleBannerReturn(next);
    };

    // 「知道了」只关这一次，不写永久标记：还没试过的功能下次进来仍会提醒。
    // 想彻底不看的人走下面那个「不再提示」。
    const handleLater = () => {
        writeGuideState(state);
        closeAll();
    };

    const handleMute = () => {
        const next: GuideState = { tried: state.tried, muted: true };
        setState(next);
        writeGuideState(next);
        // 用户明确说了不想再看，把待回归的横幅也取消掉——不然过几秒它又自己冒出来。
        clearReturnTimer();
        closeAll();
    };

    if (!bannerOpen && !modalOpen) return null;

    // 横幅文案跟着进度走：已经试过一个的话，直说还剩哪个，比笼统地说「新增了两个功能」有用。
    const remaining = FEATURES.filter((item) => !state.tried.includes(item.id));
    let bannerText = `${APP_NAME}新增了「收藏提示词」和「3D 场景台」`;
    if (remaining.length === 1) bannerText = `还有「${remaining[0].title}」没试过`;

    return (
        <>
            {bannerOpen && !modalOpen ? <UpdateBanner message={bannerText} actionLabel="看看" source="guide" onAction={() => setModalOpen(true)} /> : null}
            <Modal
                open={modalOpen}
                onCancel={handleLater}
                width={560}
                centered
                title="两个新功能"
                footer={
                    <div className="flex items-center justify-between">
                        <Button type="text" size="small" onClick={handleMute}>
                            不再提示
                        </Button>
                        <Button type="primary" onClick={handleLater}>
                            知道了
                        </Button>
                    </div>
                }
            >
                <div className="flex flex-col gap-3">
                    {FEATURES.map((item) => (
                        <FeatureCard key={item.id} icon={item.icon} title={item.title} desc={item.desc} actionLabel={item.actionLabel} tried={state.tried.includes(item.id)} onAction={() => handleTry(item.id)} />
                    ))}
                </div>
            </Modal>
        </>
    );
}

function FeatureCard({ icon, title, desc, actionLabel, tried, onAction }: { icon: ReactNode; title: string; desc: string; actionLabel: string; tried: boolean; onAction: () => void }) {
    // 试过的那条留在原地、标一个「已试过」，让用户看得出还剩哪个没试，而不是凭空少一块。
    let badge = null;
    if (tried)
        badge = (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#059669]/10 px-2 py-0.5 text-[11px] text-[#059669] dark:bg-[#34D399]/15 dark:text-[#34D399]">
                <Check className="size-3" />
                已试过
            </span>
        );
    let buttonLabel = actionLabel;
    if (tried) buttonLabel = "再看一次";
    return (
        <section className="flex flex-col gap-2 rounded-xl border border-black/5 p-3 dark:border-white/10">
            <span className="flex items-center gap-2 text-sm font-medium">
                {icon}
                {title}
                {badge}
            </span>
            <p className="text-xs leading-relaxed opacity-70">{desc}</p>
            <div className="flex justify-end">
                <Button size="small" type={tried ? "text" : "default"} onClick={onAction}>
                    {buttonLabel}
                </Button>
            </div>
        </section>
    );
}
