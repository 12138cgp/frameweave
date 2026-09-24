import { apiGet, compactApiParams } from "@/services/api/request";

export type Prompt = {
    id: string;
    title: string;
    coverUrl: string;
    prompt: string;
    tags: string[];
    category: string;
    githubUrl: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
};

export const ALL_PROMPTS_OPTION = "全部";

export type PromptCategoryOption = {
    category: string;
    name: string;
    description: string;
    count: number;
};

export type PromptListResponse = {
    items: Prompt[];
    tags: string[];
    categories: string[];
    // 分类选项：category 是筛选用的编码，name 是给用户看的中文名。
    // 老接口只回 categories（编码数组），筛选栏于是显示成一串英文 slug。
    categoryOptions?: PromptCategoryOption[];
    total: number;
};

export async function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, page, pageSize }: { keyword?: string; tag?: string[]; category?: string; page?: number; pageSize?: number } = {}) {
    return apiGet<PromptListResponse>(
        "/api/prompts",
        compactApiParams({
            ...(keyword ? { keyword } : {}),
            ...(tag.length ? { tag } : {}),
            ...(category !== ALL_PROMPTS_OPTION ? { category } : {}),
            ...(page ? { page } : {}),
            ...(pageSize ? { pageSize } : {}),
        }),
    );
}

export function formatPromptDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
