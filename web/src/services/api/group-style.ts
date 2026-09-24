import axios from "axios";

import { apiGet, apiDelete } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

// 团队共享风格：同组成员都能选用；分享者本人或管理员可取消共享。
// 与「我的风格」的区别：后者存在个人 presets 云同步域里（私有），这里走服务端表、按 group_id 可见。

export type GroupStyleKind = "image" | "video";

export type GroupStyle = {
    id: string;
    groupId: string;
    ownerUserId: string;
    ownerName: string;
    kind: GroupStyleKind;
    nameZh: string;
    description: string;
    prefixPrompt: string;
    injectPrompt: string;
    negativePrompt: string;
    previewUrl: string;
    previewMimeType: string;
    sourceStyleId: string;
    createdAt: string;
    updatedAt: string;
};

function token() {
    const value = useUserStore.getState().token;
    if (!value) throw new Error("请先登录");
    return value;
}

export async function listGroupStyles() {
    return apiGet<GroupStyle[]>("/api/v1/group-styles", undefined, token());
}

export type ShareGroupStyleInput = {
    kind: GroupStyleKind;
    sourceStyleId: string;
    nameZh: string;
    description?: string;
    prefixPrompt?: string;
    injectPrompt: string;
    negativePrompt?: string;
    /** 预览图字节。必须一并上传：跨账号只回退公共读桶，落在磁盘上的预览图组内其他人取不到。 */
    preview?: Blob;
};

export async function shareGroupStyle(input: ShareGroupStyleInput) {
    const body = new FormData();
    body.append("kind", input.kind);
    body.append("source_style_id", input.sourceStyleId);
    body.append("name_zh", input.nameZh);
    body.append("inject_prompt", input.injectPrompt);
    if (input.description) body.append("description", input.description);
    if (input.prefixPrompt) body.append("prefix_prompt", input.prefixPrompt);
    if (input.negativePrompt) body.append("negative_prompt", input.negativePrompt);
    if (input.preview) body.append("preview", input.preview, "preview.png");
    const response = await axios.post("/api/v1/group-styles", body, { headers: { Authorization: `Bearer ${token()}` }, validateStatus: () => true });
    const payload = response.data as { code?: number; data?: GroupStyle; msg?: string };
    if (!payload || payload.code !== 0 || !payload.data) throw new Error(payload?.msg || "分享到团队失败");
    return payload.data;
}

export async function deleteGroupStyle(id: string) {
    return apiDelete<{ ok: boolean }>(`/api/v1/group-styles/${encodeURIComponent(id)}`, token());
}
