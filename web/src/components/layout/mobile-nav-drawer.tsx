"use client";

import { Drawer } from "antd";
import Link from "next/link";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    return (
        <Drawer title={<span className="font-heading text-base tracking-wide">导航</span>} placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            <div className="space-y-1.5">
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    return (
                        <Link
                            key={tool.slug}
                            href={`/${tool.slug}`}
                            onClick={onClose}
                            className={cn(
                                "flex items-center gap-3 rounded-xl px-3.5 py-3 text-[15px] leading-6 transition-colors duration-200",
                                active ? "bg-accent font-medium !text-foreground" : "!text-muted-foreground hover:bg-accent/60 hover:!text-foreground",
                            )}
                        >
                            {tool.iconSrc ? <img src={tool.iconSrc} alt="" className="size-6 shrink-0 rounded-md object-cover" /> : <Icon className="size-5" />}
                            <span className="truncate">{tool.label}</span>
                        </Link>
                    );
                })}
            </div>
        </Drawer>
    );
}
