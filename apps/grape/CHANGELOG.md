# Changelog

## [0.2.1](https://github.com/bobikenobi12/bb-thesis-2026/compare/grape-v0.2.0...grape-v0.2.1) (2026-06-15)


### Bug Fixes

* **grape:** change default URL to beta.adp.itgix.com ([25b2f42](https://github.com/bobikenobi12/bb-thesis-2026/commit/25b2f42b46f093d8027fdf6f3d56b74451575d25))
* **grape:** use unstyled status symbols in table cells ([da63824](https://github.com/bobikenobi12/bb-thesis-2026/commit/da6382432882897ee3dfc711cff316cb6d6f30fa))
* **grape:** use unstyled status symbols in table cells ([cf4a1fc](https://github.com/bobikenobi12/bb-thesis-2026/commit/cf4a1fc5a261f6aa2cfb2ef2a733e61377519469))

## [0.2.0](https://github.com/bobikenobi12/bb-thesis-2026/compare/grape-v0.1.7...grape-v0.2.0) (2026-06-03)


### Features

* add Azure cloud integration via federated identity credentials ([c39f052](https://github.com/bobikenobi12/bb-thesis-2026/commit/c39f052d8445e26ff74013445497451920d483af))
* add GCP cloud integration via Workload Identity Federation ([1d7efad](https://github.com/bobikenobi12/bb-thesis-2026/commit/1d7efadc76e43163d0fbbc857f02115d8040d4a2))
* AWS connection verification, provision button, log viewer improvements ([3c772d8](https://github.com/bobikenobi12/bb-thesis-2026/commit/3c772d8e440fb976c90d7bd54a6f18b55f2c6c21))
* **grape:** add DESTROY_WORKER job handler + save deploy metadata ([597202c](https://github.com/bobikenobi12/bb-thesis-2026/commit/597202c0f4a8765043cef68d1b95451ac13deb5e))
* **grape:** add pkg/ worker architecture + standalone worker binary ([a2fa14d](https://github.com/bobikenobi12/bb-thesis-2026/commit/a2fa14d66a9e6d601a7dc64d7d2ae214ac8c1e01))
* **grape:** redesign CLI — tendril/vine/vineyard commands, unified UI, tests ([1cc75bf](https://github.com/bobikenobi12/bb-thesis-2026/commit/1cc75bf4e859f379ceddf8a3b1a76f76126af7bc))
* pivot to GitOps with ArgoCD and Trellis-based bootstrap logging ([8c952ab](https://github.com/bobikenobi12/bb-thesis-2026/commit/8c952aba1a414b3d778216f462b6c9177765e4e1))
* proper semver versioning + enriched worker releases ([eedbe5d](https://github.com/bobikenobi12/bb-thesis-2026/commit/eedbe5d755decb0fefbe366a9f9b89d476548b93))
* smart resource caching + Azure resource fetching ([724982d](https://github.com/bobikenobi12/bb-thesis-2026/commit/724982dbf9ab68f4d8da0c3fc6b9175c3adc9925))
* **trellis:** show cluster admins selector for all cloud providers ([94c373f](https://github.com/bobikenobi12/bb-thesis-2026/commit/94c373fdd231919d0cf074ebc2c7ca96c078e643))
* **trellis:** sidebar overhaul, Jobs page, Vineyards list, config form components ([d685d80](https://github.com/bobikenobi12/bb-thesis-2026/commit/d685d8009169988febe7d7772d6f801d39cf95fa))
* worker provisioning architecture — Fargate infra, job queue, UI, and spec docs ([e3dda58](https://github.com/bobikenobi12/bb-thesis-2026/commit/e3dda58fad5e755bfe86be87e6753686e72ad0d6))


### Bug Fixes

* **ci:** bump Go to 1.25 in release workflow, add Homebrew test block ([dead336](https://github.com/bobikenobi12/bb-thesis-2026/commit/dead336619150afa7a88c2f7cee72735c8e73beb))
* cloud_identities dedup + live AWS resource fetching ([100ce95](https://github.com/bobikenobi12/bb-thesis-2026/commit/100ce95d311ea5ef3e35cfbfb8b36e8109056013))
* **grape:** add Supabase S3 config to grape-worker binary, bump terraform to 1.15.5 ([571feee](https://github.com/bobikenobi12/bb-thesis-2026/commit/571feee571c4ba60852356a4b09bd5b2c27e1808))
* **grape:** update default web origin to adp.prod.itgix.eu ([17c9c1d](https://github.com/bobikenobi12/bb-thesis-2026/commit/17c9c1d43c7425e7ab079c805b6907251cf4b2ff))
* **infra:** stage templates-worker in CI and Dockerfile ([9fdc0e0](https://github.com/bobikenobi12/bb-thesis-2026/commit/9fdc0e0a1e0d1623c94de231f489ccdfa7881b5f))
