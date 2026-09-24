"use client";

import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal } from "antd";
import { ImagePlus, Pencil, Plus, Share2, Trash2, Users } from "@/components/icons";

import { usePresetStore, type CustomImageStyle } from "@/stores/use-preset-store";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { shareGroupStyle, deleteGroupStyle } from "@/services/api/group-style";
import { useUserStore } from "@/stores/use-user-store";
import { canvasThemes } from "@/lib/canvas-theme";

type Theme = (typeof canvasThemes)[keyof typeof canvasThemes];
// 图片风格与视频风格结构一致，UI 复用；kind 决定读写哪套 store 切片与文案。
export type StyleKind = "image" | "video";
type Style = CustomImageStyle; // 结构等同 CustomVideoStyle

// PreviewThumb 按 storageKey 解析预览图(本地缓存优先，换设备靠 resolveImageUrl 自愈)。无图时占位。
// directUrl：团队共享风格的预览图存在团队存储里，服务端直接给 URL，没有 storageKey 可解析。
function PreviewThumb({ storageKey, directUrl, className, style }: { storageKey?: string; directUrl?: string; className?: string; style?: React.CSSProperties }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let alive = true;
        if (directUrl) {
            setUrl(directUrl);
            return;
        }
        if (!storageKey) {
            setUrl("");
            return;
        }
        void resolveImageUrl(storageKey, "").then((u) => {
            if (alive) setUrl(u);
        });
        return () => {
            alive = false;
        };
    }, [storageKey, directUrl]);
    if (!url) {
        return <div className={className} style={{ ...style, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.4 }}><ImagePlus className="size-4" /></div>;
    }
    return <img src={url} alt="" className={className} style={{ ...style, objectFit: "cover" }} draggable={false} />;
}

// CustomStyleSection 「我的风格 / 我的视频风格」分组：自定义风格卡片(预览图+名字，hover 显编辑/删)+「新建」卡片。渲染在选择器顶部。
export function CustomStyleSection({ theme, value, onSelect, kind = "image" }: { theme: Theme; value: string; onSelect: (id: string) => void; kind?: StyleKind }) {
    const isVideo = kind === "video";
    // 图片/视频风格结构一致，统一按 Style 处理（避免 CustomImageStyle[] | CustomVideoStyle[] 联合类型的 .map 报错）。
    const styles = usePresetStore((state) => (isVideo ? state.videoStyles : state.imageStyles)) as Style[];
    const removeStyle = usePresetStore((state) => (isVideo ? state.removeVideoStyle : state.removeImageStyle));
    const [editing, setEditing] = useState<Style | "new" | null>(null);
    const { modal, message } = App.useApp();
    const loadGroupStyles = usePresetStore((state) => state.loadGroupStyles);

    // 分享到团队：复制一份到服务端的团队表（个人这份保留）。
    // 预览图必须连字节一起传——团队成员解析不到别人名下的 storageKey（跨账号回退只覆盖公共读桶，
    // 落磁盘的文件仍按账号隔离），只存 key 的话组内看到的是空白缩略图。
    const shareToGroup = async (preset: Style) => {
        try {
            let preview: Blob | undefined = undefined;
            if (preset.previewStorageKey) {
                const url = await resolveImageUrl(preset.previewStorageKey, "");
                if (url) {
                    const response = await fetch(url);
                    if (response.ok) preview = await response.blob();
                }
            }
            await shareGroupStyle({
                kind,
                sourceStyleId: preset.id,
                nameZh: preset.nameZh,
                description: preset.description,
                prefixPrompt: preset.prefixPrompt,
                injectPrompt: preset.injectPrompt,
                negativePrompt: preset.negativePrompt,
                preview,
            });
            await loadGroupStyles();
            message.success("「" + preset.nameZh + "」已分享到团队");
        } catch (error) {
            let text = "分享失败";
            if (error instanceof Error) text = error.message;
            message.error(text);
        }
    };
    const groupLabel = isVideo ? "我的视频风格" : "我的风格";

    const confirmRemove = (preset: Style) => {
        modal.confirm({
            title: `删除风格「${preset.nameZh}」？`,
            content: isVideo ? "删除后不可恢复；已用它生成的视频不受影响。" : "删除后不可恢复；已用它生成的图片不受影响。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => removeStyle(preset.id),
        });
    };

    // 预算「是否选中了某个自定义风格」及标题色，避免 JSX 属性里出现 arr.some(...)?a:b（bun SSG SIGILL 触发点）。
    let hasSelectedCustom = false;
    for (const s of styles) {
        if (s.id === value) hasSelectedCustom = true;
    }
    let headColor = theme.node.text;
    if (hasSelectedCustom) headColor = theme.node.activeStroke;
    let headSuffix = "";
    if (hasSelectedCustom) headSuffix = " · 已选";

    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between px-1.5">
                <span className="text-xs font-medium" style={{ color: headColor }}>
                    {groupLabel}
                    {headSuffix}
                </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pb-1">
                {styles.map((preset) => {
                    const selected = preset.id === value;
                    return (
                        <div key={preset.id} className="group relative">
                            <button
                                type="button"
                                className="block w-full overflow-hidden rounded-xl border text-left hover:opacity-90"
                                style={{ borderColor: selected ? theme.node.activeStroke : theme.node.stroke, background: theme.node.fill }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onSelect(preset.id)}
                                title={preset.injectPrompt}
                            >
                                <PreviewThumb storageKey={preset.previewStorageKey} className="h-16 w-full" style={{ background: theme.node.fill }} />
                                <span className="block truncate px-1.5 py-1 text-xs" style={{ color: selected ? theme.node.activeStroke : theme.node.text }}>
                                    {preset.nameZh}
                                </span>
                            </button>
                            <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition group-hover:opacity-100">
                                <button type="button" className="rounded-md bg-black/50 p-1 text-white hover:bg-black/70" onMouseDown={(event) => event.stopPropagation()} onClick={() => setEditing(preset)} title="编辑">
                                    <Pencil className="size-3" />
                                </button>
                                <button type="button" className="rounded-md bg-black/50 p-1 text-white hover:bg-black/70" onMouseDown={(event) => event.stopPropagation()} onClick={() => void shareToGroup(preset)} title="分享到团队">
                                    <Share2 className="size-3" />
                                </button>
                                <button type="button" className="rounded-md bg-black/50 p-1 text-white hover:bg-black/70" onMouseDown={(event) => event.stopPropagation()} onClick={() => confirmRemove(preset)} title="删除">
                                    <Trash2 className="size-3" />
                                </button>
                            </div>
                        </div>
                    );
                })}
                <button
                    type="button"
                    className="flex h-[calc(4rem+1.75rem)] w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-xs hover:opacity-80"
                    style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => setEditing("new")}
                >
                    <Plus className="size-4" />
                    新建风格
                </button>
            </div>
            {editing ? <CustomStyleFormModal preset={editing} kind={kind} onClose={() => setEditing(null)} /> : null}
        </div>
    );
}

// GroupStyleSection 「团队风格」分组：本组成员分享出来的风格，同组人都能选用。
//
// 与「我的风格」的两点区别：
//   1. 没有「新建」——团队风格只能由个人风格分享而来，避免出现「组里有但谁都改不了」的孤儿；
//   2. 只有分享者本人或管理员能取消共享，普通成员只能用（否则一个人手滑就清掉全组的）。
export function GroupStyleSection({ theme, value, onSelect, kind = "image" }: { theme: Theme; value: string; onSelect: (id: string) => void; kind?: StyleKind }) {
    const isVideo = kind === "video";
    const styles = usePresetStore((state) => (isVideo ? state.groupVideoStyles : state.groupImageStyles)) as Style[];
    const loadGroupStyles = usePresetStore((state) => state.loadGroupStyles);
    const me = useUserStore((state) => state.user);
    const { modal, message } = App.useApp();

    // 打开选择器时现拉：团队风格是服务端状态，别人刚分享的应当马上能看到。
    useEffect(() => {
        void loadGroupStyles();
    }, [loadGroupStyles]);

    const canManage = (preset: Style) => {
        if (!me) return false;
        if (me.role === "admin") return true;
        if (me.role === "admin_l2") return true;
        return preset.ownerName === me.displayName || preset.ownerName === me.username;
    };

    const confirmUnshare = (preset: Style) => {
        modal.confirm({
            title: "取消共享「" + preset.nameZh + "」？",
            content: "组内其他成员将不再看到它；分享者本人「我的风格」里那条不受影响。",
            okText: "取消共享",
            okButtonProps: { danger: true },
            cancelText: "再想想",
            onOk: async () => {
                try {
                    await deleteGroupStyle(preset.id);
                    await loadGroupStyles();
                    message.success("已取消共享");
                } catch (error) {
                    let text = "操作失败";
                    if (error instanceof Error) text = error.message;
                    message.error(text);
                }
            },
        });
    };

    if (!styles.length) return null;

    // 预算标题色/后缀，避免 JSX 属性里出现三元（本文件踩过 bun 编译期 SIGILL）。
    let hasSelected = false;
    for (const item of styles) {
        if (item.id === value) hasSelected = true;
    }
    let headColor = theme.node.text;
    if (hasSelected) headColor = theme.node.activeStroke;
    let headSuffix = "";
    if (hasSelected) headSuffix = " · 已选";
    let groupLabel = "团队风格";
    if (isVideo) groupLabel = "团队视频风格";

    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-1 px-1.5">
                <Users className="size-3" style={{ color: headColor }} />
                <span className="text-xs font-medium" style={{ color: headColor }}>
                    {groupLabel}
                    {headSuffix}
                </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pb-1">
                {styles.map((preset) => {
                    const selected = preset.id === value;
                    let borderColor = theme.node.stroke;
                    if (selected) borderColor = theme.node.activeStroke;
                    let textColor = theme.node.text;
                    if (selected) textColor = theme.node.activeStroke;
                    let ownerHint = "";
                    if (preset.ownerName) ownerHint = "来自 " + preset.ownerName;
                    let tip = preset.injectPrompt;
                    if (ownerHint) tip = ownerHint + "\n" + preset.injectPrompt;
                    return (
                        <div key={preset.id} className="group relative">
                            <button
                                type="button"
                                className="block w-full overflow-hidden rounded-xl border text-left hover:opacity-90"
                                style={{ borderColor, background: theme.node.fill }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onSelect(preset.id)}
                                title={tip}
                            >
                                <PreviewThumb directUrl={preset.previewUrl} className="h-16 w-full" style={{ background: theme.node.fill }} />
                                <span className="block truncate px-1.5 pt-1 text-xs" style={{ color: textColor }}>
                                    {preset.nameZh}
                                </span>
                                <span className="block truncate px-1.5 pb-1 text-[10px]" style={{ color: theme.node.muted }}>
                                    {ownerHint}
                                </span>
                            </button>
                            {canManage(preset) ? (
                                <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition group-hover:opacity-100">
                                    <button type="button" className="rounded-md bg-black/50 p-1 text-white hover:bg-black/70" onMouseDown={(event) => event.stopPropagation()} onClick={() => confirmUnshare(preset)} title="取消共享">
                                        <Trash2 className="size-3" />
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// CustomStyleFormModal 新建/编辑自定义风格表单：名字 + 风格提示词 + 可选负面词 + 预览图。图片/视频共用，kind 决定写哪套 store。
function CustomStyleFormModal({ preset, kind, onClose }: { preset: Style | "new"; kind: StyleKind; onClose: () => void }) {
    const { message } = App.useApp();
    const isVideo = kind === "video";
    const addImageStyle = usePresetStore((state) => state.addImageStyle);
    const updateImageStyle = usePresetStore((state) => state.updateImageStyle);
    const addVideoStyle = usePresetStore((state) => state.addVideoStyle);
    const updateVideoStyle = usePresetStore((state) => state.updateVideoStyle);
    const isNew = preset === "new";
    const existing = isNew ? null : preset;
    const [name, setName] = useState(existing?.nameZh || "");
    const [inject, setInject] = useState(existing?.injectPrompt || "");
    const [negative, setNegative] = useState(existing?.negativePrompt || "");
    const [previewKey, setPreviewKey] = useState(existing?.previewStorageKey || "");
    const [uploading, setUploading] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const onPickFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (fileRef.current) fileRef.current.value = "";
        if (!file) return;
        setUploading(true);
        try {
            const uploaded = await uploadImage(file);
            setPreviewKey(uploaded.storageKey);
        } catch {
            message.error("预览图处理失败，请换一张");
        } finally {
            setUploading(false);
        }
    };

    const save = () => {
        if (!name.trim()) {
            message.warning("请填写风格名字");
            return;
        }
        if (!inject.trim()) {
            message.warning("请填写风格提示词（生成时会追加到你的描述后）");
            return;
        }
        const payload = { nameZh: name, injectPrompt: inject, negativePrompt: negative, previewStorageKey: previewKey || undefined };
        if (isNew) {
            if (isVideo) addVideoStyle(payload);
            else addImageStyle(payload);
        } else if (isVideo) {
            updateVideoStyle(existing!.id, payload);
        } else {
            updateImageStyle(existing!.id, payload);
        }
        message.success(isNew ? "已新建风格" : "已更新风格");
        onClose();
    };

    const injectPlaceholder = isVideo
        ? "如：cinematic film look, smooth camera movement, dramatic lighting, film grain"
        : "如：cyberpunk neon aesthetic, rain-slick streets, cinematic rim light, high contrast";

    return (
        <Modal open title={isNew ? "新建风格" : "编辑风格"} onOk={save} onCancel={onClose} okText="保存" cancelText="取消" width={520} destroyOnHidden>
            <div className="space-y-3 pt-2">
                <div>
                    <div className="mb-1 text-xs text-neutral-500">风格名字</div>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={isVideo ? "如：电影感 / 我的运镜风" : "如：赛博霓虹 / 我的插画风"} maxLength={20} />
                </div>
                <div>
                    <div className="mb-1 text-xs text-neutral-500">风格提示词（生成时自动追加到你的主体描述后）</div>
                    <Input.TextArea value={inject} onChange={(e) => setInject(e.target.value)} rows={3} placeholder={injectPlaceholder} />
                </div>
                <div>
                    <div className="mb-1 text-xs text-neutral-500">负面词（可选，合并进 Avoid）</div>
                    <Input.TextArea value={negative} onChange={(e) => setNegative(e.target.value)} rows={2} placeholder="如：blurry, low quality, distorted" />
                </div>
                <div>
                    <div className="mb-1 text-xs text-neutral-500">预览图（可选，方便直观识别；换设备自动跟随）</div>
                    <div className="flex items-center gap-3">
                        <PreviewThumb storageKey={previewKey} className="h-16 w-16 rounded-lg border border-neutral-200 dark:border-neutral-700" />
                        <Button loading={uploading} onClick={() => fileRef.current?.click()}>{previewKey ? "更换预览图" : "上传预览图"}</Button>
                        {previewKey ? <Button type="text" danger onClick={() => setPreviewKey("")}>移除</Button> : null}
                    </div>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
                </div>
            </div>
        </Modal>
    );
}
