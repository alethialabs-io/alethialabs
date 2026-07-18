// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { oAuthDiscoveryMetadata } from "better-auth/plugins";
import { auth } from "@/lib/auth";

// RFC 8414 — OAuth 2.0 Authorization Server Metadata. MCP clients (claude.ai
// connectors) fetch this to discover the authorize/token/registration endpoints
// served by Better Auth's mcp() plugin.
//
// lib/auth widens `plugins` (for the conditional enterprise pushes), erasing the
// mcp() plugin's endpoint inference on `auth` though it exists at runtime — bridge
// to the exact shape the helper requires (no behaviour change).
export const GET = oAuthDiscoveryMetadata(
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- better-auth widens `plugins`, erasing mcp()'s endpoint inference on `auth` though it exists at runtime
	auth as unknown as Parameters<typeof oAuthDiscoveryMetadata>[0],
);
