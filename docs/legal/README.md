# The legal set

This directory holds Alethia's internal legal records. The public legal pages live in
`apps/marketing/app/`, and the constants they render from live in `packages/legal/src/`.

**No lawyer has reviewed any of it.** By the maintainer's decision of 2026-11-17, agents write and
audit the whole legal set. That is why the register below exists: where nobody outside checks the
text, the text has to be checkable against the code.

Three things stay the maintainer's and are not drafted here: signing the vendor data-processing
agreements, any tax registration, and the live Stripe account.

## The register: `legal-set.json`

[`legal-set.json`](legal-set.json) is one file with three lists.

| List | What an entry is |
|---|---|
| `documents` | A legal page or record: where it lives, whether it is hash-sealed, its version, and the board unit that owns its audit |
| `claims` | A statement quoted from a document, tied to the code or configuration that makes it true |
| `findings` | A statement quoted from a document that the code does not bear out, waiting for the unit that owns it |

`node scripts/check-legal-set.mjs` checks all three and runs in CI. To read the register as a table,
with the claims and the open findings under it:

```sh
node scripts/check-legal-set.mjs --print
```

This file does not repeat the table, the claims or the findings. A second copy would go stale and
nothing would report it.

## Documents

Each entry has these fields.

| Field | Meaning |
|---|---|
| `id` | Stable name. Claims and findings refer to it |
| `kind` | `public-page`, `internal-record`, `repository-file` or `source-module` |
| `route` | The public path, or `null` |
| `source` | The file, relative to the repository root |
| `status` | `current`, or `planned` for a document a board unit is still to write |
| `sealed` | `true` when the document is in `LEGAL_DOCUMENTS` in `packages/legal/src/documents.ts` |
| `version` | For a sealed document, the registry's version. Otherwise the date the document shows |
| `displayedDate` | The date the document shows its reader: `lastUpdated` on a page, `Effective:` in a record |
| `contentHash` | For a sealed document, the registry's hash. Otherwise `null` |
| `owner` | The board unit that audits it, or `null` with an `ownerNote` saying why no unit does |

`version`, `displayedDate` and `contentHash` are copies. The check fails when one differs from its
source, and this command rewrites them:

```sh
node scripts/check-legal-set.mjs --sync
```

So a re-seal is two commands: `node scripts/check-legal-document-hashes.mjs --seal`, then `--sync`.

"Sealed" here means the four documents in `LEGAL_DOCUMENTS`. The contributor agreements in `cla/`
have their own seal in `cla/DOCUMENTS.json` and their own check.

### What must be registered

The check derives what exists from three places, and fails when any of it is missing from the
register:

1. every route in the `DOCUMENTS` index of `apps/marketing/components/legal/legal-shell.tsx`;
2. every document in `LEGAL_DOCUMENTS`;
3. every `.md` file directly in this directory, except this one.

It fails in the other direction too: a `current` entry whose file is gone, and a `planned` entry
whose file now exists.

A legal page that is in none of those three places is not seen. Entries of kind `repository-file`
and `source-module` were added by hand, so that list is as complete as its author's search and no
more.

## Claims

A claim ties a sentence on a page to what makes it true.

```json
{
	"id": "privacy.retention.job-logs",
	"document": "privacy",
	"kind": "retention",
	"status": "tied",
	"quote": "Provisioning job logs: 30 days by default.",
	"evidence": [
		{
			"path": "apps/console/lib/retention/registry.ts",
			"pattern": "jobLogs: 30,",
			"shows": "The published default window for job logs is 30 days."
		}
	],
	"owner": "LEG-L1",
	"verifiedOn": "2026-11-17"
}
```

| Field | Rule |
|---|---|
| `quote` | Copied from the document's **source file**, not from the rendered page. Line breaks and indentation do not matter; every other character does |
| `kind` | `retention`, `consent`, `device-storage`, `subprocessor`, `security`, `entity`, `commerce`, `ai` or `other` |
| `status` | `tied` or `outside-repo` |
| `evidence` | A list of `{ path, pattern, shows }`. `pattern` is a JavaScript regular expression that must match the file. `shows` says, in a sentence, what the match proves |
| `requires` | Only on `outside-repo`: what would settle the claim, and where it is held |
| `verifiedOn` | The date someone last read the quote and the evidence together |

The check fails when the quote is no longer in the document, and when a pattern no longer matches
its file. The first means the page changed; the second means the code did. Either way a person has
to read both again.

### `tied` and `outside-repo`

A `tied` claim needs at least one evidence item. Use it when the repository settles the statement.

Use `outside-repo` when it does not: a value in the production vault, a setting in a provider's
dashboard, a signed agreement. Such a claim says in `requires` what would settle it. It is never
counted as tied, and the check's summary line reports the two counts separately. Do not mark a
claim `tied` because the example configuration agrees with the page; the example is not what runs.

### Writing evidence that means something

The check proves the words are on the page and the pattern is in the file. It cannot tell whether
the pattern carries the statement. That judgement is the author's and the reviewer's, and `shows`
is where it is written down. Three rules:

- **Point at what enforces, not at what repeats.** For "logs are deleted after 30 days", a constant
  named `30` is half of it. The other half is the code that passes that constant to the thing that
  deletes. Give both.
- **Anchor the pattern.** `"30"` matches anything. `jobLogs: 30,` matches one line. The check
  refuses a pattern shorter than eight characters and one that matches the empty string.
- **Keep a multi-line pattern inside its block.** To say that the party with `id: "stripe"` has
  `status: "active"`, use a pattern that cannot run on into the next party. The seeded
  `privacy.subprocessor.stripe` claim shows one way.

A page with no claims is unexamined, not clean. The register does not know how many statements a
page makes.

## Findings

A finding records a statement the code does not bear out. It names the unit that owns the document;
that unit corrects the page or the code. This unit corrected nothing.

```json
{
	"id": "privacy-requests.replay-consent",
	"document": "privacy-requests",
	"quote": "can change analytics and replay consent immediately",
	"says": "The page says a visitor can change a replay consent.",
	"actually": "There is no replay consent. …",
	"evidence": [],
	"owner": "LEG-L1",
	"foundOn": "2026-11-17"
}
```

`quote` follows the same rule as a claim's. It may be `null` when the finding is that something is
missing. Evidence is optional, and has a second form for that case: `{ path, absent, shows }`, where
the pattern must **not** match the file.

A finding is removed when it is fixed; Git keeps the history. The check enforces this. When the
quote leaves the page, or an `absent` pattern starts to match, the finding no longer reproduces and
the check fails until someone removes or rewrites it.

The findings seeded on 2026-11-17 came from writing the first claims and from reading
`TAX_MARKET_PRECONDITIONS.md`. They are what was noticed, not the result of an audit: the audit is
LEG-L1's. The three marked "Flagged by the tax research" are the points that document raises
against the decisions of 2026-11-17 and against `PAID_MARKETS.md`.

## For a unit that changes a legal document

1. Change the document.
2. Run `node scripts/check-legal-set.mjs`. It names every claim and finding your change touched.
3. For each one, read the statement and the code again. Update the quote, re-point the evidence, or
   remove the entry. Set `verifiedOn` to the day you did.
4. If you added a document, add its entry. If you wrote a `planned` one, set it to `current`.
5. If you changed a sealed document, re-seal it, then run `--sync`.
6. Add a claim for each statement of fact you wrote or checked.

## What the check does not do

- It does not find statements. Only the ones somebody entered are checked.
- It does not judge meaning. A well-anchored pattern on the wrong line passes.
- It does not read anything outside the repository.
- It does not see a public legal page outside the three places listed under "What must be
  registered".

`node scripts/check-legal-set.mjs --self-test` breaks a small in-memory copy of the register in
each way the check claims to catch, and fails if any of them passes.
