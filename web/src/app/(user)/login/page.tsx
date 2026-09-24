"use client";

import { LockOutlined, MobileOutlined, UserOutlined } from "@/components/icons";
import { App, Button, Form, Input, Segmented, Space, Tabs } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { APP_NAME } from "@/constant/env";
import { Suspense, useCallback, useEffect, useState } from "react";

import { fetchCurrentUser, sendSmsCode, type SendSmsCodePayload } from "@/services/api/auth";
import { flushCloudSync } from "@/services/cloud-sync";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type LoginFormValues = {
    username: string;
    password: string;
    confirmPassword?: string;
};

type SmsFormValues = {
    phone: string;
    code: string;
};

// 仅放行站内相对路径，拦截开放重定向。浏览器会忽略 URL 中的 Tab/换行/回车，并把
// //host 或 /\host 解析为协议相对的跨站地址，因此先剥离控制字符，再拒绝 // 与 /\ 前缀。
function safeRedirect(value: string | null): string {
    const cleaned = (value ?? "").replace(/[\t\n\r]/g, "");
    if (!cleaned.startsWith("/") || cleaned.startsWith("//") || cleaned.startsWith("/\\")) {
        return "/";
    }
    return cleaned;
}

export default function LoginPage() {
    return (
        <Suspense fallback={null}>
            <LoginContent />
        </Suspense>
    );
}

function LoginContent() {
    const { message } = App.useApp();
    const router = useRouter();
    const searchParams = useSearchParams();
    const login = useUserStore((state) => state.login);
    const register = useUserStore((state) => state.register);
    const smsLogin = useUserStore((state) => state.smsLogin);
    const setSession = useUserStore((state) => state.setSession);
    const isLoading = useUserStore((state) => state.isLoading);
    const allowRegister = useConfigStore((state) => state.publicSettings?.auth?.allowRegister !== false);
    const smsCodeEnabled = useConfigStore((state) => state.publicSettings?.auth?.smsCode !== false);
    const [mode, setMode] = useState<"login" | "register">("login");
    const [registerError, setRegisterError] = useState("");
    const [tab, setTab] = useState<"password" | "sms">("password");
    const [countdown, setCountdown] = useState(0);
    const [smsLoading, setSmsLoading] = useState(false);
    const redirect = safeRedirect(searchParams.get("redirect"));
    const [passwordForm] = Form.useForm<LoginFormValues>();
    const [smsForm] = Form.useForm<SmsFormValues>();
    // 独立的 state 用于保存手机号输入，绕过 Form 条件渲染导致的 getFieldValue 失效问题
    const [smsPhoneInput, setSmsPhoneInput] = useState("");

    useEffect(() => {
        const token = searchParams.get("token");
        const error = searchParams.get("error");
        if (error) message.error(error);
        if (!token) return;
        void fetchCurrentUser(token).then((user) => {
            setSession(token, user);
            message.success("登录成功");
            router.replace(redirect);
            router.refresh();
        });
    }, [message, redirect, router, searchParams, setSession]);

    useEffect(() => {
        if (!allowRegister && mode === "register") setMode("login");
    }, [allowRegister, mode]);

    // 验证码登录被关闭时，若停留在短信 tab 则切回账号密码
    useEffect(() => {
        if (!smsCodeEnabled && tab === "sms") setTab("password");
    }, [smsCodeEnabled, tab]);

    // 验证码倒计时
    useEffect(() => {
        if (countdown <= 0) return;
        const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
        return () => clearTimeout(timer);
    }, [countdown]);

    // 发送短信验证码
    const handleSendSmsCode = useCallback(async () => {
        // 直接从独立的 state 中获取，确保值的可靠获取
        const phone = smsPhoneInput.trim();
        if (!/^1\d{10}$/.test(phone)) {
            message.error("请输入正确的手机号");
            return;
        }
        setSmsLoading(true);
        try {
            const payload: SendSmsCodePayload = { phone };
            await sendSmsCode(payload);
            setCountdown(60);
            message.success("验证码已发送");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "发送失败";
            message.error(detail);
        } finally {
            setSmsLoading(false);
        }
    }, [message, smsPhoneInput]);

    // 账号密码表单提交
    const submitPassword = async (values: LoginFormValues) => {
        setRegisterError("");
        try {
            if (mode === "register" && !allowRegister) {
                message.error("当前未开放注册");
                return;
            }
            if (mode === "register" && values.password !== values.confirmPassword) {
                message.error("两次输入的密码不一致");
                return;
            }
            // 切账号:登录前若还握着上一个账号的 token,先把它没推的编辑推上云(用旧 token),再登入新账号;8s 上限,不卡登录。
            if (useUserStore.getState().token) {
                await Promise.race([flushCloudSync(), new Promise((resolve) => setTimeout(resolve, 8000))]);
            }
            const action = mode === "register" ? register : login;
            const user = await action({ username: values.username, password: values.password });
            message.success(mode === "register" ? "注册成功" : "登录成功");
            router.replace(redirect);
            router.refresh();
            if (user.role !== "admin" && user.role !== "admin_l2") router.replace("/");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "登录失败";
            if (mode === "register" && detail.indexOf("用户名已存在") !== -1) {
                setRegisterError(detail);
            } else {
                message.error(detail);
            }
        }
    };

    // 手机验证码表单提交
    const submitSms = async (values: SmsFormValues) => {
        try {
            if (!/^1\d{10}$/.test(values.phone)) {
                message.error("请输入正确的手机号");
                return;
            }
            if (!values.code) {
                message.error("请输入验证码");
                return;
            }
            // 切账号:登录前若还握着上一个账号的 token,先把它没推的编辑推上云(用旧 token),再登入新账号;8s 上限,不卡登录。
            if (useUserStore.getState().token) {
                await Promise.race([flushCloudSync(), new Promise((resolve) => setTimeout(resolve, 8000))]);
            }
            const user = await smsLogin({ phone: values.phone, code: values.code });
            message.success("登录成功");
            router.replace(redirect);
            router.refresh();
            if (user.role !== "admin" && user.role !== "admin_l2") router.replace("/");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "登录失败";
            message.error(detail);
        }
    };

    return (
        <main className="bg-paper-grid flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto bg-background px-6 py-10">
            <section className="paper-card paper-frame anim-rise relative w-full max-w-[440px] p-8 sm:p-10">
                <div className="mb-7 text-center">
                    <img src="/logo-mark.svg" alt={APP_NAME} className="mx-auto mb-4 size-14 rounded-xl" />
                    <h1 className="font-heading text-3xl font-medium tracking-wide text-stone-950 dark:text-stone-100">{`登录 ${APP_NAME}`}</h1>
                    <p className="mt-3 text-base leading-7 text-stone-500 dark:text-stone-400">
                        支持{["账号密码", ...(smsCodeEnabled ? ["手机验证码"] : [])].join("、")}登录。
                    </p>
                </div>

                <Tabs
                    activeKey={tab}
                    onChange={(key) => setTab(key as "password" | "sms")}
                    centered
                    items={[
                        {
                            key: "password",
                            label: "账号密码",
                        },
                        ...(smsCodeEnabled ? [{ key: "sms", label: "手机验证码" }] : []),
                    ]}
                />

                {tab === "password" ? (
                    <Form<LoginFormValues>
                        form={passwordForm}
                        layout="vertical"
                        size="large"
                        requiredMark={false}
                        className="mt-4"
                        onFinish={submitPassword}
                    >
                        <Form.Item>
                            <Segmented
                                block
                                value={mode}
                                onChange={(value) => setMode(value as "login" | "register")}
                                options={allowRegister ? [{ label: "登录", value: "login" }, { label: "注册", value: "register" }] : [{ label: "登录", value: "login" }]}
                            />
                        </Form.Item>
                        <Form.Item
                            name="username"
                            label={<span className="font-medium text-stone-800 dark:text-stone-200">用户名</span>}
                            rules={[{ required: true, message: "请输入用户名" }]}
                        >
                            <Input prefix={<UserOutlined />} autoComplete="username" />
                        </Form.Item>
                        {mode === "register" && registerError ? (
                            <div className="-mt-1 mb-3 text-sm text-[#DC2626] dark:text-[#EF4444]">{registerError}</div>
                        ) : null}
                        <Form.Item
                            name="password"
                            label={<span className="font-medium text-stone-800 dark:text-stone-200">密码</span>}
                            rules={[{ required: true, message: "请输入密码" }]}
                        >
                            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
                        </Form.Item>
                        {mode === "register" ? (
                            <Form.Item
                                name="confirmPassword"
                                label={<span className="font-medium text-stone-800 dark:text-stone-200">确认密码</span>}
                                rules={[{ required: true, message: "请再次输入密码" }]}
                            >
                                <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
                            </Form.Item>
                        ) : null}
                        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                            <Button block type="primary" htmlType="submit" loading={isLoading} className="hover-lift">
                                {mode === "register" ? "注册" : "登录"}
                            </Button>
                        </Space>
                    </Form>
                ) : (
                    <Form<SmsFormValues>
                        form={smsForm}
                        layout="vertical"
                        size="large"
                        requiredMark={false}
                        className="mt-4"
                        onFinish={submitSms}
                    >
                        <Form.Item
                            name="phone"
                            label={<span className="font-medium text-stone-800 dark:text-stone-200">手机号</span>}
                            rules={[
                                { required: true, message: "请输入手机号" },
                                // antd 的 pattern 规则要 RegExp；传字符串不但类型报错，校验本身也不生效（前端手机号格式形同虚设）
                                { pattern: /^1\d{10}$/, message: "请输入正确的手机号" },
                            ]}
                        >
                            <Input
                                prefix={<MobileOutlined />}
                                placeholder="请输入手机号"
                                maxLength={11}
                                value={smsPhoneInput}
                                onChange={(e) => setSmsPhoneInput(e.target.value)}
                            />
                        </Form.Item>
                        <Form.Item
                            name="code"
                            label={<span className="font-medium text-stone-800 dark:text-stone-200">验证码</span>}
                            rules={[{ required: true, message: "请输入验证码" }]}
                        >
                            <Space.Compact style={{ width: "100%" }}>
                                <Input prefix={<LockOutlined />} placeholder="请输入验证码" maxLength={6} style={{ width: "calc(100% - 120px)" }} />
                                <Button
                                    onClick={handleSendSmsCode}
                                    loading={smsLoading}
                                    disabled={countdown > 0}
                                    style={{ width: "120px" }}
                                >
                                    {countdown > 0 ? `${countdown}s 后重试` : "获取验证码"}
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                            <Button block type="primary" htmlType="submit" loading={isLoading} className="hover-lift">
                                登录 / 注册
                            </Button>
                            <p className="text-center text-xs text-stone-400 dark:text-stone-500">
                                未注册的手机号将自动创建账号
                            </p>
                        </Space>
                    </Form>
                )}
            </section>
        </main>
    );
}
