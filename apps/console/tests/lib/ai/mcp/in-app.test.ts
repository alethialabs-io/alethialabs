// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Running an in-app tool in-process for a declared read (lib/ai/mcp/in-app.ts): the tool's own result
// comes back, whether it answers synchronously or with a promise; a tool with no execute, or one that
// streams, is refused as the programming error it would be.

import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import { runInAppTool } from "@/lib/ai/mcp/in-app";

describe("runInAppTool", () => {
	it("returns what the tool's execute answers, sync or async, with the input it was given", async () => {
		const execute = vi.fn(async ({ n }: { n: number }) => ({ doubled: n * 2 }));
		expect(await runInAppTool("double", tool({ inputSchema: z.object({ n: z.number() }), execute }), { n: 2 })).toEqual({ doubled: 4 });
		expect(execute).toHaveBeenCalledWith({ n: 2 }, { toolCallId: "mcp:double", messages: [] });
		const sync = tool({ inputSchema: z.object({}), execute: () => "now" });
		expect(await runInAppTool("sync", sync, {})).toBe("now");
	});

	it("refuses a tool with no execute and a tool that streams", async () => {
		await expect(runInAppTool("hitl", tool({ inputSchema: z.object({}) }), {})).rejects.toThrow("has no execute");
		const streaming = tool({
			inputSchema: z.object({}),
			async *execute() {
				yield 1;
			},
		});
		await expect(runInAppTool("stream", streaming, {})).rejects.toThrow("streams its result");
	});
});
