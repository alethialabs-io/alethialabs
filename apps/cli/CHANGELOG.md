# Changelog

## [0.7.0](https://github.com/alethialabs-io/alethialabs/compare/cli-v0.6.1...cli-v0.7.0) (2026-09-24)


### Features

* **auth:** the CLI device screen names what it hands over, and "This isn't me" now denies it ([#4035](https://github.com/alethialabs-io/alethialabs/issues/4035)) ([cc6489a](https://github.com/alethialabs-io/alethialabs/commit/cc6489aa31e07260a0e7e4e288740489ff0a026c))
* **brand:** every token projected, lossy or refused — gen:go-brand with a no-silent-gap guard ([#3697](https://github.com/alethialabs-io/alethialabs/issues/3697)) ([93668e1](https://github.com/alethialabs-io/alethialabs/commit/93668e1f02754dee6db2b139a27d5a79225836f5)), closes [#3668](https://github.com/alethialabs-io/alethialabs/issues/3668)
* **cli:** --org becomes a real global, and the provider routes obey it ([#4029](https://github.com/alethialabs-io/alethialabs/issues/4029)) ([778f8bc](https://github.com/alethialabs-io/alethialabs/commit/778f8bc04f7ffc3a66b483e31db5c042498dbcb9))
* **cli:** `alethia init` writes the file and `alethia up` runs the whole path ([#4322](https://github.com/alethialabs-io/alethialabs/issues/4322)) ([ab73135](https://github.com/alethialabs-io/alethialabs/commit/ab73135e2d1ddfea2a09a8a4c70c325fde542b71))
* **cli:** add cursor-paged inline table widget ([#4203](https://github.com/alethialabs-io/alethialabs/issues/4203)) ([6dc4de4](https://github.com/alethialabs-io/alethialabs/commit/6dc4de48ff9cfc5468644bafdb0b818415a88b56))
* **cli:** add install-aware self-update ([#3535](https://github.com/alethialabs-io/alethialabs/issues/3535)) ([fc86f99](https://github.com/alethialabs-io/alethialabs/commit/fc86f99abdab32db6844d97e9eac9605806b403e))
* **cli:** add shared field spec kit ([#4235](https://github.com/alethialabs-io/alethialabs/issues/4235)) ([73b4e7c](https://github.com/alethialabs-io/alethialabs/commit/73b4e7c01577f8330f770fd6c33b22fe0ceb5119))
* **cli:** alethia.yaml and `alethia apply` — the project as a file, no id or tuple leaves the terminal ([#4303](https://github.com/alethialabs-io/alethialabs/issues/4303)) ([e39703f](https://github.com/alethialabs-io/alethialabs/commit/e39703f623b8148a8539afdd1b84961236c1e1aa))
* **cli:** break-glass takes every field as a flag, and confirms what it is about to do ([#3832](https://github.com/alethialabs-io/alethialabs/issues/3832)) ([14b4511](https://github.com/alethialabs-io/alethialabs/commit/14b451129e23533692dbe9e74a0d8c54ce534bda))
* **cli:** check:cli-surface enforces its four counters at zero, and the empty allowlist is deleted ([#4835](https://github.com/alethialabs-io/alethialabs/issues/4835)) ([53c4068](https://github.com/alethialabs-io/alethialabs/commit/53c4068d3f0a61a6b30655ae4b1fe74042c27376)), closes [#3664](https://github.com/alethialabs-io/alethialabs/issues/3664)
* **cli:** connectors take every field as a flag, and no id is copied between commands ([#3737](https://github.com/alethialabs-io/alethialabs/issues/3737)) ([fe7ed4b](https://github.com/alethialabs-io/alethialabs/commit/fe7ed4bf7aeeb315f6ad073a69c19fa7ddfd8038))
* **cli:** deep links built over the console's own route tree, not a string literal ([#4308](https://github.com/alethialabs-io/alethialabs/issues/4308)) ([d318a5d](https://github.com/alethialabs-io/alethialabs/commit/d318a5d7598961fba1d00d16a54ef1b06c5dca49))
* **cli:** login asks --force's question when a session exists, and component kinds stops inheriting flags it never read ([#4820](https://github.com/alethialabs-io/alethialabs/issues/4820)) ([5e3e4f5](https://github.com/alethialabs-io/alethialabs/commit/5e3e4f52cae02cbc79c8231d35b6f31624cec4ef))
* **cli:** one field spec behind the auth group's flags, forms and docs ([#3745](https://github.com/alethialabs-io/alethialabs/issues/3745)) ([5eee3b3](https://github.com/alethialabs-io/alethialabs/commit/5eee3b3c200fef13bd3e0d5381f639a41c346f78))
* **cli:** project design apply confirms only when the plan would DELETE ([#3782](https://github.com/alethialabs-io/alethialabs/issues/3782)) ([ade88e4](https://github.com/alethialabs-io/alethialabs/commit/ade88e4c150baf28c2f9780ca6dcca5b9c18ee35)), closes [#3699](https://github.com/alethialabs-io/alethialabs/issues/3699)
* **cli:** project plan/apply take a runner NAME, and apply resolves its own latest PLAN ([#4569](https://github.com/alethialabs-io/alethialabs/issues/4569)) ([38c714e](https://github.com/alethialabs-io/alethialabs/commit/38c714ecc27384e19617a8c58ad6310040c135de))
* **cli:** runners take every field as a flag, and no id is copied between commands ([#3785](https://github.com/alethialabs-io/alethialabs/issues/3785)) ([6780316](https://github.com/alethialabs-io/alethialabs/commit/6780316e9591657eaa07ffa78e663198df83a6e7))
* **cli:** the addon and agent groups stop asking for a copied id ([#3786](https://github.com/alethialabs-io/alethialabs/issues/3786)) ([340bc12](https://github.com/alethialabs-io/alethialabs/commit/340bc12286d4a321f7afbe7d1cf10fda3131b208)), closes [#3710](https://github.com/alethialabs-io/alethialabs/issues/3710)
* **cli:** the BYO-IaC group asks, and stops handing ids and URLs between commands ([#3801](https://github.com/alethialabs-io/alethialabs/issues/3801)) ([1ceebfc](https://github.com/alethialabs-io/alethialabs/commit/1ceebfc45c1701295016bce94e8679b3a409e404))
* **cli:** the census [#3664](https://github.com/alethialabs-io/alethialabs/issues/3664) flips does not exist, so build it — reporting, with all four counters refusing a zero ([#4378](https://github.com/alethialabs-io/alethialabs/issues/4378)) ([d4074c2](https://github.com/alethialabs-io/alethialabs/commit/d4074c2f3acb7fa3718da9757c8ffdf40f86dc93))
* **cli:** the clusters group gets a form, one money rule, and a docs page that is checked ([#3738](https://github.com/alethialabs-io/alethialabs/issues/3738)) ([7122cd8](https://github.com/alethialabs-io/alethialabs/commit/7122cd86d4ba4bd070c73efe42b1418b830e40b6))
* **cli:** the governance group stops asking for a copied id, and its docs are checked ([#3814](https://github.com/alethialabs-io/alethialabs/issues/3814)) ([de5b9bd](https://github.com/alethialabs-io/alethialabs/commit/de5b9bd4b150c21e0d9d7bc0166407150ede28d6))
* **cli:** the jobs group stops asking for a copied id ([#3740](https://github.com/alethialabs-io/alethialabs/issues/3740)) ([56f0aac](https://github.com/alethialabs-io/alethialabs/commit/56f0aac702b4cecf73ad667f7a6bf325487f5ddd))
* **cli:** the last field of `grants add` is picked from its kind's live list, not typed ([#4572](https://github.com/alethialabs-io/alethialabs/issues/4572)) ([f6be142](https://github.com/alethialabs-io/alethialabs/commit/f6be142763524513c210125af63b5fa1444efe48))
* **cli:** the last four leaves that took input with no way to be asked ([#4539](https://github.com/alethialabs-io/alethialabs/issues/4539)) ([3d92ebf](https://github.com/alethialabs-io/alethialabs/commit/3d92ebf522598493d36d1b50dafcf41ada5477bc)), closes [#4454](https://github.com/alethialabs-io/alethialabs/issues/4454)
* **cli:** the org group takes a name where it took a copied id ([#3807](https://github.com/alethialabs-io/alethialabs/issues/3807)) ([faef3f6](https://github.com/alethialabs-io/alethialabs/commit/faef3f65e9f1348abd2181c43dd44b5293ef35ca))
* **cli:** the project group asks instead of demanding a hand-assembled tuple ([#3748](https://github.com/alethialabs-io/alethialabs/issues/3748)) ([679e0cf](https://github.com/alethialabs-io/alethialabs/commit/679e0cffcd0466227be55f6878b146eb08bb71db))
* **cli:** the verify group stops asking for a copied id ([#3784](https://github.com/alethialabs-io/alethialabs/issues/3784)) ([d6be75f](https://github.com/alethialabs-io/alethialabs/commit/d6be75f1ea50981548ae881dcf44f622b29da6af))


### Bug Fixes

* **cli:** [#3941](https://github.com/alethialabs-io/alethialabs/issues/3941)'s stream stub never reached the gate it was written for ([#4020](https://github.com/alethialabs-io/alethialabs/issues/4020)) ([98e1f6e](https://github.com/alethialabs-io/alethialabs/commit/98e1f6e11823cc6d3ec325436ae00ca9dbd1521d)), closes [#3912](https://github.com/alethialabs-io/alethialabs/issues/3912)
* **cli:** a script reading -o csv gets the wire value, not the cell a person reads ([#4193](https://github.com/alethialabs-io/alethialabs/issues/4193)) ([40dc42f](https://github.com/alethialabs-io/alethialabs/commit/40dc42f66db173eb61047e21df3e0e4122dff341)), closes [#4033](https://github.com/alethialabs-io/alethialabs/issues/4033)
* **cli:** alerts create posts the severity it matched, not the one you typed ([#4076](https://github.com/alethialabs-io/alethialabs/issues/4076)) ([8d55607](https://github.com/alethialabs-io/alethialabs/commit/8d556076278399f8e33aafcead1f8f5c625f45b6))
* **cli:** emit wire values for remaining csv rows ([#4205](https://github.com/alethialabs-io/alethialabs/issues/4205)) ([b2e1f20](https://github.com/alethialabs-io/alethialabs/commit/b2e1f20747d1a43386680928203e0773a6f09c57))
* **cli:** one absolute date, one rounding rule, one dash — the render sweep [#3659](https://github.com/alethialabs-io/alethialabs/issues/3659) named ([#4034](https://github.com/alethialabs-io/alethialabs/issues/4034)) ([e53d4f0](https://github.com/alethialabs-io/alethialabs/commit/e53d4f0cd85b570abe2b46fee1f9fed9902d7d6b))
* **cli:** render billing-group money and minutes through packages/core/format ([#3736](https://github.com/alethialabs-io/alethialabs/issues/3736)) ([9c725a7](https://github.com/alethialabs-io/alethialabs/commit/9c725a74c78982d13f8bc9f024da85d8a4227922))
* **cli:** send canonical enum values ([#3910](https://github.com/alethialabs-io/alethialabs/issues/3910)) ([f793fdd](https://github.com/alethialabs-io/alethialabs/commit/f793fdd5d104726bafc2a8ba94fa074ae2a037ca))
* **cli:** the grants comments stop saying the wire accepts any resource_type ([#4789](https://github.com/alethialabs-io/alethialabs/issues/4789)) ([931828b](https://github.com/alethialabs-io/alethialabs/commit/931828be36c073f4142dffe5d7872453bf253d0f))
* **cli:** the prompt gate and the spinner were writing to the wrong streams ([#3847](https://github.com/alethialabs-io/alethialabs/issues/3847)) ([69a52fc](https://github.com/alethialabs-io/alethialabs/commit/69a52fc1248fbb4307aa3c6ddc57a78317d41544))
* **cli:** the token refresh leaves the document alone, and the login confirm stops drawing where it cannot be seen ([#3912](https://github.com/alethialabs-io/alethialabs/issues/3912)) ([#3941](https://github.com/alethialabs-io/alethialabs/issues/3941)) ([c54a299](https://github.com/alethialabs-io/alethialabs/commit/c54a2999f5f96ee117b217d034e7d391a48c4e4d))
* **cli:** three destructive commands had no confirmation, and the test that would have caught them walked a hand-written list ([#3683](https://github.com/alethialabs-io/alethialabs/issues/3683)) ([6130c17](https://github.com/alethialabs-io/alethialabs/commit/6130c1714f3d1107ef78b10cca409706ebaabc61))

## [0.6.1](https://github.com/alethialabs-io/alethialabs/compare/cli-v0.6.0...cli-v0.6.1) (2026-08-30)


### Bug Fixes

* **fabric:** a create-matrix with shared placements built a project that could never apply ([#3345](https://github.com/alethialabs-io/alethialabs/issues/3345)) ([203a655](https://github.com/alethialabs-io/alethialabs/commit/203a65519a1ec821d1cbc7e4fb11e9eadb8bb3cc))

## [0.6.0](https://github.com/alethialabs-io/alethialabs/compare/cli-v0.5.0...cli-v0.6.0) (2026-08-29)


### Features

* **cli:** service-account tokens — `alethia` can finally run without a browser ([#2786](https://github.com/alethialabs-io/alethialabs/issues/2786)) ([c9740a3](https://github.com/alethialabs-io/alethialabs/commit/c9740a397b251aa50ea2e3c902604d99ddf65d04))


### Bug Fixes

* **cli:** remove --git-credential-id, and tell the user what actually authorizes a private clone ([#3211](https://github.com/alethialabs-io/alethialabs/issues/3211)) ([56d71fc](https://github.com/alethialabs-io/alethialabs/commit/56d71fc908b17028dbbe5ebaca8f7aaadebf9ea3)), closes [#2788](https://github.com/alethialabs-io/alethialabs/issues/2788)

## [0.5.0](https://github.com/alethialabs-io/alethialabs/compare/cli-v0.4.0...cli-v0.5.0) (2026-08-11)


### Features

* **ci:** arm the Go coverage ratchet, and revive both badges that have been dead since July ([#2001](https://github.com/alethialabs-io/alethialabs/issues/2001)) ([fa093c2](https://github.com/alethialabs-io/alethialabs/commit/fa093c2436f685b9ffa6db387130ac459de248e9))
* **cli:** `alethia verify receipt` — the signed evidence receipt, from the terminal ([#2341](https://github.com/alethialabs-io/alethialabs/issues/2341)) ([8f4cb1b](https://github.com/alethialabs-io/alethialabs/commit/8f4cb1b36c99b470c5df0ad3d29807560c373928))
* **cli:** addon enable / disable — the marketplace becomes scriptable ([#2319](https://github.com/alethialabs-io/alethialabs/issues/2319)) ([ed13b9a](https://github.com/alethialabs-io/alethialabs/commit/ed13b9a9aaf72309b6123c2c26e923fd295626b1))
* **cli:** alethia connector hetzner — the one cloud you had to leave the terminal for ([#2316](https://github.com/alethialabs-io/alethialabs/issues/2316)) ([6f52901](https://github.com/alethialabs-io/alethialabs/commit/6f5290149fcc04b4c4a7bcf07e1a3d0663b846b2))
* **cli:** alethia runner register — and harden the last route on the raw CLI seam ([#2317](https://github.com/alethialabs-io/alethialabs/issues/2317)) ([1fbb6ad](https://github.com/alethialabs-io/alethialabs/commit/1fbb6ad97c08589343ebc79f71633c6626fc89a7))
* **cli:** attach, scan and detach your own charts and IaC from the terminal ([#2321](https://github.com/alethialabs-io/alethialabs/issues/2321)) ([f81fdb6](https://github.com/alethialabs-io/alethialabs/commit/f81fdb692de467ef38de31e5ea73d6b59d81e5d1))
* **cli:** author components per ENVIRONMENT — and stop a remove destroying the sibling tier ([#2309](https://github.com/alethialabs-io/alethialabs/issues/2309)) ([7f96ec3](https://github.com/alethialabs-io/alethialabs/commit/7f96ec320a2f0bdededafd964ccf699cce24ed05))
* **cli:** placement from the terminal — a two-tier project stops costing two clusters ([#2313](https://github.com/alethialabs-io/alethialabs/issues/2313)) ([b09c6ac](https://github.com/alethialabs-io/alethialabs/commit/b09c6ac1bc1f3a587a309cf223ef399d4419303d))


### Bug Fixes

* **alibaba:** withdraw the WAF offer — the WAF 3.0 instance is account-scoped and a project cannot own it ([#1841](https://github.com/alethialabs-io/alethialabs/issues/1841)) ([#1970](https://github.com/alethialabs-io/alethialabs/issues/1970)) ([675745e](https://github.com/alethialabs-io/alethialabs/commit/675745e91eac59811eadae45b878e273d5c492f5))
* **auth:** require explicit approval for the CLI device flow, and bound, expire and secure the credential path ([#2233](https://github.com/alethialabs-io/alethialabs/issues/2233)) ([d05a1c9](https://github.com/alethialabs-io/alethialabs/commit/d05a1c958faa29474ac51c6ae4cd91f70978914c))
* **cli:** honour --no-input in confirm() and add an explicit --yes to the destructive commands ([#2239](https://github.com/alethialabs-io/alethialabs/issues/2239)) ([f5ca7ed](https://github.com/alethialabs-io/alethialabs/commit/f5ca7ed6182b98c55edd56d9f1f03abd07b7276c))
* **cli:** measure the coverage gate off the profile, not `go tool cover -func` ([#2275](https://github.com/alethialabs-io/alethialabs/issues/2275)) ([7a7fd4d](https://github.com/alethialabs-io/alethialabs/commit/7a7fd4db04322163ef3603d41471aeb8dea6cd4c)), closes [#1990](https://github.com/alethialabs-io/alethialabs/issues/1990)
* **runners:** the deploy form offered clouds whose runner templates do not exist ([#1817](https://github.com/alethialabs-io/alethialabs/issues/1817)) ([b4dae57](https://github.com/alethialabs-io/alethialabs/commit/b4dae5761655838105b4b768674c1094397acf63)), closes [#1794](https://github.com/alethialabs-io/alethialabs/issues/1794)
* **ui:** align table headers, neutralise newlines in cells, and stop swallowing write errors ([#2224](https://github.com/alethialabs-io/alethialabs/issues/2224)) ([4a77a9d](https://github.com/alethialabs-io/alethialabs/commit/4a77a9d75a11f32c3b7322f0c85937de846867d9))

## [0.4.0](https://github.com/alethialabs-io/alethialabs/compare/cli-v0.3.0...cli-v0.4.0) (2026-07-30)


### Features

* **runner:** scan BYO charts pulled from an OCI registry ([#1300](https://github.com/alethialabs-io/alethialabs/issues/1300)) ([#1313](https://github.com/alethialabs-io/alethialabs/issues/1313)) ([e18d171](https://github.com/alethialabs-io/alethialabs/commit/e18d171088f0792fc1bb4fc7a65713acc48eb6d4))


### Bug Fixes

* **fleet:** `fleet set` creates a pool when the provider has none (upsert) ([#871](https://github.com/alethialabs-io/alethialabs/issues/871)) ([8a5510c](https://github.com/alethialabs-io/alethialabs/commit/8a5510c57715669d79aee86cbc32746071c0ed19))

## [0.3.0](https://github.com/alethialabs-io/alethialabs/compare/cli-v0.2.1...cli-v0.3.0) (2026-07-19)


### Features

* **breakglass:** audited, gated, blast-radius-bounded privileged recovery backend + CLI ([#364](https://github.com/alethialabs-io/alethialabs/issues/364)) ([d001598](https://github.com/alethialabs-io/alethialabs/commit/d001598b293bdf75190d54ed719ee29b61fd6e8e))
* **cli:** addon/chart/iac project-source commands ([#828](https://github.com/alethialabs-io/alethialabs/issues/828)) ([62ea144](https://github.com/alethialabs-io/alethialabs/commit/62ea14453586cb4414ab7ca112c6942a34e4c36c))
* **cli:** broaden install channels (Scoop, deb/rpm/apk) + wire get.alethialabs.io ([#359](https://github.com/alethialabs-io/alethialabs/issues/359)) ([7c18ce9](https://github.com/alethialabs-io/alethialabs/commit/7c18ce907a1babfb785bd38a56190036dd537ddc))
* **cli:** cloud-inventory + org-settings + agent commands ([#830](https://github.com/alethialabs-io/alethialabs/issues/830)) ([d4901bb](https://github.com/alethialabs-io/alethialabs/commit/d4901bbf41a492e8eacb30ee9fafe247a6369fde))
* **cli:** drift + cost project posture commands ([#825](https://github.com/alethialabs-io/alethialabs/issues/825)) ([462de90](https://github.com/alethialabs-io/alethialabs/commit/462de9098fd595bbf5c943553adb76be9cd0ead5))
* **cli:** fix Homebrew release pipeline + surface richer data in CLI UI ([#351](https://github.com/alethialabs-io/alethialabs/issues/351)) ([9bcfc17](https://github.com/alethialabs-io/alethialabs/commit/9bcfc17f5080016f79928e9d55b56fcd8669a6ac))
* **cli:** make ArgoCD legible on the CLI — cluster get/list + GitOps sync/health ([#785](https://github.com/alethialabs-io/alethialabs/issues/785)) ([d22e6d9](https://github.com/alethialabs-io/alethialabs/commit/d22e6d971106c90cd32eef08f4d5ee753a2c1af6))
* **cli:** promotion + staged delivery-pipeline commands ([#829](https://github.com/alethialabs-io/alethialabs/issues/829)) ([df4879f](https://github.com/alethialabs-io/alethialabs/commit/df4879f5b0582fcb2a4dec5796431ce57b93a418))
* **cli:** protection + probes environment-state commands ([#826](https://github.com/alethialabs-io/alethialabs/issues/826)) ([b2fc041](https://github.com/alethialabs-io/alethialabs/commit/b2fc0410dffeee546c2862e7cf173c29b4305053))
* **cli:** repo/provider/config-export commands + verify wire fix ([#822](https://github.com/alethialabs-io/alethialabs/issues/822)) ([dbcc7e8](https://github.com/alethialabs-io/alethialabs/commit/dbcc7e899c1e81a20f8f01d5e4fe4688126eccf2))
* **connectors:** Alibaba cloud-shell setup script + UI tab + CLI flow ([#448](https://github.com/alethialabs-io/alethialabs/issues/448)) ([9e12fee](https://github.com/alethialabs-io/alethialabs/commit/9e12fee72acdc56191b5002d3e0cf73027f240c5))
* **connectors:** AWS cloud-shell setup script + UI tab + CLI flow ([#451](https://github.com/alethialabs-io/alethialabs/issues/451)) ([76ee574](https://github.com/alethialabs-io/alethialabs/commit/76ee5746d1a1b556e7c5ce941a3b21d775183ae5))
* **db:** add PROBE_CLUSTER job kind + environment_probes history table (BYOC B2.1) ([#449](https://github.com/alethialabs-io/alethialabs/issues/449)) ([c7e6732](https://github.com/alethialabs-io/alethialabs/commit/c7e6732957b8e4fa7d7c7fcf3829523e65095023))
* **fabric:** W-g1 CLI --env — target a specific environment on plan/apply/destroy ([#843](https://github.com/alethialabs-io/alethialabs/issues/843)) ([#863](https://github.com/alethialabs-io/alethialabs/issues/863)) ([6b745ab](https://github.com/alethialabs-io/alethialabs/commit/6b745ab2740e541124cdb3ad674c624d5ae033cd))
* **observability:** OpenTelemetry traces + metrics on the traceparent substrate ([#346](https://github.com/alethialabs-io/alethialabs/issues/346)) ([cf8caf8](https://github.com/alethialabs-io/alethialabs/commit/cf8caf8595900dfb10657a6756849d5c077b7708))
* **services:** W2 [#0](https://github.com/alethialabs-io/alethialabs/issues/0) seam — resolved_image output field + BUILD job kind + result contract ([#597](https://github.com/alethialabs-io/alethialabs/issues/597)) ([73650f4](https://github.com/alethialabs-io/alethialabs/commit/73650f4116e7857ac23c2d1ece400fbda0ef653a))


### Bug Fixes

* **ci:** make Go modules tidy standalone + fix the CLI mirror sync ([#851](https://github.com/alethialabs-io/alethialabs/issues/851)) ([65c7406](https://github.com/alethialabs-io/alethialabs/commit/65c74067762c2c26002181c8d6c7dc973d5e4470))
* **connectors:** deliver Azure platform app id to browser + CLI at runtime ([#423](https://github.com/alethialabs-io/alethialabs/issues/423)) ([93b0f74](https://github.com/alethialabs-io/alethialabs/commit/93b0f74301d856c1a09b05bd254dbbe40cde9820))
