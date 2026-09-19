// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every component card reads in the same four beats — Essentials, Sizing, Security, Advanced —
// whatever order its schema happens to be written in, and a section you open stays open the next
// time you come back to that kind. A database, a queue and a bucket are different resources; the
// questions you ask about them are not.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigFields } from "@/components/design-project/canvas/inspector/config-fields";
import {
	CONFIG_SCHEMA,
	getKindConfig,
	type KindConfig,
} from "@/components/design-project/canvas/inspector/config-schema";
import {
	sortSections,
	tierOf,
	TIER_ORDER,
} from "@/components/design-project/canvas/inspector/section-order";
import { useInspectorPrefsStore } from "@/lib/stores/use-inspector-prefs-store";
import { typedKeys } from "@/lib/typed-object";

const SCHEMA: KindConfig = {
	sections: [
		{
			id: "adv",
			title: "Advanced",
			tier: "advanced",
			fields: [{ key: "sku", type: "text", label: "SKU" }],
		},
		{
			id: "sec",
			title: "Security",
			tier: "security",
			fields: [{ key: "iam", type: "text", label: "IAM" }],
		},
		{
			id: "gen",
			title: "General",
			defaultOpen: true,
			fields: [{ key: "name", type: "text", label: "Name" }],
		},
		{
			id: "size",
			title: "Sizing",
			tier: "sizing",
			fields: [{ key: "gb", type: "text", label: "GB" }],
		},
	],
	summary: () => "",
};

beforeEach(() => {
	useInspectorPrefsStore.setState({ openSections: {}, tab: {} });
});

describe("section order", () => {
	it("renders tier order regardless of the order the schema declares", () => {
		render(
			<ConfigFields schema={SCHEMA} config={{}} provider="aws" onChange={vi.fn()} />,
		);
		// The Advanced header also renders its provider badge, and the badge's text abuts the title
		// with no whitespace ("Advancedonly") — so match on what each header STARTS with.
		const titles = ["General", "Sizing", "Security", "Advanced"];
		const headings = screen
			.getAllByRole("button")
			.map((b) => b.textContent ?? "")
			.map((text) => titles.find((t) => text.startsWith(t)))
			.filter((t): t is string => t !== undefined);
		expect(headings).toEqual(titles);
	});

	it("is stable within a tier — a kind's own ordering of its essentials is meaningful", () => {
		const sections = sortSections([
			{ id: "a", title: "A", fields: [] },
			{ id: "b", title: "B", fields: [] },
			{ id: "c", title: "C", tier: "security", fields: [] },
			{ id: "d", title: "D", fields: [] },
		]);
		expect(sections.map((s) => s.id)).toEqual(["a", "b", "d", "c"]);
	});

	it("every kind in the real schema declares only known tiers", () => {
		for (const kind of typedKeys(CONFIG_SCHEMA)) {
			const schema = getKindConfig(kind);
			if (!schema) continue;
			for (const section of schema.sections) {
				expect(TIER_ORDER).toContain(tierOf(section));
			}
		}
	});

	it("no kind puts an Advanced section anywhere but last", () => {
		for (const kind of typedKeys(CONFIG_SCHEMA)) {
			const schema = getKindConfig(kind);
			if (!schema) continue;
			const tiers = sortSections(schema.sections).map(tierOf);
			const ranks = tiers.map((t) => TIER_ORDER.indexOf(t));
			expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		}
	});
});

describe("section open state", () => {
	it("remembers what you opened, per kind, across a remount", async () => {
		const user = userEvent.setup();
		const { unmount } = render(
			<ConfigFields
				schema={SCHEMA}
				config={{}}
				provider="aws"
				kind="database"
				onChange={vi.fn()}
			/>,
		);
		// Advanced is collapsed by default — the portable fields stay in front.
		expect(screen.queryByLabelText("SKU")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /Advanced/ }));
		expect(screen.getByLabelText("SKU")).toBeInTheDocument();

		unmount();
		render(
			<ConfigFields
				schema={SCHEMA}
				config={{}}
				provider="aws"
				kind="database"
				onChange={vi.fn()}
			/>,
		);
		expect(screen.getByLabelText("SKU")).toBeInTheDocument();
	});

	it("is per kind — opening a database's Advanced says nothing about a cache's", async () => {
		const user = userEvent.setup();
		const { unmount } = render(
			<ConfigFields
				schema={SCHEMA}
				config={{}}
				provider="aws"
				kind="database"
				onChange={vi.fn()}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Advanced/ }));
		unmount();

		render(
			<ConfigFields
				schema={SCHEMA}
				config={{}}
				provider="aws"
				kind="cache"
				onChange={vi.fn()}
			/>,
		);
		expect(screen.queryByLabelText("SKU")).not.toBeInTheDocument();
	});
});
