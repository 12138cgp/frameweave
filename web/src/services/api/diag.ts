import { apiPost } from "./request";

import { useUserStore } from "@/stores/use-user-store";

// 诊断上报：画布持久化被 skipNextPersistRef 吞掉了一次。纯观测，见 handler/diag.go 的说明。
// 失败一律吞掉——诊断绝不能影响正常流程，更不能因为它给用户弹错误。
export async function reportPersistSwallow(payload: { projectId: string; reason: string; nodeCount: number; changed: string[] }) {
    try {
        const token = useUserStore.getState().token;
        if (!token) return;
        await apiPost("/api/diag/persist-swallow", payload, token);
    } catch {
        /* 静默 */
    }
}
