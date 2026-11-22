// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cloud connect definitions (#6842), read as data.
//
//   · Every cloud has a definition, each is complete, and each step id is its cloud's slug.
//   · NO SECRET FIELD IS IN ANY DRAFT SCHEMA. The draft keys are named exactly, per cloud: a role
//     ARN, the GCP ids, the Azure ids — and nothing at all for the clouds whose input is a token.
//     The name heuristic is checked too, but the exact lists are the assertion.
//   · Every field says what is wrong with it (B-04): an empty GCP form names both fields.
//   · The paste readers take the values from a setup script's whole output, by label.
//   · Text typed into a field only reaches a copyable shell command when it is the identifier
//     the command expects.

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as cloudConnect from "@/components/cloud-connect/cloud-connect.wizard";
import {
	awsConnectWizard,
	azureConnectWizard,
	CLOUD_CONNECT_WIZARD_ID,
	commandWith,
	extractAlibabaRoleArn,
	extractAwsRoleArn,
	gcpConnectWizard,
	hetznerConnectWizard,
	parseGcpIds,
} from "@/components/cloud-connect/cloud-connect.wizard";
import { CONNECTABLE_CLOUDS } from "@/lib/cloud-providers/generated/catalog";
import { GCP_PROJECT_ID_REGEX } from "@/lib/cloud-providers/gcp-wif";
import {
	assertWizardComplete,
	draftTopLevelKeys,
	isWizardDefinition,
	sensitiveDraftKeys,
} from "@/lib/wizard/define";

/** The module's exports, read as plain values so the definitions can be picked out by shape. */
const EXPORTS: Readonly<Record<string, unknown>> = cloudConnect;

/** Every definition the module exports. */
const DEFINITIONS = Object.values(EXPORTS).filter(isWizardDefinition);

/** The keys each cloud's draft may keep — identifiers only. `null`: the cloud keeps no draft. */
const EXPECTED_DRAFT_KEYS: Record<string, readonly string[] | null> = {
	aws: ["roleArn"],
	gcp: ["mode", "projectId", "projectNumber"],
	azure: ["subscriptionId", "tenantId", "clientId"],
	hetzner: null,
	alibaba: ["roleArn"],
	digitalocean: null,
	civo: null,
};

/** The fields that carry a credential or a pasted config: never in a draft. */
const NEVER_DRAFTED = ["token", "s3AccessKey", "s3SecretKey", "wifConfigJson"];

/** The messages a step schema gives `values`, keyed by field. */
function messages(schema: z.ZodType, values: unknown): Record<string, string[]> {
	const result = schema.safeParse(values);
	const found: Record<string, string[]> = {};
	if (result.success) return found;
	for (const issue of result.error.issues) {
		const key = issue.path.join(".");
		found[key] = [...(found[key] ?? []), issue.message];
	}
	return found;
}

describe("cloud connect definitions", () => {
	it("cover every connectable cloud, one step each, named by the cloud", () => {
		const stepIds = DEFINITIONS.map((definition) => definition.steps.map((step) => step.id));
		expect(stepIds.every((ids) => ids.length === 1)).toBe(true);
		expect(stepIds.flat().sort()).toEqual([...CONNECTABLE_CLOUDS].sort());
		expect(new Set(DEFINITIONS.map((definition) => definition.id))).toEqual(new Set([CLOUD_CONNECT_WIZARD_ID]));
		expect(new Set(DEFINITIONS.map((definition) => definition.presentation))).toEqual(new Set(["overlay"]));
	});

	it("are complete", () => {
		const problems: string[] = [];
		for (const definition of DEFINITIONS) {
			try {
				assertWizardComplete(definition);
			} catch (error) {
				problems.push(error instanceof Error ? error.message : String(error));
			}
		}
		expect(problems).toEqual([]);
	});

	it("keep identifiers only in a draft, and nothing for a token cloud", () => {
		const kept: Record<string, readonly string[] | null> = {};
		for (const definition of DEFINITIONS) {
			const cloud = definition.steps[0]?.id ?? "";
			kept[cloud] = definition.draft === null ? null : draftTopLevelKeys(definition.draft.schema);
		}
		expect(kept).toEqual(EXPECTED_DRAFT_KEYS);
	});

	it("never list a credential or a pasted config in a draft schema", () => {
		const leaks: string[] = [];
		for (const definition of DEFINITIONS) {
			if (definition.draft === null) continue;
			const keys = draftTopLevelKeys(definition.draft.schema) ?? [];
			leaks.push(...keys.filter((key) => NEVER_DRAFTED.includes(key)));
			leaks.push(...sensitiveDraftKeys(definition.draft.schema));
		}
		expect(leaks).toEqual([]);
	});
});

describe("cloud connect field messages", () => {
	it("an empty GCP form names both of its fields", () => {
		const found = messages(gcpConnectWizard.schema, {
			mode: "ids",
			projectId: "",
			projectNumber: "",
			wifConfigJson: "",
		});
		expect(found).toEqual({
			projectId: ["Enter the project ID."],
			projectNumber: ["Enter the project number the script printed."],
		});
	});

	it("a malformed GCP id and number each say what they should be", () => {
		const found = messages(gcpConnectWizard.schema, {
			mode: "ids",
			projectId: "My_Project",
			projectNumber: "12a",
			wifConfigJson: "",
		});
		expect(Object.keys(found).sort()).toEqual(["projectId", "projectNumber"]);
		expect(found.projectNumber).toEqual(["A project number is digits only."]);
	});

	it("the GCP config mode asks for the config and nothing else", () => {
		expect(
			messages(gcpConnectWizard.schema, { mode: "config", projectId: "", projectNumber: "", wifConfigJson: "{}" }),
		).toEqual({ wifConfigJson: ['Paste the whole credential config. It starts with "type": "external_account".'] });
		expect(
			messages(gcpConnectWizard.schema, {
				mode: "config",
				projectId: "",
				projectNumber: "",
				wifConfigJson: '{"type":"external_account"}',
			}),
		).toEqual({});
	});

	it("an AWS CloudFormation stack ARN is named as one", () => {
		const found = messages(awsConnectWizard.schema, { roleArn: "arn:aws:cloudformation:eu-west-1:123456789012:stack/x/y" });
		expect(found.roleArn?.[0]).toMatch(/CloudFormation stack ARN/);
	});

	it("an Azure subscription pasted as the client ID is caught before a round trip", () => {
		const id = "11111111-2222-3333-4444-555555555555";
		const found = messages(azureConnectWizard.schema, {
			subscriptionId: id,
			tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			clientId: id,
		});
		expect(Object.keys(found)).toEqual(["clientId"]);
	});

	it("Hetzner wants both Object Storage keys or neither", () => {
		const token = "x".repeat(32);
		expect(messages(hetznerConnectWizard.schema, { token, s3AccessKey: "", s3SecretKey: "" })).toEqual({});
		expect(Object.keys(messages(hetznerConnectWizard.schema, { token, s3AccessKey: "a", s3SecretKey: "" }))).toEqual([
			"s3SecretKey",
		]);
		expect(messages(hetznerConnectWizard.schema, { token: "short", s3AccessKey: "", s3SecretKey: "" })).toEqual({
			token: ["Enter a valid Hetzner API token."],
		});
	});
});

describe("reading a setup script's output", () => {
	it("takes the role ARN out of the AWS script's whole output", () => {
		const output = [
			"Setup complete! (keyless, direct-OIDC)",
			"  IAM Role ARN: arn:aws:iam::123456789012:role/AlethiaProvisionerRole",
			"--- START CONFIG ---",
			"role_arn=arn:aws:iam::123456789012:role/AlethiaProvisionerRole",
		].join("\n");
		expect(extractAwsRoleArn(output)).toBe("arn:aws:iam::123456789012:role/AlethiaProvisionerRole");
		expect(extractAwsRoleArn("nothing here")).toBeNull();
	});

	it("takes the RAM role ARN out of the Alibaba script's output", () => {
		expect(extractAlibabaRoleArn("role_arn=acs:ram::5123456789012345:role/AlethiaProvisioner\n")).toBe(
			"acs:ram::5123456789012345:role/AlethiaProvisioner",
		);
	});

	it("reads the GCP project id and number by their labels", () => {
		const output = "  Project ID:      acme-prod-1\n  Project Number:  123456789012\n";
		expect(parseGcpIds(output)).toEqual({ projectId: "acme-prod-1", projectNumber: "123456789012" });
		expect(parseGcpIds('project_id = "acme-prod-1"\nproject_number = "42"')).toEqual({
			projectId: "acme-prod-1",
			projectNumber: "42",
		});
		expect(parseGcpIds("123456789012")).toEqual({});
	});
});

describe("a setup command with a typed value in it", () => {
	const command = "bash alethia-gcp-setup.sh YOUR_PROJECT_ID";

	it("takes the value when it is the identifier the command expects", () => {
		expect(commandWith(command, "YOUR_PROJECT_ID", " acme-prod-1 ", GCP_PROJECT_ID_REGEX)).toBe(
			"bash alethia-gcp-setup.sh acme-prod-1",
		);
	});

	it("keeps the placeholder for anything else, so typed text never becomes shell", () => {
		const attempts = ["acme; rm -rf ~", "$(curl evil)", "acme-prod-1 && echo", ""];
		const changed = attempts.filter(
			(value) => commandWith(command, "YOUR_PROJECT_ID", value, GCP_PROJECT_ID_REGEX) !== command,
		);
		expect(changed).toEqual([]);
	});
});
