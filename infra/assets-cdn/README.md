# infra/assets-cdn — assets.alethialabs.io

One public host for the media every app links to: the home-page films and their posters, the founder
photo, brand files. A Cloudflare R2 bucket (`alethia-public-assets`, EU jurisdiction) served through
an R2 custom domain, with Cloudflare's cache in front.

**Applied by the maintainer, by hand.** CI (`.github/workflows/infra-assets-cdn.yml`) validates,
lints and runs the mocked `tofu test`; it holds no credential and has no apply job.

## Why

- **Big media stays out of git.** A 60–90 s film is tens of MB; committed, it is cloned by every
  worktree, every CI run and every image build, and it can never be removed from history.
- **One host for every app.** Marketing, News, docs, the console and email all link the same URL, so
  a poster replaced once is replaced everywhere.
- **R2, not S3.** Egress is free on R2, and the home film is downloaded by every visitor. The same
  traffic out of S3 + CloudFront is billed per GB.

## What it creates

| Resource | Why |
|---|---|
| `cloudflare_r2_bucket.assets` | The bucket. `jurisdiction = "eu"` keeps objects in the EU; `prevent_destroy` because the media exists nowhere else in servable form |
| `cloudflare_r2_custom_domain.assets` | `assets.alethialabs.io` → the bucket. Cloudflare manages the DNS record and certificate; TLS ≥ 1.2 |
| `cloudflare_r2_managed_domain.assets` | The `*.r2.dev` URL, **disabled** — it bypasses the cache and is rate limited |
| `cloudflare_r2_bucket_cors.assets` | `GET`/`HEAD` from `alethialabs.io` and `www.` — for code that reads bytes (fonts, `fetch()`); a plain `<img>`/`<video>` needs none |
| `cloudflare_ruleset.cache[0]` | The zone's cache rule: one year at the edge for `/brand/`, `/media/`, `/people/` on this host; errors for 60 s. Gated on `manage_cache_rule` (below) |

Nothing is publicly **writable**. Writes need an R2 API token, which this stack does not create.

## Cost

R2's free tier per month: **10 GB-month storage, 1 M Class A (write) and 10 M Class B (read)
operations, unlimited egress.** Cached hits at the edge do not reach R2 at all.

Expected set: two films (~40–80 MB each at 1080p), their posters, a photo and brand files —
**well under 1 GB, so €0/month.** Past the free tier: storage $0.015/GB-month, Class B $0.36 per
million. A thousand visitors a day watching the film is ~30 k cache misses a month at worst —
inside the free operations. Free-plan cache does not store single objects over 512 MB; keep films
below that (they are an order of magnitude smaller).

## Path convention — every cached key is versioned

`/brand/`, `/media/` and `/people/` are cached for **a year** at the edge, and uploads set the same
for browsers. A cached object cannot be changed in place, so **a new version is a new name**:

```
/brand/alethia-mark-v2.svg
/media/films/home-2026-12-v1.mp4
/media/posters/home-2026-12-v1.jpg
/people/borislav-borisov-v1.jpg
```

Never overwrite a key that has been published. Upload the new file under a new name, change the
link, and leave the old object until nothing references it.

## Runbook (maintainer)

### 1. Before the first apply

- **The host is free.** Cloudflare → alethialabs.io → DNS: there must be no `assets` record (the
  custom domain creates its own; an existing one makes it fail).
- **The zone's cache ruleset is unowned.** Cloudflare → alethialabs.io → Caching → **Cache Rules**.
  A zone holds ONE cache-settings ruleset; with `manage_cache_rule = true` (committed) this stack
  takes it over and any rule listed there is replaced. If the list is **empty**, keep `true`. If it
  is not, either move those rules into `main.tf` first or set `manage_cache_rule = false` in
  `terraform.tfvars` — the edge then still caches by each object's `Cache-Control`.

### 2. Token

Cloudflare → My Profile → API Tokens → Create a custom token, scoped to the Alethia Labs account and
the `alethialabs.io` zone only:

- Account · **Workers R2 Storage** · Edit
- Zone · **Zone** · Read
- Zone · **Cache Rules** · Edit (only if `manage_cache_rule = true`)
- Zone · **DNS** · Edit (the custom domain writes its record)

### 3. Apply

```sh
cd infra/assets-cdn
cp backend.hcl.example backend.hcl
export CLOUDFLARE_API_TOKEN=…                 # the token from step 2; never a tfvars value
export TF_VAR_cloudflare_account_id=…         # 32-hex account id
tofu init -backend-config=backend.hcl
tofu plan -out=assets.tfplan                  # expect 5 to add (4 with manage_cache_rule = false)
tofu apply assets.tfplan
```

Then confirm: `curl -sI https://assets.alethialabs.io/` answers from Cloudflare (a 404 for the bare
root is correct — there is no index object), and the bucket's r2.dev URL is off in the dashboard.

### 4. Upload credentials

Create a separate **R2 API token** (R2 → Manage API tokens) with *Object Read & Write* on
`alethia-public-assets` only. That token, not the apply token, is the one that uploads.

## Uploading

The bucket is in the **EU jurisdiction**, so S3 clients must use the EU endpoint
`https://<account-id>.eu.r2.cloudflarestorage.com` (the non-EU endpoint does not see it). Always set
the cache header and the content type:

```sh
# wrangler (reads CLOUDFLARE_API_TOKEN)
npx wrangler r2 object put alethia-public-assets/media/films/home-2026-12-v1.mp4 \
  --file ./home.mp4 --jurisdiction eu --remote \
  --content-type video/mp4 --cache-control "public, max-age=31536000, immutable"

# or any S3 client with the R2 token's access key pair
aws s3 cp ./home.mp4 s3://alethia-public-assets/media/films/home-2026-12-v1.mp4 \
  --endpoint-url "https://$ACCOUNT_ID.eu.r2.cloudflarestorage.com" --region auto \
  --content-type video/mp4 --cache-control "public, max-age=31536000, immutable"
```

Every file needs a provenance entry in `docs/legal/BRAND_DESIGN_PROVENANCE.md` before it is linked,
the same as a committed asset.

## Using it from an app

`apps/marketing/lib/assets.ts` exports `assetUrl(key)`, built on `NEXT_PUBLIC_ASSETS_URL` (default
`https://assets.alethialabs.io`). Plain `<img>`/`<video>` tags take the URL directly.
