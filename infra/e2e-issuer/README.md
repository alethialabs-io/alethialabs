<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# e2e-issuer

The public origin of the E2E assertion issuer (`apps/e2e-issuer`): **`https://e2e-issuer.alethialabs.io`**.
That origin is the `iss` of every assertion the broker mints, and four cloud trust stacks pin it byte
for byte (`infra/{aws-oidc,gcp-e2e,azure-e2e,alibaba-e2e}`). The maintainer ruled it on #4226
(2026-09-23): a Cloudflare custom domain managed in code with remote state, `workers.dev` off, a
zone-scoped apply token kept apart from the deploy token, and a scheduled health check.

| This stack owns | It does not own |
|---|---|
| The **Workers Custom Domain** binding `e2e-issuer.alethialabs.io` → the `alethia-e2e-issuer` Worker (its name is read from `apps/e2e-issuer/wrangler.jsonc`) | The Worker's **code** — `.github/workflows/deploy-e2e-issuer.yml` deploys it with a different token |
| The host's **CAA** record set | The host's DNS record and certificate — Cloudflare creates both for the custom domain |
| `tls-ca-pin.json` — the reviewed CA fingerprints `alibaba-e2e` pins | Any cloud trust — the four trust stacks do that |

Applied **by the maintainer only**. There is no apply job: `.github/workflows/infra-e2e-issuer.yml`
validates, lints, scans and runs the mocked `tofu test`, with no Cloudflare or state credential.

## Why there is no single-CA pin

The ruling asked for a CAA record that restricts issuance to one CA. On this zone that cannot hold,
for three documented reasons:

1. **Cloudflare adds CAA records of its own.** *"Cloudflare adds CAA records automatically when you
   have Universal SSL and add any CAA records to your zone"* — for `pki.goog`, `letsencrypt.org`,
   `ssl.com` and `sectigo.com`, and *"this list is not exhaustive"*. The added records are served but
   do not appear in the dashboard or the API.
   ([Cloudflare: CAA records](https://developers.cloudflare.com/ssl/edge-certificates/caa-records/))
   A one-CA set in this stack would be answered as a four-CA set, so the plan would state something
   the live DNS contradicts.
2. **The custom domain's certificate CA is Cloudflare's choice.** A custom domain *"will also
   generate an Advanced Certificate … with default settings"*
   ([Cloudflare: Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)).
   Which CA those defaults use is not documented. Choosing one means deleting that certificate and
   ordering an Advanced Certificate Manager certificate (a paid add-on). A CAA set that left out the
   CA Cloudflare picks would make issuance or a **renewal** fail, and the issuer would go dark when
   the certificate expires.
3. **One CA is not one chain.** Google Trust Services and Let's Encrypt each issue from several
   intermediates. Alibaba RAM pins certificates, not CAs, so pinning one CA would still break.

So the stack does two things instead:

- **The CAA set names exactly the four CAs Cloudflare documents.** That is the smallest set that
  cannot break issuance. It still refuses every other public CA, and it is now written down rather
  than left to an invisible injection.
- **The Alibaba pin is strong on its own terms.** `tls-ca-pin.json` holds the SHA-1 fingerprints of
  every CA certificate the host serves (at most five — RAM's limit), observed from the live host and
  reviewed in a PR. `alibaba-e2e` pins exactly that set. Its plan **refuses**, by precondition, a pin
  that is empty, that names another origin, or that does not cover the chain being served. The
  *E2E issuer health* workflow compares the live chain with the pin every six hours and opens an
  issue naming a new certificate before the nightly finds it. RAM's own guidance is to add a new
  fingerprint at least a day before a rotation; this signal is what gives you that lead time.

The whole zone's Universal SSL CA could be pinned in the dashboard, but the custom domain's
certificate is an Advanced certificate, and Cloudflare's backup certificates come from Sectigo
([Cloudflare: certificate authorities](https://developers.cloudflare.com/ssl/reference/certificate-authorities/)).
Neither step gets you to one chain.

**Not covered here:** a wildcard certificate for `*.alethialabs.io` would also cover this host, and a
CA looks up CAA for a wildcard at the zone apex, which has no CAA record today. That is a zone-wide
decision, left as a follow-up.

## The token

Create a **new** custom API token in the Cloudflare dashboard (*My Profile → API Tokens → Create
Custom Token*). It is not the deploy token.

| Permission | Scope | Why |
|---|---|---|
| Zone · Workers Routes · Edit | `alethialabs.io` only | Create the custom domain ([Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/)) |
| Zone · DNS · Edit | `alethialabs.io` only | The CAA records |
| Zone · Zone · Read | `alethialabs.io` only | The zone is looked up by name |
| Account · Workers Scripts · Edit | the account | **Required by Cloudflare, not chosen.** The attach-to-domain API accepts only *Workers Scripts Write*, and Cloudflare documents that custom domains *"do not currently support per-Worker roles"*, so it cannot be narrowed to one Worker |

The last row means the maintainer's hope — zone-scoped permissions only — cannot be met in full. The
token can also deploy Workers. Make up for that where the token lives instead:

- Set **TTL** so the token expires the day you apply, and add **Client IP filtering** for your own
  address.
- Keep it in your shell only (`export CLOUDFLARE_API_TOKEN=…`). Never put it in a GitHub secret,
  a file or a `-var`. The provider reads the environment, so it never appears in a plan or in state.
- Revoke it after the apply.

The **deploy token** (`CLOUDFLARE_API_TOKEN` in the `e2e-issuer` GitHub environment) stays as it is:
Account · Workers Scripts · Edit and no zone permission. Do not add zone permissions to it. Because
the custom domain is not declared in `wrangler.jsonc`, a deploy never needs them.

## Runbook — moving the issuer to the custom domain

Do the steps in this order. Each one says how you know it worked. Nothing before step 7 changes any
cloud trust.

**0. Merge the PR.** This is safe before anything else: the deploy that the merge triggers is refused
by its preflight (`E2E_ISSUER_URL` is still the `workers.dev` origin, and `wrangler.jsonc` turns
`workers.dev` off). The live Worker keeps serving at `workers.dev`, unchanged. Expect that one red
*Deploy E2E assertion issuer* run, with the reason in its annotations.

**1. Create the token** (above). Check that the host has no record yet — a CNAME there blocks the
custom domain:

```bash
dig +short e2e-issuer.alethialabs.io; dig +short CNAME e2e-issuer.alethialabs.io   # both empty
```

**2. Apply this stack**, from an up-to-date checkout that contains it:

```bash
cd infra/e2e-issuer
cp backend.hcl.example backend.hcl              # the shared AWS state bucket; your AWS admin creds
tofu init -backend-config=backend.hcl
export CLOUDFLARE_API_TOKEN=…                   # the token from step 1
export TF_VAR_cloudflare_account_id=…           # the account that owns alethialabs.io and the Worker
tofu plan -out=tfplan
```

Expected plan: **5 to add** — `cloudflare_workers_custom_domain.issuer` and four
`cloudflare_dns_record.caa[...]`, and nothing to change or destroy. One check warns:
`issuer_serves_discovery_at_this_origin`, because the host does not resolve yet. That is expected. If
the plan shows anything else, stop.

```bash
tofu apply tfplan
```

Then check that the host routes to the Worker. The Worker is still deployed for the `workers.dev`
origin, so it refuses this one, and that refusal proves the routing:

```bash
curl -sS https://e2e-issuer.alethialabs.io/.well-known/openid-configuration
# {"error":"issuer_origin_mismatch"}   ← HTTP 503. The certificate can take a few minutes.
dig +short CAA e2e-issuer.alethialabs.io     # the four issuers (Cloudflare may add issuewild lines)
```

**3. Point the variable at the new origin.**

```bash
gh variable set E2E_ISSUER_URL --repo alethialabs-io/alethialabs --body https://e2e-issuer.alethialabs.io
```

Only *Deploy E2E assertion issuer* and *E2E issuer health* read it. If you have set
`ALETHIA_E2E_ASSERTION_BROKER_URL` anywhere (the console's copy), set it to the same origin.

**4. Deploy.**

```bash
gh workflow run deploy-e2e-issuer.yml --repo alethialabs-io/alethialabs --ref dev
```

The preflight passes: the origin is the committed one, and the host answers with the Worker's own
`issuer_origin_mismatch`. The Worker is deployed with `ISSUER_URL` set to the new origin and
`workers.dev` off. The post-deploy step then retries for up to three minutes, until discovery names
the new origin and the JWKS has a usable RS256 key. A red run names the check that failed.

**5. Verify.**

```bash
node scripts/ci/check-e2e-issuer-health.mjs --expected-url https://e2e-issuer.alethialabs.io
curl -sS -o /dev/null -w '%{http_code}\n' https://alethia-e2e-issuer.<account-subdomain>.workers.dev/.well-known/openid-configuration  # no longer 200
(cd infra/e2e-issuer && tofu plan)      # No changes, and no check warns
```

The health check should report exactly **one** finding: `tls-pin` says `tls-ca-pin.json` pins nothing
yet. Anything else is a real finding.

**6. Pin the chain** — one reviewed PR:

```bash
node scripts/ci/check-e2e-issuer-health.mjs --print-pin --expected-url https://e2e-issuer.alethialabs.io \
  --out infra/e2e-issuer/tls-ca-pin.json
git diff infra/e2e-issuer/tls-ca-pin.json    # read the subjects: the issuing CA and its parent
```

Use `--out`, never `> infra/e2e-issuer/tls-ca-pin.json`. The shell empties the target before the
script runs, so a redirect destroys the entries the merge has to keep. `--out` reads the file first,
then replaces it atomically (a temp file, then a rename). It refuses to pin a chain that does not
verify to a trusted root for this host name.

Merge it. `node scripts/ci/check-e2e-issuer-health.mjs --expected-url https://e2e-issuer.alethialabs.io`
now exits `0`. Run *E2E issuer health* once by hand (`gh workflow run e2e-issuer-health.yml --ref dev`).
Its schedule starts only when the workflow reaches `main`.

**7. The four trust applies** — only after #4903 (the e2e stacks' remote state) is resolved. Follow
[`docs/testing/e2e-federation-apply-runbook.md`](../../docs/testing/e2e-federation-apply-runbook.md),
part two. The origin is already committed in all four `terraform.tfvars`. `alibaba-e2e` reads the pin
from step 6 and refuses to plan without it.

Then **revoke the token** from step 1.

## Afterwards

- **The health tracker.** *E2E issuer health* keeps one issue labelled `tracker:e2e-issuer-health`
  open while any check fails, and closes it when all pass. If the instrument itself cannot look (for
  example, the pin file is unreadable), the job fails instead of opening an issue.
- **A new certificate chain** (the tracker's `tls-pin` row names it): run
  `--print-pin --expected-url https://e2e-issuer.alethialabs.io --out infra/e2e-issuer/tls-ca-pin.json`
  again. It keeps the existing entries and appends the new ones. Merge, then plan and apply `alibaba-e2e`. The
  only change should be `fingerprints`. Remove retired entries by hand in a later PR.
- **Signing-key age** (the `keys` row): rotate the key as `apps/e2e-issuer/README.md` describes. The
  check reads age from the `YYYY-MM` kid convention.
- **Tearing down:** `tofu destroy` here removes the binding and the CAA records, but not the Advanced
  certificate Cloudflare generated. Delete that by hand (output `certificate_id`). Destroying this
  stack takes the issuer offline, so remove the four cloud trusts first.

## Files

| File | |
|---|---|
| `main.tf` | the zone lookup, the custom domain, the CAA set, and the reasons for the CA set |
| `variables.tf` | `cloudflare_account_id` (required, not committed), `zone_name`, `hostname` — each validated |
| `checks.tf` | reports: the origin's shape, the zone and account, the binding, the CAA set, and a live discovery probe |
| `checks.tftest.hcl` | mocked tests. Each validation, precondition and check is shown to fire |
| `terraform.tfvars` | committed: `zone_name`, `hostname` |
| `tls-ca-pin.json` | the reviewed CA fingerprints. The one copy, read by `alibaba-e2e` and the health check |
| `backend.hcl.example` | S3 state in `alethia-tofu-state-270587882865`, key `e2e-issuer/terraform.tfstate` |
