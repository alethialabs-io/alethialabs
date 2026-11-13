<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Traefik replaces ingress-nginx in the add-on catalogue

**Status:** Accepted, 2026-11-11 · **Issue:** #6543 · **Follows:** #6538 (ingress-nginx 4.15.1),
#6550 (`securityRelease` and the update notice)

## Context

The Kubernetes project retired ingress-nginx. Best-effort maintenance ended in March 2026, and the
announcement says that after it "there will be no further releases, no bugfixes, and no updates to
resolve any security vulnerabilities". SIG Network recommends moving to Gateway API or to another
Ingress controller ([announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)).
#6538 moved the add-on to chart 4.15.1, the final release.

The marketplace therefore needs a maintained controller, and ingress-nginx needs a way out of the
catalogue that does not break the environments that run it.

## Property

The marketplace offers a maintained ingress controller. A new environment is steered to it, and from
**2027-02-09** cannot install ingress-nginx at all. An environment that already has ingress-nginx
keeps it: it still deploys, can be reconfigured and pinned, and is shown why it is deprecated, the
date, and a migration guide. Nothing removes a running controller except the user.

## Options

Three maintained Gateway API implementations were compared on 2026-11-11, from primary sources
(release pages, security advisory listings, chart artefacts pulled and rendered with `helm template`,
and the Gateway API conformance reports).

| | Envoy Gateway | Traefik v3 | NGINX Gateway Fabric |
|---|---|---|---|
| Governance | Envoy sub-project; Envoy is CNCF graduated | Traefik Labs | F5 / NGINX |
| Licence (app / chart) | Apache-2.0 / Apache-2.0 | MIT / Apache-2.0 | Apache-2.0 / Apache-2.0 |
| Latest stable | v1.10.0 (2026-11-06); v1.9.3 (2026-10-26) | v3.7.18 (2026-11-10); the newest chart, 42.3.2, carries v3.7.17 | 2.8.1 (2026-11-03) |
| Chart distribution | **OCI only** (`oci://docker.io/envoyproxy/gateway-helm`) | **Classic HTTPS repo** (`https://traefik.github.io/charts`) | **OCI only** (`oci://ghcr.io/nginx/charts/nginx-gateway-fabric`) |
| Kubernetes 1.33–1.35 | v1.10 supports 1.34–1.37 and drops 1.33; v1.9 covers 1.33–1.36, end of life 2027-02-14 ([matrix](https://gateway.envoyproxy.io/news/releases/matrix/)) | chart `kubeVersion: >=1.30.0-0`; upstream promises "at least the latest three minor versions" ([requirements](https://doc.traefik.io/traefik/includes/kubernetes-requirements/)) | "1.32+"; chart `kubeVersion: >= 1.32.0-0` |
| Gateway API conformance (v1.6 reports) | HTTP, GRPC, TLS core pass; 36 HTTP extended features | HTTP core **partial**; 19 HTTP extended features unsupported, including timeouts, retry and CORS | HTTP, GRPC, TLS, TCP, UDP core pass; timeouts and retry unsupported |
| Gateway API CRDs | installed by the chart (experimental channel v1.6.1) | not shipped; install standard v1.6.3 separately | not shipped |
| Data-plane Service | one per Gateway, created by the controller | one, rendered by the chart | one per Gateway, created by the controller |
| Cloud LB annotations | EnvoyProxy `envoyService.annotations` | chart `service.annotations` | Gateway `spec.infrastructure`, or `nginx.service.patches` |
| Default resources | controller 100m / 256Mi; each proxy 100m / 512Mi | none set | none set |
| Reads existing Ingress | no | yes, including the `kubernetesIngressNGINX` provider that reads `nginx.ingress.kubernetes.io/*` | no |
| Security advisories, 2026 | 16, all fixed in 1.8.5 / 1.9.2 | 45 since May, 8+ in the ingress-nginx provider; all listed fixed in v3.7.17 | 4, fixed in 2.6.4 / 2.6.8 |

Conformance reports are under `conformance/reports/v1.6/` in
[kubernetes-sigs/gateway-api](https://github.com/kubernetes-sigs/gateway-api): `envoy-gateway/experimental-v1.9.0-default-report.yaml`,
`traefik-traefik/experimental-v3.7.10-default-report.yaml` and
`nginx-nginx-gateway-fabric/experimental-2.8.0-default-report.yaml`. Traefik's supported nginx
annotations are listed at
<https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/ingress-nginx/>.

Cloud load balancers: every candidate exposes a `type: LoadBalancer` Service, which each cloud's
controller turns into its own load balancer: the AWS Load Balancer Controller or the in-tree NLB on
EKS, the GKE L4 load balancer, the AKS standard load balancer, hcloud-cloud-controller-manager (whose
location this platform sets cluster-wide, see `scripts/check-hetzner-lb-location.mjs`), and the ACK
CLB/NLB. The difference is where the annotations go. A chart-rendered Service is the easiest for a
marketplace add-on, because the clouds then differ only in a values key.

## Decision

**Traefik**, chart `traefik/traefik` 42.4.0 (proxy v3.7.18), namespace `traefik`. The decision was
taken on chart 42.3.2 (proxy v3.7.17), the newest chart on 2026-11-11. Traefik v3.7.18 was released
on 2026-11-10 with fixes for five advisories, and chart 42.4.0, published on 2026-11-12, is the first
to carry it. #6598 moved the pin to it, and the catalogue entry sets `securityRelease`. Reasons:

1. **It fits the catalogue's checks.** It is the only candidate in a classic HTTPS Helm repository.
   `check-addon-charts-render.mjs`, `check-render-determinism.sh`, `check-published-defaults.sh`,
   `check-resource-fit.sh` and `derive-compat.mjs` all read `chartRepo` as an https index. An OCI-only
   chart would need each of them extended before it could be guarded at all.
2. **It is the smallest move for an environment that runs ingress-nginx.** The
   `kubernetesIngressNGINX` provider (non-experimental since v3.6.2) serves `ingressClassName: nginx`
   Ingresses and reads most of their annotations, so the controller can be swapped before a single
   Ingress is rewritten. Envoy Gateway and NGINX Gateway Fabric need every Ingress converted first,
   and `ingress2gateway` does not convert auth, cookie affinity, rate limits or snippets.
3. **One chart-owned Service** keeps the cloud load-balancer story identical to ingress-nginx's.
4. **A Gateway API provider is there** for the move from Ingress to HTTPRoute.

The add-on's knobs are replicas, service type, a metrics Service, **Serve NGINX-class Ingresses**
and **Gateway API**. Both of the last two are off by default. Its IngressClass is not the cluster
default, it requests 100m CPU and 128Mi memory with a 512Mi memory limit, the Traefik API and
dashboard are off, and the NGINX provider refuses `ExternalName` Service backends.

**Serve NGINX-class Ingresses is off by default.** The provider ignores an annotation it does not
support and still serves the route. Some unsupported annotations are access controls: a source-range
denylist, ModSecurity and OWASP rules, and client-certificate CN matching. With the provider on
beside a running ingress-nginx, each NGINX-class Ingress is reachable on Traefik's own load-balancer
address without those controls, before any DNS moves. So the migration guide makes the annotation
review the precondition of turning the setting on, and names those annotations. The provider also
needs an `nginx` IngressClass with `spec.controller: k8s.io/ingress-nginx` to exist.

**Gateway API is off by default because no Alethia cluster has the CRDs.** The chart does not ship
them, and no template or platform add-on installs them. With the provider on and no CRDs, the
chart's GatewayClass and Gateway cannot be applied, and the whole Application fails to sync. The
knob's help text names the prerequisite.

### Deprecation

`AddOnDef.deprecated { reason, replacementId, removalDate, migrationGuideUrl }` marks ingress-nginx,
with `replacementId: "traefik"` and `removalDate: "2027-02-09"`, 90 days after this decision.
`lib/addons/deprecation.ts` holds the rule:

- Before the date, a new install is accepted. The palette labels the add-on deprecated and names the
  replacement, and its card opens with a notice and an **Open Traefik** button.
- From the start of the date (UTC), `enableAddon` refuses a **new** install, so the console and the
  CLI give the same answer. The card drops its Enable button.
- An environment that already has it is never refused. Its card says it keeps working, gives the
  date, and links the migration guide. #6550's update notice is unchanged beside it.

The migration guide is `apps/docs/content/docs/guides/design-project/migrate-from-ingress-nginx.mdx`.

## Consequences

- **Security cadence.** Traefik publishes advisories often, several of them in the ingress-nginx
  provider. The chart pin must follow Traefik patch releases closely, and `securityRelease` is the
  marker to set when a bump carries a fix. The first such bump is chart 42.4.0 (v3.7.18), in #6598.
- **Weak Gateway API extended conformance.** HTTPRoute timeouts, retry and CORS are not supported in
  Gateway mode; they need Traefik Middlewares, which do not carry over to another implementation.
- **Gateway API CRDs are a follow-up.** Until something installs the standard-channel CRDs, Gateway
  API on this add-on is opt-in and the user's to prepare.
- **Envoy Gateway stays the better Gateway API engine.** If the chart checks learn `oci://`, it is
  the candidate to revisit: pin v1.9.x for Kubernetes 1.33 (end of life 2027-02-14) and decide who
  owns the Gateway API CRDs before turning its bundled ones on.
- **Not verified here:** whether Traefik's "latest three minor versions" wording formally covers 1.33
  and 1.34 once 1.36 and 1.37 exist (the chart's `kubeVersion` admits them), and the exact Alibaba
  load-balancer annotation names.
- The catalogue grows from 18 to 19, because ingress-nginx stays for the environments that have it.
  `tests/lib/addons/catalog-count.test.ts` and `test/e2e/addon_surface.go` say so.
