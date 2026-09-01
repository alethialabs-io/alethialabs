// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hand-written expectations for the two name grammars. Independent of the generated conformance
// table for the same reason tests/lib/slugify.test.ts is: that table is produced BY this code.

import { describe, expect, it } from "vitest";

import { RESERVED_PROJECT_CHILD_SLUGS } from "@/lib/routing";
import {
	ADDON_APP_NAME_PREFIX,
	ADDON_ID_MAX_LENGTH,
	DNS1123_LABEL_MAX_LENGTH,
	ENVIRONMENT_NAME_INPUT_MAX_LENGTH,
	ENVIRONMENT_NAME_MAX_LENGTH,
	RESERVED_ENVIRONMENT_NAMES,
	chartSlug,
	environmentNameProblem,
	environmentNameSchema,
	isDns1123Label,
	namespaceProblem,
	namespaceSchema,
	normalizeEnvironmentName,
} from "@/lib/validations/names";

describe("the namespace grammar", () => {
	it("accepts exactly what Kubernetes accepts", () => {
		for (const ok of ["a", "1", "1dev", "12345", "a-b-c", "boutique-dev", "a".repeat(63)]) {
			expect(namespaceProblem(ok), ok).toBeNull();
			expect(isDns1123Label(ok), ok).toBe(true);
		}
	});

	it("refuses `dev-`, which the CLI route used to accept and Kubernetes does not", () => {
		expect(namespaceProblem("dev-")).toMatch(/start and end with a letter or digit/);
		expect(isDns1123Label("dev-")).toBe(false);
	});

	it("accepts `1dev`, which the console form used to refuse and Kubernetes does not", () => {
		expect(namespaceProblem("1dev")).toBeNull();
	});

	it("refuses the rest of what Kubernetes refuses", () => {
		for (const bad of ["-dev", "-", "Dev", "dev_1", "dev.1", "dev/1"]) {
			expect(namespaceProblem(bad), bad).toMatch(/start and end with a letter or digit/);
		}
		expect(namespaceProblem("")).toBe("Namespace is required");
		expect(namespaceProblem("a".repeat(64))).toMatch(/at most 63/);
		expect(DNS1123_LABEL_MAX_LENGTH).toBe(63);
	});

	it("refuses rather than repairs — the schema never rewrites the operator's namespace", () => {
		const ok = namespaceSchema.safeParse("boutique-dev");
		expect(ok.success && ok.data).toBe("boutique-dev");
		expect(namespaceSchema.safeParse("Boutique-Dev").success).toBe(false);
	});
});

describe("the environment-name rule", () => {
	it("normalizes rather than refusing what slugifying can fix", () => {
		expect(environmentNameProblem("Prod")).toBeNull();
		expect(normalizeEnvironmentName("Prod")).toBe("prod");
		expect(normalizeEnvironmentName("My Preview Env")).toBe("my-preview-env");
		// `dev-` is a namespace Kubernetes refuses, but as a NAME it slugs cleanly.
		expect(normalizeEnvironmentName("dev-")).toBe("dev");
		expect(normalizeEnvironmentName("Préprod")).toBe("preprod");
	});

	it("refuses a name that slugs away entirely", () => {
		for (const bad of ["", "!!!", "   "]) {
			expect(environmentNameProblem(bad), bad).toMatch(/at least one letter or number/);
		}
	});

	it("refuses every name a console route would permanently shadow", () => {
		// Asserted over the WHOLE reserved list, not a sample: a segment added to the console's
		// project drilldown must be refused the day it is added, and naming three of them here
		// would pass while the fourth silently became creatable.
		expect(RESERVED_ENVIRONMENT_NAMES.length).toBeGreaterThan(0);
		expect([...RESERVED_ENVIRONMENT_NAMES]).toEqual([...RESERVED_PROJECT_CHILD_SLUGS]);
		for (const reserved of RESERVED_ENVIRONMENT_NAMES) {
			expect(environmentNameProblem(reserved), reserved).toMatch(/reserved by the console/);
			// And through the un-normalized spelling, which is how `project env add Settings` arrives.
			const shouted = reserved.toUpperCase();
			expect(environmentNameProblem(shouted), shouted).toMatch(/reserved by the console/);
		}
	});

	it("bounds the raw input instead of silently slugging a megabyte down to 40", () => {
		expect(environmentNameProblem("a".repeat(ENVIRONMENT_NAME_INPUT_MAX_LENGTH))).toBeNull();
		expect(environmentNameProblem("a".repeat(ENVIRONMENT_NAME_INPUT_MAX_LENGTH + 1))).toMatch(
			/at most 200 are read/,
		);
	});

	it("caps the stored slug at the environment budget", () => {
		const long = "staging environment for the european region";
		expect(normalizeEnvironmentName(long).length).toBeLessThanOrEqual(
			ENVIRONMENT_NAME_MAX_LENGTH,
		);
		expect(normalizeEnvironmentName(long)).toBe("staging-environment-for-the-european-reg");
	});

	it("parses to the STORED value, so a caller cannot forget to normalize", () => {
		const parsed = environmentNameSchema.safeParse("Prod");
		expect(parsed.success && parsed.data).toBe("prod");
		const refused = environmentNameSchema.safeParse("settings");
		expect(refused.success).toBe(false);
		if (!refused.success) {
			expect(refused.error.issues[0]?.message).toMatch(/reserved by the console/);
		}
	});
});

describe("chartSlug", () => {
	it("keeps `addon-<id>` inside a DNS-1123 label — the cap it used to have none of", () => {
		const id = chartSlug("a".repeat(200));
		expect(id.length).toBe(ADDON_ID_MAX_LENGTH);
		expect(`${ADDON_APP_NAME_PREFIX}${id}`.length).toBeLessThanOrEqual(DNS1123_LABEL_MAX_LENGTH);
		expect(isDns1123Label(`${ADDON_APP_NAME_PREFIX}${id}`)).toBe(true);
	});

	it("folds accents, so the console and the runner name one chart one way", () => {
		expect(chartSlug("Café Chart")).toBe("cafe-chart");
	});

	it("falls back to `chart` rather than an empty add-on id", () => {
		expect(chartSlug("")).toBe("chart");
		expect(chartSlug("***")).toBe("chart");
	});
});
