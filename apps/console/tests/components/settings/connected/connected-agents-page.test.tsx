// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connected-agents page's states (AGT-L2 SPEC §5a): loading, a failed read, a refused read,
// connected + available, none connected, agent access off, no search match, the manage sheet, and
// Disconnect through its confirmation — plus the accessibility notes: every action names its app,
// the dot is decoration and the state label says it in words, and the sheet is a named dialog that
// Escape closes.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedAgentsRead } from "@/lib/rpc/procedures/agents";

const answers = vi.hoisted(() => ({
	connected: (async () => ({})) as () => Promise<unknown>,
}));
const disconnectAgent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"agents.connected": () => answers.connected(),
			"workspace.projects": async () => [
				{ id: "p-pay", project_name: "payments-api" },
				{ id: "p-web", project_name: "web" },
			],
		}).orpc,
	};
});
vi.mock("@/app/server/actions/agents/connections", () => ({ disconnectAgent }));

/** The address bar as a store, so `replaceState` re-renders what reads `useSearchParams`. */
const LOCATION_EVENT = "test:location";
vi.mock("next/navigation", () => ({
	useSearchParams: () => {
		const search = useSyncExternalStore(
			(notify) => {
				window.addEventListener(LOCATION_EVENT, notify);
				return () => window.removeEventListener(LOCATION_EVENT, notify);
			},
			() => window.location.search,
		);
		return new URLSearchParams(search);
	},
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/settings/connected",
	useParams: () => ({ org: "acme" }),
}));

import { ConnectedAgentsPage } from "@/components/settings/connected/connected-agents-page";
import { AGENT_APPS, agentAppIdentity } from "@/lib/agents/catalog";
import type { ConnectedAgent } from "@/lib/agents/grants";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

const realReplace = window.history.replaceState.bind(window.history);

/** One live grant. */
function grant(grantId: string, clientId: string, extra: Partial<ConnectedAgent> = {}): ConnectedAgent {
	return {
		grantId,
		clientId,
		identity: agentAppIdentity({ clientId, name: "Release bot", icon: null }),
		verified: true,
		scopes: ["read", "plan", "apply"],
		projectIds: null,
		connectedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
		...extra,
	};
}

const CLAUDE_CODE = grant("11111111-1111-4111-8111-111111111111", "https://claude.ai/code/oauth/client.json");
const CURSOR = grant("22222222-2222-4222-8222-222222222222", "https://cursor.com/oauth/client.json", {
	scopes: ["read", "destroy"],
	projectIds: ["p-pay", "p-web"],
});
const CUSTOM = grant("33333333-3333-4333-8333-333333333333", "https://tools.acme.io/mcp/client.json", {
	projectIds: ["p-web"],
});

/** The board's answer. */
function boardRead(connected: ConnectedAgent[], agentAccessEnabled = true): ConnectedAgentsRead {
	return { connected, catalog: AGENT_APPS, agentAccessEnabled };
}

/** Renders the page under a fresh client, at `search`. */
function renderPage(search = "") {
	realReplace(null, "", `/acme/~/settings/connected${search}`);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
	return render(<ConnectedAgentsPage orgSlug="acme" />, { wrapper });
}

beforeEach(() => {
	vi.clearAllMocks();
	window.history.replaceState = (...args: Parameters<History["replaceState"]>) => {
		realReplace(...args);
		window.dispatchEvent(new Event(LOCATION_EVENT));
	};
	useWorkspaceStore.setState({
		activeOrgId: "org-1",
		organizations: [{ id: "org-1", name: "acme", slug: "acme" } as never],
	});
	answers.connected = async () => boardRead([CLAUDE_CODE, CURSOR, CUSTOM]);
});
afterEach(() => {
	window.history.replaceState = realReplace;
});

describe("ConnectedAgentsPage — the read's states", () => {
	it("loading: the board-shaped skeleton, never the empty state", () => {
		answers.connected = () => new Promise(() => {});
		const { container } = renderPage();
		expect(container.querySelector('[data-skeleton="connected-agents"]')).not.toBeNull();
		expect(screen.queryByText("No agents match these filters.")).toBeNull();
	});

	it("error: a region error with a retry, saying nothing changed", async () => {
		answers.connected = async () => {
			throw new Error("boom");
		};
		renderPage();
		// The read retries a real failure once before it gives up.
		expect(await screen.findByText("Couldn't load your connected agents", undefined, { timeout: 4000 })).toBeTruthy();
		expect(screen.getByText("Your connections are unchanged. Try again in a moment.")).toBeTruthy();
		expect(screen.getByRole("button", { name: /try again|retry/i })).toBeTruthy();
	});

	it("denied: a refused read is its own calm state, not an error and not an empty board", async () => {
		answers.connected = async () => {
			throw new ORPCError("FORBIDDEN", { defined: true });
		};
		renderPage();
		expect(await screen.findByText("Connected agents aren't available")).toBeTruthy();
		expect(screen.queryByText("Couldn't load your connected agents")).toBeNull();
	});
});

describe("ConnectedAgentsPage — the board", () => {
	it("connected + available: connected cards first, the footnote, no count, actions named after their app", async () => {
		renderPage();
		const list = await screen.findByRole("list", { name: "Agent apps" });
		const cards = within(list).getAllByRole("listitem");
		expect(cards.map((c) => c.getAttribute("data-connected") === "true")).toEqual([true, true, true, false, false, false]);
		// No description line above the row (polish-wave §3): the old one is gone, and so is its toolbar.
		expect(screen.queryByText(/Apps you've let act for you in acme/)).toBeNull();
		expect(document.querySelector('[data-slot="page-toolbar"]')).toBeNull();
		expect(screen.getByText("Only you can see and disconnect your connections.")).toBeTruthy();
		// The projects chip: all, a count, and the one project's name.
		expect(within(cards[0] as HTMLElement).getByText("All projects")).toBeTruthy();
		expect(within(cards[1] as HTMLElement).getByText("2 projects")).toBeTruthy();
		expect(within(cards[2] as HTMLElement).getByText("web")).toBeTruthy();
		expect(within(cards[0] as HTMLElement).getByText("Connected 8 minutes ago")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Manage Claude Code" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Manage Release bot" })).toBeTruthy();
		const setUp = screen.getByRole("link", { name: "Set up Claude" });
		expect(setUp.getAttribute("href")).toBe("/docs/agents/claude");
		expect(within(cards[3] as HTMLElement).getByText("Not connected")).toBeTruthy();
		// The dot is decoration; the state label carries the meaning.
		for (const dot of document.querySelectorAll('[data-slot="agent-dot"]')) expect(dot.getAttribute("aria-hidden")).toBe("true");
		// No count pill anywhere on the page.
		expect(document.querySelector('[data-slot="count-pill"]')).toBeNull();
	});

	it("none connected: every card offers Set up, and the page says how to start", async () => {
		answers.connected = async () => boardRead([]);
		renderPage();
		expect(await screen.findByText(/You haven't connected an agent to acme yet/)).toBeTruthy();
		expect(screen.getByText("alethia agent setup")).toBeTruthy();
		expect(screen.queryAllByRole("button", { name: /^Manage / })).toHaveLength(0);
		expect(screen.getAllByText("Not connected")).toHaveLength(AGENT_APPS.length);
	});

	it("agent access off: the banner links to agent settings and connected cards read paused", async () => {
		answers.connected = async () => boardRead([CLAUDE_CODE], false);
		renderPage();
		const banner = await screen.findByRole("status");
		expect(within(banner).getByText("Agent access is off in acme.")).toBeTruthy();
		expect(within(banner).getByRole("link", { name: "Agent settings" }).getAttribute("href")).toBe("/acme/~/settings/agents");
		expect(screen.getByText("Paused · agent access off")).toBeTruthy();
	});

	it("no search match: the empty state clears the filters, from the URL too", async () => {
		renderPage("?q=nothing-like-this");
		expect(await screen.findByText("No agents match these filters.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(await screen.findByRole("list", { name: "Agent apps" })).toBeTruthy();
		expect(window.location.search).toBe("");
	});

	it("the Status filter in the link narrows the board to connected cards", async () => {
		renderPage("?status=connected");
		const list = await screen.findByRole("list", { name: "Agent apps" });
		expect(within(list).getAllByRole("listitem")).toHaveLength(3);
	});

	it("typing a search writes it to the URL and narrows the cards", async () => {
		renderPage();
		await screen.findByRole("list", { name: "Agent apps" });
		fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "curs" } });
		await waitFor(() => expect(window.location.search).toBe("?q=curs"));
		expect(within(screen.getByRole("list", { name: "Agent apps" })).getAllByRole("listitem")).toHaveLength(1);
	});
});

describe("ConnectedAgentsPage — the manage sheet and Disconnect", () => {
	it("Manage opens a named sheet with what the app can do, where, and its identity; Escape closes it", async () => {
		const user = userEvent.setup();
		renderPage();
		const manage = await screen.findByRole("button", { name: "Manage Cursor" });
		manage.focus();
		await user.keyboard("{Enter}");
		const sheet = await screen.findByRole("dialog", { name: "Cursor" });
		expect(window.location.search).toBe(`?selected=${CURSOR.grantId}`);
		expect(within(sheet).getByText("See your projects")).toBeTruthy();
		expect(within(sheet).getByText("Ask to destroy")).toBeTruthy();
		expect(within(sheet).queryByText("Run plans")).toBeNull();
		expect(within(sheet).getByText("payments-api")).toBeTruthy();
		expect(within(sheet).getByText(CURSOR.clientId)).toBeTruthy();
		expect(within(sheet).getByText("Verified by its metadata document")).toBeTruthy();
		expect(within(sheet).getByText(/To change what Cursor can do, connect it again from the app/)).toBeTruthy();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cursor" })).toBeNull());
		expect(window.location.search).toBe("");
	});

	it("a link with ?selected= reopens the sheet; all projects reads as including new ones", async () => {
		renderPage(`?selected=${CLAUDE_CODE.grantId}`);
		const sheet = await screen.findByRole("dialog", { name: "Claude Code" });
		expect(within(sheet).getByText("All projects, including new ones")).toBeTruthy();
	});

	it("Disconnect asks first, then disconnects that grant and closes the sheet", async () => {
		disconnectAgent.mockResolvedValue({ ok: true, data: { grantId: CURSOR.grantId } });
		renderPage(`?selected=${CURSOR.grantId}`);
		const sheet = await screen.findByRole("dialog", { name: "Cursor" });
		fireEvent.click(within(sheet).getByRole("button", { name: "Disconnect" }));
		const confirm = await screen.findByRole("alertdialog", { name: "Disconnect Cursor?" });
		expect(within(confirm).getByText(/Cursor loses access to acme right away\. Its requests waiting for approval can't be used\./)).toBeTruthy();
		expect(disconnectAgent).not.toHaveBeenCalled();
		fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect" }));
		await waitFor(() => expect(disconnectAgent).toHaveBeenCalledWith({ grantId: CURSOR.grantId }));
		await waitFor(() => expect(window.location.search).toBe(""));
	});

	it("cancelling the confirmation disconnects nothing", async () => {
		renderPage(`?selected=${CURSOR.grantId}`);
		const sheet = await screen.findByRole("dialog", { name: "Cursor" });
		fireEvent.click(within(sheet).getByRole("button", { name: "Disconnect" }));
		const confirm = await screen.findByRole("alertdialog", { name: "Disconnect Cursor?" });
		fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(disconnectAgent).not.toHaveBeenCalled();
	});
});
