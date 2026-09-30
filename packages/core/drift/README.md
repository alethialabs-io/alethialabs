<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# `drift` — continuous drift posture (the "keep proving it" half)

Turns the `resource_drift` section of an OpenTofu **`plan -refresh-only -json`** into a
compact, storable per-environment `Posture` (`in_sync`, `drifted` count, per-resource
`kind` ∈ modified/deleted/other). Pure and deterministic — `Analyze(*tfjson.Plan) *Posture`,
or `AnalyzeWithSchemas(plan, *tfjson.ProviderSchemas)` when the caller can also supply the
workspace's provider schemas.

A scheduled refresh-only job (cadence tiered by environment criticality, to bound provider-API
cost) runs `tofu plan -refresh-only`, calls `Analyze`, and stores the posture row; the result
feeds the same evidence timeline as the apply-time gate so the headline — "and keeps proving
it" — is literally true.

**Not every refresh delta is drift.** A provider routinely returns a value its own create never
recorded — an unset collection coming back empty, a deprecated field newly hydrated. Reporting
those means a *clean* apply reads as 28% drifted on day zero, which is how a detection feature
loses its reader (#2358: 9 of 32 Azure resources, minutes after `Apply complete!`). `normalize.go`
classifies them out on seven rules, and each is deliberately narrow (the seventh, `kubernetes_owned`, is the one that records a real change — owned by the cluster — rather than a representational one):

| Rule | Fires on | Why it cannot hide a real change |
|---|---|---|
| `empty_collection` | `null`/absent ↔ an **empty** list or map, either direction, any depth | A collection's meaning is its element set; `null` and `[]` both have ∅. Hiding something real needs an element to appear or disappear — and then the other side is non-empty and the rule does not fire. Scalars are excluded: `""`, `0`, `false` are not interchangeable with null. |
| `undeclared_collection` | `null`/absent → a **non-empty** collection, at depth 0, on an attribute the configuration does not declare, not sensitive | If state records null after a successful create, the provider's own Read returned null then. A later populated read is the provider's behaviour changing, not the infrastructure. |
| `computed_attribute` | any delta, at depth 0, on an attribute the **provider schema** marks `Computed && !Optional && !Required`, not sensitive | Such an attribute has no config path into it at all — `google_storage_bucket.updated`, an ARN, a `self_link`. "Out-of-band" is divergence from *intent*, and an attribute no configuration can express carries no intent to diverge from. `Optional+Computed` (`tags`, `min_tls_version`) is **not** dismissed: that is the shape a real out-of-band scalar flip takes. |
| `sensitivity_only` | a pure update with **no differing value at all**, non-empty, number-free, whose sensitivity marks are the only possible difference: either the printed **masks** differ, or they are equal and the **provider schema** explains it (declares a sensitive attribute, has no dynamic `any` type, and the masks mark a non-empty path set) | A mark is OpenTofu's note of which paths to redact, not a property of the infrastructure. OpenTofu's drift comparison (cty `RawEquals`) compares marks. In v1.9 refresh re-marks every value as *recorded marks ∪ schema marks*, and jsonplan prints *each side's marks ∪ schema marks* — so a state written without some schema-sensitive marks reads "changed" forever while both masks print **identical**. That is what `talos_machine_secrets` / `talos_cluster_kubeconfig` do on every hetzner Fabric (#845 run 36706419571 — the first version of this rule expected the masks to differ, and they did not). Numbers and dynamic types are refused because equal JSON would then not prove equal values; equal values with equal masks and no schema to explain them stay drift (no vacuous dismissal). See `marks.go`. |
| `assignment_back_reference` | on `hetznercloud/hcloud` only: a primary IP going unassigned → assigned (`assignee_id`, `assignee_type`), or a firewall's `apply_to` only **gaining** `{server = id}` entries | The template assigns both from the **server** (`public_net.ipv4`, `firewall_ids`); the IP and firewall were created first and never re-read, so their state is stale by construction. Dismissed only when each named server is a **managed** `hcloud_server` of the same provider whose forward edge holds in **both** the recorded state (the last apply) and the refreshed state. An unmanaged server, a re-assignment, a detach, a removed or altered entry, or a label selector is never dismissed. See `backref.go`. |
| `assignment_back_reference` (aws) | on `hashicorp/aws` only, a container that only **gained** what separate attachment resources in the same state put there: `aws_iam_role.managed_policy_arns` ← `aws_iam_role_policy_attachment`; `aws_security_group.ingress`/`egress` ← `aws_security_group_rule` (compared as permission atoms, since the provider's Read regroups rules); `aws_route_table.route` ← `aws_route`; `aws_eip.association_id`/`network_interface`/`private_ip` ← the `aws_nat_gateway` created on that allocation; `aws_default_network_acl.subnet_ids` ← `aws_subnet`s of the same VPC that no network ACL or NACL association claims | The container is created first and recorded empty; the attachment is made afterwards and nothing re-reads the container, so every AWS environment read out of sync on day zero (#845 run 36717544116: 17 of 18). Every recorded entry must survive; every gained entry must be declared by a managed attachment of the same provider **in the same module instance** whose recorded **and** refreshed values both declare it. An out-of-band policy, rule, route, association or subnet move is not declared, so it stays drift. A security-group rule a Kubernetes controller opens (the AWS Load Balancer Controller's `elbv2.k8s.aws/...` rule for a LoadBalancer Service) is not in state, so this tier never dismisses it — see `kubernetes_owned`. `aws_vpc_security_group_*_rule` is not recognised yet. See `awsbackref.go`. |
| `assignment_back_reference` (gcp) | on `hashicorp/google` only, a `google_container_cluster` whose `node_pool` only **gained** elements, each a managed `google_container_node_pool` in the same state, and whose `node_config` went from empty to that first pool's node config, with `remove_default_node_pool = true` | The gke module removes the default pool and manages its pool as a separate resource; the cluster is recorded with no pool, and its Read reports every pool the API lists and the first pool's node config (the GKE API's documented response shape), so every GCP Standard environment read out of sync on day zero (#845 run 36740452010: the only drift). Each gained element must name exactly one managed pool of the same provider **in the same module instance**, present in both the recorded and the refreshed state, whose `cluster`, project and location are this cluster's — and must **mirror** that pool's refreshed value field for field (null ≡ empty collection), except the three fields the provider fills from prior state rather than the API (`name_prefix`, `network_config.create_pod_range`, `node_config.taint`), which must hold the empty-prior value. A pool created out of band, a pool matching no managed one, a changed or removed recorded pool, a non-empty recorded node config, a node config matching no managed pool, or a cluster that kept its default pool stays drift. An out-of-band change to the pool itself is reported on the pool resource. See `gcpbackref.go`. |
| `inapplicable_field` | on `hashicorp/aws` only: a network ACL's `ingress`/`egress` whose only change is `icmp_code`/`icmp_type` going null → 0 on rules whose protocol is **not** ICMP (1) or ICMPv6 (58), matched one-to-one | AWS ignores ICMP type/code on any other protocol, so no traffic decision differs. An ICMP rule's type or code, any other field, an added or removed rule, or 0 → null is never dismissed. See `awsInapplicableRoots` in `awsbackref.go`. |
| `kubernetes_owned` | on `hashicorp/aws` only, and only with **cluster evidence** (`AnalyzeWithEvidence`): an `aws_security_group`'s `ingress` that only **gained** rules, each either declared by an `aws_security_group_rule` (as above) or accounted for by a live AWS Load Balancer Controller `TargetGroupBinding` — source is the binding's `securityGroup` peer, protocol and port bounds are what the controller renders from the binding's `networking` ports (restricted mode merges every binding sharing a source into min–max; unrestricted writes each port), description is exactly `elbv2.k8s.aws/targetGroupBinding=shared`, and the group carries `kubernetes.io/cluster/<cluster>` = `owned`/`shared` in both views | **Not representational — a real change, owned by the cluster** (maintainer ruling 2026-09-30). The description is required and never sufficient (anyone with `ec2:AuthorizeSecurityGroupIngress` can write it): the binding must exist at scan time, not be deleting, and name a Service that exists. A rule from a group no binding names, a port outside the bindings' bounds, a CIDR source, a deleted binding, an untagged or foreign group, or the string alone stays drift. No cluster access or a read error is **no evidence**, never "no bindings" (`ParseClusterEvidence` refuses a document that is not a list), so the rule stays drift. The resource stays **named** in `NormalizedDetails` under this reason. See `k8sowned.go`. |

Only a pure `update` is ever dismissible, both sides must parse as objects, and there must be at
least one differing leaf — so a change carrying no readable diff stays drift rather than being
dismissed vacuously. `sensitivity_only` is the one exception, and it replaces the leaf with positive
evidence (a differing mask, or equal masks the provider schema explains) rather than dropping the requirement. A resource is dismissed only when **every** differing leaf qualifies; one real
delta anywhere keeps the whole resource.

"Not sensitive" means the plan's sensitivity mask holds no `true` anywhere under that attribute.
The mask's **structure** is not a mark: OpenTofu keeps one slot per list or set element even when
nothing is marked, so a firewall with four `apply_to` blocks prints `"apply_to": [{}, {}, {}, {}]`.
Reading any non-empty container as a mark made every non-empty list attribute undismissable, on
every provider, and is why the hcloud `apply_to` back-reference never fired against a real plan
(#845 run 36706419571).

Dismissals are **counted and named**, not dropped: `Normalized` / `NormalizedDetails` record what
was examined and why it was set aside, carrying attribute *paths* and never *values* (plan JSON
values are plaintext secrets). "32 examined, 9 dismissed as representational, here they are" is a
control that can be shown to have operated; a bare `0 drifted` is not.

When a resource is dismissed on a mixture of rules it is recorded under the **weakest** one it used
(`empty_collection` > `sensitivity_only` > `computed_attribute` > `undeclared_collection` >
`assignment_back_reference` > `inapplicable_field` > `kubernetes_owned`), so the trail never overstates
how firm the dismissal was.

What `undeclared_collection` deliberately stops catching, and permanently: an out-of-band change to
an undeclared, non-sensitive, top-level collection whose state value is null — a subnet added
through the cloud console, say. That sits inside a boundary this package already declares, since
such a resource is *unmanaged* and the next paragraph says plainly that we cannot see those.

**Cluster evidence fails closed, and is read only while something drifts.** `packages/core/provisioner/drift.go`
asks the environment's cluster (aws only — `ClusterEvidenceReader`) for its `TargetGroupBinding`s and
`Service`s with a bounded `kubectl` read, and only when the schema-aware pass still drifted; like the
schemas, the evidence can only dismiss (`TestClusterEvidenceNeverIncreasesDrift`). Any failure leaves
the posture as it was and logs a warning. Only the number of bindings is logged — the evidence is
security-group ids and ports, and none of it reaches the posture.

**Schema evidence fails closed.** `Analyze` — and `AnalyzeWithSchemas(plan, nil)`, and a schema
document that does not cover a resource's provider or type — reaches verdict-for-verdict the same
posture it reached before `computed_attribute` existed. Missing evidence never widens a dismissal.
Without it, a server-set attribute drifts **forever**: only an apply rewrites state and a
refresh-only check never applies, so one GCS timestamp reddened every gcp proof cell (#3099).
`packages/core/provisioner/drift.go` fetches the schemas best-effort from the already-`init`-ed
workdir (a local plugin RPC, no cloud call) and degrades to `nil` on any failure.

**Honest coverage.** A refresh-only plan only sees resources in state, so it detects *modified*
and *deleted-out-of-band* managed resources. It **cannot** see **unmanaged** resources (in the
cloud, not in state) — that needs a cloud inventory source (AWS Config / Cloud Asset Inventory),
tracked separately. `Posture.UnmanagedKnown` is `false` here so a consumer never implies we
checked for unmanaged resources when we did not.

```bash
go test ./packages/core/drift/...
```

Not yet wired: the scheduled job type + per-env posture storage/UI (Phase 2 infra). This package
is the tested, deterministic core those will call.
