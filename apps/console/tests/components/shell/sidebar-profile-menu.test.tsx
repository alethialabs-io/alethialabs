// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The account menu (#6924): what signing out does, and what the menu shows by instance edition.
//
// SIGNING OUT. The handler awaited `authClient.signOut()`, ignored its answer and pushed the router
// to "/". Three things were wrong with that. The auth client ANSWERS a failure as `{ error }`, so a
// sign-out that did not happen was treated as one that did. A router push keeps the tab's memory,
// which holds a query client per organization with the previous person's rows. And the wizard
// drafts in the tab's storage were left for whoever signs in next: `clearAllWizardDrafts()` existed
// and had no caller. The REAL `SidebarProfile` is rendered here over the real draft storage and the
// real sign-in-memory store; the auth client, the toast and the document load are the stubs.
//
// BY EDITION. The menu printed "Platform Status — All systems normal." on every instance, during
// an outage too, linking the hosted service's status page from self-managed consoles as well.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellEdition } from "@/components/shell/shell-edition";
import type { Viewer } from "@/lib/auth/viewer";

const { signOut, hardNavigate, toastError, entitled } = vi.hoisted(() => ({
	signOut: vi.fn(),
	hardNavigate: vi.fn(),
	toastError: vi.fn(),
	// What `useEntitlement("organizations")` answers: true on a paid plan, false on the free one.
	entitled: { current: true },
}));

vi.mock("next/navigation", () => ({
	usePathname: () => "/acme/~/settings/general",
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: { signOut },
	liveSession: {
		subscribe: () => () => {},
		get: () => ({ data: null, isPending: true, error: null }),
		onPossibleChange: () => () => {},
	},
}));
vi.mock("@/components/shell/hard-navigate", () => ({ hardNavigate }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));
vi.mock("@repo/privacy/consent-provider", () => ({
	useConsent: () => ({ openPreferences: vi.fn() }),
}));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({
	useEntitlement: () => entitled.current,
}));
vi.mock("@/components/theme-menu", () => ({ InlineThemeSwitcher: () => null }));
// Closed on first render; their own modules reach server actions this test has no use for.
vi.mock("@/components/shell/account-settings-dialog", () => ({ AccountSettingsDialog: () => null }));
vi.mock("@/components/shell/feedback-dialog", () => ({ FeedbackDialog: () => null }));
vi.mock("@/components/shell/notifications-popover", () => ({ NotificationsPopover: () => null }));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));

const { ViewerProvider } = await import("@/components/providers/viewer-provider");
const { ShellEditionProvider } = await import("@/components/shell/shell-edition-provider");
const { SidebarProfile } = await import("@/components/shell/sidebar-profile");
const { useAuthPrefsStore } = await import("@/lib/stores/use-auth-prefs-store");

const ADA: Viewer = {
	id: "u-ada",
	name: "Ada Lovelace",
	email: "ada@acme.test",
	image: null,
	createdAt: new Date("2026-01-15T09:00:00.000Z"),
};

const HOSTED: ShellEdition = { deployment: "hosted", edition: "enterprise", offering: "hosted" };
const SELF_HOSTED: ShellEdition = {
	deployment: "self-managed",
	edition: "community",
	offering: "self-hosted",
};

/** A wizard draft's storage key, as `lib/wizard/draft.ts` writes one. */
const WIZARD_DRAFT_KEY = "alethia:wizard:v1:new-project:u-ada:acme";
/** Something else in the tab's storage, which a sign-out has no business removing. */
const OTHER_KEY = "some-other-tab-state";

/** The profile bar under a seeded viewer, inside the shell's edition when one is given. */
function profile(edition: ShellEdition | null): ReactElement {
	const bar = (
		<ViewerProvider viewer={ADA}>
			<SidebarProfile />
		</ViewerProvider>
	);
	return edition === null ? bar : <ShellEditionProvider edition={edition}>{bar}</ShellEditionProvider>;
}

/** Renders the bar and opens the account menu. */
async function openMenu(edition: ShellEdition | null) {
	const user = userEvent.setup();
	render(profile(edition));
	await user.click(screen.getByRole("button", { name: "Account menu" }));
	await screen.findByRole("menuitem", { name: "Sign out" });
	return user;
}

beforeEach(() => {
	vi.clearAllMocks();
	entitled.current = true;
	signOut.mockResolvedValue({ data: { success: true }, error: null });
	sessionStorage.clear();
	sessionStorage.setItem(WIZARD_DRAFT_KEY, JSON.stringify({ v: 1, step: "name", at: 1, values: {} }));
	sessionStorage.setItem(OTHER_KEY, "kept");
	useAuthPrefsStore.setState({ lastMethod: "email", lastEmail: "ada@acme.test" });
});

describe("the account menu — signing out", () => {
	it("ends the session, clears the wizard drafts and the sign-in memory, and leaves with a document load", async () => {
		const user = await openMenu(HOSTED);
		await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
		await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/"));
		expect(signOut).toHaveBeenCalledTimes(1);
		// `clearAllWizardDrafts()` ran: the draft is gone from the tab's storage, and only the draft.
		expect(sessionStorage.getItem(WIZARD_DRAFT_KEY)).toBeNull();
		expect(sessionStorage.getItem(OTHER_KEY)).toBe("kept");
		expect(useAuthPrefsStore.getState().lastEmail).toBeNull();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("says it is signing out while the session is being ended, and cannot be started twice", async () => {
		let finish: (answer: { error: null }) => void = () => {};
		signOut.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const user = await openMenu(HOSTED);
		await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
		expect(await screen.findByText("Signing out…")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Account menu" })).toBeDisabled();
		// Still signed in as far as the browser knows: nothing is cleared before the server answers.
		expect(sessionStorage.getItem(WIZARD_DRAFT_KEY)).not.toBeNull();
		expect(hardNavigate).not.toHaveBeenCalled();
		finish({ error: null });
		await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/"));
		expect(signOut).toHaveBeenCalledTimes(1);
	});

	it("a sign-out the server refused leaves the person signed in, says so, and clears nothing", async () => {
		signOut.mockResolvedValue({ data: null, error: { status: 500, statusText: "error" } });
		const user = await openMenu(HOSTED);
		await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError).toHaveBeenCalledWith(
			"Couldn't sign you out. You are still signed in. Try again.",
		);
		expect(hardNavigate).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(WIZARD_DRAFT_KEY)).not.toBeNull();
		expect(useAuthPrefsStore.getState().lastEmail).toBe("ada@acme.test");
		// The bar stops saying it is signing out, and the menu can be used for another attempt.
		expect(screen.queryByText("Signing out…")).toBeNull();
		expect(screen.getByRole("button", { name: "Account menu" })).toBeEnabled();
	});

	it("a sign-out that could not reach the server is the same failure", async () => {
		signOut.mockRejectedValue(new TypeError("Failed to fetch"));
		const user = await openMenu(HOSTED);
		await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(hardNavigate).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(WIZARD_DRAFT_KEY)).not.toBeNull();
	});
});

describe("the account menu — by instance edition", () => {
	it("makes no statement about the platform's status on any edition", async () => {
		await openMenu(HOSTED);
		expect(screen.queryByText(/all systems/i)).toBeNull();
		expect(screen.queryByText(/platform status/i)).toBeNull();
	});

	it("on the hosted service: the feedback dialog, the status page and the home page", async () => {
		await openMenu(HOSTED);
		expect(screen.getByRole("menuitem", { name: "Feedback" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Report an issue" })).toBeNull();
		expect(screen.getByRole("menuitem", { name: "Status" })).toHaveAttribute(
			"href",
			"https://status.alethialabs.io",
		);
		expect(screen.getByRole("menuitem", { name: "Home page" })).toHaveAttribute("href", "/home");
	});

	it("on a self-managed instance: an issue tracker, and no status page or home page of ours", async () => {
		await openMenu(SELF_HOSTED);
		expect(screen.queryByRole("menuitem", { name: "Feedback" })).toBeNull();
		expect(screen.getByRole("menuitem", { name: "Report an issue" })).toHaveAttribute(
			"href",
			"https://github.com/alethialabs-io/alethialabs/issues/new",
		);
		expect(screen.queryByRole("menuitem", { name: "Status" })).toBeNull();
		expect(screen.queryByRole("menuitem", { name: "Home page" })).toBeNull();
		const hosted = screen
			.getAllByRole("menuitem")
			.map((item) => item.getAttribute("href") ?? "")
			.filter((href) => href.includes("alethialabs.io"));
		expect(hosted).toEqual([]);
	});

	it("outside the shell, where the edition is not known, it is the self-managed menu", async () => {
		await openMenu(null);
		expect(screen.queryByRole("menuitem", { name: "Feedback" })).toBeNull();
		expect(screen.queryByRole("menuitem", { name: "Status" })).toBeNull();
		expect(screen.getByRole("menuitem", { name: "Report an issue" })).toBeInTheDocument();
	});

	it("offers the upgrade to a free organization on the hosted service only", async () => {
		entitled.current = false;
		await openMenu(HOSTED);
		expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeInTheDocument();
	});

	it("offers no upgrade on a self-managed instance, whatever the organization's plan", async () => {
		entitled.current = false;
		await openMenu(SELF_HOSTED);
		expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
	});
});
