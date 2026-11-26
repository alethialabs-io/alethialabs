// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The consent screen's 22 states (AGT-L2, SPEC §5b), each rendered from the read it comes from, with
// the spec's copy — and the consent rules: nothing is ticked that the role cannot use, Ask to destroy
// is never ticked for the person, an org that refuses the app locks Allow, and what is submitted is
// exactly what was offered and ticked.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentScope } from "@/lib/approvals/types";

const h = vi.hoisted(() => ({
	answer: vi.fn(),
	navigate: vi.fn(),
	signOut: vi.fn(),
}));

vi.mock("@/app/server/actions/agents/consent", () => ({ answerAgentConsent: h.answer }));
vi.mock("@/components/shell/hard-navigate", () => ({ hardNavigate: h.navigate }));
vi.mock("@/components/shell/sign-out", () => ({ signOutOfConsole: h.signOut }));
vi.mock("@/components/auth/auth-shell", () => ({ AUTH_SHELL_SIGN_OUT_FAILED: "Couldn't sign you out." }));
vi.mock("@/lib/auth/client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("@/lib/stores/use-auth-prefs-store", () => ({ useAuthPrefsStore: { getState: () => ({ forget: vi.fn() }) } }));
vi.mock("@/lib/wizard/draft", () => ({ clearAllWizardDrafts: vi.fn() }));

import { ConsentScreen, DENIED_REDIRECT_MS } from "@/components/auth/consent/consent-screen";
import { ConsentSkeleton } from "@/components/auth/consent/consent-skeleton";
import type { ConsentOrgView, ConsentView, ReadyConsent } from "@/components/auth/consent/consent-model";
import { agentAppIdentity } from "@/lib/agents/catalog";

const ALL: AgentScope[] = ["read", "design", "plan", "apply", "destroy"];
const ACCOUNT = { name: "Dana Petrova", email: "dana@acme.io", image: null };
const QUERY = "client_id=x&sig=s&exp=1";

/** One org. */
function org(id: string, extra: Partial<ConsentOrgView> = {}): ConsentOrgView {
	return {
		id,
		name: id,
		role: "admin",
		roleLabel: "Admin",
		personal: false,
		refusal: null,
		agentsKeptOffProduction: false,
		roleAllows: ALL,
		grantable: ALL,
		projects: [
			{ id: `${id}-p1`, name: "payments-api" },
			{ id: `${id}-p2`, name: "web" },
		],
		existing: null,
		...extra,
	};
}

const VIEWER_GLOBEX = org("globex", { role: "viewer", roleLabel: "Viewer", roleAllows: ["read"], grantable: ["read"] });

/** A ready read: Claude Code, verified, asking for every permission, in acme and globex. */
function ready(extra: Partial<ReadyConsent> = {}): ReadyConsent {
	return {
		state: "ready",
		clientId: "https://claude.ai/code/client.json",
		identity: agentAppIdentity({ clientId: "https://claude.ai/code/client.json", name: null, icon: null }),
		verified: true,
		redirectHost: "localhost:33418",
		requested: { agent: ALL, oidc: ["openid", "profile"], unknown: [] },
		orgs: [org("acme"), VIEWER_GLOBEX],
		...extra,
	};
}

/** Renders the screen for `view`. */
function show(view: ConsentView) {
	return render(<ConsentScreen view={view} account={ACCOUNT} oauthQuery={QUERY} manageHref="/dashboard/settings/connected" />);
}

const allow = (name: RegExp | string = /^Allow$/) => screen.getByRole("button", { name });
const checkbox = (label: string) => screen.getByRole("checkbox", { name: label });
/** A control is disabled natively or, for the base-ui checkbox, through aria-disabled. */
const isDisabled = (el: HTMLElement) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

beforeEach(() => {
	h.answer.mockReset();
	h.navigate.mockReset();
	h.signOut.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("1 · default, verified app, two orgs", () => {
	it("names the account, the app and its publisher, and the orgs with the role in each", () => {
		show(ready());
		expect(screen.getByRole("heading", { level: 1, name: "Let Claude Code work in Alethia?" })).toBeTruthy();
		expect(screen.getByText("It will act as you and never do more than you can.")).toBeTruthy();
		expect(screen.getByText("dana@acme.io")).toBeTruthy();
		expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
		expect(screen.getByText(/which publishes this app's identity/).textContent).toContain("Verified by claude.ai");
		const orgs = screen.getByRole("radiogroup", { name: "Organization" });
		expect(within(orgs).getAllByRole("radio")).toHaveLength(2);
		expect(within(orgs).getByText("Your role: Admin")).toBeTruthy();
		expect(screen.getByText("Claude Code can only see the one you choose. Connect again to use another.")).toBeTruthy();
		expect(screen.getByText(/also gets your name and email/).textContent).toContain("Settings → Connected agents");
	});

	it("ticks every requested permission the role can use except Ask to destroy", () => {
		show(ready());
		for (const label of ["See your projects", "Change designs", "Run plans", "Ask to deploy"]) {
			expect(checkbox(label).getAttribute("aria-checked")).toBe("true");
		}
		expect(checkbox("Ask to destroy").getAttribute("aria-checked")).toBe("false");
		expect(allow().hasAttribute("disabled")).toBe(false);
		expect(screen.getByText("Untick anything you don't want to allow.")).toBeTruthy();
	});
});

describe("2 · many orgs", () => {
	it("searches a scrolling list past five, and says when nothing matches", async () => {
		const orgs = ["acme", "globex", "initech", "hooli", "tyrell", "cyberdyne", "aperture"].map((id) => org(id));
		show(ready({ orgs }));
		const search = screen.getByPlaceholderText("Search your 7 organizations");
		expect(screen.getByRole("searchbox", { name: "Search organizations" })).toBe(search);
		await userEvent.type(search, "hoo");
		expect(screen.getAllByRole("radio").filter((r) => r.getAttribute("name") === "consent-org")).toHaveLength(1);
		await userEvent.clear(search);
		await userEvent.type(search, "zzz");
		expect(screen.getByText("No organization matches.")).toBeTruthy();
	});
});

describe("3 · no org (personal workspace)", () => {
	it("shows the workspace instead of a picker", () => {
		const personal = org("user-1", { name: "Personal", personal: true, roleLabel: "Owner", projects: [] });
		show(ready({ orgs: [personal] }));
		expect(screen.queryByRole("radiogroup", { name: "Organization" })).toBeNull();
		expect(screen.getByText("Your personal workspace")).toBeTruthy();
		expect(screen.getByText("You aren't in an organization. Claude Code works in your personal workspace.")).toBeTruthy();
		expect(screen.getByText("Your workspace has no projects yet. Claude Code will see the ones you create.")).toBeTruthy();
	});
});

describe("4 · unknown or unverified app", () => {
	it("shows the self-given name, the redirect host, a strong alert and the unverified button", () => {
		const identity = agentAppIdentity({ clientId: "abc123", name: "Release helper", icon: "https://evil.example/claude.png" });
		show(ready({ identity, verified: false, redirectHost: "localhost:5173" }));
		expect(screen.getByRole("heading", { level: 1, name: "Let Release helper work in Alethia?" })).toBeTruthy();
		expect(screen.getByText(/name given by the app/)).toBeTruthy();
		expect(screen.getByText(/Alethia couldn't confirm who publishes this app/).textContent).toContain(
			"After you allow, you'll be sent to localhost:5173.",
		);
		// A self-asserted icon is never drawn: the neutral glyph is.
		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.getByText("Only allow apps you set up yourself")).toBeTruthy();
		expect(allow("Allow unverified app")).toBeTruthy();
	});
});

describe("5 · app not on the org's allow-list", () => {
	it("marks the org, locks every control and Allow until another org is chosen", async () => {
		const acme = org("acme", { refusal: "client_not_allowed" });
		show(ready({ orgs: [acme, org("globex")], identity: agentAppIdentity({ clientId: "https://windsurf.com/c.json", name: "Windsurf", icon: null }) }));
		// The screen opens on the org that allows the app; choose acme.
		fireEvent.click(screen.getByRole("radio", { name: /acme/ }));
		expect(screen.getByText("Not allowed")).toBeTruthy();
		expect(screen.getByText("acme doesn't allow Windsurf")).toBeTruthy();
		expect(
			screen.getByText(
				"acme only lets approved apps act as agents. Choose another organization, or ask someone who manages agents in acme to add Windsurf.",
			),
		).toBeTruthy();
		expect(allow().hasAttribute("disabled")).toBe(true);
		expect(isDisabled(checkbox("See your projects"))).toBe(true);
		fireEvent.click(screen.getByRole("radio", { name: /globex/ }));
		expect(allow().hasAttribute("disabled")).toBe(false);
	});
});

describe("6 · agent access off in the org", () => {
	it("says so and disables Allow", () => {
		show(ready({ orgs: [org("acme", { refusal: "agent_access_disabled" })] }));
		expect(screen.getByText("Agents are turned off in acme")).toBeTruthy();
		expect(
			screen.getByText("Someone who manages agents in acme has turned agent access off. Choose another organization, or ask them."),
		).toBeTruthy();
		expect(allow().hasAttribute("disabled")).toBe(true);
	});
});

describe("7 · org keeps agents off production", () => {
	it("informs and leaves Allow enabled", () => {
		show(ready({ orgs: [org("acme", { agentsKeptOffProduction: true })] }));
		expect(screen.getByText("acme keeps agents off production")).toBeTruthy();
		expect(screen.getByText("Claude Code can plan production environments, but only a person can deploy or destroy them.")).toBeTruthy();
		expect(allow().hasAttribute("disabled")).toBe(false);
	});
});

describe("8 · a permission the role can't use", () => {
	it("is unticked and disabled, with the reason", () => {
		show(ready({ orgs: [VIEWER_GLOBEX] }));
		const deploy = checkbox("Ask to deploy");
		expect(deploy.getAttribute("aria-checked")).toBe("false");
		expect(isDisabled(deploy)).toBe(true);
		expect(screen.getByText("Your role in globex (Viewer) can't deploy, so this isn't offered.")).toBeTruthy();
		expect(checkbox("See your projects").getAttribute("aria-checked")).toBe("true");
	});
});

describe("9 · zero projects", () => {
	it("offers only all projects", () => {
		show(ready({ orgs: [org("acme", { projects: [] })] }));
		expect(screen.getByText("acme has no projects yet. Claude Code will see the ones you create.")).toBeTruthy();
		expect(screen.queryByText("Only these projects")).toBeNull();
	});
});

describe("10 · many projects", () => {
	it("searches the projects, lists the chosen ones, and blocks Allow when none is chosen", async () => {
		const names = ["auth-service", "billing-worker", "checkout-api", "data-lake", "edge-proxy", "email-sender", "web"];
		show(ready({ orgs: [org("acme", { projects: names.map((n) => ({ id: n, name: n })) })] }));
		fireEvent.click(screen.getByRole("radio", { name: "Only these projects" }));
		expect(screen.getByText("Choose at least one project, or allow all.")).toBeTruthy();
		expect(allow().hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("None chosen yet.")).toBeTruthy();
		await userEvent.type(screen.getByPlaceholderText("Search 7 projects"), "check");
		fireEvent.click(checkbox("checkout-api"));
		expect(screen.getByText("1 chosen: checkout-api")).toBeTruthy();
		expect(allow().hasAttribute("disabled")).toBe(false);
	});
});

describe("11 · re-consent with an existing grant", () => {
	it("marks the changes, sums them up and offers Update connection", () => {
		const existing = { scopes: ["read", "design", "plan", "apply"] satisfies AgentScope[], projectIds: null, createdAt: "2026-11-03T10:00:00Z" };
		show(ready({ orgs: [org("acme", { existing })] }));
		expect(screen.getByText("You connected Claude Code to acme on 3 Nov 2026")).toBeTruthy();
		expect(screen.getByText("Allowing replaces that connection with the choices below. Changes are marked.")).toBeTruthy();
		fireEvent.click(checkbox("Ask to destroy"));
		fireEvent.click(checkbox("Change designs"));
		expect(screen.getByText("New")).toBeTruthy();
		expect(screen.getByText("Removing")).toBeTruthy();
		const box = screen.getByText("What changes").parentElement;
		if (!box) throw new Error("no changes box");
		expect(box.textContent).toContain("Adds Ask to destroy");
		expect(box.textContent).toContain("Removes Change designs");
		expect(box.textContent).toContain("Projects stay: all projects");
		expect(screen.getByText("Currently: all projects. No change.")).toBeTruthy();
		expect(allow("Update connection")).toBeTruthy();
	});
});

describe("12 · scopes beyond the known set", () => {
	it("names them as not offered", () => {
		show(ready({ requested: { agent: ["read", "plan"], oidc: ["openid"], unknown: ["billing:write", "admin"] } }));
		expect(screen.getByText("Not offered by Alethia")).toBeTruthy();
		expect(screen.getByText(/also asked for/).textContent).toBe(
			"Claude Code also asked for billing:write and admin. Alethia has no such permissions, so they won't be granted.",
		);
		expect(screen.queryByRole("checkbox", { name: "Ask to deploy" })).toBeNull();
	});
});

describe("13 · no Alethia scopes at all", () => {
	it("is a message page with Deny and the setup guide", () => {
		show(ready({ requested: { agent: [], oidc: ["openid", "profile"], unknown: [] } }));
		expect(screen.getByRole("heading", { level: 1, name: "Claude Code didn't ask for any Alethia permissions" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Allow/ })).toBeNull();
		expect(screen.getByRole("link", { name: "Setup guide" }).getAttribute("href")).toBe("/docs/agents/claude-code");
	});
});

describe("14 · wrong account", () => {
	it("switches through a message that keeps the request, and Back returns to the form", async () => {
		h.signOut.mockResolvedValue("signed-out");
		show(ready());
		fireEvent.click(screen.getByRole("button", { name: "Not you? Switch account" }));
		expect(screen.getByRole("heading", { level: 1, name: "Sign in with another account" })).toBeTruthy();
		expect(screen.getByText("You'll come straight back here to finish connecting Claude Code. Nothing has been granted yet.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByRole("heading", { level: 1, name: "Let Claude Code work in Alethia?" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Not you? Switch account" }));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Sign in with another account" }));
		});
		const effects = h.signOut.mock.calls[0]?.[0];
		effects.leave("/");
		expect(h.navigate).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(`/auth/oauth/consent?${QUERY}`)}`);
		expect(h.answer).not.toHaveBeenCalled();
	});
});

describe("15–18 · submitting, network error, denied, allowed", () => {
	it("15 · says Allowing… and disables both buttons while the answer is in flight", async () => {
		let settle: (v: unknown) => void = () => {};
		h.answer.mockReturnValue(new Promise((r) => (settle = r)));
		show(ready());
		fireEvent.click(allow());
		const pending = await screen.findByRole("button", { name: /Allowing…/ });
		expect(pending.hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("button", { name: "Deny" }).hasAttribute("disabled")).toBe(true);
		await act(async () => settle({ ok: true, data: { outcome: "expired" } }));
	});

	it("16 · keeps the choices and re-enables the buttons when Alethia can't be reached", async () => {
		h.answer.mockRejectedValue(new TypeError("Failed to fetch"));
		show(ready());
		fireEvent.click(checkbox("Change designs"));
		await act(async () => fireEvent.click(allow()));
		expect(screen.getByText("Couldn't reach Alethia")).toBeTruthy();
		expect(screen.getByText("Nothing was granted. Check your connection and try again.")).toBeTruthy();
		expect(allow().hasAttribute("disabled")).toBe(false);
		expect(checkbox("Change designs").getAttribute("aria-checked")).toBe("false");
	});

	it("17 · says the app was denied, then returns to it", async () => {
		vi.useFakeTimers();
		h.answer.mockResolvedValue({ ok: true, data: { outcome: "redirect", url: "https://app.example/cb?error=access_denied" } });
		show(ready());
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Deny" })));
		expect(h.answer).toHaveBeenCalledWith({ oauthQuery: QUERY, accept: false });
		expect(screen.getByRole("heading", { level: 1, name: "You denied Claude Code" })).toBeTruthy();
		expect(screen.getByText("Claude Code was told no and has no access to Alethia. You can close this page.")).toBeTruthy();
		expect(h.navigate).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(DENIED_REDIRECT_MS));
		expect(h.navigate).toHaveBeenCalledWith("https://app.example/cb?error=access_denied");
	});

	it("18 · submits exactly what was offered and ticked, then returns to the app", async () => {
		h.answer.mockResolvedValue({ ok: true, data: { outcome: "redirect", url: "https://app.example/cb?code=c" } });
		show(ready());
		await act(async () => fireEvent.click(allow()));
		expect(h.answer).toHaveBeenCalledWith({
			oauthQuery: QUERY,
			accept: true,
			orgId: "acme",
			scopes: ["read", "design", "plan", "apply"],
			projectIds: null,
		});
		expect(screen.getByRole("heading", { level: 1, name: "Returning to Claude Code…" })).toBeTruthy();
		expect(
			screen.getByText(
				"Claude Code can now work in acme with the permissions you chose. If nothing happens in a few seconds, go back to Claude Code yourself.",
			),
		).toBeTruthy();
		expect(screen.getByRole("link", { name: "Return to Claude Code" }).getAttribute("href")).toBe("https://app.example/cb?code=c");
		expect(screen.getByRole("link", { name: "Manage connections" }).getAttribute("href")).toBe("/dashboard/settings/connected");
		expect(h.navigate).toHaveBeenCalledWith("https://app.example/cb?code=c");
	});

	it("never sends a tick left over from an org whose role allowed more", async () => {
		h.answer.mockResolvedValue({ ok: true, data: { outcome: "redirect", url: "https://app.example/cb" } });
		show(ready());
		fireEvent.click(screen.getByRole("radio", { name: /globex/ }));
		await act(async () => fireEvent.click(allow()));
		expect(h.answer).toHaveBeenCalledWith(expect.objectContaining({ orgId: "globex", scopes: ["read"] }));
	});

	it("says Choose at least one, or deny. and blocks Allow when nothing is ticked", () => {
		show(ready({ orgs: [VIEWER_GLOBEX] }));
		fireEvent.click(checkbox("See your projects"));
		expect(screen.getByText("Choose at least one, or deny.")).toBeTruthy();
		expect(allow().hasAttribute("disabled")).toBe(true);
	});
});

describe("19–21 · requests that can't be answered", () => {
	it("19 · expired", () => {
		show({ state: "expired" });
		expect(screen.getByRole("heading", { level: 1, name: "This request has expired" })).toBeTruthy();
		expect(screen.getByText("Connection requests are valid for a few minutes. Go back to the app and connect again.")).toBeTruthy();
	});

	it("19 · an answer that finds the request expired moves to the same page", async () => {
		h.answer.mockResolvedValue({ ok: true, data: { outcome: "expired" } });
		show(ready());
		await act(async () => fireEvent.click(allow()));
		expect(screen.getByRole("heading", { level: 1, name: "This request has expired" })).toBeTruthy();
	});

	it("20 · already answered", () => {
		show({ state: "answered" });
		expect(screen.getByRole("heading", { level: 1, name: "This request was already answered" })).toBeTruthy();
		expect(
			screen.getByText(
				"Someone already allowed or denied this request, maybe in another tab. Go back to the app; if it isn't connected, connect again from there.",
			),
		).toBeTruthy();
	});

	it("21 · opened directly", () => {
		show({ state: "missing" });
		expect(screen.getByRole("heading", { level: 1, name: "Nothing to connect" })).toBeTruthy();
		expect(
			screen.getByText(
				"This page opens when an app such as Claude Code or Cursor asks to connect to Alethia. Start from that app to continue.",
			),
		).toBeTruthy();
	});
});

describe("22 · loading", () => {
	it("is a skeleton of the column, marked busy", () => {
		const { container } = render(<ConsentSkeleton />);
		expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
	});
});
