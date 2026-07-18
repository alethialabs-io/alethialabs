// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the normalized topic_subscriptions child table (Phase C). Proves three things against
// real Postgres: (1) the migration BACKFILL faithfully unnests project_topics.subscriptions JSONB
// into rows with the right protocol enum + author `ordinal`; (2) the join-through RLS policy scopes
// a subscription to its topic's project's org (a different org sees nothing); (3) ON DELETE CASCADE
// removes a topic's subscriptions when the topic is cleared (the delete+reinsert save path). Seeded
// via the service connection (bypasses RLS); read back through the RLS-enforced app connection.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withScope } from "@/lib/db";
import {
	projectEnvironments,
	projects,
	projectTopics,
	topicSubscriptions,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
const ORG_OTHER = randomUUID();
const USER_OTHER = randomUUID();
const PROJ = randomUUID();
const ENV = randomUUID();
const TOPIC = randomUUID();

const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

describeIfDb("topic_subscriptions — backfill, RLS, cascade", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(projects).values({
			id: PROJ,
			org_id: ORG,
			user_id: USER,
			project_name: `p-${PROJ}`,
			region: "westeurope",
			iac_version: "1.0",
		});
		await db.insert(projectEnvironments).values({
			id: ENV,
			project_id: PROJ,
			user_id: USER,
			name: "production",
			is_default: true,
		});
		// A topic carrying the legacy JSONB — the backfill's input. Two subscriptions, distinct order.
		await db.insert(projectTopics).values({
			id: TOPIC,
			project_id: PROJ,
			environment_id: ENV,
			name: "events",
			subscriptions: [
				{ protocol: "https", endpoint: "https://a.example/hook" },
				{ protocol: "sqs", endpoint: "arn:aws:sqs:::q" },
			],
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projects).where(eq(projects.id, PROJ)); // cascades to env/topic/subs
	});

	it("backfill unnests the JSONB into ordered rows with the enum protocol", async () => {
		const db = getServiceDb();
		// The EXACT backfill from migration 0107, scoped to the seeded topic.
		await db.execute(sql`
			INSERT INTO topic_subscriptions (topic_id, protocol, endpoint, ordinal)
			SELECT t.id,
			       (e.elem->>'protocol')::topic_subscription_protocol,
			       e.elem->>'endpoint',
			       (e.ord - 1)::int
			FROM project_topics t
			CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.subscriptions, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
			WHERE t.id = ${TOPIC}
			  AND COALESCE(e.elem->>'endpoint', '') <> ''
			  AND (e.elem->>'protocol') IN ('https','sqs','email','lambda')
		`);
		const rows = await db
			.select()
			.from(topicSubscriptions)
			.where(eq(topicSubscriptions.topic_id, TOPIC))
			.orderBy(topicSubscriptions.ordinal);
		expect(rows.map((r) => [r.ordinal, r.protocol, r.endpoint])).toEqual([
			[0, "https", "https://a.example/hook"],
			[1, "sqs", "arn:aws:sqs:::q"],
		]);
	});

	it("RLS scopes subscriptions to the owning org (join-through the topic)", async () => {
		if (!APP_ROLE_DISTINCT) return; // single-role dev: RLS is a no-op, nothing to prove
		// Owner's org sees its topic's subscriptions.
		const mine = await withScope({ ownerId: USER, orgId: ORG }, (tx) =>
			tx.select().from(topicSubscriptions).where(eq(topicSubscriptions.topic_id, TOPIC)),
		);
		expect(mine.length).toBeGreaterThan(0);
		// A different org sees none of them.
		const theirs = await withScope({ ownerId: USER_OTHER, orgId: ORG_OTHER }, (tx) =>
			tx.select().from(topicSubscriptions).where(eq(topicSubscriptions.topic_id, TOPIC)),
		);
		expect(theirs).toHaveLength(0);
	});

	it("ON DELETE CASCADE removes subscriptions when the topic is cleared", async () => {
		const db = getServiceDb();
		// Seed a throwaway topic + subscription, then delete the topic (the save path's delete half).
		const throwaway = randomUUID();
		await db.insert(projectTopics).values({
			id: throwaway,
			project_id: PROJ,
			environment_id: ENV,
			name: "throwaway",
		});
		await db.insert(topicSubscriptions).values({
			topic_id: throwaway,
			protocol: "email",
			endpoint: "ops@example.com",
			ordinal: 0,
		});
		await db.delete(projectTopics).where(eq(projectTopics.id, throwaway));
		const orphans = await db
			.select()
			.from(topicSubscriptions)
			.where(eq(topicSubscriptions.topic_id, throwaway));
		expect(orphans).toHaveLength(0);
	});
});
