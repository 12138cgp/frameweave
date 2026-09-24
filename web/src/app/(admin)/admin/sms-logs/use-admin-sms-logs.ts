"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App } from "antd";

import { fetchAdminSmsLogs, type SmsLog, type SmsLogSummary, type SmsLogStatus } from "@/services/api/sms-logs";
import { useUserStore } from "@/stores/use-user-store";

const defaultPageSize = 10;

export type SmsLogFilters = {
    start: string;
    end: string;
    keyword: string;
    status: string;
    ip: string;
};

const emptyFilters: SmsLogFilters = { start: "", end: "", keyword: "", status: "", ip: "" };

export function useAdminSmsLogs() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const clearSession = useUserStore((state) => state.clearSession);
    const [filters, setFilters] = useState<SmsLogFilters>(emptyFilters);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(defaultPageSize);

    const listQuery = useQuery({
        queryKey: ["admin", "sms-logs", token, filters, page, pageSize],
        queryFn: () =>
            fetchAdminSmsLogs(token, {
                start: filters.start,
                end: filters.end,
                keyword: filters.keyword,
                ip: filters.ip,
                type: filters.status as SmsLogStatus | "",
                page,
                pageSize,
            }),
        enabled: Boolean(token),
        retry: false,
    });

    useEffect(() => {
        if (listQuery.isError) {
            const errorMessage = listQuery.error instanceof Error ? listQuery.error.message : "短信记录加载失败";
            message.error(errorMessage);
            if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) void clearSession();
        }
    }, [clearSession, message, listQuery.error, listQuery.isError]);

    const applyFilters = (next: Partial<SmsLogFilters>) => {
        setFilters((prev) => ({ ...prev, ...next }));
        setPage(1);
    };

    const resetAll = () => {
        setFilters(emptyFilters);
        setPage(1);
        setPageSize(defaultPageSize);
    };

    return {
        items: listQuery.data?.items || [],
        total: listQuery.data?.total || 0,
        summary: listQuery.data?.summary,
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
        refresh: () => {
            void listQuery.refetch();
        },
        fetchAllForExport: async () => {
            const res = await fetchAdminSmsLogs(token, {
                start: filters.start,
                end: filters.end,
                keyword: filters.keyword,
                ip: filters.ip,
                type: filters.status as SmsLogStatus | "",
                all: "1",
                page: 1,
                pageSize: 10000,
            });
            return res.items;
        },
    };
}

export type { SmsLog, SmsLogSummary };
