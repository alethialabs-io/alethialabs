// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Playwright "setup" project: signs a persona in once via the hermetic email-OTP flow and saves
// the authenticated browser state to e2e/.auth/persona.json. Any spec that only needs an authed
// session (not the onboarding demo itself) can reuse it via a project with
// `use: { storageState: STORAGE_STATE }, dependencies: ["setup"]` — no per-test re-signup. The
// hero spec deliberately does NOT use this (signing in IS the first act it demonstrates).

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test as setup } from "@playwright/test";
import { signUpWithOtp, STORAGE_STATE } from "./auth";

setup("authenticate a reusable persona", async ({ page }) => {
	await mkdir(path.dirname(STORAGE_STATE), { recursive: true });
	await signUpWithOtp(page);
	await page.context().storageState({ path: STORAGE_STATE });
});
