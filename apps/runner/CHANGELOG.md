# Changelog

## [0.3.0](https://github.com/alethialabs-io/alethialabs/compare/runner-v0.2.0...runner-v0.3.0) (2026-07-23)


### Features

* **fabric:** namespace-placement keyless-mint dispatch seam ([#1013](https://github.com/alethialabs-io/alethialabs/issues/1013)) ([#1138](https://github.com/alethialabs-io/alethialabs/issues/1138)) ([5b870e8](https://github.com/alethialabs-io/alethialabs/commit/5b870e8ea90ea8f4e7b29250c3f3508a967f89bd))
* **fabric:** per-namespace cloud identity (AWS IRSA) for namespace placement (Closes [#957](https://github.com/alethialabs-io/alethialabs/issues/957)) ([#1029](https://github.com/alethialabs-io/alethialabs/issues/1029)) ([3cc73a7](https://github.com/alethialabs-io/alethialabs/commit/3cc73a7a62b2e5d1840ae08da9d46e664caa4635))
* **runner:** `registry-token` cross-account keyless registry refresher (B2/PR B) (Part of [#925](https://github.com/alethialabs-io/alethialabs/issues/925)) ([#1036](https://github.com/alethialabs-io/alethialabs/issues/1036)) ([fb77a43](https://github.com/alethialabs-io/alethialabs/commit/fb77a43e95c30d477342815a2bd65ee8dfc8c8dc))


### Bug Fixes

* **core,runner:** make git clone/pull cancellable via context ([#987](https://github.com/alethialabs-io/alethialabs/issues/987)) ([#1025](https://github.com/alethialabs-io/alethialabs/issues/1025)) ([efc55fe](https://github.com/alethialabs-io/alethialabs/commit/efc55fe94aae926d15c6389dc5af73c33d6ee543))
* **infracost:** checksum-verify, timeout, and config-driven version ([#983](https://github.com/alethialabs-io/alethialabs/issues/983)) ([3eca757](https://github.com/alethialabs-io/alethialabs/commit/3eca7570bef8478b977276db57e7959edcbbc968)), closes [#946](https://github.com/alethialabs-io/alethialabs/issues/946) [#950](https://github.com/alethialabs-io/alethialabs/issues/950)
* **runner,console:** stop persisting live runner_token at rest; re-mint on update ([#945](https://github.com/alethialabs-io/alethialabs/issues/945)) ([#1014](https://github.com/alethialabs-io/alethialabs/issues/1014)) ([8d9fcb0](https://github.com/alethialabs-io/alethialabs/commit/8d9fcb04be5d886e59ce0ec10fa8b0f2add4edb4))
* **runner:** ActivateTokenCloud restores a pre-existing token on cleanup ([#988](https://github.com/alethialabs-io/alethialabs/issues/988)) ([#1020](https://github.com/alethialabs-io/alethialabs/issues/1020)) ([f7cb0a7](https://github.com/alethialabs-io/alethialabs/commit/f7cb0a78cdd11829309ae8af984440574641241b))
* **runner:** cross-compile the runner image for its target arch (multi-arch build bug) ([#1052](https://github.com/alethialabs-io/alethialabs/issues/1052)) ([17ab6d9](https://github.com/alethialabs-io/alethialabs/commit/17ab6d901481942b8849780a89e03adf80896962)), closes [#1050](https://github.com/alethialabs-io/alethialabs/issues/1050)
* **runner:** fail the audit job when the verify verdict can't persist ([#991](https://github.com/alethialabs-io/alethialabs/issues/991)) ([cd2950c](https://github.com/alethialabs-io/alethialabs/commit/cd2950c7bf1a4a25de936b7e2d6d6a493495620d)), closes [#986](https://github.com/alethialabs-io/alethialabs/issues/986)
* **runner:** nil-guard resolveAccountID ([#989](https://github.com/alethialabs-io/alethialabs/issues/989)) ([#1018](https://github.com/alethialabs-io/alethialabs/issues/1018)) ([d052776](https://github.com/alethialabs-io/alethialabs/commit/d05277650dca237a1e421e3c95e991e420750016))
* **runner:** single config-driven tofu version + panic-safe id truncation ([#964](https://github.com/alethialabs-io/alethialabs/issues/964)) ([977396c](https://github.com/alethialabs-io/alethialabs/commit/977396ce5f00d0b51e0e136fe9a7477b2890f3bf)), closes [#947](https://github.com/alethialabs-io/alethialabs/issues/947) [#949](https://github.com/alethialabs-io/alethialabs/issues/949)
* **runner:** StreamWake reuses the configured transport + gets an idle deadline ([#953](https://github.com/alethialabs-io/alethialabs/issues/953)) ([#1024](https://github.com/alethialabs-io/alethialabs/issues/1024)) ([d29cee5](https://github.com/alethialabs-io/alethialabs/commit/d29cee50212a71f971ddd3beb47ccf1cf6ac4ad4))
* **security:** write secret-bearing files owner-only (0600) ([#961](https://github.com/alethialabs-io/alethialabs/issues/961)) ([e684a6a](https://github.com/alethialabs-io/alethialabs/commit/e684a6a0f034c3c84abfdbc371d773333e860a12))

## [0.2.0](https://github.com/alethialabs-io/alethialabs/compare/runner-v0.1.0...runner-v0.2.0) (2026-07-19)


### Features

* **addons:** W4.5 — secret knobs render to a runner-seeded k8s Secret, never the manifest (Closes [#640](https://github.com/alethialabs-io/alethialabs/issues/640)) ([#656](https://github.com/alethialabs-io/alethialabs/issues/656)) ([ea3a718](https://github.com/alethialabs-io/alethialabs/commit/ea3a718fe0e0ea74f0d4da9443bef6a37933c14a))
* **breakglass:** audited, gated, blast-radius-bounded privileged recovery backend + CLI ([#364](https://github.com/alethialabs-io/alethialabs/issues/364)) ([d001598](https://github.com/alethialabs-io/alethialabs/commit/d001598b293bdf75190d54ed719ee29b61fd6e8e))
* **byo-iac:** deploy-time binding resolution + bind-sheet UI for BYO-IaC targets ([#687](https://github.com/alethialabs-io/alethialabs/issues/687), [#823](https://github.com/alethialabs-io/alethialabs/issues/823)) ([#824](https://github.com/alethialabs-io/alethialabs/issues/824)) ([6c67392](https://github.com/alethialabs-io/alethialabs/commit/6c673920dd5e94048b69c82f2899d3cd5ec7a85f))
* **canvas:** a BYO-IaC environment reads as an architecture (W8) ([#527](https://github.com/alethialabs-io/alethialabs/issues/527)) ([b913323](https://github.com/alethialabs-io/alethialabs/commit/b9133230eb38c0d6cc4bfb7ee699985c1fe9d461))
* **connectors:** four-cloud OIDC-only + cloud-shell parity (AWS/Azure/Aliyun ↔ GCP) ([7e8caac](https://github.com/alethialabs-io/alethialabs/commit/7e8caac969c7a27fabf7ab3e3ac6f7203090b7ea))
* **connectors:** four-cloud OIDC-only + cloud-shell parity (AWS/Azure/Aliyun ↔ GCP) ([a50d9ab](https://github.com/alethialabs-io/alethialabs/commit/a50d9abe08a2aba4b64adffcc2e8683b4ff51e62))
* **db:** add PROBE_CLUSTER job kind + environment_probes history table (BYOC B2.1) ([#449](https://github.com/alethialabs-io/alethialabs/issues/449)) ([c7e6732](https://github.com/alethialabs-io/alethialabs/commit/c7e6732957b8e4fa7d7c7fcf3829523e65095023))
* **e2e/aws:** pre-apply cost ceiling + stale-cluster preflight + single-NAT (BYOC A1.4) ([3565daf](https://github.com/alethialabs-io/alethialabs/commit/3565daf08bad75758b8ab21dc309a7a79cc04680))
* **e2e/aws:** pre-apply cost ceiling + stale-cluster preflight + single-NAT (BYOC A1.4) ([605483c](https://github.com/alethialabs-io/alethialabs/commit/605483c724e9e0314da9c9275dc4cc4ea600a5fd))
* **hetzner:** surface in-cluster data-service endpoints + credential refs (FT-2) ([#511](https://github.com/alethialabs-io/alethialabs/issues/511)) ([4e18b67](https://github.com/alethialabs-io/alethialabs/commit/4e18b67b95c7f6f4741cfb528b8e19223984c777))
* **keyless:** per-cloud keyless DB credential auth — GCP Cloud SQL IAM / Azure Entra ([#722](https://github.com/alethialabs-io/alethialabs/issues/722)) ([#766](https://github.com/alethialabs-io/alethialabs/issues/766)) ([394ab3c](https://github.com/alethialabs-io/alethialabs/commit/394ab3cf282d1fbf36e99e76ebc24817855b84a7))
* **observability:** OpenTelemetry traces + metrics on the traceparent substrate ([#346](https://github.com/alethialabs-io/alethialabs/issues/346)) ([cf8caf8](https://github.com/alethialabs-io/alethialabs/commit/cf8caf8595900dfb10657a6756849d5c077b7708))
* **observability:** self-hosted error tracking (Sentry SDK → GlitchTip, env-gated) ([#362](https://github.com/alethialabs-io/alethialabs/issues/362)) ([594a4ce](https://github.com/alethialabs-io/alethialabs/commit/594a4cefbccba21ecb00d3dd5411c387c0f2a460))
* **runner:** detect and repair apply-orphaned resources — a failed apply could permanently wedge an environment ([#526](https://github.com/alethialabs-io/alethialabs/issues/526)) ([#543](https://github.com/alethialabs-io/alethialabs/issues/543)) ([8c04139](https://github.com/alethialabs-io/alethialabs/commit/8c0413988641862ca5236dea4b8cf8ab5347de1b))
* **runner:** executeBuild — schedule in-cluster kaniko builds, capture digests (Closes [#588](https://github.com/alethialabs-io/alethialabs/issues/588)) ([#606](https://github.com/alethialabs-io/alethialabs/issues/606)) ([0939afc](https://github.com/alethialabs-io/alethialabs/commit/0939afc9578afd0e7a38b709c8467e5902877200))
* **scanner:** W5 Path A seam [#0](https://github.com/alethialabs-io/alethialabs/issues/0) — describe BYO chart workloads ([#648](https://github.com/alethialabs-io/alethialabs/issues/648)) ([#663](https://github.com/alethialabs-io/alethialabs/issues/663)) ([a5ebaa7](https://github.com/alethialabs-io/alethialabs/commit/a5ebaa7d0861fc8be8252e964ecdb91ad5aea7a5))
* **services:** W2 [#0](https://github.com/alethialabs-io/alethialabs/issues/0) seam — resolved_image output field + BUILD job kind + result contract ([#597](https://github.com/alethialabs-io/alethialabs/issues/597)) ([73650f4](https://github.com/alethialabs-io/alethialabs/commit/73650f4116e7857ac23c2d1ece400fbda0ef653a))
* surface GitOps/ArgoCD status — Deploy tab, canvas badges, cluster card (Closes [#574](https://github.com/alethialabs-io/alethialabs/issues/574)) ([#642](https://github.com/alethialabs-io/alethialabs/issues/642)) ([190fd29](https://github.com/alethialabs-io/alethialabs/commit/190fd29b71d08cab4f7c4a536adb78c88b7c18d4))


### Bug Fixes

* **ci:** make Go modules tidy standalone + fix the CLI mirror sync ([#851](https://github.com/alethialabs-io/alethialabs/issues/851)) ([65c7406](https://github.com/alethialabs-io/alethialabs/commit/65c74067762c2c26002181c8d6c7dc973d5e4470))
* **runner:** flag orphan_risk on non-cancel mid-apply interruption (audit [#8](https://github.com/alethialabs-io/alethialabs/issues/8)) ([#396](https://github.com/alethialabs-io/alethialabs/issues/396)) ([8a706df](https://github.com/alethialabs-io/alethialabs/commit/8a706df2a79f5c0a479af984ec9d88aca61c416c))
* **runner:** resolve BYO chart git tokens per-repo, not once per job ([#468](https://github.com/alethialabs-io/alethialabs/issues/468)) ([1a9549d](https://github.com/alethialabs-io/alethialabs/commit/1a9549da70b3bbb7da4bb597c26d15b850bc68c6))
* **runner:** un-break dev — executeBuild now uses the canonical imagebuild renderer ([#611](https://github.com/alethialabs-io/alethialabs/issues/611)) ([7b84b52](https://github.com/alethialabs-io/alethialabs/commit/7b84b52518bdc4dd758d556d56cca699a9f2c59d))
* **runner:** wire the PROBE_CLUSTER executor — every probe job was failing ([#528](https://github.com/alethialabs-io/alethialabs/issues/528)) ([#533](https://github.com/alethialabs-io/alethialabs/issues/533)) ([6998054](https://github.com/alethialabs-io/alethialabs/commit/69980549a330858b949eb2f6529e5acf71b23fa6))
* **secrets:** stop AWS generated secret values leaking into execution_metadata (audit P1) ([#393](https://github.com/alethialabs-io/alethialabs/issues/393)) ([07a1c72](https://github.com/alethialabs-io/alethialabs/commit/07a1c72464507e060d70e02d345cae58ed066022))
* **security:** stop persisting argocd admin password in execution_metadata ([#427](https://github.com/alethialabs-io/alethialabs/issues/427)) ([7d086ab](https://github.com/alethialabs-io/alethialabs/commit/7d086abb5ef25c8228c40e0a5aff46614348b399))
