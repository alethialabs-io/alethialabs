// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What reaches the tab's storage from a wizard, and when it leaves (lib/wizard/draft.ts).
//
// The assertions on storage read the STORED TEXT, not what `readDraft` returns: a field that was
// written and then filtered on the way back would still have been written.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	clearAllWizardDrafts,
	clearDraft,
	type DraftAddress,
	draftKey,
	draftValues,
	isRecord,
	mergeDraftInto,
	readDraft,
	sweepDrafts,
	writeDraft,
} from "@/lib/wizard/draft";
import type { WizardDraft } from "@/lib/wizard/types";

const ADDRESS: DraftAddress = { id: "cloud-connect", viewerId: "user-1", scope: "acme" };
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** A draft that keeps two identifiers for thirty minutes. */
const DRAFT: WizardDraft = {
	version: 1,
	ttlMinutes: 30,
	schema: z.object({ roleArn: z.string(), projectNumber: z.string().optional() }),
};

/** What a connect form holds: the two identifiers, and things a draft must never keep. */
const FORM_VALUES = {
	roleArn: "arn:aws:iam::123456789012:role/alethia",
	projectNumber: "42",
	apiToken: "hunter2-token",
	serviceAccountJson: '{"private_key":"-----BEGIN"}',
	attachment: new File(["x"], "key.pem"),
	billing: { taxId: "BG123" },
};

/** Everything the tab's storage holds, as one string. */
function storedText(): string {
	const parts: string[] = [];
	for (let index = 0; index < window.sessionStorage.length; index += 1) {
		const key = window.sessionStorage.key(index);
		if (key !== null) parts.push(key, window.sessionStorage.getItem(key) ?? "");
	}
	return parts.join("\n");
}

beforeEach(() => {
	window.sessionStorage.clear();
	clearAllWizardDrafts();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("draftValues — the allowlist", () => {
	it("keeps the listed keys and nothing else", () => {
		expect(draftValues(DRAFT, FORM_VALUES)).toEqual({
			roleArn: "arn:aws:iam::123456789012:role/alethia",
			projectNumber: "42",
		});
	});

	it("keeps nothing when the values are not an object", () => {
		expect(draftValues(DRAFT, null)).toBeNull();
		expect(draftValues(DRAFT, "roleArn")).toBeNull();
		expect(draftValues(DRAFT, [FORM_VALUES])).toBeNull();
	});

	it("keeps nothing when a listed value does not pass the schema", () => {
		expect(draftValues(DRAFT, { roleArn: 7 })).toBeNull();
		expect(draftValues(DRAFT, {})).toBeNull();
	});

	it("does not read an inherited property as a listed key", () => {
		const inherited: unknown = Object.create({ roleArn: "from-prototype" });
		expect(draftValues(DRAFT, inherited)).toBeNull();
	});

	it.each([
		["any", z.any()],
		["a loose object", z.looseObject({ roleArn: z.string() })],
		["a record", z.record(z.string(), z.unknown())],
		["an object with an open value", z.object({ roleArn: z.string(), extra: z.unknown().optional() })],
		["an object with a catchall", z.object({ roleArn: z.string() }).catchall(z.unknown())],
	])("keeps nothing at all when the draft schema is %s", (_name, schema) => {
		const unsafe: WizardDraft = { version: 1, ttlMinutes: 30, schema };
		expect(draftValues(unsafe, FORM_VALUES)).toBeNull();
		expect(writeDraft(ADDRESS, unsafe, FORM_VALUES, "identity", NOW)).toBe(false);
		expect(window.sessionStorage.length).toBe(0);
	});
});

describe("writeDraft — what is stored", () => {
	it("stores only the listed fields, under the viewer's key", () => {
		expect(writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW)).toBe(true);
		const key = "alethia:wizard:v1:cloud-connect:user-1:acme";
		expect(draftKey(ADDRESS, 1)).toBe(key);
		expect(JSON.parse(window.sessionStorage.getItem(key) ?? "null")).toEqual({
			v: 1,
			step: "identity",
			at: NOW,
			values: { roleArn: "arn:aws:iam::123456789012:role/alethia", projectNumber: "42" },
		});
	});

	it("never stores an unlisted field's name or value", () => {
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW);
		const text = storedText();
		for (const absent of ["apiToken", "hunter2", "serviceAccountJson", "private_key", "attachment", "key.pem", "billing", "BG123"]) {
			expect(text).not.toContain(absent);
		}
	});

	it("escapes the parts of a key, so one part cannot pose as another", () => {
		const address: DraftAddress = { id: "a", viewerId: "u:1", scope: "org:x/y" };
		expect(draftKey(address, 2)).toBe("alethia:wizard:v2:a:u%3A1:org%3Ax%2Fy");
	});

	it("leaves the stored draft alone when the new values do not pass the schema", () => {
		writeDraft(ADDRESS, DRAFT, { roleArn: "arn:first" }, "identity", NOW);
		expect(writeDraft(ADDRESS, DRAFT, { roleArn: 7 }, "identity", NOW + 1)).toBe(false);
		expect(readDraft(ADDRESS, DRAFT, NOW + 2)?.values).toEqual({ roleArn: "arn:first" });
	});
});

describe("readDraft — when a draft is given back, and when it is removed", () => {
	it("gives back the values and the step", () => {
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW);
		expect(readDraft(ADDRESS, DRAFT, NOW + MINUTE)).toEqual({
			values: { roleArn: "arn:aws:iam::123456789012:role/alethia", projectNumber: "42" },
			step: "identity",
		});
	});

	it("answers null when there is none", () => {
		expect(readDraft(ADDRESS, DRAFT, NOW)).toBeNull();
	});

	it("removes a draft older than the TTL, and keeps one exactly at it", () => {
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW);
		expect(readDraft(ADDRESS, DRAFT, NOW + 30 * MINUTE)).not.toBeNull();
		expect(readDraft(ADDRESS, DRAFT, NOW + 30 * MINUTE + 1)).toBeNull();
		expect(window.sessionStorage.length).toBe(0);
	});

	it("removes a draft dated in the future", () => {
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW + MINUTE);
		expect(readDraft(ADDRESS, DRAFT, NOW)).toBeNull();
		expect(window.sessionStorage.length).toBe(0);
	});

	it("removes the draft of another version", () => {
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW);
		const next: WizardDraft = { ...DRAFT, version: 2 };
		expect(readDraft(ADDRESS, next, NOW)).toBeNull();
		expect(window.sessionStorage.length).toBe(0);
	});

	it("removes a draft whose envelope names another version than its key", () => {
		const key = draftKey(ADDRESS, 1);
		window.sessionStorage.setItem(
			key,
			JSON.stringify({ v: 2, step: "identity", at: NOW, values: { roleArn: "arn:x" } }),
		);
		expect(readDraft(ADDRESS, DRAFT, NOW)).toBeNull();
		expect(window.sessionStorage.getItem(key)).toBeNull();
	});

	it.each([
		["text that is not JSON", "{not json"],
		["JSON that is not an envelope", JSON.stringify(["roleArn"])],
		["an envelope with no step", JSON.stringify({ v: 1, at: NOW, values: { roleArn: "arn:x" } })],
		[
			"a step that is not an identifier",
			JSON.stringify({ v: 1, step: "../x", at: NOW, values: { roleArn: "arn:x" } }),
		],
		[
			"values that do not pass the schema",
			JSON.stringify({ v: 1, step: "identity", at: NOW, values: { roleArn: 7 } }),
		],
	])("removes %s", (_name, text) => {
		const key = draftKey(ADDRESS, 1);
		window.sessionStorage.setItem(key, text);
		expect(readDraft(ADDRESS, DRAFT, NOW)).toBeNull();
		expect(window.sessionStorage.getItem(key)).toBeNull();
	});

	it("drops a stored key the schema does not list, on the way back in", () => {
		window.sessionStorage.setItem(
			draftKey(ADDRESS, 1),
			JSON.stringify({
				v: 1,
				step: "identity",
				at: NOW,
				values: { roleArn: "arn:x", apiToken: "planted" },
			}),
		);
		expect(readDraft(ADDRESS, DRAFT, NOW)?.values).toEqual({ roleArn: "arn:x" });
	});

	it("removes every draft another viewer left in this tab", () => {
		const other: DraftAddress = { ...ADDRESS, viewerId: "user-2" };
		const elsewhere: DraftAddress = { id: "create-org", viewerId: "user-2", scope: "globex" };
		writeDraft(other, DRAFT, FORM_VALUES, "identity", NOW);
		writeDraft(elsewhere, DRAFT, FORM_VALUES, "identity", NOW);
		window.sessionStorage.setItem("unrelated", "kept");
		expect(readDraft(ADDRESS, DRAFT, NOW)).toBeNull();
		expect(window.sessionStorage.length).toBe(1);
		expect(window.sessionStorage.getItem("unrelated")).toBe("kept");
	});

	it("keeps this viewer's drafts of other wizards and scopes", () => {
		const sibling: DraftAddress = { ...ADDRESS, scope: "globex" };
		writeDraft(sibling, DRAFT, FORM_VALUES, "identity", NOW);
		sweepDrafts(ADDRESS, 1);
		expect(readDraft(sibling, DRAFT, NOW)).not.toBeNull();
	});
});

describe("clearing", () => {
	it("clearDraft removes one address in every version and nothing else", () => {
		const sibling: DraftAddress = { ...ADDRESS, scope: "globex" };
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW);
		writeDraft(ADDRESS, { ...DRAFT, version: 2 }, FORM_VALUES, "identity", NOW);
		writeDraft(sibling, DRAFT, FORM_VALUES, "identity", NOW);
		clearDraft(ADDRESS);
		expect(window.sessionStorage.length).toBe(1);
		expect(window.sessionStorage.getItem(draftKey(sibling, 1))).not.toBeNull();
	});

	it("clearAllWizardDrafts removes every wizard draft and leaves other keys", () => {
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW);
		writeDraft({ ...ADDRESS, viewerId: "user-2" }, DRAFT, FORM_VALUES, "identity", NOW);
		window.sessionStorage.setItem("alethia:pending-paid-setup:user-1", "kept");
		clearAllWizardDrafts();
		expect(window.sessionStorage.length).toBe(1);
		expect(window.sessionStorage.getItem("alethia:pending-paid-setup:user-1")).toBe("kept");
	});
});

describe("storage that throws", () => {
	/** Makes every method of the tab's storage throw, as a browser that refuses storage does. */
	function refuseStorage(): void {
		const refuse = () => {
			throw new DOMException("refused", "SecurityError");
		};
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(refuse);
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(refuse);
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(refuse);
		vi.spyOn(Storage.prototype, "key").mockImplementation(refuse);
	}

	it("keeps the draft in the page, still through the allowlist", () => {
		refuseStorage();
		expect(writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW)).toBe(true);
		expect(readDraft(ADDRESS, DRAFT, NOW)).toEqual({
			values: { roleArn: "arn:aws:iam::123456789012:role/alethia", projectNumber: "42" },
			step: "identity",
		});
	});

	it("clears the page copy as it clears storage", () => {
		refuseStorage();
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW);
		clearDraft(ADDRESS);
		expect(readDraft(ADDRESS, DRAFT, NOW)).toBeNull();
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW);
		clearAllWizardDrafts();
		expect(readDraft(ADDRESS, DRAFT, NOW)).toBeNull();
	});

	it("removes an expired page copy", () => {
		refuseStorage();
		writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW);
		expect(readDraft(ADDRESS, DRAFT, NOW + 31 * MINUTE)).toBeNull();
		expect(readDraft(ADDRESS, DRAFT, NOW)).toBeNull();
	});

	it("survives a window whose storage cannot even be reached", () => {
		const reach = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
			throw new DOMException("refused", "SecurityError");
		});
		expect(writeDraft(ADDRESS, DRAFT, FORM_VALUES, "identity", NOW)).toBe(true);
		expect(readDraft(ADDRESS, DRAFT, NOW)?.step).toBe("identity");
		clearDraft(ADDRESS);
		expect(readDraft(ADDRESS, DRAFT, NOW)).toBeNull();
		reach.mockRestore();
	});
});

describe("mergeDraftInto", () => {
	it("lays the draft over the base, merging plain objects key by key", () => {
		const base = { name: "", placement: { region: "", zone: "a" }, tags: ["x"] };
		const draft = { name: "pool", placement: { region: "fsn1" }, tags: ["y", "z"] };
		expect(mergeDraftInto(base, draft)).toEqual({
			name: "pool",
			placement: { region: "fsn1", zone: "a" },
			tags: ["y", "z"],
		});
		expect(base.placement).toEqual({ region: "", zone: "a" });
	});

	it("replaces a value whose kinds differ", () => {
		expect(mergeDraftInto({ a: { b: 1 } }, { a: "text" })).toEqual({ a: "text" });
		expect(mergeDraftInto({ a: "text" }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
	});
});

describe("isRecord", () => {
	it("is true for a plain object only", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
	});
});
