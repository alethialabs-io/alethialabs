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

/** Every capability a leg may promise. Adding one means adding what `--assert-env` requires of it. */
export const CAPABILITIES = ["stripe", "ai-mock"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The variable a workflow sets. Comma-separated capability names; empty or absent means none. */
export const PROMISE_VAR = "ALETHIA_E2E_CAPABILITIES";

/** What each promise requires to be present in the console's environment for the promise to be true. */
const REQUIRED_ENV: Record<Capability, readonly string[]> = {
	stripe: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_TEAM", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"],
	"ai-mock": ["ALETHIA_AI_MOCK"],
};

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
		const problems = assertEnvForPromises();
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
