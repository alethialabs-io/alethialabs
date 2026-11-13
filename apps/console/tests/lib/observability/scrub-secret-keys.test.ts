// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// A known secret value is redacted from a Sentry event or breadcrumb wherever it appears, including
// as an object KEY (#6678). The scrub used to judge a key only by its name (`isSecretKey`), so a map
// keyed by a token sent the token as a property name. The key is renamed in the scrubbed COPY; the
// object the event refers to keeps its own key (copy-on-write, #6662).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent } from "@/lib/observability/scrub";

/** A secret env value used as an object key below. It holds no denylisted NAME substring, so a key made of it is judged by its value alone. */
const SECRET = "zz-kv-hidden-value-5d2a";
/** A second secret env value, for two keys that collide once both are renamed. */
const OTHER_SECRET = "zz-kv-other-value-8e71";
/** The env names the two secrets are planted under; both match the secret-name denylist. */
const ENV_NAMES: readonly [string, string] = ["ZZ_TEST_KEY_SECRET", "ZZ_TEST_KEY_OTHER_TOKEN"];

beforeEach(() => {
	process.env[ENV_NAMES[0]] = SECRET;
	process.env[ENV_NAMES[1]] = OTHER_SECRET;
});

afterEach(() => {
	for (const name of ENV_NAMES) delete process.env[name];
});

/** An event whose `extra` holds a nested map keyed by SECRET. */
function eventKeyedBySecret(): { extra: { members: { byHandle: Record<string, { user: string }> } } } {
	return {
		extra: { members: { byHandle: { [`handle-${SECRET}`]: { user: "u-1" }, plain: { user: "u-2" } } } },
	};
}

describe("an object key that carries a secret value", () => {
	it("is renamed to a redacted form in a nested object of the event", () => {
		const event = eventKeyedBySecret();
		const out = scrubEvent(event);
		const byHandle = out.extra.members.byHandle;
		expect(Object.keys(byHandle).sort()).toEqual(["handle-[REDACTED]", "plain"]);
		expect(byHandle["handle-[REDACTED]"]).toEqual({ user: "u-1" });
		expect(JSON.stringify(out)).not.toContain(SECRET);
	});

	it("leaves the original object, and every object on the path to it, untouched", () => {
		const event = eventKeyedBySecret();
		const extra = event.extra;
		const members = extra.members;
		const byHandle = members.byHandle;
		const out = scrubEvent(event);
		expect(Object.keys(byHandle).sort()).toEqual([`handle-${SECRET}`, "plain"]);
		expect(members.byHandle).toBe(byHandle);
		expect(extra.members).toBe(members);
		// The path to the renamed key is copied; the unchanged value under it is shared, not copied.
		expect(out.extra).not.toBe(extra);
		expect(out.extra.members.byHandle).not.toBe(byHandle);
		expect(out.extra.members.byHandle.plain).toBe(byHandle.plain);
	});

	it("still has its value scrubbed under the new name", () => {
		const out = scrubEvent({ extra: { map: { [SECRET]: `echo ${SECRET}` } } });
		expect(out.extra.map).toEqual({ "[REDACTED]": "echo [REDACTED]" });
	});

	it("keeps both keys, with a numbered suffix, when two rename to the same text", () => {
		const out = scrubEvent({
			extra: { map: { "[REDACTED]": "already", [SECRET]: "first", [OTHER_SECRET]: "second" } },
		});
		expect(out.extra.map).toEqual({
			"[REDACTED]": "already",
			"[REDACTED]#2": "first",
			"[REDACTED]#3": "second",
		});
	});

	it("is renamed in a breadcrumb's data, and at the top level of a breadcrumb", () => {
		const data = { [SECRET]: 1 };
		const crumb: Record<string, unknown> = { data, [`x-${SECRET}`]: "y" };
		const out = scrubBreadcrumb(crumb);
		expect(out).toEqual({ data: { "[REDACTED]": 1 }, "x-[REDACTED]": "y" });
		expect(data).toEqual({ [SECRET]: 1 });
	});

	it("is left as it is, with no copy made, when no key or value carries a secret", () => {
		const map = { alpha: { user: "u-1" } };
		const out = scrubEvent({ extra: { map } });
		expect(out.extra.map).toBe(map);
	});
});
