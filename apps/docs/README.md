# apps/docs

Alethia's user-facing documentation — Next.js 16 + Fumadocs + fumadocs-mdx. Content lives in
`apps/docs/content/docs/`, routed by `apps/docs/app/(docs)/[[...slug]]/page.tsx`.

The docs site runs on the sandbox box like everything else (`pnpm env:up`); see
[`CLAUDE.md`](../../CLAUDE.md). The prose bar below is enforced by the
`Docs prose (Vale · Diátaxis + plain-language)` required check, so read it before writing.

## Writing docs (the style bar)

Docs follow **Diátaxis** for structure and a plain-language style guide for prose. The
`alethia-docs` skill (`.claude/skills/alethia-docs`) is the authoring/review companion; this
section is the human summary.

### Structure — pick the Diátaxis type

Every page is one of four kinds, and they don't mix:

| Type            | Answers                       | Alethia examples                        |
| --------------- | ----------------------------- | --------------------------------------- |
| **Tutorial**    | "teach me, start to finish"   | a first-project walkthrough             |
| **How-to**      | "help me do X"                | `cli/`, `self-hosting/` task pages      |
| **Reference**   | "tell me the facts"           | config keys, the control catalog        |
| **Explanation** | "help me understand"          | `concepts/` (pipeline, domain model)    |

### Prose — plain language (STE-informed)

- Active voice, present tense.
- One instruction per numbered step; imperative mood for procedures.
- Short sentences (aim under ~25 words).
- One term = one meaning; use the canonical product spellings (Kubernetes not k8s, OpenTofu
  not Open Tofu, ArgoCD not Argo CD).
- Required frontmatter: `title` + `description`. Register new pages in the section `meta.json`.

### Lint it before you PR

Prose is linted by [Vale](https://vale.sh) — Google's dev-docs style plus a small Alethia
delta (`styles/Alethia/`). Vale checks prose only; it ignores fenced code, code spans, URLs,
and JSX components.

```bash
brew install vale          # macOS; see vale.sh/docs for other OSes
npm i -g mdx2vast          # the MDX preprocessor Vale needs on $PATH
pnpm -F docs lint:prose    # runs `vale content`
```

The `docs-prose` CI job runs the same lint on any `apps/docs/**` change. It **fails only on
error-level alerts** — a wrong product name (the `Alethia.Terminology` rule). Plain-language
swaps and "avoid *will*/*we*" surface as non-blocking warnings; long-sentence nudges are
suggestions (hidden by default — see them with `vale --minAlertLevel=suggestion content`).

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [Fumadocs](https://fumadocs.dev) - learn about Fumadocs
