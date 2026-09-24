import { apiGet } from "@/services/api/request";

// 用户端：当前用户参与的、active 的项目（含积分池余额），用于画布「所属项目」选择器。
export type MyProject = {
    id: string;
    name: string;
    credits: number; // 项目池剩余
    creditsTotal: number; // 项目池总额
};

export async function getMyProjects(token: string) {
    const res = await apiGet<{ items: MyProject[] }>("/api/projects/mine", undefined, token);
    return res.items;
}
