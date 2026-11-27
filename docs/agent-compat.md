<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Agent client compatibility

This page tracks one question: **which MCP clients can use Alethia, and over which protocol
revision?** It is the record for spec §4.8 (management repo,
`spec/features/beta-2027-01-31/agent-surface.md`) and issue #6863.

**The rule for this page:** a cell says *passes* only when a named test or a recorded run proves
it, and the cell names that test or run. A blank cell means nobody has tested it. It does not mean
the thing fails, and it does not mean it works.

There are two surfaces:

- **The remote endpoint.** `POST /api/mcp` (`apps/console/app/api/mcp/route.ts`), Streamable HTTP
  with OAuth.
- **The local stdio server.** `alethia mcp` (`apps/cli/internal/mcp/server.go`), newline-delimited
  JSON-RPC that runs as the person signed in to the CLI.

## 1. The seven clients: not recorded yet

Spec §4.8 names seven clients. Each one runs the same sequence against a running environment:
connect, OAuth with CIMD, list tools, a read call, `request_apply`, `wait_for_job`.

| Client | Version | Connect | OAuth (CIMD) | List tools | Read call | `request_apply` | `wait_for_job` |
|---|---|---|---|---|---|---|---|
| Claude Code | | | | | | | |
| claude.ai / Claude Desktop | | | | | | | |
| Cursor | | | | | | | |
| VS Code Copilot | | | | | | | |
| Codex CLI | | | | | | | |
| Windsurf | | | | | | | |
| Gemini CLI | | | | | | | |

**Nobody has run any of these yet.** Each run needs the client itself, signed in to a real account,
and a running environment with a URL. CI has neither. The spec plans scripted runs for Claude Code,
Codex CLI and Gemini CLI, hand runs for the four GUI clients, and one sandbox slot for about two
days. The decision rule below is due **2026-12-04**.

The setup pages under `apps/docs/content/docs/agents/` (Claude Code, Claude, Cursor, VS Code,
Codex) say how to add the server to each client. No test checks those steps. Until a row above is
filled, they are instructions, not compatibility claims.

## 2. What CI proves: each surface, revision by revision

These tests post raw JSON-RPC in the wire format of each revision. They do not use an SDK client,
because the SDK's own client agrees with its server by construction. A pass means "a client that
speaks revision X gets these answers". It says nothing about any named client. The MCP SDK is
`@modelcontextprotocol/server` 2.4.0, the version pinned in `pnpm-lock.yaml`.

Tests cited as **R** are in `apps/console/tests/mcp-compat/remote-route-conformance.test.ts`.
Tests cited as **S** are in `apps/cli/internal/mcp/conformance_test.go`.

| Revision | Remote endpoint `/api/mcp` | Local stdio `alethia mcp` |
|---|---|---|
| 2026-07-28 | **Served.** Proven by R, "2026-07-28, the sequence spec §4.8 names": `server/discover` advertises exactly `2026-07-28` and the instructions. `tools/list` lists 19 tools, or 12 under `?readonly`, and fewer for a narrower token. A read call, `request_apply` and `wait_for_job` return their structured results. Bad arguments are refused. | **Served without a handshake.** Proven by S, `TestConformance_TheModernRevisionServesTheSequenceWithoutAHandshake`: `server/discover`, then `tools/list`, then `tools/call`, each with the `_meta` envelope. |
| 2025-11-25 | **Refused**, `400` and `-32022`, with `supported: ["2026-07-28"]`. Proven by R, "2025-era revisions are refused". | **Served.** Proven by S, `TestConformance_EachHandshakeRevisionServesTheSequence/2025-11-25`: `initialize` agrees on 2025-11-25, then `tools/list` and `tools/call`. |
| 2025-06-18 | **Refused**, same answer. Proven by R. | **Served.** Proven by S, `…/2025-06-18`. |
| 2025-03-26 | **Refused**, same answer. Proven by R. | **Served.** Proven by S, `…/2025-03-26`. |
| 2024-11-05 | **Refused**, same answer. Proven by R. | **Not served.** `initialize` offers 2025-11-25, and under the 2025 lifecycle a client that cannot speak it disconnects. Proven by S, `TestConformance_A2024RevisionIsOfferedTheNewestHandshakeRevision`. |
| 2024-10-07 | **Refused**, same answer. Proven by R. | **Not served**, the same way. Proven by S. |

The remote endpoint also has these properties, all proven by R:

- A 2025-era `tools/list` that skips `initialize` is refused too. Leaving out the handshake does
  not get a client past the era check.
- A 2025-era notification gets `202` and is dropped.
- The route exports `POST` only, so no `GET` (SSE) or `DELETE` (session) handler exists.
- A modern envelope that names a revision the endpoint does not serve gets `-32022`, and so does
  one with no `MCP-Protocol-Version` header.
- The list of tested revisions covers every 2025-era revision that the SDK's
  `SUPPORTED_PROTOCOL_VERSIONS` names. When the SDK learns a new revision, R fails until someone
  adds it here.

**What the R tests stand in for.** OAuth, the actor and plan checks, and the tool handlers are
replaced with stand-ins. Those parts have their own tests: `tests/app/api/mcp-route-audience.test.ts`
and `tests/lib/ai/mcp/*`. The route module, the SDK handler with the route's own posture, and the
real server with the declared tool contract are not stood in.

## 3. Discovery: what a client reads before it connects

`scripts/check-mcp-discovery.sh <base-url>` follows the chain a client follows. A POST to `/api/mcp`
without a token must answer `401`. The `resource_metadata` pointer in that answer must lead to the
RFC 9728 document. That document must name the RFC 8414 authorization server. The server metadata
must advertise CIMD (`client_id_metadata_document_supported`), PKCE `S256`, public clients (`none`)
and the five agent scopes. Every response must be JSON with CORS headers.
`scripts/check-mcp-discovery.sh --self-test` runs the same checks against a local fixture and
needs no deployment.

| Deployment | Date (UTC) | Result |
|---|---|---|
| `https://alethialabs.io` | 2026-11-27 | **Passed**, every check. The script also reported that no dynamic client registration endpoint is advertised. |
| `--self-test` fixture | 2026-11-27 | **Passed.** Removing `S256`, or one agent scope, from the fixture makes it fail. |

This is discovery only. Nothing here fetches a client's metadata document, shows the consent
screen or exchanges a code for a token. For any client, that part is still the "OAuth (CIMD)"
column in §1.

Because no dynamic client registration endpoint exists, a client that can register only through
DCR cannot connect without a pre-registered client id. The spec's rule covers this case: a client
that cannot use CIMD gets a pre-registered client id. Which clients that applies to is a §1
question.

## 4. The decision rule: what is known and what is not

Spec §4.8: *if any of the seven cannot complete the sequence against the modern-only route, the
route accepts legacy revisions (dual-era) and the conformance suite covers both; if a client cannot
use CIMD, it gets a pre-registered client id.*

The tests above settle these points:

- **The remote endpoint is modern-only.** A client that speaks no revision newer than 2025-11-25
  cannot use it (§2).
- **The stdio server accepts both eras.** Such a client can use `alethia mcp` instead (§2).
- **The fallback works on the same server.** R's block "dual-era readiness" builds the same server
  under the SDK's `legacy: "stateless"` posture and serves `initialize`, `tools/list` and a read
  call at 2025-03-26, 2025-06-18 and 2025-11-25. The route itself still uses `"reject"`. Switching
  means changing `{ legacy: "reject" }` to `"stateless"` in the route and moving R's legacy
  expectations from *refused* to *served*.

The tests do **not** settle this point: which of the seven clients speak 2026-07-28, and which
use CIMD. Only the §1 runs can answer it, so the rule cannot be applied until those runs exist.

## 5. Known gaps in the stdio server

These are open findings, not results:

- **It does not check the envelope's revision.** On 2026-11-27, a one-off probe sent a `tools/list`
  whose envelope named `2099-01-01`, and the server answered it. The SDK's modern path answers the
  same request with `-32022`. No test locks this behaviour in either direction.
- **It sends the modern result metadata only on `server/discover`.** The SDK's modern path adds
  `resultType` and the `_meta` server info to every result. The stdio server sends `_meta` only on
  `server/discover`, and never sends `resultType`. No test shows whether a 2026-07-28 client
  needs them.
- **No real client has driven it.** The same is true of the remote endpoint.

## Running the checks

```bash
# remote endpoint, one file (from apps/console)
npx vitest run tests/mcp-compat --maxWorkers=1
# stdio server (from apps/cli)
go test ./internal/mcp/ -run Conformance
# discovery: fixture, or a real deployment
scripts/check-mcp-discovery.sh --self-test
scripts/check-mcp-discovery.sh https://alethialabs.io
```

After you complete a client run, fill in its row in §1. Record the client's version and the date,
and add a link to the transcript or recording for each passed cell. A run with no record does not
count.
