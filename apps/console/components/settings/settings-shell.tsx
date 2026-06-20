// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { SettingsNav } from "./settings-nav";

/**
 * Two-pane settings layout (Console-style): a sticky left section-nav and the
 * section content. Stacks on mobile. Used by the settings route layout so every
 * section page renders inside the same chrome.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex w-full flex-col gap-8 lg:flex-row lg:gap-12">
			<aside className="lg:w-56 lg:shrink-0">
				<div className="lg:sticky lg:top-4">
					<SettingsNav />
				</div>
			</aside>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}
