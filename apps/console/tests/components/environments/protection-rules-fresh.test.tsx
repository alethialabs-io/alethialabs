// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6120 review — the protection-rules drawer seeds its form from a FRESH read, never from the cache.
//
// The defect this pins: the drawer used to seed from whatever the query cache held when it mounted.
// That answer can be minutes old (30 s fresh, kept for 5 min, and a live hint only marks it stale),
// and Save sends the whole form — so opening the drawer over a stale "approval: off" and pressing
// Save would silently switch off the approval gate a teammate had just switched on. Now the read is
// refetched on every open and the form is seeded only from that answer; until it lands, nothing is
// editable and Save is disabled.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler> }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/protection", () => ({ setProtectionRules: vi.fn() }));

import { ProtectionRulesDialog } from "@/components/environments/protection-rules-dialog";
import { orpc } from "@/lib/rpc/client";
import type { ProtectionRulesRead } from "@/lib/rpc/procedures/environments";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const KEY = orpc.environments.protectionRules.queryKey({
	input: { projectId: PROJECT, environmentId: ENV },
});

/** A stored rules row with the approval gate `on` or off, requiring `minCount` approvals. */
function rules(on: boolean, minCount: number): ProtectionRulesRead {
	return {
		environmentId: ENV,
		rules: {
			id: "33333333-3333-4333-8333-333333333333",
			project_id: PROJECT,
			environment_id: ENV,
			user_id: "44444444-4444-4444-8444-444444444444",
			org_id: null,
			created_at: new Date("2026-10-01T00:00:00Z"),
			updated_at: new Date("2026-10-01T00:00:00Z"),
			require_predecessor: false,
			require_verify_pass: false,
			require_approval: on,
			approvers: { user_ids: [], role: null, min_count: minCount },
			soak_minutes: null,
			cost_delta_threshold: null,
		},
	};
}

/** Opens the drawer over a cache that already holds `cached` — an answer from a while ago. */
function openOver(cached: ProtectionRulesRead) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
	client.setQueryData(KEY, cached);
	render(
		<QueryClientProvider client={client}>
			<ProtectionRulesDialog open onOpenChange={() => {}} projectId={PROJECT} envId={ENV} envName="production" />
		</QueryClientProvider>,
	);
}

describe("ProtectionRulesDialog — the form is seeded from a fresh read", () => {
	it("a cached 'approval off' and a server 'approval on, ×2': the form shows the server's", async () => {
		h.handlers["environments.protectionRules"] = async () => rules(true, 2);
		openOver(rules(false, 1));

		const approval = await screen.findByRole("switch", { name: "Require approval" });
		expect(approval).toHaveAttribute("aria-checked", "true");
		expect(screen.getByRole("spinbutton", { name: "Approvals required" })).toHaveValue(2);
		expect(screen.getByRole("button", { name: /save rules/i })).toBeEnabled();
	});

	it("while the fresh read is in flight, the cached copy is not shown and Save is disabled", async () => {
		h.handlers["environments.protectionRules"] = () => new Promise(() => {});
		openOver(rules(false, 1));

		expect(document.body.querySelector('[data-state="pending"]')).not.toBeNull();
		expect(screen.queryByRole("switch", { name: "Require approval" })).toBeNull();
		expect(screen.getByRole("button", { name: /save rules/i })).toBeDisabled();
	});
});
