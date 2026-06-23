// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { auth } from "@/lib/auth";

// RFC 9728 — OAuth 2.0 Protected Resource Metadata. Points MCP clients from the
// /api/mcp resource to this app's authorization server (the 401 from withMcpAuth
// also advertises this document via WWW-Authenticate).
//
// lib/auth widens `plugins`, erasing the mcp() plugin's endpoint inference on `auth`
// though it exists at runtime — bridge to the shape the helper requires.
export const GET = oAuthProtectedResourceMetadata(
	auth as unknown as Parameters<typeof oAuthProtectedResourceMetadata>[0],
);
