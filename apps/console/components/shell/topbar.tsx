"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Menu } from "lucide-react";
import { DownloadCliButton } from "@/components/download-cli-button";
import { EnvSwitcher } from "@/components/env-switcher";
import { HeaderBreadcrumbs } from "@/components/header-breadcrumbs";
import { SetupGuideButton } from "@/components/onboarding/setup-guide";
import { ProjectSwitcher } from "@/components/project-switcher";
import { Button } from "@repo/ui/button";
import { AskAiButton } from "./ask-ai-button";

/**
 * The main-column topbar: project / env quick-switchers on the left, the route breadcrumb
 * centered as plain text (hidden when empty, e.g. on the org overview), and the CLI
 * download on the right.
 */
export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	return (
		<header className="relative flex h-[53px] shrink-0 items-center gap-1 border-b bg-background px-2 sm:px-4">
			<Button
				variant="ghost"
				size="icon"
				className="h-9 w-9 shrink-0 lg:hidden"
				onClick={onOpenSidebar}
				aria-label="Open navigation"
			>
				<Menu className="h-5 w-5" />
			</Button>

			<ProjectSwitcher />
			<EnvSwitcher />

			{/* Centered breadcrumb — plain text, collapses to nothing on the bare overview. */}
			<div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 md:block">
				<div className="pointer-events-auto flex items-center empty:hidden">
					<HeaderBreadcrumbs />
				</div>
			</div>

			<div className="ml-auto flex items-center gap-1.5">
				<AskAiButton />
				<SetupGuideButton />
				<DownloadCliButton />
			</div>
		</header>
	);
}
