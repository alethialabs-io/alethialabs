# Contributor docs

How Alethia is built, for people changing it. User-facing documentation lives in `apps/docs`
(published at https://alethialabs.io/docs); these pages moved out of it in #5240 because no one
*using* Alethia needs them.

| Page | What it covers |
| --- | --- |
| [console-internals.md](./console-internals.md) | The console's stack and its client-state stores |
| [database-schema.md](./database-schema.md) | The console's tables and their columns |
| [runner-apis.md](./runner-apis.md) | The HTTP API the runner calls on the console |
| [runner-internals.md](./runner-internals.md) | The runner's code map, queue recovery and the fleet scaler |
| [authorization.md](./authorization.md) | The authorization layer's internals and the open-core boundary |
| [elench.md](./elench.md) | The verification engine, adding controls, and the agent harness |
| [core-library.md](./core-library.md) | The `packages/core` Go library, package by package |
| [cli-tui.md](./cli-tui.md) | The CLI's terminal UI components |
| [release-system.md](./release-system.md) | Builds, releases and the CI/CD pipeline |
| [homebrew-core.md](./homebrew-core.md) | Submitting the CLI to Homebrew core |
| [releasing-packages.md](./releasing-packages.md) | Publishing the shared packages to npm as `@alethialabs/*`: changesets, the Version packages PR, trusted publishing |
| [control-plane-ci.md](./control-plane-ci.md) | The `infra-cp-*` workflows and the secrets each needs |
| [marketing-site.md](./marketing-site.md) | Running and configuring the marketing site |
| [testing.md](./testing.md) | Engineering quality and testing practice |

For the component map, start at [ARCHITECTURE.md](../../ARCHITECTURE.md). For the testing bar,
[TESTING.md](../../TESTING.md).
