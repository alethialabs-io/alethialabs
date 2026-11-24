// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform alert paging (#7408): wires the operator org, its channel, and one alert rule per platform
// alert, so the alerts the platform raises on `ALETHIA_PLATFORM_ALERT_ORG_ID` (payment holds, abuse
// ceilings, background-loop heartbeats, operator billing alerts) page a person instead of being only
// log lines. Run once by an operator or a production session; safe to run again — a converged org
// is reported unchanged and nothing is written.
//
// What it does, in order (the decisions are in `platform-alert-paging-core.ts`):
//   1. the org: an existing one by `--org-id` or `--org-slug`, or a new one by `--org-slug` +
//      `--org-name` + `--owner-email` (created through `provisionOrg`, which validates the slug the
//      way the console does and INVITES the owner, never force-adds an account);
//   2. the channel the operator names (`--channel-type`, `--channel-name`): reused by name, or created
//      the way the Alerts page creates one — the same zod validator, the same encryption, and a real
//      test delivery through the channel's sender BEFORE the row is saved, so it never exists
//      unverified. A secret destination (webhook/Slack/… URL, PagerDuty routing key) is read from
//      ALETHIA_PAGING_CHANNEL_SECRET, which the `platform-alert-paging` creds profile supplies; it is
//      never an argument and never printed;
//   3. one rule per event of the catalog's "Platform health" group, bound to that channel, validated
//      with the Alerts page's policy validator;
//   4. with `--write-vault`, `ALETHIA_PLATFORM_ALERT_ORG_ID` merged into the production vault (the
//      `prod-env` profile's Secrets Manager secret in scripts/creds/profiles.json), every other key
//      kept, no value printed. The running console reads it after the next deploy-console run;
//   5. a [TEST] platform alert emitted on the org through the real emit → dispatch path, waiting for
//      each delivery to settle and reporting whether the channel accepted it.
//
// The org and channel writers of the console are server actions bound to a signed-in actor, so this
// cannot call them; it calls what they call — the validators (`lib/validations/alerts.ts`), the
// channel senders, `encryptSecret`, `provisionOrg` and `invalidateOrgRules` — and never writes a
// field they would not.
//
// Usage (from the repo root; NODE_PATH supplies the `server-only` stub, as for replay-tombstones.ts):
//
//   pnpm creds prod-env,platform-alert-paging -- env NODE_PATH=scripts/e2e/node-stubs \
//     pnpm -C apps/console exec tsx scripts/ops/platform-alert-paging.ts \
//     --org-slug alethia-ops [--org-name "Alethia Operations" --owner-email ops@…] \
//     --channel-type slack --channel-name "Platform on-call" \
//     [--recipients a@…,b@…] [--dry-run] [--write-vault] [--skip-test-alert]
//
//   … platform-alert-paging.ts --vault-only --org-id <uuid> [--dry-run]
//       sets only the vault key, without a database (for when the database is reachable only from
//       the box and the vault only from a workstation).
//
// Needs ALETHIA_DATABASE_URL (the service connection), ALETHIA_CRED_ENCRYPTION_KEY for a non-email
// channel, PLATFORM_SYSTEM_USER_EMAIL (the `created_by` of what it writes), and the aws CLI signed in
// for --write-vault. Exit codes: 0 done; 1 refused, failed, or the test alert was not delivered;
// 2 usage.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { alertChannelType } from "@/lib/db/schema/enums";
import type * as SsrfModule from "@/lib/net/ssrf-guard";
import type * as ProvisionModule from "@/lib/platform/provision";
import {
	type DesiredRule,
	type ExistingChannel,
	type ExistingRule,
	ORG_ID_ENV,
	type OrgRow,
	type OrgSelector,
	type PagingOptions,
	PagingRefusal,
	type PagingStore,
	type PagingVault,
	type TestDelivery,
	deriveRuleSet,
	renderReport,
	runPaging,
	testPassed,
} from "./platform-alert-paging-core";

/** The env var the destination secret arrives in (from the `platform-alert-paging` creds profile). */
const SECRET_ENV = "ALETHIA_PAGING_CHANNEL_SECRET";

/** How long the test alert's deliveries are awaited before they are reported as still pending. */
const TEST_WAIT_MS = 45_000;

const USAGE = `Usage:
  platform-alert-paging.ts (--org-id <uuid> | --org-slug <slug> [--org-name <name> --owner-email <email>])
                           --channel-type <${alertChannelType.enumValues.join("|")}> --channel-name <name>
                           [--recipients a@x,b@y] [--dry-run] [--write-vault] [--skip-test-alert]
  platform-alert-paging.ts --vault-only --org-id <uuid> [--dry-run]

A non-email channel's destination (URL, or PagerDuty routing key) is read from ${SECRET_ENV}.`;

/** A usage error: printed with the usage text, exit 2. */
class UsageError extends Error {}

/** Parsed command line. */
interface Cli {
	vaultOnly: boolean;
	orgId: string | undefined;
	opts: PagingOptions | null;
	dryRun: boolean;
}

/** Parses argv into the run's options, refusing an incomplete or contradictory command line. */
export function parseCli(argv: string[], env: Readonly<Partial<Record<string, string>>>): Cli {
	const { values } = parseArgs({
		args: argv,
		options: {
			"org-id": { type: "string" },
			"org-slug": { type: "string" },
			"org-name": { type: "string" },
			"owner-email": { type: "string" },
			"channel-type": { type: "string" },
			"channel-name": { type: "string" },
			recipients: { type: "string" },
			"dry-run": { type: "boolean", default: false },
			"write-vault": { type: "boolean", default: false },
			"skip-test-alert": { type: "boolean", default: false },
			"vault-only": { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
		strict: true,
	});
	if (values.help) throw new UsageError("");
	const dryRun = values["dry-run"] ?? false;
	const orgId = values["org-id"];
	if (orgId !== undefined && !z.string().uuid().safeParse(orgId).success) {
		throw new UsageError(`--org-id must be a UUID.`);
	}
	if (values["vault-only"]) {
		if (!orgId) throw new UsageError("--vault-only needs --org-id.");
		return { vaultOnly: true, orgId, opts: null, dryRun };
	}

	const slug = values["org-slug"];
	if (!orgId === !slug) throw new UsageError("Name the org with exactly one of --org-id or --org-slug.");
	let org: OrgSelector;
	if (orgId) {
		org = { by: "id", id: orgId };
	} else {
		const name = values["org-name"];
		const ownerEmail = values["owner-email"];
		if (Boolean(name) !== Boolean(ownerEmail)) {
			throw new UsageError("--org-name and --owner-email go together (they are used only to create the org).");
		}
		org = { by: "slug", slug: slug ?? "", ...(name && ownerEmail ? { create: { name, ownerEmail } } : {}) };
	}

	const type = z.enum(alertChannelType.enumValues).safeParse(values["channel-type"]);
	if (!type.success) throw new UsageError(`--channel-type must be one of ${alertChannelType.enumValues.join(", ")}.`);
	const channelName = values["channel-name"]?.trim();
	if (!channelName) throw new UsageError("--channel-name is required.");
	const recipients = (values.recipients ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (recipients.length > 0 && type.data !== "email") {
		throw new UsageError("--recipients is for an email channel only.");
	}
	const secret = env[SECRET_ENV]?.trim();
	return {
		vaultOnly: false,
		orgId,
		dryRun,
		opts: {
			org,
			channel: { type: type.data, name: channelName, recipients, secret: secret ? secret : undefined },
			dryRun,
			writeVault: values["write-vault"] ?? false,
			testAlert: !(values["skip-test-alert"] ?? false),
		},
	};
}

/** Where a person reads the channel's alerts, without its secret destination. */
export function channelLabel(channel: PagingOptions["channel"]): string {
	return channel.type === "email" ? channel.recipients.join(", ") || "its recipients" : `the ${channel.type} destination`;
}

// ── The vault ────────────────────────────────────────────────────────────────────

/** The `prod-env` profile's coordinates, read from scripts/creds/profiles.json (one source of truth). */
interface VaultCoordinates {
	secretId: string;
	region: string;
	awsProfile: string | undefined;
}

const profileSchema = z.object({
	profiles: z.object({
		"prod-env": z.object({ asm_path: z.string().min(1), region: z.string().min(1), aws_profile: z.string().optional() }),
	}),
});

/** Finds scripts/creds/profiles.json by walking up from the working directory. */
function findProfiles(start: string): string {
	let dir = start;
	for (;;) {
		const candidate = join(dir, "scripts", "creds", "profiles.json");
		if (existsSync(candidate)) return candidate;
		const up = dirname(dir);
		if (up === dir) throw new PagingRefusal("scripts/creds/profiles.json not found above the working directory; --write-vault runs from a repo checkout.");
		dir = up;
	}
}

/** Reads the prod vault's coordinates from the creds profiles. */
function vaultCoordinates(): VaultCoordinates {
	const raw: unknown = JSON.parse(readFileSync(findProfiles(process.cwd()), "utf8"));
	const p = profileSchema.parse(raw).profiles["prod-env"];
	return { secretId: p.asm_path, region: p.region, awsProfile: p.aws_profile };
}

const secretObject = z.record(z.string(), z.unknown());

/**
 * The production vault through the aws CLI. The secret's JSON is captured, never printed or passed
 * on a command line: the write goes through a 0600 file in a private temp dir, removed afterwards.
 * An aws failure surfaces its stderr, which never carries the value (the call failed before it).
 */
function awsVault(c: VaultCoordinates): PagingVault {
	const env = { ...process.env, ...(c.awsProfile && !process.env.AWS_PROFILE ? { AWS_PROFILE: c.awsProfile } : {}) };
	/** Runs one aws call and returns its stdout. */
	const aws = (args: string[]): string => {
		try {
			return execFileSync("aws", [...args, "--region", c.region], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			const stderr = err instanceof Error && "stderr" in err ? String(err.stderr).trim().slice(0, 400) : "";
			throw new PagingRefusal(`aws secretsmanager failed on ${c.secretId}: ${stderr || "no output"}`);
		}
	};
	/** The whole secret as an object. */
	const readAll = (): Record<string, unknown> => {
		const text = aws(["secretsmanager", "get-secret-value", "--secret-id", c.secretId, "--query", "SecretString", "--output", "text"]);
		const parsed = secretObject.safeParse(JSON.parse(text));
		if (!parsed.success) throw new PagingRefusal(`${c.secretId} is not a JSON object.`);
		return parsed.data;
	};
	return {
		describe: () => `${c.secretId} (${c.region})`,
		read: async (key) => {
			const v = readAll()[key];
			return typeof v === "string" && v.length > 0 ? v : undefined;
		},
		write: async (key, value) => {
			const next = { ...readAll(), [key]: value };
			const dir = mkdtempSync(join(tmpdir(), "alethia-vault-"));
			const file = join(dir, "secret.json");
			try {
				writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
				aws(["secretsmanager", "put-secret-value", "--secret-id", c.secretId, "--secret-string", `file://${file}`]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

// ── The database ─────────────────────────────────────────────────────────────────

/** Maps a sender's verification failure to a message that names no destination. */
function verifyFailure(err: unknown, ssrf: typeof SsrfModule): string {
	if (err instanceof ssrf.SsrfError) return ssrf.UNREACHABLE_DESTINATION;
	return err instanceof Error ? err.message : String(err);
}

/**
 * Loads `lib/platform/provision` on first use only. Its import graph reaches the фактура PDF renderer
 * (`provision` → `billing-email` → `factura/issue` → `@react-pdf`), which resolves inside Next's
 * bundler but not under plain tsx, so loading it eagerly would stop every run, including the ones that
 * only reuse an org. When it cannot load, the refusal names the way round.
 */
async function loadProvision(purpose: string): Promise<typeof ProvisionModule> {
	try {
		return await import("@/lib/platform/provision");
	} catch (err) {
		const why = err instanceof Error ? err.message.slice(0, 200) : String(err);
		throw new PagingRefusal(
			`To ${purpose} this needs lib/platform/provision, which did not load here (${why}). Provision the org from the staff app (it also creates the platform system user), then re-run with --org-slug <its slug>.`,
		);
	}
}

/** The real store: the console's validators, sender, encryption and org provisioning, over the service connection. */
async function databaseStore(): Promise<PagingStore> {
	const [{ and, eq, inArray, like }, { getServiceDb }, schema, { channelInputSchema, policyInputSchema }, channels, crypto, ruleCache, emit, ssrf] =
		await Promise.all([
			import("drizzle-orm"),
			import("@/lib/db"),
			import("@/lib/db/schema"),
			import("@/lib/validations/alerts"),
			import("@/lib/alerts/channels"),
			import("@/lib/crypto/secrets"),
			import("@/lib/alerts/rule-cache"),
			import("@/lib/alerts/emit"),
			import("@/lib/net/ssrf-guard"),
		]);
	const { alertChannels, alertDeliveries, alertRuleChannels, alertRules, organization, user } = schema;
	const db = getServiceDb();

	/** The policy validator's input for a managed rule. */
	const policyFor = (d: DesiredRule, channelId: string) =>
		policyInputSchema.parse({
			name: d.name,
			description: d.description,
			event_patterns: [d.key],
			match: {},
			severity: d.severity,
			throttle_seconds: d.throttle_seconds,
			escalate: false,
			enabled: true,
			channels: [{ id: channelId }],
		});

	/** Channel row → the columns the core reads. */
	const toChannel = (c: typeof alertChannels.$inferSelect): ExistingChannel => ({
		id: c.id,
		type: c.type,
		name: c.name,
		enabled: c.enabled,
		is_verified: c.is_verified,
	});

	return {
		findOrg: async (sel): Promise<OrgRow | null> => {
			const where = "id" in sel ? eq(organization.id, sel.id) : eq(organization.slug, sel.slug);
			const [row] = await db
				.select({ id: organization.id, name: organization.name, slug: organization.slug })
				.from(organization)
				.where(where)
				.limit(1);
			return row ?? null;
		},
		createOrg: async (input) => {
			const provision = await loadProvision("create the org");
			try {
				const { orgId } = await provision.provisionOrg(input);
				return { id: orgId, name: input.name, slug: input.slug };
			} catch (err) {
				if (err instanceof provision.ProvisionError) throw new PagingRefusal(err.message);
				throw err;
			}
		},
		systemUserId: async (create) => {
			const email = process.env.PLATFORM_SYSTEM_USER_EMAIL?.trim().toLowerCase();
			if (!email) throw new PagingRefusal("PLATFORM_SYSTEM_USER_EMAIL is not set; it names the user recorded as creating the channel and rules.");
			const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
			if (row) return row.id;
			if (!create) return null;
			return (await loadProvision(`create the platform system user ${email}`)).ensurePlatformSystemUser();
		},
		listChannels: async (orgId) =>
			(await db.select().from(alertChannels).where(eq(alertChannels.org_id, orgId))).map(toChannel),
		createChannel: async (orgId, input, createdBy) => {
			const parsed = channelInputSchema.safeParse({
				type: input.type,
				name: input.name,
				enabled: true,
				recipients: input.type === "email" ? input.recipients : undefined,
				secret:
					input.type === "email" || !input.secret
						? undefined
						: input.type === "pagerduty"
							? { routingKey: input.secret }
							: { url: input.secret },
			});
			if (!parsed.success) {
				// Paths and messages only: a zod issue for the URL says "Invalid url", never the value.
				const why = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
				throw new PagingRefusal(`The channel is not valid: ${why}`);
			}
			const data = parsed.data;
			if (data.type !== "email" && !crypto.isCredEncryptionConfigured()) {
				throw new PagingRefusal("ALETHIA_CRED_ENCRYPTION_KEY is not set, so a secret-bearing channel cannot be stored.");
			}
			const fields: Record<string, string> = {};
			if (data.secret?.url) fields.url = data.secret.url;
			if (data.secret?.routingKey) fields.routingKey = data.secret.routingKey;
			const secret = Object.keys(fields).length > 0 ? crypto.encryptSecret(fields) : null;
			const now = new Date();
			const preview: typeof alertChannels.$inferSelect = {
				id: "preview",
				org_id: orgId,
				type: data.type,
				name: data.name,
				config: { recipients: data.recipients ?? [] },
				secret,
				enabled: true,
				is_verified: false,
				last_verified_at: null,
				created_by: createdBy,
				created_at: now,
				updated_at: now,
			};
			try {
				await channels.getChannelSender(data.type).verify(preview);
			} catch (err) {
				throw new PagingRefusal(`The channel did not verify, so it was not saved: ${verifyFailure(err, ssrf)}`);
			}
			const [row] = await db
				.insert(alertChannels)
				.values({
					org_id: orgId,
					type: data.type,
					name: data.name,
					enabled: true,
					config: { recipients: data.recipients ?? [] },
					secret,
					is_verified: true,
					last_verified_at: now,
					created_by: createdBy,
				})
				.returning();
			return toChannel(row);
		},
		listRules: async (orgId): Promise<ExistingRule[]> => {
			const rules = await db.select().from(alertRules).where(eq(alertRules.org_id, orgId));
			const ids = rules.map((r) => r.id);
			const bindings =
				ids.length === 0
					? []
					: await db
							.select({ rule_id: alertRuleChannels.rule_id, channel_id: alertRuleChannels.channel_id })
							.from(alertRuleChannels)
							.where(inArray(alertRuleChannels.rule_id, ids));
			return rules.map((r) => ({
				id: r.id,
				name: r.name,
				description: r.description,
				event_patterns: r.event_patterns,
				severity: r.severity,
				throttle_seconds: r.throttle_seconds,
				enabled: r.enabled,
				channelIds: bindings.filter((b) => b.rule_id === r.id).map((b) => b.channel_id),
			}));
		},
		createRule: async (orgId, desired, channelId, createdBy) => {
			const p = policyFor(desired, channelId);
			const id = await db.transaction(async (tx) => {
				const [created] = await tx
					.insert(alertRules)
					.values({
						org_id: orgId,
						name: p.name,
						description: p.description ?? null,
						event_patterns: p.event_patterns,
						match: p.match,
						severity: p.severity,
						throttle_seconds: p.throttle_seconds,
						escalate: p.escalate,
						recipient: null,
						enabled: p.enabled,
						created_by: createdBy,
					})
					.returning({ id: alertRules.id });
				await tx.insert(alertRuleChannels).values({ rule_id: created.id, channel_id: channelId, min_severity: null });
				return created.id;
			});
			ruleCache.invalidateOrgRules(orgId);
			return id;
		},
		updateRule: async (orgId, ruleId, desired, channelId) => {
			const p = policyFor(desired, channelId);
			await db.transaction(async (tx) => {
				const [rule] = await tx
					.update(alertRules)
					.set({
						name: p.name,
						description: p.description ?? null,
						event_patterns: p.event_patterns,
						severity: p.severity,
						throttle_seconds: p.throttle_seconds,
						enabled: true,
						updated_at: new Date(),
					})
					.where(and(eq(alertRules.id, ruleId), eq(alertRules.org_id, orgId)))
					.returning({ id: alertRules.id });
				if (!rule) throw new PagingRefusal(`Rule ${ruleId} vanished from the org mid-run; re-run the script.`);
				await tx
					.insert(alertRuleChannels)
					.values({ rule_id: rule.id, channel_id: channelId, min_severity: null })
					.onConflictDoNothing();
			});
			ruleCache.invalidateOrgRules(orgId);
		},
		emitTestAlert: async (orgId, rule, subject): Promise<TestDelivery[]> => {
			ruleCache.invalidateOrgRules(orgId);
			const queued = await emit.emitAlertEvent(orgId, rule.key, {
				title: `[TEST] ${rule.name}`,
				summary: "A test from scripts/ops/platform-alert-paging.ts confirming platform alerts reach this channel. No action needed.",
				severity: rule.severity,
				resource_type: "paging_test",
				resource_id: subject,
			});
			if (queued === 0) return [];
			const deadline = Date.now() + TEST_WAIT_MS;
			for (;;) {
				const rows = await db
					.select({ channelId: alertDeliveries.channel_id, status: alertDeliveries.status, lastError: alertDeliveries.last_error })
					.from(alertDeliveries)
					.where(and(eq(alertDeliveries.org_id, orgId), like(alertDeliveries.dedupe_key, `%:${rule.key}:${subject}`)));
				if (rows.every((r) => r.status !== "pending") || Date.now() > deadline) return rows;
				await new Promise((r) => setTimeout(r, 1_000));
			}
		},
	};
}

// ── Entry ────────────────────────────────────────────────────────────────────────

/** Runs the command; returns the exit code. */
async function main(argv: string[]): Promise<number> {
	let cli: Cli;
	try {
		cli = parseCli(argv, process.env);
	} catch (err) {
		if (err instanceof UsageError || (err instanceof TypeError && "code" in err)) {
			if (err.message) console.error(err.message);
			console.error(USAGE);
			return 2;
		}
		throw err;
	}

	try {
		if (cli.vaultOnly && cli.orgId) {
			const vault = awsVault(vaultCoordinates());
			const current = await vault.read(ORG_ID_ENV);
			if (current === cli.orgId) {
				console.log(`Vault  ${ORG_ID_ENV} in ${vault.describe()} already names ${cli.orgId}. Nothing written.`);
			} else if (cli.dryRun) {
				console.log(`Vault  would set ${ORG_ID_ENV} in ${vault.describe()} (currently ${current ? "a different org" : "unset"}). Nothing written.`);
			} else {
				await vault.write(ORG_ID_ENV, cli.orgId);
				console.log(`Vault  set ${ORG_ID_ENV} in ${vault.describe()} (was ${current ? "a different org" : "unset"}).`);
				console.log("       The running console reads it only after the next deploy-console run.");
			}
			return 0;
		}
		if (!cli.opts) throw new UsageError("nothing to do");

		const { CATEGORIES } = await import("@/lib/alerts/catalog");
		const desired = deriveRuleSet(CATEGORIES);
		const store = await databaseStore();
		const vault = cli.opts.writeVault ? awsVault(vaultCoordinates()) : null;
		const report = await runPaging(cli.opts, desired, store, vault, process.env[ORG_ID_ENV]);
		for (const line of renderReport(report, channelLabel(cli.opts.channel))) console.log(line);
		if (report.test.kind === "emitted" && !testPassed(report.test.deliveries)) return 1;
		return 0;
	} catch (err) {
		if (err instanceof PagingRefusal) {
			console.error(`Refused: ${err.message}`);
			return 1;
		}
		throw err;
	}
}

if (process.argv[1] && /platform-alert-paging\.ts$/.test(process.argv[1])) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		},
	);
}
