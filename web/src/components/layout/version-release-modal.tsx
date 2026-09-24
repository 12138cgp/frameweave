"use client";

import type { CSSProperties } from "react";
import { Modal, Tag, Timeline } from "antd";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION } from "@/constant/env";

function getTagColor(type: string) {
    if (type === "新增") return "green";
    if (type === "修复") return "red";
    if (type === "调整") return "blue";
    if (type === "文档") return "purple";
    return "default";
}

function getReleaseTitle(version: string) {
    return version === "Unreleased" ? "未发布" : version;
}

type VersionReleaseModalProps = {
    className?: string;
    style?: CSSProperties;
};

export function VersionReleaseModal({ className, style }: VersionReleaseModalProps) {
    const { open, setOpen, openReleaseModal, latestVersion, releases, checking, hasNewVersion, checkLatestRelease } = useVersionCheck();

    return (
        <>
            <button
                type="button"
                className={className || "shrink-0 cursor-pointer text-xs font-medium tabular-nums text-muted-foreground transition-colors duration-[180ms] hover:text-foreground"}
                style={style}
                onClick={openReleaseModal}
                title="查看版本更新"
            >
                <span className="relative inline-flex">
                    {APP_VERSION}
                    {hasNewVersion ? <span className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-brand" /> : null}
                </span>
            </button>
            <Modal title={<span className="font-heading text-lg font-medium tracking-wide">版本更新</span>} open={open} width={680} centered footer={null} onCancel={() => setOpen(false)}>
                <div className="mb-6 mt-1 grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-border bg-card/60 px-4 py-3">
                        <div className="text-xs text-muted-foreground">当前版本</div>
                        <div className="mt-1.5 font-heading text-base font-medium tabular-nums tracking-wide text-foreground">{APP_VERSION}</div>
                    </div>
                    <div className="rounded-xl border border-border bg-card/60 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-muted-foreground">最新版本</div>
                            <button
                                type="button"
                                className="cursor-pointer bg-transparent p-0 text-[11px] font-normal text-muted-foreground/80 underline-offset-2 transition-colors duration-[180ms] hover:text-foreground hover:underline"
                                onClick={() => void checkLatestRelease(true)}
                            >
                                {checking ? "检查中..." : "检查更新"}
                            </button>
                        </div>
                        <div className="mt-1.5 font-heading text-base font-medium tabular-nums tracking-wide text-foreground">{latestVersion}</div>
                    </div>
                </div>
                <div className="max-h-[56vh] overflow-y-auto pr-2">
                    <Timeline
                        items={releases.map((release) => ({
                            content: (
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-heading text-sm font-medium tracking-wide text-foreground">{getReleaseTitle(release.version)}</span>
                                        <span className="text-xs text-muted-foreground">{release.date}</span>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {release.version === latestVersion ? <Tag color="green">最新</Tag> : null}
                                            {release.version === APP_VERSION ? <Tag>当前</Tag> : null}
                                        </div>
                                    </div>
                                    <div className="mt-2.5 space-y-2">
                                        {release.items.map((item, index) => (
                                            <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-foreground/80">
                                                <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                                    {item.type}
                                                </Tag>
                                                <span className="min-w-0 flex-1">{item.content}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ),
                        }))}
                    />
                </div>
            </Modal>
        </>
    );
}
