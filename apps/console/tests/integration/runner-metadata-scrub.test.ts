// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6123): runner metadata keeps no deploy credential at rest.
//
// lib/db/programmables.sql carries an idempotent block, between `BEGIN/END
// runner-metadata-credential-scrub` markers, that migrate applies on every run (scripts/migrate.mjs
// re-applies the whole file). This runs THAT block — read from the file, not a copy — against real
// Postgres: a seeded legacy row loses the key and keeps the rest of its deploy config, rows without
// the key are not touched, and a second run changes nothing (the rows' `xmin` does not move, which is
// the database's own record that no UPDATE wrote them).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const OWNER = randomUUID();
const SECRET = `legacy-${randomUUID()}`;
const ids = { legacy: "", clean: "", scalar: "" };

/** The scrub block exactly as programmables.sql ships it. */
function scrubBlock(): string {
	const file = readFileSync(join(__dirname, "../../lib/db/programmables.sql"), "utf8");
	const match = /-- BEGIN runner-metadata-credential-scrub\n([\s\S]*?)-- END runner-metadata-credential-scrub/.exec(file);
	if (!match) throw new Error("the scrub block's markers are missing from programmables.sql");
	return match[1];
}

/** Runs the shipped block once. */
const runScrub = () => getServiceDb().execute(sql.raw(scrubBlock()));

/** Each seeded row's metadata and xmin (the id of the transaction that last wrote it). */
async function state() {
	const rows = await getServiceDb().execute<{ id: string; metadata: unknown; xmin: string }>(
		sql`select id, metadata, xmin::text as xmin from runners where id in (${sql.join(
			Object.values(ids).map((id) => sql`${id}::uuid`),
			sql`, `,
		)})`,
	);
	return new Map(rows.map((r) => [r.id, { metadata: r.metadata, xmin: r.xmin }]));
}

/** Inserts a self runner in OWNER's personal org with raw metadata (shapes the typed column refuses). */
async function seed(metadata: unknown): Promise<string> {
	const id = randomUUID();
	await getServiceDb().execute(sql`
		insert into runners (id, user_id, org_id, name, operator, provisioning, token_hash, metadata)
		values (${id}::uuid, ${OWNER}::uuid, ${OWNER}::uuid, ${`it-scrub-${id.slice(0, 8)}`}, 'self', 'deployed',
		        ${`it-scrub-${randomUUID()}`}, ${JSON.stringify(metadata)}::jsonb)`);
	return id;
}

describeIfDb("runner metadata keeps no deploy credential at rest (programmables.sql scrub)", () => {
	beforeAll(async () => {
		ids.legacy = await seed({ deploy_config: { region: "eu-west-1", image_tag: "1.2.0", runner_token: SECRET } });
		ids.clean = await seed({ deploy_config: { region: "eu-west-1", image_tag: "1.2.0" } });
		ids.scalar = await seed({ deploy_config: "runner_token", cloud_instance_id: "vm-1" });
	});

	afterAll(async () => {
		await getServiceDb().delete(runners).where(inArray(runners.id, Object.values(ids).filter(Boolean)));
	});

	it("removes the stored credential and keeps the rest of the deploy config", async () => {
		const before = await state();
		await runScrub();
		const after = await state();

		expect(after.get(ids.legacy)?.metadata).toEqual({ deploy_config: { region: "eu-west-1", image_tag: "1.2.0" } });
		expect(JSON.stringify([...after.values()])).not.toContain(SECRET);
		// Rows without the key are not written at all — not merely left equal.
		expect(after.get(ids.clean)).toEqual(before.get(ids.clean));
		expect(after.get(ids.scalar)).toEqual(before.get(ids.scalar));
	});

	it("a second run (the next migrate) changes nothing", async () => {
		const before = await state();
		await runScrub();
		expect(await state()).toEqual(before);
	});
});
