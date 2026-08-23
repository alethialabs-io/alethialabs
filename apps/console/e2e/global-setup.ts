// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Playwright global setup: creates the QA personas ONCE, serially (so the shared OTP log is never
// raced), and saves each one's Better Auth session as a storageState the fixtures reuse. Also resolves
// each persona's user_id + org_id from the DB for the seed helper. Writes e2e/.auth/{persona}.json +
// e2e/.auth/personas.json. Resilient to transient recompile 500s (the dev tree may be edited live).
//
// Skip re-creation on a fast iteration with REUSE_AUTH=1 (reuses existing e2e/.auth if present).

import { chromium, type FullConfig } from "@playwright/test";
import fs from "node:fs";
import { loadRootEnv } from "./helpers/env";
import { closeDb, orgIdBySlug, userIdByEmail } from "./helpers/db";
import {
	AUTH_DIR,
	personaEmail,
	personaMetaPath,
	type PersonaName,
	type PersonaRecord,
	signUpHobby,
	signUpTeamTrial,
	storageStatePath,
} from "./helpers/personas";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** Retries an async persona-creation step through transient failures (recompile 500s, slow OTP). */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
	let lastErr: unknown;
	for (let i = 1; i <= attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			console.warn(`[global-setup] ${label} attempt ${i}/${attempts} failed: ${(err as Error).message}`);
			await new Promise((r) => setTimeout(r, 2_000));
		}
	}
	throw lastErr;
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
	// Playwright resolves globalSetup per CONFIG, not per project, so this function is invoked even
	// by `--project=hero`. Those runs are merge-gating and must not pay for — or be broken by — a
	// persona factory that signs several users up and talks to the database. Opt in explicitly.
	if (process.env.ALETHIA_QA_E2E !== "1") return;

	loadRootEnv();
	fs.mkdirSync(AUTH_DIR, { recursive: true });

	if (process.env.REUSE_AUTH === "1" && fs.existsSync(personaMetaPath())) {
		console.log("[global-setup] REUSE_AUTH=1 and personas.json present — reusing existing sessions.");
		return;
	}

	const stamp = Date.now();
	const browser = await chromium.launch();
	const records: Partial<Record<PersonaName, PersonaRecord>> = {};

	/** Signs up one persona in its own context, saves storageState, resolves ids, records it. */
	async function create(
		name: PersonaName,
		flow: (page: import("@playwright/test").Page, email: string) => Promise<{ orgSlug: string }>,
	): Promise<void> {
		const email = personaEmail(name, stamp);
		await withRetry(`create ${name}`, async () => {
			const context = await browser.newContext({ baseURL: BASE_URL });
			const page = await context.newPage();
			try {
				const { orgSlug } = await flow(page, email);
				const ssPath = storageStatePath(name);
				await context.storageState({ path: ssPath });
				const userId = (await userIdByEmail(email)) ?? undefined;
				const orgId = (await orgIdBySlug(orgSlug)) ?? undefined;
				records[name] = { name, email, orgSlug, orgId, userId, storageState: ssPath };
				console.log(`[global-setup] ${name} → org=${orgSlug} user=${userId ?? "?"} org_id=${orgId ?? "?"}`);
			} finally {
				await context.close();
			}
		});
	}

	try {
		// ownerHobby is required; ownerTeam is best-effort (Stripe may be unconfigured on this box).
		await create("ownerHobby", (page, email) => signUpHobby(page, email));
		try {
			await create("ownerTeam", (page, email) => signUpTeamTrial(page, email));
		} catch (err) {
			console.warn(`[global-setup] ownerTeam persona unavailable: ${(err as Error).message}`);
		}
		// `member` persona (invited into ownerTeam's org) is added in a later step; RBAC specs that
		// need it will error clearly until then.
	} finally {
		fs.writeFileSync(personaMetaPath(), JSON.stringify(records, null, 2));
		await browser.close();
		await closeDb();
	}

	if (!records.ownerHobby) {
		throw new Error("[global-setup] Failed to create the ownerHobby persona — cannot run the suite.");
	}
}
