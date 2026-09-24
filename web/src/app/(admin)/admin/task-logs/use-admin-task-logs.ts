"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App } from "antd";

import { fetchAdminTaskLogs } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const defaultPageSize = 20;

export type TaskLogFilters = {
    keyword: string;
    type: string;
    model: string;
    member: string;
    start: string;
    end: string;
};

const emptyFilters: TaskLogFilters = { keyword: "", type: "", model: "", member: "", start: "", end: "" };

export function useAdminTaskLogs() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const clearSession = useUserStore((state) => state.clearSession);
    const [filters, setFilters] = useState<TaskLogFilters>(emptyFilters);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(defaultPageSize);

    const listQuery = useQuery({
        queryKey: ["admin", "task-logs", token, filters, page, pageSize],
        queryFn: () => fetchAdminTaskLogs(token, { ...filters, page, pageSize }),
        enabled: Boolean(token),
        retry: false,
    });

    useEffect(() => {
        if (listQuery.isError) {
            const errorMessage = listQuery.error instanceof Error ? listQuery.error.message : "读取任务日志失败";
            message.error(errorMessage);
            if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) void clearSession();
        }
    }, [clearSession, message, listQuery.error, listQuery.isError]);

    const applyFilters = (next: Partial<TaskLogFilters>) => {
        setFilters((prev) => ({ ...prev, ...next }));
        setPage(1);
    };

    const resetAll = () => {
        setFilters(emptyFilters);
        setPage(1);
        setPageSize(defaultPageSize);
    };

    return {
        logs: listQuery.data?.items || [],
        total: listQuery.data?.total || 0,
        filters,
        page,
        pageSize,
        isLoading: listQuery.isFetching,
        applyFilters,
        resetAll,
        changePage: (value: number) => setPage(value),
        changePageSize: (value: number) => {
            setPageSize(value);
            setPage(1);
        },
        refreshLogs: () => {
            void listQuery.refetch();
        },
    };
}
