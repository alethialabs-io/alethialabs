// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The decision half of the platform alert paging command (#7408): what the operator org, its
// channel and its rules SHOULD be, compared with what they ARE, and the one ordered run that
// converges them. It imports no server module (no database, no `server-only`), so the unit tests
// drive it against an in-memory store; `platform-alert-paging.ts` wires the real one.
//
// THE RULE SET IS DERIVED. One rule per event of the catalog's "Platform health" group
// (`lib/alerts/catalog.ts`, category id `platform`) — the events the platform raises on the org
// named by `ALETHIA_PLATFORM_ALERT_ORG_ID`. A platform alert added to that group gets its rule on
// the next run without an edit here. A group that disappears is a refusal, not an empty rule set:
// an empty set would report "nothing to do" while nobody is paged.
//
// WHAT "MANAGED" MEANS. A rule this command wrote carries {@link MANAGED_MARKER} at the start of
// its description and exactly one event pattern, the event's key. Only those rules are ever
// updated. A rule a person made is never edited: when an ENABLED one already routes an event to
// the chosen channel (by an exact key or a glob such as `system.platform.*`), that event is
// reported `covered` and no managed rule is added beside it. A managed rule whose key left the
// catalog is reported `stale` and left in place — deleting a pager rule is a person's decision.

import type { CatalogCategory } from "@/lib/alerts/catalog";
import { eventMatches } from "@/lib/alerts/catalog";
import type { AlertChannelType, AlertSeverity } from "@/lib/db/schema/enums";

/** The catalog category whose events are the platform alerts. */
export const PLATFORM_CATEGORY_ID = "platform";

/** Starts the description of every rule this command manages; how a re-run finds its own rules. */
export const MANAGED_MARKER = "Managed by scripts/ops/platform-alert-paging.ts";

/**
 * The managed rules' re-alert window. Each emitter already latches per process or per episode;
 * this collapses the same (event, subject) across replicas, the job `lib/abuse/platform-alert.ts`
 * says the rule's own throttle does. A different subject (another subscription) still pages.
 */
export const PAGING_THROTTLE_SECONDS = 900;

/** The vault key the platform emitters read. */
export const ORG_ID_ENV = "ALETHIA_PLATFORM_ALERT_ORG_ID";

/** One rule the operator org should have. */
export interface DesiredRule {
	/** The catalog event's display id (`platform.loop_degraded`). */
	eventId: string;
	/** The exact emit key the rule subscribes to. */
	key: string;
	name: string;
	description: string;
	severity: AlertSeverity;
	throttle_seconds: number;
}

/** A rule as read from `alert_rules`, with the channels bound to it. */
export interface ExistingRule {
	id: string;
	name: string;
	description: string | null;
	event_patterns: string[];
	severity: AlertSeverity;
	throttle_seconds: number;
	enabled: boolean;
	channelIds: string[];
}

/** A channel as read from `alert_channels` (never its secret). */
export interface ExistingChannel {
	id: string;
	type: AlertChannelType;
	name: string;
	enabled: boolean;
	is_verified: boolean;
}

/** An organization row, by the columns this command reads. */
export interface OrgRow {
	id: string;
	name: string;
	slug: string | null;
}

/** A refusal: the command stops, writes nothing further, and prints this. */
export class PagingRefusal extends Error {}

/**
 * The managed rule set, one per event of the catalog's platform group, in catalog order. Refuses
 * when the group is missing or empty, and when an event's key is a glob (a platform emitter raises
 * one concrete key, and a glob would also match keys nobody chose to page on).
 */
export function deriveRuleSet(categories: readonly CatalogCategory[]): DesiredRule[] {
	const group = categories.find((c) => c.id === PLATFORM_CATEGORY_ID);
	if (!group || group.events.length === 0) {
		throw new PagingRefusal(
			`lib/alerts/catalog.ts has no "${PLATFORM_CATEGORY_ID}" category with events, so there is no platform alert to page on.`,
		);
	}
	const seen = new Set<string>();
	const rules: DesiredRule[] = [];
	for (const e of group.events) {
		if (e.key.includes("*")) {
			throw new PagingRefusal(`Platform event ${e.id} has a glob key (${e.key}); a platform alert is one concrete key.`);
		}
		if (seen.has(e.key)) continue;
		seen.add(e.key);
		rules.push({
			eventId: e.id,
			key: e.key,
			name: `Platform paging: ${e.label}`,
			description: `${MANAGED_MARKER} from the catalog event ${e.id} (${e.key}). Re-run the script rather than editing this rule.`,
			severity: e.severity,
			throttle_seconds: PAGING_THROTTLE_SECONDS,
		});
	}
	return rules;
}

/** Whether this command wrote the rule (marker first, one pattern). */
export function isManagedRule(rule: ExistingRule): boolean {
	return (rule.description ?? "").startsWith(MANAGED_MARKER) && rule.event_patterns.length === 1;
}

/** What the run does about one desired rule. */
export type RuleAction =
	| { kind: "create"; desired: DesiredRule }
	| { kind: "update"; desired: DesiredRule; ruleId: string; changes: string[] }
	| { kind: "unchanged"; desired: DesiredRule; ruleId: string }
	| { kind: "covered"; desired: DesiredRule; ruleId: string; ruleName: string };

/** A managed rule whose key is no longer a platform event. Reported, never deleted. */
export interface StaleRule {
	ruleId: string;
	name: string;
	key: string;
}

/** The field-by-field differences between a managed rule and the rule it should be. */
function ruleDrift(rule: ExistingRule, desired: DesiredRule, channelId: string | null): string[] {
	const changes: string[] = [];
	if (rule.name !== desired.name) changes.push("name");
	if (rule.description !== desired.description) changes.push("description");
	if (rule.severity !== desired.severity) changes.push(`severity ${rule.severity} → ${desired.severity}`);
	if (rule.throttle_seconds !== desired.throttle_seconds) {
		changes.push(`throttle ${rule.throttle_seconds}s → ${desired.throttle_seconds}s`);
	}
	if (!rule.enabled) changes.push("re-enable");
	if (channelId === null || !rule.channelIds.includes(channelId)) changes.push("bind the channel");
	return changes;
}

/**
 * Compares the desired rules with the org's rules. `channelId` is the paging channel, or null when
 * it does not exist yet (a dry run that would create it): then nothing is bound to it, so nothing is
 * `covered` and every managed rule needs the binding.
 */
export function planRules(
	desired: readonly DesiredRule[],
	existing: readonly ExistingRule[],
	channelId: string | null,
): { actions: RuleAction[]; stale: StaleRule[] } {
	const managed = existing.filter(isManagedRule);
	const actions: RuleAction[] = desired.map((d): RuleAction => {
		const own = managed.find((r) => r.event_patterns[0] === d.key);
		if (own) {
			const changes = ruleDrift(own, d, channelId);
			return changes.length === 0
				? { kind: "unchanged", desired: d, ruleId: own.id }
				: { kind: "update", desired: d, ruleId: own.id, changes };
		}
		const cover =
			channelId === null
				? undefined
				: existing.find(
						(r) =>
							!isManagedRule(r) &&
							r.enabled &&
							r.channelIds.includes(channelId) &&
							r.event_patterns.some((p) => eventMatches(p, d.key)),
					);
		if (cover) return { kind: "covered", desired: d, ruleId: cover.id, ruleName: cover.name };
		return { kind: "create", desired: d };
	});
	const wanted = new Set(desired.map((d) => d.key));
	const stale = managed
		.filter((r) => !wanted.has(r.event_patterns[0] ?? ""))
		.map((r) => ({ ruleId: r.id, name: r.name, key: r.event_patterns[0] ?? "" }));
	return { actions, stale };
}

/** What the run does about the channel. */
export type ChannelAction =
	| { kind: "reuse"; channel: ExistingChannel }
	| { kind: "create"; type: AlertChannelType; name: string };

/**
 * Finds the operator's channel by name and type, or plans to create it. A channel of that name with
 * another type is a refusal: reusing it would page somewhere the operator did not name, and a
 * second channel of the same name would make the Alerts page ambiguous.
 */
export function planChannel(
	existing: readonly ExistingChannel[],
	type: AlertChannelType,
	name: string,
): ChannelAction {
	const same = existing.filter((c) => c.name === name);
	const match = same.find((c) => c.type === type);
	if (match) return { kind: "reuse", channel: match };
	if (same.length > 0) {
		throw new PagingRefusal(
			`The org already has a channel named "${name}" of type ${same[0]?.type}, not ${type}. Pick another --channel-name, or the matching --channel-type.`,
		);
	}
	return { kind: "create", type, name };
}

/** How the operator named the org. */
export type OrgSelector =
	| { by: "id"; id: string }
	| { by: "slug"; slug: string; create?: { name: string; ownerEmail: string } };

/** What the run does about the org. */
export type OrgAction =
	| { kind: "reuse"; org: OrgRow }
	| { kind: "create"; name: string; slug: string; ownerEmail: string };

/** What the operator asked for, already parsed. */
export interface PagingOptions {
	org: OrgSelector;
	channel: {
		type: AlertChannelType;
		name: string;
		recipients: string[];
		/** The destination URL or PagerDuty routing key, from the environment. Never printed. */
		secret: string | undefined;
	};
	dryRun: boolean;
	writeVault: boolean;
	testAlert: boolean;
}

/** The database half the run needs. The real one reuses the console's writers and validators. */
export interface PagingStore {
	findOrg(selector: { id: string } | { slug: string }): Promise<OrgRow | null>;
	createOrg(input: { name: string; slug: string; ownerEmail: string }): Promise<OrgRow>;
	/** The platform system user's id (the `created_by` of what this writes); null when absent and `create` is false. */
	systemUserId(create: boolean): Promise<string | null>;
	listChannels(orgId: string): Promise<ExistingChannel[]>;
	/** Validates, verifies with a real test delivery, then inserts. Throws a PagingRefusal on a bad destination. */
	createChannel(orgId: string, input: PagingOptions["channel"], createdBy: string): Promise<ExistingChannel>;
	listRules(orgId: string): Promise<ExistingRule[]>;
	createRule(orgId: string, desired: DesiredRule, channelId: string, createdBy: string): Promise<string>;
	/** Converges a managed rule onto `desired` and adds the binding to `channelId`; other bindings stay. */
	updateRule(orgId: string, ruleId: string, desired: DesiredRule, channelId: string): Promise<void>;
	/** Emits a test platform alert and waits for its deliveries to settle. */
	emitTestAlert(orgId: string, rule: DesiredRule, subject: string): Promise<TestDelivery[]>;
}

/** One delivery of the test alert, after waiting. */
export interface TestDelivery {
	channelId: string | null;
	status: "pending" | "sent" | "failed" | "dead";
	lastError: string | null;
}

/** The production vault, read and written without printing a value. */
export interface PagingVault {
	/** Where it is, for the operator (`alethia/prod/env (eu-central-1)`). */
	describe(): string;
	/** The key's current value, or undefined when unset. */
	read(key: string): Promise<string | undefined>;
	/** Sets the key, keeping every other key. */
	write(key: string, value: string): Promise<void>;
}

/** What the vault step found or did. */
export type VaultOutcome =
	| { kind: "skipped"; envValue: string | undefined }
	| { kind: "unchanged" }
	| { kind: "set"; previously: "unset" | "a different org" }
	| { kind: "would-set"; previously: "unset" | "a different org" };

/** The full result of one run, rendered by {@link renderReport}. */
export interface PagingReport {
	dryRun: boolean;
	org: OrgAction;
	orgId: string | null;
	channel: ChannelAction;
	rules: RuleAction[];
	stale: StaleRule[];
	vault: VaultOutcome;
	vaultWhere: string;
	test: { kind: "skipped" } | { kind: "would-emit"; rule: DesiredRule } | { kind: "emitted"; rule: DesiredRule; deliveries: TestDelivery[] };
	/** How many writes the run made (0 on a dry run, and on a converged re-run). */
	writes: number;
}

/** The rule whose key the test alert uses: the first critical one, so it exercises a real page. */
export function pickTestRule(rules: readonly DesiredRule[]): DesiredRule {
	const pick = rules.find((r) => r.severity === "critical") ?? rules[0];
	if (!pick) throw new PagingRefusal("There is no platform rule to test.");
	return pick;
}

/** Resolves the org action: an existing org by id or slug, or a slug to create. */
async function planOrg(store: PagingStore, selector: OrgSelector): Promise<OrgAction> {
	if (selector.by === "id") {
		const org = await store.findOrg({ id: selector.id });
		if (!org) throw new PagingRefusal(`No organization has the id ${selector.id}.`);
		return { kind: "reuse", org };
	}
	const org = await store.findOrg({ slug: selector.slug });
	if (org) return { kind: "reuse", org };
	if (!selector.create) {
		throw new PagingRefusal(
			`No organization has the slug "${selector.slug}". To create it, pass --org-name and --owner-email as well.`,
		);
	}
	return { kind: "create", name: selector.create.name, slug: selector.slug, ownerEmail: selector.create.ownerEmail };
}

/**
 * The run. Reads everything first and plans; a dry run stops there. Otherwise it writes in order —
 * org, system user, channel, rules — then the vault (when `writeVault`), then the test alert. Every
 * step is idempotent, so a second run against the result writes nothing and reports `writes: 0`.
 * `envOrgId` is the value the process sees for {@link ORG_ID_ENV} (the vault's, under `pnpm creds
 * prod-env`), used only to warn when it names another org.
 */
export async function runPaging(
	opts: PagingOptions,
	desired: readonly DesiredRule[],
	store: PagingStore,
	vault: PagingVault | null,
	envOrgId: string | undefined,
): Promise<PagingReport> {
	if (desired.length === 0) throw new PagingRefusal("The derived rule set is empty.");
	const org = await planOrg(store, opts.org);
	const orgId0 = org.kind === "reuse" ? org.org.id : null;
	const channels = orgId0 ? await store.listChannels(orgId0) : [];
	const channel = planChannel(channels, opts.channel.type, opts.channel.name);
	if (channel.kind === "create") assertDestination(opts.channel);
	const rules0 = orgId0 ? await store.listRules(orgId0) : [];
	const channelId0 = channel.kind === "reuse" ? channel.channel.id : null;
	const plan0 = planRules(desired, rules0, channelId0);
	const testRule = pickTestRule(desired);
	const vaultWhere = vault?.describe() ?? "the production vault";

	if (opts.dryRun) {
		let vaultOutcome: VaultOutcome = { kind: "skipped", envValue: envOrgId };
		if (opts.writeVault && vault && orgId0) {
			const current = await vault.read(ORG_ID_ENV);
			vaultOutcome =
				current === orgId0
					? { kind: "unchanged" }
					: { kind: "would-set", previously: current ? "a different org" : "unset" };
		} else if (opts.writeVault) {
			vaultOutcome = { kind: "would-set", previously: envOrgId ? "a different org" : "unset" };
		}
		return {
			dryRun: true,
			org,
			orgId: orgId0,
			channel,
			rules: plan0.actions,
			stale: plan0.stale,
			vault: vaultOutcome,
			vaultWhere,
			test: opts.testAlert ? { kind: "would-emit", rule: testRule } : { kind: "skipped" },
			writes: 0,
		};
	}

	let writes = 0;
	let orgRow: OrgRow;
	if (org.kind === "create") {
		orgRow = await store.createOrg({ name: org.name, slug: org.slug, ownerEmail: org.ownerEmail });
		writes++;
	} else {
		orgRow = org.org;
	}
	const existingUser = await store.systemUserId(false);
	const createdBy = existingUser ?? (await store.systemUserId(true));
	if (!createdBy) throw new PagingRefusal("Could not resolve the platform system user (PLATFORM_SYSTEM_USER_EMAIL).");
	if (!existingUser) writes++;

	let channelRow: ExistingChannel;
	if (channel.kind === "create") {
		channelRow = await store.createChannel(orgRow.id, opts.channel, createdBy);
		writes++;
	} else {
		channelRow = channel.channel;
	}

	// Re-plan against the org as it now is: a just-created org or channel changes what is covered.
	const plan = planRules(desired, await store.listRules(orgRow.id), channelRow.id);
	for (const a of plan.actions) {
		if (a.kind === "create") {
			await store.createRule(orgRow.id, a.desired, channelRow.id, createdBy);
			writes++;
		} else if (a.kind === "update") {
			await store.updateRule(orgRow.id, a.ruleId, a.desired, channelRow.id);
			writes++;
		}
	}

	let vaultOutcome: VaultOutcome = { kind: "skipped", envValue: envOrgId };
	if (opts.writeVault) {
		if (!vault) throw new PagingRefusal("--write-vault needs the vault, and none is configured.");
		const current = await vault.read(ORG_ID_ENV);
		if (current === orgRow.id) {
			vaultOutcome = { kind: "unchanged" };
		} else {
			await vault.write(ORG_ID_ENV, orgRow.id);
			writes++;
			vaultOutcome = { kind: "set", previously: current ? "a different org" : "unset" };
		}
	}

	let test: PagingReport["test"] = { kind: "skipped" };
	if (opts.testAlert) {
		const subject = `paging-test-${new Date().toISOString()}`;
		test = { kind: "emitted", rule: testRule, deliveries: await store.emitTestAlert(orgRow.id, testRule, subject) };
	}

	return {
		dryRun: false,
		org,
		orgId: orgRow.id,
		channel: channel.kind === "create" ? { kind: "reuse", channel: channelRow } : channel,
		rules: plan.actions,
		stale: plan.stale,
		vault: vaultOutcome,
		vaultWhere,
		test,
		writes,
	};
}

/** Refuses a channel to create that has no destination for its type. */
function assertDestination(channel: PagingOptions["channel"]): void {
	if (channel.type === "email") {
		if (channel.recipients.length === 0) {
			throw new PagingRefusal("An email channel needs --recipients a@example.com[,b@example.com].");
		}
		return;
	}
	if (!channel.secret) {
		const what = channel.type === "pagerduty" ? "PagerDuty integration routing key" : `${channel.type} destination URL`;
		throw new PagingRefusal(
			`A ${channel.type} channel needs its ${what} in ALETHIA_PAGING_CHANNEL_SECRET. Store it once with  ! pnpm creds --set platform-alert-paging  and run the script under  pnpm creds prod-env,platform-alert-paging -- …`,
		);
	}
}

/** Whether every test delivery reached its channel. */
export function testPassed(deliveries: readonly TestDelivery[]): boolean {
	return deliveries.length > 0 && deliveries.every((d) => d.status === "sent");
}

/** The operator-facing report: the plan on a dry run, what was done otherwise. Never a secret. */
export function renderReport(r: PagingReport, channelLabel: string): string[] {
	const out: string[] = [];
	out.push(
		r.dryRun
			? "Platform alert paging: PLAN (dry run, nothing written)"
			: "Platform alert paging: APPLIED",
	);
	out.push("");
	if (r.org.kind === "reuse") {
		out.push(`Operator org   reuse    ${r.org.org.name} (${r.org.org.slug ?? "no slug"}, ${r.org.org.id})`);
	} else {
		out.push(
			`Operator org   ${r.dryRun ? "create" : "created"}   ${r.org.name} (${r.org.slug}); owner invitation to ${r.org.ownerEmail}${r.orgId ? `, ${r.orgId}` : ""}`,
		);
	}
	if (r.channel.kind === "reuse") {
		const c = r.channel.channel;
		const flags = [c.enabled ? null : "DISABLED", c.is_verified ? null : "not verified"].filter(Boolean);
		out.push(`Channel        ${r.dryRun ? "reuse " : "ready "}   ${c.type} "${c.name}" (${c.id})${flags.length ? ` [${flags.join(", ")}]` : ""}`);
	} else {
		out.push(
			`Channel        create   ${r.channel.type} "${r.channel.name}" to ${channelLabel}; a test delivery verifies it before it is saved`,
		);
	}
	out.push("");
	out.push(`Rules: one per platform alert in lib/alerts/catalog.ts (${r.rules.length})`);
	const verb = (k: RuleAction["kind"]): string =>
		({
			create: r.dryRun ? "+ create   " : "+ created  ",
			update: r.dryRun ? "~ update   " : "~ updated  ",
			unchanged: "= unchanged",
			covered: "= covered  ",
		})[k];
	for (const a of r.rules) {
		const line = `  ${verb(a.kind)} ${a.desired.eventId.padEnd(34)} ${a.desired.key.padEnd(44)} ${a.desired.severity}`;
		if (a.kind === "update") out.push(`${line}  (${a.changes.join(", ")})`);
		else if (a.kind === "covered") out.push(`${line}  (by the existing rule "${a.ruleName}")`);
		else out.push(line);
	}
	for (const s of r.stale) {
		out.push(`  ! stale      "${s.name}" (${s.key}) is no longer a platform alert; left in place, delete it in the console if unwanted`);
	}
	out.push("");
	switch (r.vault.kind) {
		case "skipped":
			out.push(`Vault          not touched (pass --write-vault to set ${ORG_ID_ENV} in ${r.vaultWhere})`);
			if (r.vault.envValue && r.orgId && r.vault.envValue !== r.orgId) {
				out.push(`               WARNING: this process sees ${ORG_ID_ENV} naming a DIFFERENT org. Platform alerts go there, not here.`);
			} else if (r.vault.envValue && r.vault.envValue === r.orgId) {
				out.push(`               this process already sees ${ORG_ID_ENV} naming this org`);
			}
			break;
		case "unchanged":
			out.push(`Vault          ${ORG_ID_ENV} in ${r.vaultWhere} already names this org`);
			break;
		case "would-set":
			out.push(`Vault          would set ${ORG_ID_ENV} in ${r.vaultWhere} (currently ${r.vault.previously})`);
			break;
		case "set":
			out.push(`Vault          set ${ORG_ID_ENV} in ${r.vaultWhere} (was ${r.vault.previously})`);
			out.push("               The running console reads it only after the next deploy-console run.");
			break;
	}
	switch (r.test.kind) {
		case "skipped":
			out.push("Test alert     skipped");
			break;
		case "would-emit":
			out.push(`Test alert     would emit a [TEST] ${r.test.rule.key} on the org and wait for its delivery`);
			break;
		case "emitted": {
			const d = r.test.deliveries;
			if (d.length === 0) {
				out.push(`Test alert     FAILED: emitting ${r.test.rule.key} matched no rule and channel, so nothing was delivered`);
			} else {
				for (const x of d) {
					const where = x.channelId ?? "a removed channel";
					out.push(
						x.status === "sent"
							? `Test alert     DELIVERED ${r.test.rule.key} to ${where}; confirm it arrived on ${channelLabel}`
							: `Test alert     ${x.status.toUpperCase()} to ${where}${x.lastError ? `: ${x.lastError}` : ""}`,
					);
				}
			}
			break;
		}
	}
	out.push("");
	out.push(r.dryRun ? "Nothing was written. Re-run without --dry-run to apply." : `${r.writes} change(s) written.`);
	return out;
}
