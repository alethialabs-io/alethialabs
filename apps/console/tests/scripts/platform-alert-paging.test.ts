// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// scripts/ops/platform-alert-paging (#7408) against an in-memory store and vault. Pinned: the rule set
// is DERIVED from the catalog's platform group (a new platform event gets a rule with no edit to the
// script); `--dry-run` prints the full plan and writes nothing; an apply converges and a second apply
// writes nothing; a person's rule that already routes an event is never edited and never doubled;
// a managed rule that drifted is converged; the vault key is set once; the destination secret is
// never printed.

import { describe, expect, it } from "vitest";
import { type CatalogCategory, CATEGORIES } from "@/lib/alerts/catalog";
import {
	type DesiredRule,
	deriveRuleSet,
	type ExistingChannel,
	type ExistingRule,
	MANAGED_MARKER,
	type OrgRow,
	PAGING_THROTTLE_SECONDS,
	type PagingOptions,
	PagingRefusal,
	type PagingStore,
	type PagingVault,
	pickTestRule,
	planChannel,
	planRules,
	renderReport,
	runPaging,
	type TestDelivery,
} from "../../scripts/ops/platform-alert-paging-core";
import { channelLabel, parseCli } from "../../scripts/ops/platform-alert-paging";

const SECRET_URL = "https://hooks.slack.com/services/T000/B000/very-secret-token";
const OPS_ORG: OrgRow = { id: "00000000-0000-4000-8000-0000000000a1", name: "Alethia Operations", slug: "alethia-ops" };

/** The platform events of the real catalog, the derivation's ground truth. */
const platformKeys = CATEGORIES.flatMap((c) => c.events).filter((e) => e.key.startsWith("system.platform."));

/** A fixture database: orgs, channels, rules, and a write counter. */
interface Fixture {
	orgs: OrgRow[];
	channels: (ExistingChannel & { orgId: string })[];
	rules: (ExistingRule & { orgId: string })[];
	systemUser: string | null;
	writes: string[];
	emitted: string[];
}

/** A fresh fixture holding the operator org and nothing else. */
function fixture(): Fixture {
	return { orgs: [OPS_ORG], channels: [], rules: [], systemUser: "00000000-0000-4000-8000-0000000000u1", writes: [], emitted: [] };
}

let seq = 0;
/** A deterministic id. */
const nextId = (p: string): string => `${p}-${++seq}`;

/** The in-memory store over a fixture. Mirrors the real one's contract, not its SQL. */
function memoryStore(f: Fixture): PagingStore {
	return {
		findOrg: async (sel) => f.orgs.find((o) => ("id" in sel ? o.id === sel.id : o.slug === sel.slug)) ?? null,
		createOrg: async (input) => {
			const org = { id: nextId("org"), name: input.name, slug: input.slug };
			f.orgs.push(org);
			f.writes.push(`org ${input.slug}`);
			return org;
		},
		systemUserId: async (create) => {
			if (!f.systemUser && create) {
				f.systemUser = nextId("user");
				f.writes.push("system user");
			}
			return f.systemUser;
		},
		listChannels: async (orgId) => f.channels.filter((c) => c.orgId === orgId),
		createChannel: async (orgId, input) => {
			const c = { id: nextId("ch"), orgId, type: input.type, name: input.name, enabled: true, is_verified: true };
			f.channels.push(c);
			f.writes.push(`channel ${input.name}`);
			return c;
		},
		listRules: async (orgId) => f.rules.filter((r) => r.orgId === orgId).map((r) => ({ ...r, channelIds: [...r.channelIds] })),
		createRule: async (orgId, d, channelId) => {
			const id = nextId("rule");
			f.rules.push({
				id,
				orgId,
				name: d.name,
				description: d.description,
				event_patterns: [d.key],
				severity: d.severity,
				throttle_seconds: d.throttle_seconds,
				enabled: true,
				channelIds: [channelId],
			});
			f.writes.push(`rule ${d.key}`);
			return id;
		},
		updateRule: async (orgId, ruleId, d, channelId) => {
			const r = f.rules.find((x) => x.id === ruleId && x.orgId === orgId);
			if (!r) throw new PagingRefusal("gone");
			Object.assign(r, { name: d.name, description: d.description, event_patterns: [d.key], severity: d.severity, throttle_seconds: d.throttle_seconds, enabled: true });
			if (!r.channelIds.includes(channelId)) r.channelIds.push(channelId);
			f.writes.push(`update ${d.key}`);
		},
		emitTestAlert: async (orgId, rule): Promise<TestDelivery[]> => {
			f.emitted.push(rule.key);
			return f.rules
				.filter((r) => r.orgId === orgId && r.enabled && r.event_patterns.includes(rule.key))
				.flatMap((r) => r.channelIds.map((channelId) => ({ channelId, status: "sent" as const, lastError: null })));
		},
	};
}

/** An in-memory vault. */
function memoryVault(initial: Record<string, string> = {}): PagingVault & { data: Record<string, string>; writes: number } {
	const v = {
		data: { ...initial },
		writes: 0,
		describe: () => "alethia/prod/env (eu-central-1)",
		read: async (key: string) => v.data[key],
		write: async (key: string, value: string) => {
			v.data[key] = value;
			v.writes++;
		},
	};
	return v;
}

/** The options of a typical run. */
function options(over: Partial<PagingOptions> = {}): PagingOptions {
	return {
		org: { by: "slug", slug: "alethia-ops" },
		channel: { type: "slack", name: "Platform on-call", recipients: [], secret: SECRET_URL },
		dryRun: false,
		writeVault: true,
		testAlert: true,
		...over,
	};
}

describe("deriveRuleSet", () => {
	it("gives every platform event of the real catalog exactly one rule, in catalog order", () => {
		const rules = deriveRuleSet(CATEGORIES);
		expect(rules.map((r) => r.key)).toEqual(platformKeys.map((e) => e.key));
		expect(rules.length).toBeGreaterThanOrEqual(5);
		for (const r of rules) {
			const ev = platformKeys.find((e) => e.key === r.key);
			expect(r.severity).toBe(ev?.severity);
			expect(r.description.startsWith(MANAGED_MARKER)).toBe(true);
			expect(r.throttle_seconds).toBe(PAGING_THROTTLE_SECONDS);
		}
	});

	it("covers the keys the platform emitters raise", () => {
		const keys = deriveRuleSet(CATEGORIES).map((r) => r.key);
		for (const k of [
			"system.platform.loop_degraded",
			"system.platform.payment_needs_support",
			"system.platform.cost_guard_failed_open",
			"system.platform.free_ai_paused",
		]) {
			expect(keys).toContain(k);
		}
	});

	it("picks up a new platform event without an edit to the script", () => {
		const extended: CatalogCategory[] = CATEGORIES.map((c) =>
			c.id === "platform"
				? { ...c, events: [...c.events, { id: "platform.new_thing", key: "system.platform.new_thing", label: "New thing", severity: "critical", live: true }] }
				: c,
		);
		const rules = deriveRuleSet(extended);
		expect(rules.at(-1)).toMatchObject({ eventId: "platform.new_thing", key: "system.platform.new_thing", severity: "critical" });
	});

	it("takes nothing from other categories", () => {
		const keys = deriveRuleSet(CATEGORIES).map((r) => r.key);
		expect(keys.every((k) => k.startsWith("system.platform."))).toBe(true);
	});

	it("refuses a catalog with no platform group rather than paging on nothing", () => {
		expect(() => deriveRuleSet(CATEGORIES.filter((c) => c.id !== "platform"))).toThrow(PagingRefusal);
	});

	it("refuses a glob key in the platform group", () => {
		const globbed: CatalogCategory[] = [{ id: "platform", label: "P", icon: "Cpu", events: [{ id: "p.any", key: "system.platform.*", label: "Any", severity: "info", live: true }] }];
		expect(() => deriveRuleSet(globbed)).toThrow(/glob/);
	});
});

describe("planRules", () => {
	const desired = deriveRuleSet(CATEGORIES);
	const first = desired[0] as DesiredRule;

	/** A managed rule exactly as desired, bound to `ch`. */
	const managed = (d: DesiredRule, ch: string, over: Partial<ExistingRule> = {}): ExistingRule => ({
		id: `r-${d.eventId}`,
		name: d.name,
		description: d.description,
		event_patterns: [d.key],
		severity: d.severity,
		throttle_seconds: d.throttle_seconds,
		enabled: true,
		channelIds: [ch],
		...over,
	});

	it("creates every rule on an empty org", () => {
		const { actions, stale } = planRules(desired, [], "ch1");
		expect(actions.every((a) => a.kind === "create")).toBe(true);
		expect(stale).toEqual([]);
	});

	it("reports a converged org unchanged", () => {
		const { actions } = planRules(desired, desired.map((d) => managed(d, "ch1")), "ch1");
		expect(actions.every((a) => a.kind === "unchanged")).toBe(true);
	});

	it("converges a drifted managed rule and names what changed", () => {
		const drifted = managed(first, "other", { enabled: false, severity: "info", throttle_seconds: 0 });
		const [a] = planRules([first], [drifted], "ch1").actions;
		expect(a).toMatchObject({
			kind: "update",
			changes: expect.arrayContaining(["re-enable", "bind the channel", `throttle 0s → ${PAGING_THROTTLE_SECONDS}s`]),
		});
	});

	it("leaves a person's enabled rule that already routes the event alone, and adds none beside it", () => {
		const person: ExistingRule = { id: "mine", name: "All platform", description: null, event_patterns: ["system.platform.*"], severity: "warning", throttle_seconds: 0, enabled: true, channelIds: ["ch1"] };
		const { actions } = planRules(desired, [person], "ch1");
		expect(actions.every((a) => a.kind === "covered")).toBe(true);
	});

	it("does not count a person's rule that is disabled or bound elsewhere", () => {
		const disabled: ExistingRule = { id: "d", name: "x", description: null, event_patterns: [first.key], severity: "warning", throttle_seconds: 0, enabled: false, channelIds: ["ch1"] };
		const elsewhere: ExistingRule = { ...disabled, id: "e", enabled: true, channelIds: ["ch2"] };
		const [a] = planRules([first], [disabled, elsewhere], "ch1").actions;
		expect(a?.kind).toBe("create");
	});

	it("reports a managed rule whose event left the catalog as stale, and never plans to delete it", () => {
		const gone = managed({ ...first, eventId: "platform.retired", key: "system.platform.retired" }, "ch1");
		const { stale, actions } = planRules(desired, [gone], "ch1");
		expect(stale).toEqual([{ ruleId: gone.id, name: gone.name, key: "system.platform.retired" }]);
		expect(actions.some((a) => "ruleId" in a && a.ruleId === gone.id)).toBe(false);
	});

	it("treats a channel that does not exist yet as bound to nothing", () => {
		const person: ExistingRule = { id: "mine", name: "All", description: null, event_patterns: ["system.platform.*"], severity: "warning", throttle_seconds: 0, enabled: true, channelIds: ["ch1"] };
		const { actions } = planRules(desired, [person, managed(first, "ch1")], null);
		expect(actions[0]?.kind).toBe("update");
		expect(actions.slice(1).every((a) => a.kind === "create")).toBe(true);
	});
});

describe("planChannel", () => {
	const ch: ExistingChannel = { id: "c", type: "slack", name: "Platform on-call", enabled: true, is_verified: true };
	it("reuses the named channel of that type", () => {
		expect(planChannel([ch], "slack", "Platform on-call")).toEqual({ kind: "reuse", channel: ch });
	});
	it("plans to create a missing one", () => {
		expect(planChannel([], "email", "Ops mail")).toEqual({ kind: "create", type: "email", name: "Ops mail" });
	});
	it("refuses the name taken by another type", () => {
		expect(() => planChannel([ch], "email", "Platform on-call")).toThrow(PagingRefusal);
	});
});

describe("runPaging", () => {
	const desired = deriveRuleSet(CATEGORIES);

	it("--dry-run against a fixture database prints the full plan and writes nothing", async () => {
		const f = fixture();
		const vault = memoryVault();
		const report = await runPaging(options({ dryRun: true }), desired, memoryStore(f), vault, undefined);
		const text = renderReport(report, channelLabel(options().channel)).join("\n");

		expect(f.writes).toEqual([]);
		expect(vault.writes).toBe(0);
		expect(f.emitted).toEqual([]);
		expect(report.writes).toBe(0);
		expect(text).toContain("PLAN (dry run, nothing written)");
		expect(text).toContain("reuse    Alethia Operations (alethia-ops");
		expect(text).toContain('create   slack "Platform on-call"');
		for (const d of desired) expect(text).toContain(d.key);
		expect(text).toContain("would set ALETHIA_PLATFORM_ALERT_ORG_ID in alethia/prod/env (eu-central-1) (currently unset)");
		expect(text).toContain(`would emit a [TEST] ${pickTestRule(desired).key}`);
		expect(text).not.toContain(SECRET_URL);
	});

	it("applies, then a second run changes nothing", async () => {
		const f = fixture();
		const vault = memoryVault();
		const store = memoryStore(f);

		const first = await runPaging(options(), desired, store, vault, undefined);
		expect(first.writes).toBe(1 + desired.length + 1); // channel + rules + vault
		expect(f.rules).toHaveLength(desired.length);
		expect(vault.data.ALETHIA_PLATFORM_ALERT_ORG_ID).toBe(OPS_ORG.id);
		expect(first.test.kind === "emitted" && first.test.deliveries.every((d) => d.status === "sent")).toBe(true);

		const writesBefore = f.writes.length;
		const second = await runPaging(options(), desired, store, vault, OPS_ORG.id);
		expect(second.writes).toBe(0);
		expect(f.writes.length).toBe(writesBefore);
		expect(vault.writes).toBe(1);
		expect(second.rules.every((a) => a.kind === "unchanged")).toBe(true);
		expect(second.vault).toEqual({ kind: "unchanged" });
		expect(renderReport(second, "x").join("\n")).toContain("0 change(s) written.");

		const dry = await runPaging(options({ dryRun: true }), desired, store, vault, OPS_ORG.id);
		expect(dry.rules.every((a) => a.kind === "unchanged")).toBe(true);
		expect(dry.vault).toEqual({ kind: "unchanged" });
	});

	it("creates the org from a slug when asked, then reuses it", async () => {
		const f = fixture();
		f.orgs = [];
		const store = memoryStore(f);
		const opts = options({ org: { by: "slug", slug: "alethia-ops", create: { name: "Alethia Operations", ownerEmail: "ops@example.com" } }, writeVault: false, testAlert: false });
		const first = await runPaging(opts, desired, store, null, undefined);
		expect(first.org.kind).toBe("create");
		const second = await runPaging(opts, desired, store, null, undefined);
		expect(second.org.kind).toBe("reuse");
		expect(second.writes).toBe(0);
	});

	it("refuses an unknown slug without --org-name/--owner-email", async () => {
		const f = fixture();
		await expect(runPaging(options({ org: { by: "slug", slug: "nope" } }), desired, memoryStore(f), null, undefined)).rejects.toThrow(/--org-name/);
	});

	it("refuses a channel to create with no destination, naming the creds step", async () => {
		const f = fixture();
		const opts = options({ channel: { type: "slack", name: "x", recipients: [], secret: undefined } });
		await expect(runPaging(opts, desired, memoryStore(f), null, undefined)).rejects.toThrow(/pnpm creds --set platform-alert-paging/);
		expect(f.writes).toEqual([]);
	});

	it("warns when the process sees the env var naming another org", async () => {
		const f = fixture();
		const report = await runPaging(options({ dryRun: true, writeVault: false }), desired, memoryStore(f), null, "00000000-0000-4000-8000-0000000000ff");
		expect(renderReport(report, "x").join("\n")).toContain("naming a DIFFERENT org");
	});

	it("reports a test alert that reached no channel as failed", async () => {
		const f = fixture();
		const store = { ...memoryStore(f), emitTestAlert: async () => [] };
		const report = await runPaging(options({ writeVault: false }), desired, store, null, undefined);
		expect(renderReport(report, "x").join("\n")).toContain("Test alert     FAILED");
	});
});

describe("parseCli", () => {
	it("reads the destination from the environment, never from argv", () => {
		const cli = parseCli(["--org-slug", "alethia-ops", "--channel-type", "slack", "--channel-name", "On-call"], { ALETHIA_PAGING_CHANNEL_SECRET: SECRET_URL });
		expect(cli.opts?.channel.secret).toBe(SECRET_URL);
		expect(channelLabel(cli.opts?.channel ?? options().channel)).not.toContain(SECRET_URL);
		expect(cli.opts?.testAlert).toBe(true);
	});

	it("refuses both or neither org selectors, and recipients on a non-email channel", () => {
		expect(() => parseCli(["--channel-type", "slack", "--channel-name", "x"], {})).toThrow(/exactly one/);
		expect(() => parseCli(["--org-slug", "a", "--org-id", OPS_ORG.id, "--channel-type", "slack", "--channel-name", "x"], {})).toThrow(/exactly one/);
		expect(() => parseCli(["--org-slug", "a", "--channel-type", "slack", "--channel-name", "x", "--recipients", "a@b.co"], {})).toThrow(/email channel only/);
		expect(() => parseCli(["--org-slug", "a", "--channel-type", "sms", "--channel-name", "x"], {})).toThrow(/--channel-type/);
	});

	it("takes --vault-only with an org id", () => {
		expect(parseCli(["--vault-only", "--org-id", OPS_ORG.id, "--dry-run"], {})).toMatchObject({ vaultOnly: true, orgId: OPS_ORG.id, dryRun: true });
		expect(() => parseCli(["--vault-only"], {})).toThrow(/--org-id/);
	});
});
