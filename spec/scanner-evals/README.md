# Scanner evals

Quality gate for the repo analyzer (`lib/scanner`). Each fixture is a **`RepoDigest`**
(the deterministic output of the `ANALYZE_REPO` job) plus the **expected `InferredStack`**
assertions. The harness runs `inferStack(digest)` on each fixture and scores it, and
checks that `inferredStackToFormData` produces a spec that passes `specFormSchema` for
all three providers. GA is gated on a precision/recall threshold.

## Layout

```
spec/scanner-evals/
  fixtures/
    <name>.digest.json     # a RepoDigest (paste from a real ANALYZE_REPO job's execution_metadata.repo_digest)
    <name>.expected.json   # { runtime?, framework?, needs: [{ kind, engine? }] } — minimum expected
  README.md
```

## Assertions (per fixture)

- **runtime/framework** match (when asserted).
- **needs recall** — every expected `kind` (database/cache/queue/topic/nosql/secret) is
  inferred (engine match where asserted).
- **no hallucinated needs** beyond a tolerance (precision).
- **spec validity** — `inferredStackToFormData(stack, …)` passes `specFormSchema` for aws/gcp/azure.

## Harness (TODO)

A `pnpm -F console scanner:eval` script that loads each fixture, calls `inferStack`, diffs
against `*.expected.json`, and reports per-fixture + aggregate precision/recall. Run in CI
on `lib/scanner/**` changes; fail under threshold. (Needs `AI_GATEWAY_API_KEY`.)

## Seed fixtures to add

- a Django app (`requirements.txt` + `DATABASE_URL`/`REDIS_URL` → postgres + redis)
- a Go service (`go.mod` + a `Dockerfile` EXPOSE)
- a Next.js app (`package.json` + `prisma/schema.prisma` → postgres)
- a `docker-compose` stack (postgres + redis + a worker → db + cache + queue)
