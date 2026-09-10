// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CAPABILITIES ARE PROMISED, NOT DETECTED.
//
// A spec that needs Stripe used to guard itself with `test.skip(!process.env.STRIPE_SECRET_KEY)`.
// An unset variable then turned every billing assertion into a green skip, and a run reporting
// "35 skipped" read like a run that had measured 35 things. The same shape — `HAVE_MEMBER` —
// turned every RBAC denial in this suite into a skip for two months (e2e/AUTHORING.md).
//
// So the promise is made ONCE, in the workflow, per leg: `ALETHIA_E2E_CAPABILITIES=stripe,ai-mock`.
// A spec declares what it needs with a Playwright tag (`@needs:stripe`), and the `qa` fixture asks
// this module. In CI, a tagged spec on a leg that does not promise the capability is RED — the leg's
// declaration and the spec's need disagree, and one of them is wrong. Locally it skips with a reason
// that says NOT MEASURED, because a laptop without Stripe keys is the normal case, not a defect.
//
//   ALETHIA_E2E_CAPABILITIES=stripe pnpm -C apps/console exec tsx e2e/helpers/capabilities.ts --assert-env
//
// `--assert-env` is the workflow's pre-check: it runs in seconds, before the console build, and
// fails the leg when a promised capability's variables are absent — an unset repository secret is
// then a named failure at the top of the job rather than a downgraded run at the bottom.

// ── `encryption` (#4456) ───────────────────────────────────────────────────────────────────────
//
// Without `ALETHIA_CRED_ENCRYPTION_KEY` a console's `isCredEncryptionConfigured()` is false and
// every surface that stores a secret is inert: the add-channel sheet shows its "needs an encryption
// key" note and disables submit, and every connector credential path is unreachable behind the same
// mechanism. That was the state of EVERY gate leg, and it could not be DECLARED — a spec could not
// write `@needs:encryption` and go red on a leg that does not promise it, so the only options were
// to avoid the surface or to write a test that quietly asserts the disabled state. Both leave the
// gap invisible, which is the exact outcome this module exists to prevent.
//
// `console`, `qa` and `audit-interaction` now PROMISE it, and release-gate.yml sets the key on
// exactly the legs that do. The value is not a repository secret and never was one to wait for:
// `.github/workflows/e2e-nightly.yml` already used a fixed non-secret throwaway literal for this
// variable, with the same rationale and a `.gitleaks.toml` allowlist anchored to the literal and
// to this variable name rather than to a file, so the gate reuses it verbatim.
//
// WHAT PROMISING IT ON `qa` COST, because the accounting is the interesting part.
// `e2e/flows/alerts.negative.spec.ts` closed with a describe block that existed only because the
// key was absent, under a comment reading "If the gate ever promises the key, THIS is the test that
// goes red and says so". Exactly ONE of its two tests did. The other — that Email is still offered
// "because it stores no secret" — stayed GREEN, having quietly stopped discriminating: its whole
// meaning was the contrast with the sibling that had just changed. A red test says so; a test that
// stops measuring does not, and nothing in the gate would have reported it. So both were rewritten
// into the positive paths they stood in for and tagged `@needs:encryption`, which RENAMED them —
// and a renamed test is a baseline entry the run no longer contains (`scripts/e2e-ratchet.mjs`
// rule 4), so two keys moved in `apps/console/e2e/gate-baseline.json`. Their statuses did not.

// ── WHY THE NAMES BELOW MAY NOT OVERLAP ────────────────────────────────────────────────────────
//
// release-gate.yml's `env:` block selects a capability's variables with
// `contains(matrix.capabilities, '<name>')`, because `matrix.capabilities` is a comma-separated SET
// and the `==` it used before matched nothing the moment a leg promised two things. `contains` is a
// SUBSTRING test, though, so it agrees with set membership only while no capability name contains
// another: a future `stripe-connect` would hand every leg promising it the real Stripe keys it
// never promised — availability without a promise, which is this module's rule read backwards.
//
// `--assert-env` therefore refuses the whole set when that stops holding. It is checked there, on
// every leg, before the build, rather than stated in a comment beside the YAML, because a sentence
// asserting a property nothing enforces is indistinguishable from one that is still true.

/** Every capability a leg may promise. Adding one means adding what `--assert-env` requires of it. */
export const CAPABILITIES = ["stripe", "ai-mock", "encryption"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The variable a workflow sets. Comma-separated capability names; empty or absent means none. */
export const PROMISE_VAR = "ALETHIA_E2E_CAPABILITIES";

/** What each promise requires to be present in the console's environment for the promise to be true. */
const REQUIRED_ENV: Record<Capability, readonly string[]> = {
	stripe: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_TEAM", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"],
	"ai-mock": ["ALETHIA_AI_MOCK"],
	encryption: ["ALETHIA_CRED_ENCRYPTION_KEY"],
};

/** The key length `apps/console/lib/crypto/secrets.ts` refuses anything but, in bytes. */
const CRED_KEY_BYTES = 32;

/**
 * Whether a value is a key `lib/crypto/secrets.ts` will accept — base64 decoding to exactly 32
 * bytes. Returns the decoded length so the caller can say what it got.
 *
 * PRESENCE IS NOT ENOUGH HERE, unlike every other required variable. `decodeKey()` throws
 * "must decode to 32 bytes (got N)", and the console does not throw it at boot — it throws at the
 * first credential write, as a 400 at the bottom of a leg that has already spent its hour
 * (scripts/env.sh records that exact string). A present-but-wrong key would therefore satisfy a
 * presence check and still leave every secret-bearing surface unreachable, which is the downgraded
 * run this whole module exists to convert into a named failure at the top of the job.
 */
function credKeyBytes(raw: string): number {
	return Buffer.from(raw, "base64").length;
}

type Env = Readonly<Record<string, string | undefined>>;

function isCapability(value: string): value is Capability {
	return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The capabilities this process was promised. An unknown name is an error, not an ignored word:
 * `stripe-test` promising nothing would be exactly the silent downgrade this module exists to end.
 */
export function promised(env: Env = process.env): Set<Capability> {
	const raw = env[PROMISE_VAR] ?? "";
	const out = new Set<Capability>();
	for (const token of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
		if (!isCapability(token)) {
			throw new Error(
				`${PROMISE_VAR} names "${token}", which is not a capability this suite knows ` +
					`(${CAPABILITIES.join(", ")}). A misspelt promise must not promise nothing.`,
			);
		}
		out.add(token);
	}
	return out;
}

/** Whether this is a CI run — the mode in which an unmet need is a failure, never a skip. */
export function isCI(env: Env = process.env): boolean {
	return Boolean(env.CI);
}

/**
 * The capabilities a test's tags declare. `@needs:<capability>`; any other `@needs:` is an error.
 * Tags Playwright hands over carry their leading `@`.
 */
export function needsTags(tags: readonly string[]): Capability[] {
	const out: Capability[] = [];
	for (const tag of tags) {
		const m = /^@needs:(.+)$/.exec(tag);
		if (!m) continue;
		if (!isCapability(m[1])) {
			throw new Error(`tag "${tag}" names a capability this suite does not know (${CAPABILITIES.join(", ")}).`);
		}
		out.push(m[1]);
	}
	return out;
}

/**
 * Enforce one need against the promises.
 *
 * Returns `"promised"` when the leg promised it. Otherwise: in CI, THROWS — the spec's tag and the
 * workflow's declaration disagree, and a red test is the only honest report; locally, calls `skip`
 * with a reason that begins `NOT MEASURED`, so a laptop run reads as what it is.
 */
export function requireCapability(
	capability: Capability,
	opts: { env?: Env; skip: (reason: string) => void },
): "promised" | "skipped" {
	const env = opts.env ?? process.env;
	if (promised(env).has(capability)) return "promised";
	if (isCI(env)) {
		throw new Error(
			`this spec needs "${capability}" but this leg does not promise it. Add it to ` +
				`${PROMISE_VAR} in .github/workflows/release-gate.yml for this leg, or move the spec to a ` +
				`leg that promises it. In CI an unmet need is a failure, never a skip.`,
		);
	}
	opts.skip(`NOT MEASURED: "${capability}" is not configured locally (${PROMISE_VAR} does not promise it)`);
	return "skipped";
}

/**
 * Every ordered pair of capability names where one CONTAINS the other, reported as a problem
 * string. Empty means `contains(matrix.capabilities, '<name>')` in release-gate.yml is equivalent
 * to membership of the promised set, which is the only condition under which that expression is
 * the right one. See the header for what breaks when it is not.
 *
 * Static — it reads no environment — and deliberately so: this is a property of the NAMES, and the
 * leg that would be handed a variable it never promised is not the leg that added the name.
 */
export function overlappingCapabilityNames(
	names: readonly string[] = CAPABILITIES,
): string[] {
	const problems: string[] = [];
	for (const outer of names) {
		for (const inner of names) {
			if (outer === inner) continue;
			if (!outer.includes(inner)) continue;
			problems.push(
				`capability "${outer}" contains "${inner}", so release-gate.yml's ` +
					`contains(matrix.capabilities, '${inner}') is true on a leg that promised only ` +
					`"${outer}" — it would be handed ${inner}'s variables without promising them. ` +
					`Rename one of them, or teach the workflow an exact-membership test.`,
			);
		}
	}
	return problems;
}

/**
 * Every promised capability's required variables, checked for presence and non-emptiness.
 * Returns the problems; an empty list means every promise can be kept.
 */
export function assertEnvForPromises(env: Env = process.env): string[] {
	const problems: string[] = [];
	for (const cap of promised(env)) {
		for (const name of REQUIRED_ENV[cap]) {
			const value = env[name];
			if (value === undefined || value.trim() === "") {
				problems.push(`${PROMISE_VAR} promises "${cap}" but ${name} is ${value === undefined ? "unset" : "empty"}`);
			}
		}
		if (cap === "ai-mock" && env.ALETHIA_AI_MOCK !== "1") {
			problems.push(`${PROMISE_VAR} promises "ai-mock" but ALETHIA_AI_MOCK is "${env.ALETHIA_AI_MOCK}", not "1"`);
		}
		if (cap === "encryption") {
			const raw = env.ALETHIA_CRED_ENCRYPTION_KEY;
			// A missing/empty key is already reported by the loop above; only shape is left to ask.
			if (raw !== undefined && raw.trim() !== "") {
				const bytes = credKeyBytes(raw);
				if (bytes !== CRED_KEY_BYTES) {
					problems.push(
						`${PROMISE_VAR} promises "encryption" but ALETHIA_CRED_ENCRYPTION_KEY decodes to ` +
							`${bytes} bytes, not ${CRED_KEY_BYTES} — lib/crypto/secrets.ts refuses it, and it would ` +
							`fail at the first credential write rather than here. Generate one with: openssl rand -base64 32`,
					);
				}
			}
		}
	}
	return problems;
}

/** The self-test: every rule, both directions. Returns the failures; empty means green. */
export function selfTest(): string[] {
	const failures: string[] = [];
	const ok = (label: string, cond: boolean) => {
		if (!cond) failures.push(label);
	};
	const throws = (label: string, fn: () => unknown) => {
		try {
			fn();
			failures.push(`${label} (did not throw)`);
		} catch {
			/* expected */
		}
	};
	ok("no promise → empty set", promised({}).size === 0);
	ok("a promise is read", promised({ [PROMISE_VAR]: "stripe" }).has("stripe"));
	ok("two promises are read", promised({ [PROMISE_VAR]: "stripe, ai-mock" }).size === 2);
	throws("an unknown promise throws", () => promised({ [PROMISE_VAR]: "stripe-test" }));
	ok("tags are parsed", needsTags(["@needs:stripe", "@slow"]).join() === "stripe");
	throws("an unknown @needs tag throws", () => needsTags(["@needs:nope"]));
	ok(
		"promised → promised",
		requireCapability("stripe", { env: { [PROMISE_VAR]: "stripe" }, skip: () => {} }) === "promised",
	);
	throws("CI without the promise throws", () =>
		requireCapability("stripe", { env: { CI: "1" }, skip: () => {} }),
	);
	let reason = "";
	ok(
		"locally without the promise skips with NOT MEASURED",
		requireCapability("stripe", { env: {}, skip: (r) => (reason = r) }) === "skipped" && reason.startsWith("NOT MEASURED"),
	);
	ok("no promise → no env problems", assertEnvForPromises({}).length === 0);
	ok(
		"a promised stripe with no keys names every missing variable",
		assertEnvForPromises({ [PROMISE_VAR]: "stripe" }).length === REQUIRED_ENV.stripe.length,
	);
	ok(
		"an EMPTY key is a problem, not a value",
		assertEnvForPromises({ [PROMISE_VAR]: "stripe", STRIPE_SECRET_KEY: " " }).some((p) => p.includes("empty")),
	);
	ok(
		"ai-mock must be the literal 1",
		assertEnvForPromises({ [PROMISE_VAR]: "ai-mock", ALETHIA_AI_MOCK: "true" }).length === 1 &&
			assertEnvForPromises({ [PROMISE_VAR]: "ai-mock", ALETHIA_AI_MOCK: "1" }).length === 0,
	);

	// ── encryption (#4456) ─────────────────────────────────────────────────────────────────────
	// The two keys are CONSTRUCTED, not written out. A 44-character base64 literal in this file is
	// a gitleaks finding (measured: it red the `Secret scan` check), and `.gitleaks.toml`'s one
	// allowlisted key blob is anchored to an `ALETHIA_CRED_ENCRYPTION_KEY:` assignment — a bare
	// literal here would not match it. These tests need a key of the right SHAPE, never a
	// particular key, so there is nothing to write out.
	const KEY32 = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); // 32 bytes
	const KEY5 = Buffer.from("short").toString("base64"); // 5 bytes — present, and refused
	ok("encryption is a capability a leg may promise", (CAPABILITIES as readonly string[]).includes("encryption"));
	ok("@needs:encryption parses", needsTags(["@needs:encryption"]).join() === "encryption");
	ok(
		"encryption promised with no key names the variable",
		assertEnvForPromises({ [PROMISE_VAR]: "encryption" }).some((p) => p.includes("ALETHIA_CRED_ENCRYPTION_KEY")),
	);
	ok(
		"a 32-byte base64 key satisfies the promise",
		assertEnvForPromises({ [PROMISE_VAR]: "encryption", ALETHIA_CRED_ENCRYPTION_KEY: KEY32 }).length === 0,
	);
	ok(
		"a PRESENT key of the wrong length is a problem, not a pass",
		assertEnvForPromises({ [PROMISE_VAR]: "encryption", ALETHIA_CRED_ENCRYPTION_KEY: KEY5 }).some((p) =>
			p.includes("decodes to 5 bytes"),
		),
	);
	ok(
		"an empty key is reported ONCE, as absent, not twice",
		assertEnvForPromises({ [PROMISE_VAR]: "encryption", ALETHIA_CRED_ENCRYPTION_KEY: " " }).length === 1,
	);
	throws("CI without the encryption promise throws", () =>
		requireCapability("encryption", { env: { CI: "1" }, skip: () => {} }),
	);
	ok(
		"encryption promised → promised",
		requireCapability("encryption", { env: { [PROMISE_VAR]: "encryption" }, skip: () => {} }) === "promised",
	);
	ok(
		"a leg may promise encryption alongside stripe",
		promised({ [PROMISE_VAR]: "stripe,encryption" }).size === 2,
	);

	// ── the name-overlap invariant, BOTH DIRECTIONS ────────────────────────────────────────────
	// The negative case is the whole point: a check that only ever sees the passing set is
	// indistinguishable from `return []`, and this one is asked about a list that is currently
	// clean. So it is driven over a set that DOES clash, and the clash is named.
	ok("today's capability names do not overlap", overlappingCapabilityNames().length === 0);
	ok(
		"a name that CONTAINS another is reported, naming both",
		overlappingCapabilityNames(["stripe", "stripe-connect"]).some(
			(p) => p.includes('"stripe-connect" contains "stripe"'),
		),
	);
	ok(
		"the overlap check is one-directional per pair, not symmetric noise",
		overlappingCapabilityNames(["stripe", "stripe-connect"]).length === 1,
	);
	return failures;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
// `tsx e2e/helpers/capabilities.ts --assert-env | --self-test`. Direct invocation only; importing
// this module runs nothing.
const invokedDirectly =
	typeof process !== "undefined" && /capabilities\.(ts|js|mjs)$/.test(String(process.argv[1] ?? ""));

if (invokedDirectly) {
	const argv = process.argv.slice(2);
	if (argv.includes("--self-test")) {
		const failures = selfTest();
		for (const f of failures) console.log(`FAIL - ${f}`);
		console.log(failures.length === 0 ? "capabilities self-test: all passed" : `capabilities self-test: ${failures.length} FAILED`);
		process.exit(failures.length === 0 ? 0 : 1);
	}
	if (argv.includes("--assert-env")) {
		// The name-overlap invariant is checked FIRST and on every leg, promise or not: it is what
		// makes release-gate.yml's `contains(...)` selection equivalent to membership of the set,
		// and the leg it would silently over-provision is not the leg whose promise introduced the
		// clash. A leg promising nothing is exactly as good a place to notice it.
		const problems = [...overlappingCapabilityNames(), ...assertEnvForPromises()];
		const names = [...promised()];
		if (problems.length > 0) {
			for (const p of problems) console.error(`::error::${p}`);
			process.exit(1);
		}
		console.log(`capabilities: ${names.length === 0 ? "none promised" : `promised ${names.join(", ")} — every required variable is present`}`);
		process.exit(0);
	}
	console.error("usage: tsx e2e/helpers/capabilities.ts --assert-env | --self-test");
	process.exit(2);
}
