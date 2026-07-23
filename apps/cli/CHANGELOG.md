# Changelog

## [0.3.1](https://github.com/alethialabs-io/alethialabs/compare/cli-v0.3.0...cli-v0.3.1) (2026-07-23)


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
