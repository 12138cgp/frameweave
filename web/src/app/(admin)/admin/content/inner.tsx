"use client";

import { Suspense } from "react";

import { AdminTabHub } from "../admin-tab-hub";
import Assets from "../assets/page";
import CanvasHistory from "../canvas-history/page";
import Prompts from "../prompts/page";
import PromptFavorites from "../prompt-favorites/inner";

// 内容管理：原「素材库 / 画布历史 / 提示词管理」，加上「收藏提示词」。都是查看与维护用户产生的内容。
// 画布历史同时是出事时的还原入口，和素材库放一起，排查「用户说东西没了」时不用两头找。
//
// 收藏提示词放这里而不是单列一条菜单：它和「提示词管理」是同一件事的两面——
// 那个是平台给用户的提示词模板，这个是用户自己攒出来的好提示词，挨着看才有对比价值。
// 本 hub 的菜单项是 roles:["admin"]，所以天然只有超管进得来（后端也挂在超管专用组）。
export default function Inner() {
    return (
        <Suspense fallback={null}>
            <AdminTabHub
                tabs={[
                    { key: "assets", label: "素材库", Component: Assets },
                    { key: "history", label: "画布历史", Component: CanvasHistory },
                    { key: "prompts", label: "提示词管理", Component: Prompts },
                    { key: "favorites", label: "收藏提示词", Component: PromptFavorites },
                ]}
            />
        </Suspense>
    );
}
