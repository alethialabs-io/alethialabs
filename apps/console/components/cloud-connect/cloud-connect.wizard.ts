// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cloud connect, declared for the wizard engine (`lib/wizard/`): one step per cloud.
//
// The overlay is `?wizard=cloud-connect&step=<cloud>`. Each cloud asks for different things, so
// each cloud is its own definition with ONE step whose id is the cloud's slug; they share the
// wizard id, and the sheet picks the definition the URL's step names. A definition per cloud keeps
// every field typed by the cloud that owns it, and the field names are the server's own
// (`connectCloudAccount`'s input), so a server field error lands on its field with no mapping.
//
// THE DRAFT KEEPS IDENTIFIERS ONLY: a role ARN, a GCP project id and number, the three Azure ids.
// Those are public names the customer's cloud prints; keeping them lets a refresh or a closed sheet
// come back filled in. Nothing else is listed, so nothing else is stored — not the Hetzner,
// DigitalOcean or Civo token, not the Object Storage key pair, not a pasted GCP credential config.
// The clouds whose only input is a credential keep no draft at all (`draft: null`).
// `tests/lib/wizard/definitions.test.ts` holds every definition here to that, and
// `tests/components/cloud-connect/cloud-connect-wizard.test.ts` names each draft's keys.
//
// The pure helpers below read the setup scripts' printed output, so a person pastes what the
// script printed and the form takes the values it needs from it.

import { z } from "zod";
import { AZURE_GUID_REGEX, azureIdConflict } from "@/lib/cloud-providers/azure-ids";
import { GCP_PROJECT_ID_REGEX } from "@/lib/cloud-providers/gcp-wif";
import type { ConnectableCloudSlug } from "@/lib/cloud-providers/generated/catalog";
import { defineWizard } from "@/lib/wizard/define";

/** The overlay's URL and draft namespace (`?wizard=cloud-connect`). */
export const CLOUD_CONNECT_WIZARD_ID = "cloud-connect";

/** How long a draft of identifiers is kept in the tab. */
const DRAFT_TTL_MINUTES = 60;

/** The shape of an IAM role ARN. */
const AWS_ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;

/** The shape of an Alibaba RAM role ARN. */
const ALIBABA_ROLE_ARN = /^acs:ram::\d+:role\/[\w+=,.@-]+$/;

/** A GCP project number: digits only. */
const GCP_PROJECT_NUMBER = /^\d{1,20}$/;

/**
 * The IAM role ARN in a pasted block — the whole CloudShell output, a `terraform output`, or the
 * ARN alone. `null` when the text holds none.
 */
export function extractAwsRoleArn(text: string): string | null {
	return text.match(/arn:aws:iam::\d{12}:role\/[\w+=,.@-]+/)?.[0] ?? null;
}

/** The RAM role ARN in a pasted block. `null` when the text holds none. */
export function extractAlibabaRoleArn(text: string): string | null {
	return text.match(/acs:ram::\d+:role\/[\w+=,.@-]+/)?.[0] ?? null;
}

/** The GCP project id and number a pasted block names. */
export interface GcpIds {
	readonly projectId?: string;
	readonly projectNumber?: string;
}

/**
 * The project id and number in the GCP setup script's output (`Project ID: …`, `Project Number: …`)
 * or a `terraform output` (`project_id = "…"`). Each value is matched by its own label, never by
 * position; a value with no label stays absent.
 */
export function parseGcpIds(text: string): GcpIds {
	const id = text.match(/project[_\s]*id\s*[:=]\s*"?([a-z][a-z0-9-]{4,28}[a-z0-9])"?/i)?.[1];
	const number = text.match(/project[_\s]*number\s*[:=]\s*"?(\d{1,20})"?/i)?.[1];
	return {
		...(id !== undefined && GCP_PROJECT_ID_REGEX.test(id) ? { projectId: id } : {}),
		...(number !== undefined ? { projectNumber: number } : {}),
	};
}

/**
 * A setup command with `placeholder` replaced by `value` — only when `value` is exactly the kind of
 * identifier the command expects (`shape`). Anything else keeps the placeholder, so text a person
 * typed can never become part of a shell command they copy.
 */
export function commandWith(command: string, placeholder: string, value: string, shape: RegExp): string {
	const trimmed = value.trim();
	return shape.test(trimmed) ? command.replace(placeholder, trimmed) : command;
}

// ── AWS ─────────────────────────────────────────────────────────────────────────────────────

const awsFields = z.object({
	roleArn: z
		.string()
		.trim()
		.superRefine((value, ctx) => {
			if (value === "") {
				ctx.addIssue({ code: "custom", message: "Paste the role ARN the setup printed." });
			} else if (value.startsWith("arn:aws:cloudformation:")) {
				ctx.addIssue({
					code: "custom",
					message:
						"That is a CloudFormation stack ARN. Open the stack's Outputs tab and copy RoleArn instead.",
				});
			} else if (!AWS_ROLE_ARN.test(value)) {
				ctx.addIssue({
					code: "custom",
					message: "That is not an IAM role ARN. It looks like arn:aws:iam::123456789012:role/AlethiaProvisionerRole.",
				});
			}
		}),
});

/** The AWS form as typed. */
export type AwsConnectValues = z.input<typeof awsFields>;
/** The AWS form as submitted. */
export type AwsConnectInput = z.output<typeof awsFields>;

/** Connect an AWS account: one IAM role ARN. The draft keeps the ARN. */
export const awsConnectWizard = defineWizard<AwsConnectValues, AwsConnectInput>({
	id: CLOUD_CONNECT_WIZARD_ID,
	presentation: "overlay",
	schema: awsFields,
	steps: [{ id: "aws", label: "AWS", fields: ["roleArn"], schema: awsFields }],
	draft: { version: 1, schema: z.object({ roleArn: z.string() }), ttlMinutes: DRAFT_TTL_MINUTES },
});

// ── GCP ─────────────────────────────────────────────────────────────────────────────────────

/** How a GCP connection is given: the two ids the script prints, or a pasted credential config. */
export const GCP_MODES = ["ids", "config"] as const;

const gcpShape = z.object({
	mode: z.enum(GCP_MODES),
	projectId: z.string().trim(),
	projectNumber: z.string().trim(),
	wifConfigJson: z.string(),
});

/** Whether `raw` is a Workload Identity Federation credential config. */
function isWifConfig(raw: string): boolean {
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "external_account";
	} catch {
		return false;
	}
}

const gcpFields = gcpShape.superRefine((v, ctx) => {
	if (v.mode === "config") {
		if (!isWifConfig(v.wifConfigJson)) {
			ctx.addIssue({
				code: "custom",
				path: ["wifConfigJson"],
				message: 'Paste the whole credential config. It starts with "type": "external_account".',
			});
		}
		return;
	}
	if (v.projectId === "") {
		ctx.addIssue({ code: "custom", path: ["projectId"], message: "Enter the project ID." });
	} else if (!GCP_PROJECT_ID_REGEX.test(v.projectId)) {
		ctx.addIssue({
			code: "custom",
			path: ["projectId"],
			message: "A project ID is 6–30 lowercase letters, digits or hyphens, and starts with a letter.",
		});
	}
	if (v.projectNumber === "") {
		ctx.addIssue({
			code: "custom",
			path: ["projectNumber"],
			message: "Enter the project number the script printed.",
		});
	} else if (!GCP_PROJECT_NUMBER.test(v.projectNumber)) {
		ctx.addIssue({ code: "custom", path: ["projectNumber"], message: "A project number is digits only." });
	}
});

/** The GCP form as typed. */
export type GcpConnectValues = z.input<typeof gcpFields>;
/** The GCP form as submitted. */
export type GcpConnectInput = z.output<typeof gcpFields>;

/**
 * Connect a GCP project: the project id and number (or, for Terraform and custom setups, the
 * credential config). The draft keeps the two ids and the mode, never the pasted config.
 */
export const gcpConnectWizard = defineWizard<GcpConnectValues, GcpConnectInput>({
	id: CLOUD_CONNECT_WIZARD_ID,
	presentation: "overlay",
	schema: gcpFields,
	steps: [
		{
			id: "gcp",
			label: "GCP",
			fields: ["mode", "projectId", "projectNumber", "wifConfigJson"],
			schema: gcpFields,
		},
	],
	draft: {
		version: 1,
		schema: z.object({ mode: z.enum(GCP_MODES), projectId: z.string(), projectNumber: z.string() }),
		ttlMinutes: DRAFT_TTL_MINUTES,
	},
});

// ── Azure ───────────────────────────────────────────────────────────────────────────────────

/** One Azure id field, with its own message when it is empty and when it is not a GUID. */
function azureId(label: string) {
	return z
		.string()
		.trim()
		.superRefine((value, ctx) => {
			if (value === "") ctx.addIssue({ code: "custom", message: `Enter the ${label}.` });
			else if (!AZURE_GUID_REGEX.test(value)) {
				ctx.addIssue({ code: "custom", message: `The ${label} is a GUID, like 00000000-0000-0000-0000-000000000000.` });
			}
		});
}

const azureFields = z
	.object({
		subscriptionId: azureId("subscription ID"),
		tenantId: azureId("tenant ID"),
		clientId: azureId("client ID"),
	})
	// Catch a mis-paste here, rather than as Entra's opaque AADSTS700016 after a round trip.
	.superRefine((v, ctx) => {
		if (![v.subscriptionId, v.tenantId, v.clientId].every((id) => AZURE_GUID_REGEX.test(id))) return;
		const conflict = azureIdConflict(v);
		if (conflict) ctx.addIssue({ code: "custom", path: [conflict.field], message: conflict.message });
	});

/** The Azure form as typed. */
export type AzureConnectValues = z.input<typeof azureFields>;
/** The Azure form as submitted. */
export type AzureConnectInput = z.output<typeof azureFields>;

/** Connect an Azure subscription: three public ids. The draft keeps all three. */
export const azureConnectWizard = defineWizard<AzureConnectValues, AzureConnectInput>({
	id: CLOUD_CONNECT_WIZARD_ID,
	presentation: "overlay",
	schema: azureFields,
	steps: [
		{
			id: "azure",
			label: "Azure",
			fields: ["subscriptionId", "tenantId", "clientId"],
			schema: azureFields,
		},
	],
	draft: {
		version: 1,
		schema: z.object({ subscriptionId: z.string(), tenantId: z.string(), clientId: z.string() }),
		ttlMinutes: DRAFT_TTL_MINUTES,
	},
});

// ── Hetzner ─────────────────────────────────────────────────────────────────────────────────

const hetznerFields = z
	.object({
		token: z.string().trim().min(16, "Enter a valid Hetzner API token."),
		// Optional Object Storage S3 key pair (both or neither). Hetzner has no API to mint these.
		s3AccessKey: z.string().trim(),
		s3SecretKey: z.string().trim(),
	})
	.superRefine((v, ctx) => {
		if ((v.s3AccessKey === "") === (v.s3SecretKey === "")) return;
		ctx.addIssue({
			code: "custom",
			path: [v.s3AccessKey === "" ? "s3AccessKey" : "s3SecretKey"],
			message: "Enter both the S3 access key and secret key, or leave both blank.",
		});
	});

/** The Hetzner form as typed. */
export type HetznerConnectValues = z.input<typeof hetznerFields>;
/** The Hetzner form as submitted. */
export type HetznerConnectInput = z.output<typeof hetznerFields>;

/** Connect Hetzner Cloud: a project-scoped token. Every input is a credential, so no draft. */
export const hetznerConnectWizard = defineWizard<HetznerConnectValues, HetznerConnectInput>({
	id: CLOUD_CONNECT_WIZARD_ID,
	presentation: "overlay",
	schema: hetznerFields,
	steps: [
		{ id: "hetzner", label: "Hetzner", fields: ["token", "s3AccessKey", "s3SecretKey"], schema: hetznerFields },
	],
	draft: null,
});

// ── Clouds offered only when an operator re-enables them ───────────────────────────────────

const alibabaFields = z.object({
	roleArn: z
		.string()
		.trim()
		.regex(ALIBABA_ROLE_ARN, "That is not a RAM role ARN. It looks like acs:ram::5123456789012345:role/AlethiaProvisioner."),
});

/** The Alibaba Cloud form as typed. */
export type AlibabaConnectValues = z.input<typeof alibabaFields>;
/** The Alibaba Cloud form as submitted. */
export type AlibabaConnectInput = z.output<typeof alibabaFields>;

/** Connect Alibaba Cloud: one RAM role ARN. The draft keeps the ARN. */
export const alibabaConnectWizard = defineWizard<AlibabaConnectValues, AlibabaConnectInput>({
	id: CLOUD_CONNECT_WIZARD_ID,
	presentation: "overlay",
	schema: alibabaFields,
	steps: [{ id: "alibaba", label: "Alibaba Cloud", fields: ["roleArn"], schema: alibabaFields }],
	draft: { version: 1, schema: z.object({ roleArn: z.string() }), ttlMinutes: DRAFT_TTL_MINUTES },
});

const tokenFields = z.object({ token: z.string().trim().min(16, "Enter a valid API token.") });

/** A token cloud's form as typed. */
export type TokenConnectValues = z.input<typeof tokenFields>;
/** A token cloud's form as submitted. */
export type TokenConnectInput = z.output<typeof tokenFields>;

/** The token clouds that have no sheet of their own. */
export type TokenOnlyCloud = Extract<ConnectableCloudSlug, "digitalocean" | "civo">;

/** Connect DigitalOcean: an API token. No draft. */
export const digitaloceanConnectWizard = defineWizard<TokenConnectValues, TokenConnectInput>({
	id: CLOUD_CONNECT_WIZARD_ID,
	presentation: "overlay",
	schema: tokenFields,
	steps: [{ id: "digitalocean", label: "DigitalOcean", fields: ["token"], schema: tokenFields }],
	draft: null,
});

/** Connect Civo: an API token. No draft. */
export const civoConnectWizard = defineWizard<TokenConnectValues, TokenConnectInput>({
	id: CLOUD_CONNECT_WIZARD_ID,
	presentation: "overlay",
	schema: tokenFields,
	steps: [{ id: "civo", label: "Civo", fields: ["token"], schema: tokenFields }],
	draft: null,
});
