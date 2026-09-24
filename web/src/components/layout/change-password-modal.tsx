"use client";

import { useEffect, useState } from "react";
import { App, Form, Input, Modal } from "antd";

import { changePassword } from "@/services/api/auth";
import { SESSION_EXPIRED_EVENT } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

type FormValues = {
    oldPassword: string;
    newPassword: string;
    confirmPassword: string;
};

// 修改密码弹窗：已登录用户校验旧密码后写入新密码。
// 后端要求新密码至少 8 位；前端再叠加一次确认密码，避免输错后把自己锁在外面。
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [form] = Form.useForm<FormValues>();
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const [submitting, setSubmitting] = useState(false);

    // 5 次失败强制下线场景：service 已旋转 SessionID，apiRequest 会触发 SESSION_EXPIRED_EVENT
    // → ClientRootInit 跳转登录页。但弹窗本身不会被自动关闭，会挂在跳转后的页面上。
    // 这里订阅事件主动 onClose，避免用户在登录页还看到「修改密码」弹窗。
    useEffect(() => {
        if (!open) return;
        const onExpired = () => onClose();
        window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
        return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    }, [open, onClose]);

    const handleFinish = async (values: FormValues) => {
        setSubmitting(true);
        try {
            await changePassword(token, { oldPassword: values.oldPassword, newPassword: values.newPassword });
            message.success("密码已修改");
            form.resetFields();
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "修改失败");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal title="修改密码" open={open} onCancel={onClose} confirmLoading={submitting} onOk={() => form.submit()} okText="保存" cancelText="取消" destroyOnHidden maskClosable={false}>
            <Form form={form} layout="vertical" requiredMark={false} onFinish={handleFinish} preserve={false}>
                <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: "请输入原密码" }]}>
                    <Input.Password placeholder="请输入原密码" autoComplete="current-password" />
                </Form.Item>
                <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: "请输入新密码" }, { min: 8, message: "新密码至少 8 位" }, { max: 72, message: "新密码不能超过 72 字节" }]}>
                    <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
                </Form.Item>
                <Form.Item
                    name="confirmPassword"
                    label="确认新密码"
                    dependencies={["newPassword"]}
                    rules={[
                        { required: true, message: "请再次输入新密码" },
                        ({ getFieldValue }) => ({
                            validator(_, value) {
                                if (!value || getFieldValue("newPassword") === value) {
                                    return Promise.resolve();
                                }
                                return Promise.reject(new Error("两次输入的新密码不一致"));
                            },
                        }),
                    ]}
                >
                    <Input.Password placeholder="再次输入新密码" autoComplete="new-password" />
                </Form.Item>
            </Form>
        </Modal>
    );
}
