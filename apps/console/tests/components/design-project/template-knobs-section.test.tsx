// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The generated "Advanced" section — every template variable a component can still set on a cloud,
// rendered from the manifest and written back into `provider_config`.
//
// Two properties carry the whole feature, and both are the kind that pass by accident if nobody
// pins them:
//
//   1. UNSETTING DELETES THE KEY. `provider_config.foo = null` is not "the template's default", it
//      is an override to null — a different apply, produced by a control that looked empty.
//   2. A KNOB THE MANIFEST EXCLUDES NEVER RENDERS. `typed` means the canvas already collects that
//      value through a real column, and a second generic control beside it is two writers of one
//      value where which one wins is a detail of the merge.
//
// The fixtures are the REAL manifest rather than a hand-made one, deliberately: a mocked knob shape
// is not the wire shape, and the thing under test is precisely the mapping from what the generator
// emits onto a control.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigFields } from "@/components/design-project/canvas/inspector/config-fields";
import {
	getKindConfig,
	type FieldDef,
} from "@/components/design-project/canvas/inspector/config-schema";
import { validateNodeConfig } from "@/components/design-project/canvas/inspector/node-validation";
import {
	KNOB_UNSET,
	knobControl,
	knobField,
	knobFieldKey,
	templateKnobFields,
} from "@/components/design-project/canvas/inspector/template-knobs-section";
import { knobsFor, type TemplateKnob } from "@/lib/cloud-providers/template-knobs";
import { useInspectorPrefsStore } from "@/lib/stores/use-inspector-prefs-store";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";

/** The generated field for one knob, or a failure naming the knob that has gone missing. */
function fieldFor(kind: NodeKind, name: string): FieldDef {
	const field = templateKnobFields("aws", kind).find((f) => f.key === `knob:${name}`);
	if (!field) throw new Error(`no generated field for aws ${kind}.${name}`);
	return field;
}

/** A field's `get`, or a failure — every knob field must read through the escape hatch. */
function readField(field: FieldDef, config: Record<string, unknown>): unknown {
	if (!field.get) throw new Error(`${field.key} has no get()`);
	return field.get(config);
}

/** A field's `set`, or a failure — every knob field must write through the escape hatch. */
function writeField(
	field: FieldDef,
	value: unknown,
	config: Record<string, unknown>,
): Partial<Record<string, unknown>> {
	if (!field.set) throw new Error(`${field.key} has no set()`);
	return field.set(value, config);
}

/** The `provider_config` a `set` patch would commit. */
function patched(patch: Partial<Record<string, unknown>>): Record<string, unknown> {
	const next = patch.provider_config;
	if (typeof next !== "object" || next === null || Array.isArray(next)) {
		throw new Error("patch did not carry a provider_config object");
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(next)) out[k] = v;
	return out;
}

beforeEach(() => {
	useInspectorPrefsStore.setState({ openSections: {}, tab: {} });
});

describe("a knob's type picks its control", () => {
	it("string → a monospace text field", () => {
		const field = fieldFor("cluster", "eks_ami_type");
		expect(field.type).toBe("text");
		expect(field.mono).toBe(true);
	});

	it("number → a numeric field that stores a real number, not the text you typed", () => {
		const field = fieldFor("cluster", "eks_volume_iops");
		expect(field.type).toBe("text");
		expect(patched(writeField(field, "3000", {}))).toEqual({ eks_volume_iops: 3000 });
	});

	it("bool → three states, because a knob has three and a switch has two", () => {
		const field = fieldFor("cluster", "ec2_spot_service_role");
		expect(field.type).toBe("select");
		expect(Array.isArray(field.options) ? field.options.map((o) => o.value) : []).toEqual([
			KNOB_UNSET,
			"true",
			"false",
		]);
	});

	it("list(string) → a row editor", () => {
		expect(fieldFor("cluster", "cluster_endpoint_public_access_cidrs").type).toBe("list");
	});

	it("list(object(…)) → JSON, never a string-row editor that would read it as zero rows", () => {
		const field = fieldFor("database", "rds_cluster_parameters");
		expect(field.type).toBe("text");
		expect(knobControl(knobsFor("aws", "database").filter((k) => k.name === "rds_cluster_parameters")[0])).toBe("json");
	});

	it("object and any → JSON", () => {
		expect(fieldFor("database", "rds_extra_credentials").type).toBe("text");
		expect(fieldFor("cluster", "eks_access_entries").type).toBe("text");
	});

	it("shows the template's own default, so you can see what you are overriding", () => {
		const field = fieldFor("cluster", "eks_ami_type");
		expect(field.description).toContain("Template default:");
	});
});

describe("a change writes provider_config[name]", () => {
	it("a text knob", () => {
		expect(patched(writeField(fieldFor("database", "rds_default_username"), "svc", {}))).toEqual({
			rds_default_username: "svc",
		});
	});

	it("a bool knob writes a boolean, not the option's string", () => {
		const field = fieldFor("cluster", "ec2_spot_service_role");
		expect(patched(writeField(field, "true", {}))).toEqual({ ec2_spot_service_role: true });
		expect(patched(writeField(field, "false", {}))).toEqual({ ec2_spot_service_role: false });
	});

	it("a list knob writes the rows", () => {
		const field = fieldFor("cluster", "cluster_endpoint_public_access_cidrs");
		expect(patched(writeField(field, ["10.0.0.0/8"], {}))).toEqual({
			cluster_endpoint_public_access_cidrs: ["10.0.0.0/8"],
		});
	});

	it("a JSON knob parses what was typed", () => {
		const field = fieldFor("database", "rds_extra_credentials");
		expect(patched(writeField(field, '{"reporting":"ro"}', {}))).toEqual({
			rds_extra_credentials: { reporting: "ro" },
		});
	});

	it("keeps the other knobs alongside it", () => {
		const field = fieldFor("cluster", "eks_ami_type");
		const patch = writeField(field, "AL2023_x86_64_STANDARD", {
			provider_config: { eks_volume_type: "gp3" },
		});
		expect(patched(patch)).toEqual({
			eks_volume_type: "gp3",
			eks_ami_type: "AL2023_x86_64_STANDARD",
		});
	});

	it("reads back what is stored", () => {
		const field = fieldFor("cluster", "eks_ami_type");
		expect(readField(field, { provider_config: { eks_ami_type: "BOTTLEROCKET_x86_64" } })).toBe(
			"BOTTLEROCKET_x86_64",
		);
	});
});

describe("unsetting DELETES the key — it never writes null or an empty value", () => {
	const stored = () => ({ provider_config: { eks_ami_type: "AL2", eks_volume_type: "gp3" } });

	it("clearing a text field", () => {
		const patch = writeField(fieldFor("cluster", "eks_ami_type"), "", stored());
		expect(patched(patch)).toEqual({ eks_volume_type: "gp3" });
		expect("eks_ami_type" in patched(patch)).toBe(false);
	});

	it("clearing a number field", () => {
		const patch = writeField(fieldFor("cluster", "eks_volume_iops"), "", {
			provider_config: { eks_volume_iops: 3000 },
		});
		expect(patched(patch)).toEqual({});
	});

	it("choosing the template default on a bool", () => {
		const patch = writeField(fieldFor("cluster", "ec2_spot_service_role"), KNOB_UNSET, {
			provider_config: { ec2_spot_service_role: true },
		});
		expect(patched(patch)).toEqual({});
	});

	it("removing every row of a list", () => {
		const patch = writeField(fieldFor("cluster", "eks_kms_key_users"), [], {
			provider_config: { eks_kms_key_users: ["arn:aws:iam::1:user/a"] },
		});
		expect(patched(patch)).toEqual({});
	});

	it("emptying a JSON field", () => {
		const patch = writeField(fieldFor("database", "rds_extra_credentials"), "  ", {
			provider_config: { rds_extra_credentials: { a: "b" } },
		});
		expect(patched(patch)).toEqual({});
	});

	it("an unset bool reads as the template default, not as off", () => {
		expect(readField(fieldFor("cluster", "ec2_spot_service_role"), {})).toBe(KNOB_UNSET);
	});
});

describe("knobs the manifest excludes never render", () => {
	const keys = (kind: NodeKind, cloud: "aws" | "gcp" = "aws") =>
		templateKnobFields(cloud, kind).map((f) => f.key);

	it("a `typed` knob — the canvas already collects it through a real column", () => {
		// The database card's hand-written Advanced pair. A generic control beside either of them
		// would be a second writer of one value.
		expect(keys("database")).not.toContain("knob:rds_instance_type");
		expect(keys("database", "gcp")).not.toContain("knob:cloud_sql_engine_version");
		expect(keys("database", "gcp")).not.toContain("knob:cloud_sql_tier");
	});

	it("an `ownedByProvider` knob — the provider always emits it, so the user's value loses", () => {
		expect(keys("database")).not.toContain("knob:rds_iam_auth_enabled");
	});

	it("an unreachable knob — no merge lands on it, so the control would change nothing", () => {
		expect(keys("bucket")).not.toContain("knob:bucket_configuration");
		expect(keys("bucket")).not.toContain("knob:s3_create");
	});

	it("every rendered field corresponds to a knob `knobsFor` still offers", () => {
		for (const kind of ["cluster", "database", "cache", "bucket", "nosql"] as const) {
			const offered = new Set(knobsFor("aws", kind).map((k) => `knob:${k.name}`));
			for (const key of keys(kind)) expect(offered.has(key)).toBe(true);
		}
	});
});

describe("an item-shaped component sets its item's attributes, not the root variable", () => {
	it("a bucket offers the `bucket_configuration` attributes and not the variable itself", () => {
		const keys = templateKnobFields("aws", "bucket").map((f) => f.key);
		// Every one of these carries `itemScope: bucket_configuration` in the manifest — they land on
		// one entry of the map via `mergeItemProviderConfig`, and the write from the card is still a
		// plain `provider_config[name]` on this node.
		expect(keys).toContain("knob:logging_bucket_name");
		expect(keys).toContain("knob:privileged_principal_actions");
		expect(keys).not.toContain("knob:bucket_configuration");
		for (const knob of knobsFor("aws", "bucket")) expect(knob.itemScope).toBe("bucket_configuration");
	});

	it("writes the attribute at the node's own provider_config root", () => {
		const patch = writeField(fieldFor("bucket", "logging_bucket_name"), "audit-logs", {});
		expect(patched(patch)).toEqual({ logging_bucket_name: "audit-logs" });
	});
});

describe("a sensitive knob's value is never rendered back", () => {
	// No settable knob is sensitive today; the flag is in the manifest schema and the day one is, a
	// card that echoed it would put it in the DOM, the accessibility tree and every screenshot.
	const secret: TemplateKnob = {
		cloud: "aws",
		component: "secret",
		name: "seed_token",
		kind: "string",
		typeExpr: "string",
		required: false,
		description: "A seed token.",
		sensitive: true,
		declaredAt: "infra/templates/project/aws/variables.tf:1",
		readBy: ["infra/templates/project/aws"],
		reachable: true,
		ownedByProvider: false,
		typed: false,
	};

	it("reads back empty even when a value is stored", () => {
		expect(readField(knobField(secret), { provider_config: { seed_token: "hunter2" } })).toBe("");
	});

	it("an empty box is a no-op, so a focus-and-blur cannot silently delete it", () => {
		const patch = writeField(knobField(secret), "", { provider_config: { seed_token: "hunter2" } });
		expect(patched(patch)).toEqual({ seed_token: "hunter2" });
	});

	it("typing a new one replaces it", () => {
		const patch = writeField(knobField(secret), "hunter3", {
			provider_config: { seed_token: "hunter2" },
		});
		expect(patched(patch)).toEqual({ seed_token: "hunter3" });
	});
});

describe("the section on the card", () => {
	it("appends one Advanced section, scoped to the cloud it was generated for", () => {
		const schema = getKindConfig("cluster", "aws");
		const section = schema?.sections.find((s) => s.id === "template-knobs");
		expect(section?.tier).toBe("advanced");
		expect(section?.providerScope).toEqual(["aws"]);
		expect(section?.fields.length).toBe(knobsFor("aws", "cluster").length);
	});

	it("leaves the hand-written Advanced fields exactly where they were", () => {
		const schema = getKindConfig("database", "aws");
		const hand = schema?.sections.find((s) => s.id === "db-advanced");
		expect(hand?.fields.map((f) => f.key)).toEqual(["engine_version", "instance_class"]);
	});

	it("asked by kind alone, it is the hand-written schema and nothing else", () => {
		// Every caller in the product asks this way today; adding a section here would change what
		// three unrelated surfaces render.
		expect(getKindConfig("cluster")).toBe(getKindConfig("cluster"));
		expect(getKindConfig("cluster")?.sections.some((s) => s.id === "template-knobs")).toBe(false);
	});

	it("a cell with no settable knobs gets no empty section", () => {
		// Hetzner's cluster has two; its cache is in-cluster and has none at all.
		expect(getKindConfig("cache", "hetzner")?.sections.some((s) => s.id === "template-knobs")).toBe(
			false,
		);
	});

	it("renders the knobs and commits one to provider_config", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const schema = getKindConfig("cluster", "aws");
		if (!schema) throw new Error("no cluster schema");
		render(
			<ConfigFields
				schema={schema}
				config={{ provider_config: {} }}
				provider="aws"
				kind="cluster"
				onChange={onChange}
			/>,
		);

		// Advanced is collapsed by default — the portable fields stay in front.
		expect(screen.queryByLabelText("eks_ami_type")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /Advanced/ }));

		const input = screen.getByLabelText("eks_ami_type");
		await user.type(input, "AL2023");
		await user.tab();

		expect(onChange).toHaveBeenCalledWith({ provider_config: { eks_ami_type: "AL2023" } });
	});
});

describe("per-knob validation says only what the template states", () => {
	it("a number knob rejects text", () => {
		const errors = validateNodeConfig("cluster", {
			provider_config: { eks_volume_iops: "fast" },
		});
		expect(errors[knobFieldKey(knobsFor("aws", "cluster").filter((k) => k.name === "eks_volume_iops")[0])]).toBe(
			"Must be a number.",
		);
	});

	it("a number knob accepts a number", () => {
		const errors = validateNodeConfig("cluster", {
			provider_config: { eks_volume_iops: 3000 },
		});
		expect(errors["knob:eks_volume_iops"]).toBeUndefined();
	});

	it("a JSON knob rejects what never parsed", () => {
		const errors = validateNodeConfig("database", {
			engine_family: "postgres",
			provider_config: { rds_extra_credentials: "{reporting" },
		});
		expect(errors["knob:rds_extra_credentials"]).toBe("Must be valid JSON.");
	});

	it("a JSON knob accepts a parsed object", () => {
		const errors = validateNodeConfig("database", {
			engine_family: "postgres",
			provider_config: { rds_extra_credentials: { reporting: "ro" } },
		});
		expect(errors["knob:rds_extra_credentials"]).toBeUndefined();
	});

	it("invents no constraint the template does not state — a string knob is never wrong", () => {
		const errors = validateNodeConfig("cluster", {
			provider_config: { eks_ami_type: "anything at all" },
		});
		expect(errors["knob:eks_ami_type"]).toBeUndefined();
	});

	it("knob errors cannot collide with a column error on the same card", () => {
		// The key is namespaced precisely because `value`, `location` and `keepers` are real knob
		// names and each is also a plausible column key.
		expect(knobFieldKey(knobsFor("aws", "cluster")[0])).toMatch(/^knob:/);
	});
});
