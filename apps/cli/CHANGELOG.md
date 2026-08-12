# Changelog

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
