"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import { deleteAdminCreditLog, fetchAdminCreditLogs, fetchAdminCreditLogsSummary, saveAdminCreditLog, type AdminCreditLog } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const defaultPageSize = 10;

export type CreditLogFilters = {
    keyword: string;
    type: string;
    model: string;
    member: string;
    start: string;
    end: string;
    source: string;
};

const emptyFilters: CreditLogFilters = { keyword: "", type: "", model: "", member: "", start: "", end: "", source: "" };

export function useAdminCreditLogs() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const token = useUserStore((state) => state.token);
    const clearSession = useUserStore((state) => state.clearSession);
    const [filters, setFilters] = useState<CreditLogFilters>(emptyFilters);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(defaultPageSize);

    const listQuery = useQuery({
        queryKey: ["admin", "credit-logs", token, filters, page, pageSize],
        queryFn: () => fetchAdminCreditLogs(token, { ...filters, page, pageSize }),
        enabled: Boolean(token),
        retry: false,
    });

    const summaryQuery = useQuery({
        queryKey: ["admin", "credit-logs-summary", token, filters],
        queryFn: () => fetchAdminCreditLogsSummary(token, filters),
        enabled: Boolean(token),
        retry: false,
    });

    const invalidateAll = async () => {
        await queryClient.invalidateQueries({ queryKey: ["admin", "credit-logs"] });
        await queryClient.invalidateQueries({ queryKey: ["admin", "credit-logs-summary"] });
    };

    const saveMutation = useMutation({
        mutationFn: (log: Partial<AdminCreditLog>) => saveAdminCreditLog(token, log),
        onSuccess: async (_, log) => {
            await invalidateAll();
            message.success(log.id ? "日志已保存" : "日志已新增");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "保存失败"),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteAdminCreditLog(token, id),
        onSuccess: async () => {
            await invalidateAll();
            message.success("日志已删除");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
    });

    useEffect(() => {
        if (listQuery.isError) {
            const errorMessage = listQuery.error instanceof Error ? listQuery.error.message : "读取日志失败";
            message.error(errorMessage);
            if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) void clearSession();
        }
    }, [clearSession, message, listQuery.error, listQuery.isError]);

    const applyFilters = (next: Partial<CreditLogFilters>) => {
        setFilters((prev) => ({ ...prev, ...next }));
        setPage(1);
    };

    const resetAll = () => {
        setFilters(emptyFilters);
        setPage(1);
        setPageSize(defaultPageSize);
    };

    // 导出：按当前筛选拉全量明细（不分页），交给页面生成 CSV。
    const fetchAllForExport = async () => {
        const res = await fetchAdminCreditLogs(token, { ...filters, all: "1" });
        return res.items;
    };

    const summary = summaryQuery.data;

    return {
        logs: listQuery.data?.items || [],
        total: listQuery.data?.total || 0,
        overall: summary?.overall,
        byMember: summary?.byMember || [],
        byModel: summary?.byModel || [],
        filters,
        page,
        pageSize,
        isLoading: listQuery.isFetching || saveMutation.isPending || deleteMutation.isPending,
        isSummaryLoading: summaryQuery.isFetching,
        applyFilters,
        resetAll,
        changePage: (value: number) => setPage(value),
        changePageSize: (value: number) => {
            setPageSize(value);
            setPage(1);
        },
        refreshLogs: () => {
            void listQuery.refetch();
            void summaryQuery.refetch();
        },
        fetchAllForExport,
        saveLog: (log: Partial<AdminCreditLog>) => saveMutation.mutateAsync(log),
        deleteLog: (id: string) => deleteMutation.mutateAsync(id),
    };
}
