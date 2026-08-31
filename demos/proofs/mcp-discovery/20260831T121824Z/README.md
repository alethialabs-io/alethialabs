<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# MCP OAuth discovery proof — #3504 / #3516

Captured 2026-08-31 from revision `11fe9bdb` plus the probe added by this
change. The probe asserts response content types and bodies; an HTML console
shell is a failure even when its status is 200.

## Production control — expected failure

```text
$ scripts/check-mcp-discovery.sh https://alethialabs.io
✗ protected: expected HTTP 200, got 404
```

This is the pre-deployment state: the well-known document named by remote MCP
discovery is not served by production.

## Branch environment — pass

Base URL: `https://env2-dev.alethialabs.io`

```text
$ scripts/check-mcp-discovery.sh https://env2-dev.alethialabs.io
✓ protected-resource metadata is canonical JSON
✓ authorization-server metadata completes the discovery chain
✓ unsupported metadata paths fail as CORS-enabled JSON
✓ metadata preflights are cacheable and cross-origin
✓ the 401 pointer names a JSON document the server serves
MCP discovery proof passed for https://env2-dev.alethialabs.io
```

The environment used email-OTP auth only. No cookie, authorization code,
access token, runner credential, or environment secret is present here.
