"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useElenchStore } from "@/lib/stores/use-elench-store";

/**
 * The `/[org]/~/agent` route — a thin opener for the global Elench surface. It launches
 * Elench as a fullscreen modal in the org context (inheriting the overlay dialog style)
 * and hands off any `?prompt=` seed from the create-project hero. Closing the modal or
 * minimizing it to a panel returns to the dashboard, where the global surface keeps the
 * conversation floating.
 */
export default function AgentPage() {
	const { org } = useParams<{ org: string }>();
	const router = useRouter();
	const open = useElenchStore((s) => s.open);
	const view = useElenchStore((s) => s.view);
	const openModal = useElenchStore((s) => s.openModal);
	const setSeedPrompt = useElenchStore((s) => s.setSeedPrompt);
	const opened = useRef(false);

	// Open the modal once; seed a handed-off prompt, then strip it from the URL.
	useEffect(() => {
		const p = new URLSearchParams(window.location.search).get("prompt");
		if (p) {
			setSeedPrompt(p);
			window.history.replaceState(null, "", window.location.pathname);
		}
		openModal({ kind: "org" });
		opened.current = true;
	}, [openModal, setSeedPrompt]);

	// Once the surface is minimized to a panel or closed, leave the blank route so the
	// panel floats over the real dashboard instead of an empty page.
	useEffect(() => {
		if (opened.current && (!open || view === "panel")) router.replace(`/${org}`);
	}, [open, view, org, router]);

	return (
		<div className="flex min-h-[50vh] items-center justify-center">
			<div className="h-6 w-6 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
		</div>
	);
}
