// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 (from #5444's review) — the purchase sheets' role picker names roles by their registry
// LABEL, as every other role picker has since #5444.
//
// `RoleField` rendered the raw key under CSS `capitalize`: it LOOKED like "Admin", while the text a
// screen reader reads — and the trigger's text, which `@repo/ui/select` resolves from the item's
// children — was "admin". The sent-invite chip did the same. Each assertion below reads the TEXT,
// which CSS cannot change, so each fails against the old components.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InviteView, RoleField } from "@/components/org/org-purchase-ui";
import { BUILT_IN_ROLE_LABELS } from "@/lib/authz/registry";

describe("RoleField", () => {
	it("shows the selected role's registry label in the trigger, with no CSS re-casing", () => {
		render(<RoleField value="operator" onChange={vi.fn()} />);
		const trigger = screen.getByRole("combobox", { name: "Role" });
		const shown = trigger.querySelector('[data-slot="select-value"]')?.textContent?.trim();

		expect(shown).toBe(BUILT_IN_ROLE_LABELS.operator);
		expect(shown).not.toBe("operator");
		expect(trigger.className).not.toMatch(/\bcapitalize\b/);
	});
});

describe("InviteView", () => {
	it("labels a sent invitation's role by its registry label", () => {
		render(
			<InviteView
				isTrialOrg={false}
				ownerEmail="owner@example.com"
				inviteEmail=""
				setInviteEmail={vi.fn()}
				inviteRole="viewer"
				setInviteRole={vi.fn()}
				sent={[{ email: "ada@example.com", role: "admin" }]}
				onAdd={vi.fn()}
				onFinish={vi.fn()}
				onAddPayment={vi.fn()}
			/>,
		);

		const chip = screen.getByText(BUILT_IN_ROLE_LABELS.admin);
		expect(chip.className).not.toMatch(/\bcapitalize\b/);
		expect(screen.queryByText("admin")).toBeNull();
	});
});
