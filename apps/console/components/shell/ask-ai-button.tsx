"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Sparkles } from "lucide-react";
import { usePathname } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { projectScope } from "./nav-config";

/**
 * The global "Ask AI" launcher — a floating pill (bottom-right, beside the setup guide)
 * mounted in the app shell so it's available on every authenticated view. Opens the Elench
 * assistant as a docked panel, scoped to the current project when inside a project workspace
 * (resolves the slug → id on click) and org-wide otherwise. Replaces the old on-canvas "AI"
 * button.
 */
export function AskAiButton() {
	const pathname = usePathname();
	const open = useElenchStore((s) => s.open);
	const openPanel = useElenchStore((s) => s.openPanel);

	const onClick = async () => {
		const scope = projectScope(pathname);
		if (scope) {
			try {
				const projectId = await resolveProjectId(scope.projectSlug);
				openPanel({ kind: "project", projectId });
				return;
			} catch {
				// Fall back to org context if the project can't be resolved.
			}
		}
		openPanel({ kind: "org" });
	};

	// Hidden while the surface is already open (the panel owns its own close control).
	if (open) return null;

	return (
		<button
			type="button"
			onClick={onClick}
			aria-label="Ask AI"
			className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground shadow-lg transition-colors hover:bg-muted"
		>
			<Sparkles className="h-4 w-4" />
			Ask AI
		</button>
	);
}
