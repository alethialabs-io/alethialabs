// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The mobile menu button names the organization (#6135, F028).
//
// Below `lg` the org switcher lives only in the drawer, so the closed header said nothing about
// which organization the page was in. The hamburger now carries the org's avatar, and its
// accessible name carries the org's name. Until the workspace context is there it must stay the
// bare "Open navigation" — never a guessed org, and never "Personal".
//
// The topbar's other controls are stubbed: their own names are swept by
// `shell-chrome-accessible-names.test.tsx`, and here they would only add providers to mount.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceOrg } from "@/lib/rpc/procedures/workspace";

const { active } = vi.hoisted(() => {
	const box: { current: Pick<WorkspaceOrg, "name" | "logo"> | null } = { current: null };
	return { active: box };
});

vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveWorkspaceOrg: () => active.current,
}));
vi.mock("@/components/project-switcher", () => ({ ProjectSwitcher: () => null }));
vi.mock("@/components/env-switcher", () => ({ EnvSwitcher: () => null }));
vi.mock("@/components/header-breadcrumbs", () => ({ HeaderBreadcrumbs: () => null }));
vi.mock("@/components/onboarding/setup-guide", () => ({ SetupGuideButton: () => null }));
vi.mock("@/components/download-cli-button", () => ({ DownloadCliButton: () => null }));
vi.mock("@/components/shell/ask-ai-button", () => ({ AskAiButton: () => null }));

const { Topbar } = await import("@/components/shell/topbar");

/** An org shaped like the workspace context's, with only what the button reads mattering. */
function org(name: string, logo: string | null = null): Pick<WorkspaceOrg, "name" | "logo"> {
	return { name, logo };
}

beforeEach(() => {
	active.current = null;
});

describe("the mobile menu button", () => {
	it("is named for what it does AND the org the page is in", () => {
		active.current = org("Acme Inc.");
		render(<Topbar onOpenSidebar={() => {}} />);
		const button = screen.getByRole("button", { name: "Open navigation — Acme Inc." });
		// The avatar is drawn (the monogram), but hidden from the tree: the name already says it.
		const avatar = button.querySelector('[data-slot="menu-org-avatar"]');
		expect(avatar).not.toBeNull();
		expect(avatar?.getAttribute("aria-hidden")).toBe("true");
		expect(avatar?.textContent).toContain("AI");
	});

	it("announces a logo org once — the image's alt does not repeat the name", () => {
		active.current = org("Acme Inc.", "/api/org/org_1/logo?v=1");
		render(<Topbar onOpenSidebar={() => {}} />);
		expect(
			screen.getByRole("button", { name: "Open navigation — Acme Inc." }),
		).toBeInTheDocument();
		expect(screen.queryByRole("img", { name: "Acme Inc." })).toBeNull();
	});

	it("before the workspace context is known, is the bare menu — no org, never \"Personal\"", () => {
		render(<Topbar onOpenSidebar={() => {}} />);
		const button = screen.getByRole("button", { name: "Open navigation" });
		expect(button.querySelector('[data-slot="menu-org-avatar"]')).toBeNull();
		expect(button.textContent ?? "").not.toContain("Personal");
	});
});
