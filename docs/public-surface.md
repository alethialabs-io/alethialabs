# What lives in this repository

This repository is **Alethia, the product**. A person who clones it should find the product, what they need to build, test and contribute to it, and the commercial tier in `ee/`. They should not find the company that makes it.

`pnpm check:public-surface` (`scripts/check-public-surface.mjs`) enforces the path half of this policy.

## Belongs here

| What | Where |
|---|---|
| The product | `apps/console`, `apps/cli`, `apps/runner`, `apps/docs`, `packages/*` (except the company packages below), `infra/templates`, `infra/connector`, helm charts, `deploy/selfhost` |
| The commercial tier | `ee/`, under `LicenseRef-Alethia-Commercial`. Enterprise features live in `ee/`; the core keeps only the interface and the loader (`check:open-core`) |
| Contributor tooling | CI, lint and test configuration; `AGENTS.md`; the agent skills and guards a contributor uses |
| Worked examples | `examples/` (add-on values), read by the console's tests |
| The product's own test estate | The e2e cloud-account stacks that the product's e2e runs use, until they get their own home |

## Does not belong here

| Class | Why | Where it goes |
|---|---|---|
| `staff-app` | The staff admin app operates the hosted service | `alethialabs-io/web` |
| `marketing` | Marketing site, blog, status page and brand assets describe the company | `alethialabs-io/web` |
| `company-finance` | Alethia Labs' own invoicing, VAT filing and legal facts | A private package behind a console billing interface |
| `company-estate-infra` | Infrastructure for the company's own accounts, mail, backups and books | A private ops repo |
| `hosted-prod-deploy` | The deploy of the hosted service | To be designed: the box runs compose from this checkout today |
| `company-ops-notes` | The agents' programme ledger, coordination rules and credential broker | Private, per the harness curation |
| `dead` | Left over from before Alethia | Deleted |

The exact path prefixes for each class are in `CLASSES` in `scripts/check-public-surface.mjs`. The files still here are listed in `scripts/public-surface-ledger.json`, and the cleanup board starts at #7967.

## How the check works

- **A tracked file in a class that the ledger does not list fails.** That is new company content: put it in its destination instead.
- **A ledger entry whose file is gone also fails.** A change that moves a directory out runs `node scripts/check-public-surface.mjs --prune` in the same diff, so the ledger only shrinks.
- **Nothing adds entries automatically.** Growing the ledger is a reviewed hand edit.

## What the check does not see

- **Git history.** Moving a file does not remove it from public history, and the history is not rewritten.
- **Text inside product files**, such as an internal hostname or an account identifier in a comment. `check:forbidden-names` and gitleaks cover text, each for its own stated set.
- **Commercial code outside `ee/`.** That is `check:open-core`'s question.
- **A new kind of company content.** The classes are a hand-written list. When something new appears, add a class.
