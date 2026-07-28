// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The definition panel must let you define anything the database can store.
//
// The flagship gap it closes: `topic.subscriptions` is a TopicSubscription[] column that has existed
// since the baseline migration, and the inspector exposed ONLY the topic's name. There was literally
// no way, in the product, to subscribe anything to a topic. These tests pin the two new field types
// (list + subresource) and the tiering that keeps the long tail of per-cloud knobs from swamping the
// portable fields.

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfigFields } from "@/components/design-project/canvas/inspector/config-fields";
import {
	CONFIG_SCHEMA,
	getKindConfig,
	type KindConfig,
} from "@/components/design-project/canvas/inspector/config-schema";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

function renderKind(
	kind: Parameters<typeof getKindConfig>[0],
	config: Record<string, unknown>,
	provider: CloudProviderSlug | null = "aws",
) {
	const onChange = vi.fn();
	const schema = getKindConfig(kind) as KindConfig;
	render(
		<ConfigFields
			schema={schema}
			config={config}
			provider={provider}
			onChange={onChange}
		/>,
	);
	return { onChange };
}

describe("topic subscriptions — the column with no editor at all", () => {
	it("is now definable", async () => {
		const user = userEvent.setup();
		const { onChange } = renderKind("topic", { name: "orders", subscriptions: [] });

		await user.click(screen.getByRole("button", { name: /add a subscription/i }));

		expect(onChange).toHaveBeenCalledWith({
			subscriptions: [{ protocol: "https", endpoint: "" }],
		});
	});

	it("renders each existing subscription as an editable row", () => {
		renderKind("topic", {
			name: "orders",
			subscriptions: [
				{ protocol: "https", endpoint: "https://a.example/hook" },
				{ protocol: "sqs", endpoint: "arn:aws:sqs:::q" },
			],
		});

		expect(screen.getByText("https://a.example/hook")).toBeInTheDocument();
		expect(screen.getByText("arn:aws:sqs:::q")).toBeInTheDocument();
	});

	it("edits a row's endpoint", async () => {
		const user = userEvent.setup();
		const { onChange } = renderKind("topic", {
			name: "orders",
			subscriptions: [{ protocol: "https", endpoint: "" }],
		});

		const endpoint = screen.getByLabelText("Endpoint");
		await user.type(endpoint, "x");

		expect(onChange).toHaveBeenCalledWith({
			subscriptions: [{ protocol: "https", endpoint: "x" }],
		});
	});

	it("removes a row", async () => {
		const user = userEvent.setup();
		const { onChange } = renderKind("topic", {
			name: "orders",
			subscriptions: [
				{ protocol: "https", endpoint: "https://keep.example" },
				{ protocol: "https", endpoint: "https://drop.example" },
			],
		});

		await user.click(
			screen.getByRole("button", { name: "Remove https://drop.example" }),
		);

		expect(onChange).toHaveBeenCalledWith({
			subscriptions: [{ protocol: "https", endpoint: "https://keep.example" }],
		});
	});
});

describe("list fields — string[] columns that were absent or comma-mangled", () => {
	it("adds a CIDR to a network's allow-list", async () => {
		const user = userEvent.setup();
		const { onChange } = renderKind("network", {
			provision_network: true,
			cidr_block: "10.0.0.0/16",
			allowed_cidr_blocks: [],
		});

		await user.click(screen.getAllByRole("button", { name: "Add" })[0]);
		expect(onChange).toHaveBeenCalledWith({ allowed_cidr_blocks: [] });
	});

	it("renders existing entries and removes one", async () => {
		const user = userEvent.setup();
		const { onChange } = renderKind("network", {
			provision_network: true,
			allowed_cidr_blocks: ["10.1.0.0/16", "10.2.0.0/16"],
		});

		await user.click(
			screen.getByRole("button", { name: "Remove Allowed CIDR blocks 2" }),
		);
		expect(onChange).toHaveBeenCalledWith({
			allowed_cidr_blocks: ["10.1.0.0/16"],
		});
	});

	it("drops blank rows on write — an empty CIDR isn't a value", async () => {
		const user = userEvent.setup();
		const { onChange } = renderKind("network", {
			provision_network: true,
			allowed_cidr_blocks: ["10.1.0.0/16", ""],
		});

		await user.type(screen.getByLabelText("Allowed CIDR blocks 1"), "0");

		// The blank second row is filtered out rather than saved and later failing zod at deploy.
		const last = onChange.mock.calls.at(-1)?.[0];
		expect(last.allowed_cidr_blocks).not.toContain("");
	});
});

describe("cluster admins — the self-admin mechanism, finally definable", () => {
	// Security is a collapsed tier by design — the portable fields stay in front — so it has to be
	// opened first. That IS the tiering working.
	const openSecurity = async (user: ReturnType<typeof userEvent.setup>) =>
		user.click(screen.getByText("Security"));

	it("reads the usernames out of the ClusterAdmin[] column", async () => {
		const user = userEvent.setup();
		renderKind("cluster", {
			cluster_version: "1.31",
			cluster_admins: [
				{ username: "arn:aws:iam::1:role/oncall", groups: ["system:masters"] },
			],
		});
		await openSecurity(user);

		expect(
			screen.getByDisplayValue("arn:aws:iam::1:role/oncall"),
		).toBeInTheDocument();
	});

	it("writes back the column's real shape ({ username, groups }), not bare strings", async () => {
		const user = userEvent.setup();
		const { onChange } = renderKind("cluster", {
			cluster_version: "1.31",
			cluster_admins: [{ username: "existing", groups: ["system:masters"] }],
		});
		await openSecurity(user);

		await user.type(screen.getByLabelText("Cluster admins 1"), "!");

		const written = onChange.mock.calls.at(-1)?.[0];
		expect(written.cluster_admins[0]).toHaveProperty("username");
		expect(written.cluster_admins[0]).toHaveProperty("groups");
	});
});

describe("tiering keeps the portable fields in front", () => {
	it("every kind's schema declares only known tiers", () => {
		const known = ["essentials", "sizing", "security", "advanced", undefined];
		for (const [kind, schema] of Object.entries(CONFIG_SCHEMA)) {
			for (const section of schema?.sections ?? []) {
				expect(known, `${kind}/${section.id} has an unknown tier`).toContain(
					section.tier,
				);
			}
		}
	});

	it("an Advanced section is provider-badged, so it's obvious you're leaving portable ground", () => {
		renderKind("database", { name: "orders", engine_family: "postgres" }, "aws");
		// The section header carries the "only" badge next to the provider mark.
		expect(screen.getByText("Advanced")).toBeInTheDocument();
		expect(screen.getByText("only")).toBeInTheDocument();
	});

	it("provider-specific fields stay hidden on clouds where they're meaningless", () => {
		// instance_class is an escape hatch for managed clouds; the in-cluster path has no SKUs.
		renderKind("database", { name: "ledger" }, "hetzner");
		expect(screen.queryByText("Instance class")).not.toBeInTheDocument();
	});
});

// #1510. A capability the cell can't honor is DISABLED with the reason, not hidden — the distinction
// these tests exist to hold, because "hidden" is what the issue title originally proposed and it is
// the option that reads as a bug.
describe("keyless IAM auth is gated to cells that can honor it", () => {
	const iamSwitch = () =>
		screen.getByRole("switch", { name: /IAM authentication/i });

	/** What a screen reader would read out under the toggle — which is also the visible note.
	 * Read through `aria-describedby` rather than by text, both to pin the a11y wiring and because
	 * "CloudNativePG" legitimately appears elsewhere in the panel. */
	const iamNote = () => {
		const id = iamSwitch().getAttribute("aria-describedby");
		expect(id).toBeTruthy();
		return document.getElementById(id as string)?.textContent ?? "";
	};

	/** Render a database and open the (collapsed-by-default) Security section. */
	const openSecurity = async (
		config: Record<string, unknown>,
		provider: CloudProviderSlug | null,
	) => {
		const user = userEvent.setup();
		const rendered = renderKind("database", config, provider);
		await user.click(screen.getByRole("button", { name: /^Security/ }));
		return { ...rendered, user };
	};

	it("is on and operable where the renderer can build it", async () => {
		const { onChange, user } = await openSecurity(
			{ name: "orders", engine_family: "mysql", iam_auth: false },
			"aws",
		);
		expect(iamSwitch()).not.toHaveAttribute("aria-disabled", "true");
		await user.click(iamSwitch());
		expect(onChange).toHaveBeenCalledWith({ iam_auth: true });
	});

	it("is disabled, off, and says why on a cloud with no identity plane", async () => {
		// `iam_auth: true` on purpose: this is the config that used to be saved and deployed, with
		// the database quietly acquiring a password. The control must read OFF, because off is what
		// the cell can actually deliver.
		await openSecurity(
			{ name: "ledger", engine_family: "postgres", iam_auth: true },
			"hetzner",
		);
		expect(iamSwitch()).toHaveAttribute("aria-disabled", "true");
		expect(iamSwitch()).not.toBeChecked();
		expect(iamNote()).toMatch(/CloudNativePG/);
	});

	it("says why on Alibaba too, on both engines", async () => {
		for (const engine_family of ["postgres", "mysql"]) {
			await openSecurity(
				{ name: "ledger", engine_family, iam_auth: true },
				"alibaba",
			);
			expect(iamSwitch()).toHaveAttribute("aria-disabled", "true");
			expect(iamNote()).toMatch(/control plane/);
			cleanup();
		}
	});

	it("keeps the rest of the Security section — this is a gate, not a hide", async () => {
		await openSecurity(
			{ name: "ledger", engine_family: "postgres" },
			"hetzner",
		);
		expect(iamSwitch()).toBeInTheDocument();
		expect(screen.getByText(/Backup retention/)).toBeInTheDocument();
	});

	it("asks for a cloud before it answers, when none is placed yet", async () => {
		await openSecurity({ name: "ledger", iam_auth: true }, null);
		expect(iamSwitch()).toHaveAttribute("aria-disabled", "true");
		expect(iamNote()).toMatch(/Select a cloud account to configure this/i);
	});
});

describe("portable sizing is exposed for the first time", () => {
	it("the cluster can be sized by capability (vCPU / memory), not just a concrete SKU", () => {
		renderKind("cluster", { cluster_version: "1.31" });
		expect(screen.getByText("vCPU per node")).toBeInTheDocument();
		expect(screen.getByText(/Memory per node/)).toBeInTheDocument();
	});

	it("writes node_size as the { vcpu, memory_gb } shape the resolver expects", async () => {
		const user = userEvent.setup();
		const { onChange } = renderKind("cluster", { cluster_version: "1.31" });

		await user.type(screen.getByLabelText(/vCPU per node/), "4");
		const written = onChange.mock.calls.at(-1)?.[0];
		expect(written.node_size).toEqual({ vcpu: 4, memory_gb: 8 });
	});
});
