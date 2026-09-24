"use client";

import dynamic from "next/dynamic";

const Inner = dynamic(() => import("./inner"), { ssr: false });

export default function AdminContentPage() {
    return <Inner />;
}
