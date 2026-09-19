# E2E assertion issuer

This Cloudflare Worker exchanges a GitHub Actions OIDC token from an approved Alethia workflow for a short-lived, audience-bound assertion. It holds no cloud credentials. A Durable Object consumes each upstream token once, keyed on the token's signed `jti`.

## Deployment values

The `e2e-issuer` GitHub environment supplies these deployment values. The environment MUST carry a deployment-branch policy of `dev` (declared in `infra/github/environments.tf`; the maintainer applies it): the workflow also refuses any other ref, but the environment is what holds the Cloudflare credentials, so it is the control that binds.

| Kind     | Name                    | Purpose                                                                 |
| -------- | ----------------------- | ----------------------------------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`  | Worker deployment only                                                  |
| Secret   | `CLOUDFLARE_ACCOUNT_ID` | Worker deployment only                                                  |
| Secret   | `SIGNING_KEYS_JSON`     | Rotation-aware RSA signing keys; uploaded only by a rotation dispatch   |
| Variable | `E2E_ISSUER_URL`        | The HTTPS origin the Worker is served at; it refuses to serve any other |
| Variable | `GITHUB_TOKEN_AUDIENCE` | Audience requested from GitHub OIDC                                     |
| Variable | `ALLOWED_REPOSITORIES`  | Comma-separated exact repository names                                  |
| Variable | `ALLOWED_WORKFLOW_REFS` | Comma-separated exact `workflow_ref` claims                             |

`E2E_ISSUER_URL` must be exactly the origin the Worker answers at (for a `workers.dev` deployment, `https://alethia-e2e-issuer.<account-subdomain>.workers.dev`). Every minted `iss`, the discovery document and the JWKS URL are derived from it, and a request at any other origin is refused with `issuer_origin_mismatch`. The deploy workflow fetches discovery from that origin after deploying, so a mismatch fails the deploy instead of failing silently at the clouds. The same value is what the console reads as `ALETHIA_E2E_ASSERTION_BROKER_URL`.

There is no per-provider audience variable. The audience each cloud trusts is `providerAudience(provider)` from `@repo/workload-identity`, the one copy the console forwards and the Worker enforces.

`SIGNING_KEYS_JSON` has one active key and may retain old or staged keys:

```json
{
  "activeKid": "2026-09",
  "keys": [
    {
      "kid": "2026-09",
      "kty": "RSA",
      "alg": "RS256",
      "use": "sig",
      "n": "base64url-modulus",
      "e": "AQAB",
      "d": "base64url-private-exponent",
      "p": "base64url-prime",
      "q": "base64url-prime",
      "dp": "base64url-exponent",
      "dq": "base64url-exponent",
      "qi": "base64url-coefficient"
    }
  ]
}
```

The deployed secret contains complete private JWKs; the public endpoint strips every private parameter. The public endpoint publishes every entry that has a public RSA half, whether or not it can sign, so a staged or retained key never takes the JWKS down.

## Rotate a signing key

The verifiers are the clouds, not this Worker, and a cloud caches a JWKS for far longer than the Worker's five-minute `max-age` — Azure for about a day. So the rotation contract is the one `scripts/rotate-oidc-key.sh` already enforces for the console's issuer: **publish, then sign; keep the outgoing key published for at least 24 hours after it stops signing.**

Key material is never part of a code deploy. The workflow uploads `SIGNING_KEYS_JSON` only when dispatched with `upload-signing-keys` set, so a code fix never touches the bundle and a rotation never ships code by accident.

1. Add the new key to `keys` (complete private JWK, `alg` `RS256`, `use` `sig`) without changing `activeKid`. Update the environment secret, then dispatch the workflow with `upload-signing-keys` checked. Confirm the new `kid` appears in `/.well-known/jwks.json`.
2. Wait **at least 24 hours** so every cloud's cached JWKS has refreshed.
3. Change `activeKid` to the new key, update the secret, dispatch again with `upload-signing-keys`. Keep the prior key in `keys`.
4. Wait **at least 24 hours** — every assertion signed by the prior key has expired (ten minutes) and every cloud cache has refreshed.
5. Remove the prior key from `keys`, update the secret, dispatch once more.

Never paste the key set into a workflow input, repository variable, log, or issue. Update the environment secret directly. A malformed bundle is reported as `jwks_unavailable` / `signing_keys_invalid` with no detail, deliberately: the parser's error message would quote the bytes around the fault, which are key material.
