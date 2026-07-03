// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Headless end-to-end check for alerting + credential RLS against a live Postgres.
// Drives the REAL emit → dispatch → webhook path (against an in-process catcher) plus
// the scope-aware RLS policy. Run: tsx scripts/verify-alerts.ts (with DB env set).
// Seeds fixed test UUIDs and cleans up. Exits non-zero on any failed assertion.

import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getChannelSender } from "@/lib/alerts/channels";
import { deliverOne } from "@/lib/alerts/dispatch";
import { emitAlertEvent, emitAlertEventSafe } from "@/lib/alerts/emit";
import { invalidateOrgRules } from "@/lib/alerts/rule-cache";
import { markFailed, markHealthy } from "@/lib/connectors/health";
import { encryptSecret } from "@/lib/crypto/secrets";
import { getServiceDb, withScope } from "@/lib/db";
import {
	alertChannels,
	alertDeliveries,
	alertRuleChannels,
	alertRules,
	connectorCredentials,
	connectorHealth,
	connectors,
	runners,
} from "@/lib/db/schema";

const ORG = "aaaaaaaa-0000-4000-8000-0000000000a1";
const USER1 = ORG; // community: owner === org
const USER2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const ORGX = "aaaaaaaa-0000-4000-8000-0000000000b1";
const SIGNING = "test-signing-secret";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
	if (ok) pass++;
	else fail++;
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Tiny HTTP catcher recording webhook POSTs. */
function startCatcher() {
	const reqs: { sig: string | null; body: string }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			reqs.push({ sig: req.headers["x-alethia-signature"] as string, body });
			res.writeHead(200);
			res.end("ok");
		});
	});
	return new Promise<{ url: string; reqs: typeof reqs; close: () => void }>(
		(resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const port = (server.address() as AddressInfo).port;
				resolve({
					url: `http://127.0.0.1:${port}/hook`,
					reqs,
					close: () => server.close(),
				});
			});
		},
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const db = getServiceDb();
	const catcher = await startCatcher();

	// Clean any prior run.
	await cleanup(db);

	// ── webhook channel → catcher ──────────────────────────────────────────────
	const [channel] = await db
		.insert(alertChannels)
		.values({
			org_id: ORG,
			type: "webhook",
			name: "verify-catcher",
			config: {},
			secret: encryptSecret({ url: catcher.url, signingSecret: SIGNING }),
			created_by: USER1,
		})
		.returning();

	// ── policy: system.job.* with a long throttle (for the throttle test) ──────
	const [policy] = await db
		.insert(alertRules)
		.values({
			org_id: ORG,
			name: "verify-ops",
			event_patterns: ["system.job.*"],
			severity: "warning",
			throttle_seconds: 3600,
			created_by: USER1,
		})
		.returning();
	await db
		.insert(alertRuleChannels)
		.values({ rule_id: policy.id, channel_id: channel.id });
	invalidateOrgRules(ORG);

	// ── Test 1: ops emit → delivery → signed webhook ───────────────────────────
	const n1 = await emitAlertEvent(ORG, "system.job.failed", {
		title: "Deploy failed: DEPLOY",
		severity: "critical",
		job_id: "job-test-1",
	});
	check("emit(system.job.failed) creates 1 delivery", n1 === 1, `got ${n1}`);

	// Wait for the fire-and-forget dispatch to deliver.
	let sent: typeof alertDeliveries.$inferSelect | undefined;
	for (let i = 0; i < 50 && !sent; i++) {
		await sleep(100);
		[sent] = await db
			.select()
			.from(alertDeliveries)
			.where(
				and(
					eq(alertDeliveries.org_id, ORG),
					eq(alertDeliveries.status, "sent"),
				),
			)
			.limit(1);
	}
	check("delivery reaches status=sent", Boolean(sent));
	check("webhook catcher received exactly 1 POST", catcher.reqs.length === 1, `got ${catcher.reqs.length}`);
	if (catcher.reqs[0]) {
		const expected = `sha256=${createHmac("sha256", SIGNING).update(catcher.reqs[0].body).digest("hex")}`;
		check("X-Alethia-Signature HMAC is valid", catcher.reqs[0].sig === expected);
	} else {
		check("X-Alethia-Signature HMAC is valid", false, "no request");
	}

	// ── Test 2: throttle collapses a repeat of the same subject ────────────────
	const n2 = await emitAlertEvent(ORG, "system.job.failed", {
		title: "Deploy failed again",
		severity: "critical",
		job_id: "job-test-1", // same subject → throttled
	});
	check("throttle: repeat of same subject → 0 deliveries", n2 === 0, `got ${n2}`);
	const n2b = await emitAlertEvent(ORG, "system.job.failed", {
		title: "Different job",
		severity: "critical",
		job_id: "job-test-2", // different subject → fires
	});
	check("throttle: different subject still fires", n2b === 1, `got ${n2b}`);

	// ── Test 3: open-core gate — authz.* skipped for community org ─────────────
	const [secPolicy] = await db
		.insert(alertRules)
		.values({
			org_id: ORG,
			name: "verify-sec",
			event_patterns: ["authz.*.*.denied"],
			severity: "warning",
			created_by: USER1,
		})
		.returning();
	await db
		.insert(alertRuleChannels)
		.values({ rule_id: secPolicy.id, channel_id: channel.id });
	invalidateOrgRules(ORG);
	const n3 = await emitAlertEvent(ORG, "authz.project.destroy.denied", {
		title: "Denied",
		severity: "warning",
		actor_id: USER1,
	});
	check("security gate: authz.* skipped without advancedAlerting", n3 === 0, `got ${n3}`);

	// ── Test 4: claim-before-send — concurrent deliverOne fires once ───────────
	const before = catcher.reqs.length;
	const [dup] = await db
		.insert(alertDeliveries)
		.values({
			org_id: ORG,
			rule_id: policy.id,
			channel_id: channel.id,
			event_key: "system.job.failed",
			dedupe_key: "verify-claim",
			context: { title: "claim test" },
			status: "pending",
		})
		.returning();
	await Promise.all([deliverOne(dup), deliverOne(dup)]);
	check(
		"claim-before-send: two concurrent deliverOne → exactly 1 POST",
		catcher.reqs.length - before === 1,
		`delta ${catcher.reqs.length - before}`,
	);

	// ── Test 5: scope-aware RLS (personal author-only, org org-visible) ────────
	const [conn] = await db.select({ id: connectors.id }).from(connectors).limit(1);
	if (!conn) {
		check("RLS test prerequisite: a connector exists", false, "no connectors seeded");
	} else {
		await db.insert(connectorCredentials).values([
			{ user_id: USER1, org_id: USER1, scope: "personal", connector_id: conn.id, credentials: {} },
			{ user_id: USER1, org_id: ORGX, scope: "org", connector_id: conn.id, credentials: {} },
		]);

		// As USER1 in their personal org: sees personal, NOT the org cred (org=ORGX).
		const u1 = await withScope({ ownerId: USER1, orgId: USER1 }, (tx) =>
			tx
				.select({ scope: connectorCredentials.scope })
				.from(connectorCredentials)
				.where(eq(connectorCredentials.connector_id, conn.id)),
		);
		check(
			"RLS: author sees own personal cred only (not the org cred)",
			u1.length === 1 && u1[0].scope === "personal",
			`rows=${u1.length} scopes=${u1.map((r) => r.scope)}`,
		);

		// As USER2 scoped to ORGX: sees the org cred, NOT USER1's personal cred.
		const u2 = await withScope({ ownerId: USER2, orgId: ORGX }, (tx) =>
			tx
				.select({ scope: connectorCredentials.scope })
				.from(connectorCredentials)
				.where(eq(connectorCredentials.connector_id, conn.id)),
		);
		check(
			"RLS: other member sees org-shared cred only (not the personal)",
			u2.length === 1 && u2[0].scope === "org",
			`rows=${u2.length} scopes=${u2.map((r) => r.scope)}`,
		);
	}

	// ── Test 6: runner-offline sweep returns flipped rows + emits ──────────────
	const STALE_RUNNER = "aaaaaaaa-0000-4000-8000-0000000000c1";
	await db.insert(runners).values({
		id: STALE_RUNNER,
		// self runner needs an owner + a provisioning mode (runners check constraints).
		user_id: USER1,
		org_id: ORG,
		operator: "self",
		provisioning: "registered",
		name: "verify-runner",
		token_hash: "verify-token-hash",
		status: "ONLINE",
		last_heartbeat: new Date(Date.now() - 10 * 60 * 1000),
	});
	const swept = await db.execute<{
		runner_id: string;
		org_id: string | null;
		runner_name: string;
	}>(sql`select * from sweep_offline_runners()`);
	check(
		"sweep_offline_runners() returns the flipped runner + org_id",
		swept.some((r) => r.runner_id === STALE_RUNNER && r.org_id === ORG),
	);
	const [roPolicy] = await db
		.insert(alertRules)
		.values({
			org_id: ORG,
			name: "verify-runner-offline",
			event_patterns: ["system.runner.offline"],
			severity: "warning",
			created_by: USER1,
		})
		.returning();
	await db
		.insert(alertRuleChannels)
		.values({ rule_id: roPolicy.id, channel_id: channel.id });
	invalidateOrgRules(ORG);
	const nRunner = await emitAlertEvent(ORG, "system.runner.offline", {
		title: "Runner offline: verify-runner",
		severity: "warning",
		resource_id: STALE_RUNNER,
	});
	check("system.runner.offline policy fires a delivery", nRunner === 1, `got ${nRunner}`);

	// ── Test 7: durable connector health — emit once per transition ────────────
	const [chPolicy] = await db
		.insert(alertRules)
		.values({
			org_id: ORG,
			name: "verify-conn-health",
			event_patterns: ["system.connector.token_failed"],
			severity: "warning",
			created_by: USER1,
		})
		.returning();
	await db
		.insert(alertRuleChannels)
		.values({ rule_id: chPolicy.id, channel_id: channel.id });
	invalidateOrgRules(ORG);

	const countTokenFailed = async () => {
		const [{ c }] = await db
			.select({ c: sql<number>`count(*)::int` })
			.from(alertDeliveries)
			.where(
				and(
					eq(alertDeliveries.org_id, ORG),
					eq(alertDeliveries.event_key, "system.connector.token_failed"),
				),
			);
		return c;
	};

	await markFailed({ userId: USER1, orgId: ORG }, "git", "github", "token refresh failed");
	let cFail = 0;
	for (let i = 0; i < 30 && cFail < 1; i++) {
		await sleep(100);
		cFail = await countTokenFailed();
	}
	check("connector token_failed emits on first failure", cFail === 1, `got ${cFail}`);

	await markFailed({ userId: USER1, orgId: ORG }, "git", "github", "still failing");
	await sleep(300);
	check(
		"transition dedup: repeat failure does not re-emit",
		(await countTokenFailed()) === 1,
	);

	await db
		.update(connectorHealth)
		.set({ alerted_at: sql`now() - interval '48 hours'` })
		.where(
			and(
				eq(connectorHealth.user_id, USER1),
				eq(connectorHealth.provider, "github"),
			),
		);
	await markFailed({ userId: USER1, orgId: ORG }, "git", "github", "failing past window");
	let cFail2 = 1;
	for (let i = 0; i < 30 && cFail2 < 2; i++) {
		await sleep(100);
		cFail2 = await countTokenFailed();
	}
	check("re-alert after window: fires again", cFail2 === 2, `got ${cFail2}`);

	await markHealthy({ userId: USER1, orgId: ORG }, "git", "github");
	const [hrow] = await db
		.select({ status: connectorHealth.status })
		.from(connectorHealth)
		.where(
			and(
				eq(connectorHealth.user_id, USER1),
				eq(connectorHealth.provider, "github"),
			),
		);
	check("markHealthy clears the failed state", hrow?.status === "healthy", `status=${hrow?.status}`);

	// ── Test 8: deploy.started (system.job.started) → delivery ─────────────────
	// The Test-1 ops policy already matches `system.job.*`, so the new emitter key
	// flows through a realistic policy with no extra wiring.
	const nStarted = await emitAlertEvent(ORG, "system.job.started", {
		title: "Job started: DEPLOY",
		severity: "info",
	});
	check("system.job.started matches the system.job.* policy", nStarted === 1, `got ${nStarted}`);

	// ── Test 9: member.joined via the CoreContext emit path (ee hook) ──────────
	// ee's afterAddMember calls core.emitAlertEvent === emitAlertEventSafe; assert the
	// same call lands a delivery (fire-and-forget, so poll).
	const [memberPolicy] = await db
		.insert(alertRules)
		.values({
			org_id: ORG,
			name: "verify-member-joined",
			event_patterns: ["system.member.*"],
			severity: "info",
			created_by: USER1,
		})
		.returning();
	await db
		.insert(alertRuleChannels)
		.values({ rule_id: memberPolicy.id, channel_id: channel.id });
	invalidateOrgRules(ORG);
	emitAlertEventSafe(ORG, "system.member.joined", {
		title: "Member joined: dev@example.com",
		severity: "info",
		resource_type: "member",
	});
	let nMember = 0;
	for (let i = 0; i < 30 && nMember < 1; i++) {
		await sleep(100);
		const [{ c }] = await db
			.select({ c: sql<number>`count(*)::int` })
			.from(alertDeliveries)
			.where(
				and(
					eq(alertDeliveries.org_id, ORG),
					eq(alertDeliveries.event_key, "system.member.joined"),
				),
			);
		nMember = c;
	}
	check("system.member.joined (CoreContext path) fires a delivery", nMember === 1, `got ${nMember}`);

	// ── Test 10: channel verify round-trip (the "Test" button path) ───────────
	// getChannelSender(type).verify decrypts the stored secret and POSTs TEST_CONTEXT —
	// proves encrypt→store→decrypt→send works (what verifyChannel does, minus the PDP).
	const beforeVerify = catcher.reqs.length;
	await getChannelSender("webhook").verify(channel);
	check(
		"channel Test reaches the endpoint (encrypt→decrypt→send)",
		catcher.reqs.length - beforeVerify === 1,
		`delta ${catcher.reqs.length - beforeVerify}`,
	);

	// ── cleanup ────────────────────────────────────────────────────────────────
	await cleanup(db);
	catcher.close();

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail === 0 ? 0 : 1);
}

async function cleanup(db: ReturnType<typeof getServiceDb>) {
	await db.delete(alertDeliveries).where(eq(alertDeliveries.org_id, ORG));
	const rules = await db
		.select({ id: alertRules.id })
		.from(alertRules)
		.where(eq(alertRules.org_id, ORG));
	if (rules.length)
		await db.delete(alertRuleChannels).where(
			inArray(
				alertRuleChannels.rule_id,
				rules.map((r) => r.id),
			),
		);
	await db.delete(alertRules).where(eq(alertRules.org_id, ORG));
	await db.delete(alertChannels).where(eq(alertChannels.org_id, ORG));
	await db.delete(runners).where(eq(runners.org_id, ORG));
	await db
		.delete(connectorHealth)
		.where(inArray(connectorHealth.user_id, [USER1, USER2]));
	await db
		.delete(connectorCredentials)
		.where(inArray(connectorCredentials.user_id, [USER1, USER2]));
	await db
		.delete(connectorCredentials)
		.where(inArray(connectorCredentials.org_id, [USER1, ORGX]));
}

main().catch((err) => {
	console.error("verify-alerts crashed:", err);
	process.exit(1);
});
