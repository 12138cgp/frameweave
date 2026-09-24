import { useCallback, useMemo, useState } from "react";
import { APP_VERSION } from "@/constant/env";
import type { ReleaseInfo } from "@/lib/release";

// 仅使用本地打包的版本信息，不请求任何远程（GitHub）地址。
function readLocalReleases(): ReleaseInfo[] {
    try {
        return JSON.parse(process.env.NEXT_PUBLIC_APP_RELEASES || "[]");
    } catch {
        return [];
    }
}

export function useVersionCheck() {
    const currentVersion = APP_VERSION;
    const localReleases = useMemo(readLocalReleases, []);
    const [releases] = useState<ReleaseInfo[]>(localReleases);
    const [open, setOpen] = useState(false);

    const checkLatestRelease = useCallback(async (_showMessage = false) => true, []);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
    }, []);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion: currentVersion,
        releases,
        checking: false,
        hasNewVersion: false,
        checkLatestRelease,
    };
}
