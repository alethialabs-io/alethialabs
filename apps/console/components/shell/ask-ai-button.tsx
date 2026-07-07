"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { Sparkles } from "lucide-react";
import { usePathname } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { projectScope } from "./nav-config";

/**
 * The "Ask AI" launcher — a topbar action (beside the setup guide), available on every
 * authenticated view. Toggles the Elench assistant as a docked panel, scoped to the current
 * project when inside a project workspace (resolves the slug → id on click) and org-wide
 * otherwise. Replaces the old floating bottom-right pill.
 */
export function AskAiButton() {
	const pathname = usePathname();
	const togglePanel = useElenchStore((s) => s.togglePanel);

	const onClick = async () => {
		const scope = projectScope(pathname);
		if (scope) {
			try {
				const projectId = await resolveProjectId(scope.projectSlug);
				togglePanel({ kind: "project", projectId });
				return;
			} catch {
				// Fall back to org context if the project can't be resolved.
			}
		}
		togglePanel({ kind: "org" });
	};

	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={onClick}
			aria-label="Ask AI"
			className="h-9 gap-2 text-muted-foreground hover:text-foreground"
		>
			<Sparkles className="h-4 w-4" />
			<span className="hidden sm:inline">Ask AI</span>
		</Button>
	);
}
