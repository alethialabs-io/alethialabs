<!-- Moved out of the user docs (apps/docs, /get-started/the-console) by #5240: contributor material. -->

# Console internals

The console's stack and client-state stores. For the component map, see [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Server Actions) |
| Database | PostgreSQL + Drizzle ORM with org-scoped Row Level Security |
| Auth | Better Auth (social OAuth: GitHub, Google native; GitLab, Bitbucket genericOAuth; email 6-digit OTP) |
| Realtime | Postgres LISTEN/NOTIFY → SSE ([how it works](https://alethialabs.io/docs/concepts/realtime)) |
| Storage | S3-compatible storage (default SeaweedFS) for OpenTofu state and plan artifacts |
| UI | Tailwind CSS, shadcn/ui, Zustand state management |

## State Management

Server data lives in **TanStack Query** (React Query) — projects, jobs, runners, clusters, and cloud inventory are fetched, cached, and revalidated there. Zustand holds only **client-side UI and ephemeral state**: filter selections, and form/canvas working state. Key stores:

| Store | Purpose |
|-------|---------|
| `useWorkspaceStore` | The active organization the session is scoped to (drives the PDP + RLS) |
| `useCloudProviderStore` | Selected provider, cloud identity, and cached cloud-resource inventory |
| `useProjectsStore` | Starred (favorite) projects on the overview |
| `useJobsFilters` / `useRunnerFilters` | Filter selections for the jobs and runners lists |
| `useCanvasStore` | The Design-a-Project architecture graph (nodes and edges) |
| `useElenchStore` | Elench assistant UI state |
| `useNotificationsStore` | Read-notification ids |

Real-time job logs and support messages stream over SSE (Postgres LISTEN/NOTIFY). See [Real-time Architecture](https://alethialabs.io/docs/concepts/realtime) for details.
