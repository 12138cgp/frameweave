import { Home, LogIn } from "@/components/icons";
import Link from "next/link";

export default function NotFound() {
    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <main className="bg-paper-grid flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-10">
                <section className="anim-rise w-full max-w-md text-center">
                    <div className="font-heading text-[96px] font-medium leading-none tracking-wide text-foreground/90 select-none">404</div>
                    <h1 className="mt-6 font-heading text-2xl font-medium tracking-wide">页面不存在</h1>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">这个地址没有对应的页面，可能已经移动或被合并到其他入口。</p>
                    <div className="mt-10 flex flex-wrap justify-center gap-3">
                        <Link
                            href="/"
                            className="hover-lift inline-flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground transition-colors hover:bg-[#1D4ED8] dark:hover:bg-[#60A5FA]"
                        >
                            <Home className="size-4" />
                            返回首页
                        </Link>
                        <Link
                            href="/login"
                            className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-card px-5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                        >
                            <LogIn className="size-4" />
                            去登录
                        </Link>
                    </div>
                </section>
            </main>
        </div>
    );
}
