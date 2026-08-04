<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Alibaba CR image scanning — does a per-repo AUTO scan rule need the instance VPC, and is that VPC argument `ForceNew`?

Research answer for **#1895**, which blocks **#1845** (`registry:vulnerability_scanning` on Alibaba —
part of the offer-parity epic #1419). Checked 2026-08-04.

Read against the provider version this repo actually resolves — `aliyun/alicloud` **1.286.0**,
pinned at `infra/templates/project/alibaba/.terraform.lock.hcl:5` — and against Alibaba's own
first-party API metadata and product documentation. No secondary write-ups.

Where the English and Chinese product docs disagree, this file says so and takes the Chinese page,
because on one table the English page is not merely thinner — it is **wrong** (see §4).

---

## The two answers, up front

**Q1 — does a per-repository `AUTO` scan rule require the CR instance to have a VPC?**
**UNRESOLVED, and it cannot be resolved from documentation.** Alibaba's only VPC sentence scopes
itself, in its own words, to the *batch* scanning feature — but Alibaba puts scan-rule creation
(including the `AUTO` trigger) inside that same VPC-prefaced procedure and never writes the
requirement down for rules. There is no prerequisites section on the page and the `CreateScanRule`
API reference documents no prerequisite and no error codes at all. §3 states exactly what would
settle it.

**Q2 — if a VPC argument must be added to `alicloud_cr_ee_instance`, is it `ForceNew`?**
**The premise is false, which is the answer.** At 1.286.0 `alicloud_cr_ee_instance` has **no VPC
attachment argument of any kind** — no `vpc_id`, no `vswitch_id`, nothing. A VPC is attached by a
*separate* resource, `alicloud_cr_vpc_endpoint_linked_vpc`, which references the instance by id.
Attaching, changing or removing a VPC therefore **never plans a replacement of the
Subscription-billed registry**. The feared money event does not exist on this path. §5 and §6
describe the two money/silence hazards that *do* exist, on different arguments.

---

## 1. What the repo pins, and what it builds today

- Provider actually resolved: **1.286.0** — `infra/templates/project/alibaba/.terraform.lock.hcl:5`
  (`provider "registry.opentofu.org/aliyun/alicloud" { version = "1.286.0" }`).
- Root constraint: `>= 1.230, < 2.0` — `infra/templates/project/alibaba/main.tf:11`.
- Module floor: `>= 1.283` — `infra/templates/project/alibaba/modules/cr/main.tf:12`.
- The registry itself: `infra/templates/project/alibaba/modules/cr/main.tf:19-24` —
  `payment_type = "Subscription"`, `period = 1`, `instance_type = "Basic"`, `instance_name`.
- The module is wired with **no network inputs at all**:
  `infra/templates/project/alibaba/cr.tf:4-10` passes only `instance_name`, `namespace_name`, `repos`.
- A VPC is not guaranteed to exist: `provision_network` is a switch
  (`infra/templates/project/alibaba/variables.tf:52-56`), independent of `provision_cr`
  (`:254-258`). When it is on, `modules/network` does export `vpc_id` and `vswitch_ids`
  (`infra/templates/project/alibaba/modules/network/outputs.tf`).

All three resources named in #1845 exist in the pinned provider — confirmed from the registration
map, not from prose:

- `alicloud_cr_scan_rule` — [`alicloud/provider.go:1019`](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/provider.go#L1019)
- `alicloud_cr_ee_instance` — [`alicloud/provider.go:1472`](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/provider.go#L1472)
- `alicloud_cr_vpc_endpoint_linked_vpc` — [`alicloud/provider.go:2090`](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/provider.go#L2090)

`alicloud_cr_scan_rule` is documented "Available since v1.265.0"; `alicloud_cr_vpc_endpoint_linked_vpc`
"Available since v1.199.0" ([`website/docs/r/cr_scan_rule.html.markdown`](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/website/docs/r/cr_scan_rule.html.markdown),
[`website/docs/r/cr_vpc_endpoint_linked_vpc.html.markdown`](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/website/docs/r/cr_vpc_endpoint_linked_vpc.html.markdown)).

---

## 2. Q2 — the `ForceNew` question, answered from the provider source

### 2.1 There is no VPC argument on `alicloud_cr_ee_instance`

The full top-level schema at
[`alicloud/resource_alicloud_cr_ee_instance.go:30-193`](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/resource_alicloud_cr_ee_instance.go#L30-L193)
is 22 keys:

`create_time`, `custom_oss_bucket`, `default_oss_bucket`, `end_time`, `image_scanner`,
`instance_endpoints`, `instance_name`, `instance_type`, `namespace_quota`, `kms_encrypted_password`,
`kms_encryption_context`, `password`, `payment_type`, `period`, `region_id`, `renew_period`,
`renewal_status`, `repo_quota`, `resource_group_id`, `status`, `vpc_quota`, `created_time` (deprecated).

**No `vpc_id`. No `vswitch_id`. No network block.** The only VPC-adjacent key is `vpc_quota`, and it
is an integer *quota*, not an attachment:

```go
// resource_alicloud_cr_ee_instance.go:177-187
"vpc_quota": {
	Type:     schema.TypeInt,
	Optional: true,
	ValidateFunc: func(val interface{}, key string) (warns []string, errs []error) {
		v := val.(int)
		if v < 0 || v > 100 {
			errs = append(errs, fmt.Errorf("%q must be between 0 and 100 inclusive, got: %d", key, v))
		}
		return
	},
},
```

### 2.2 Exactly four arguments on the instance are `ForceNew`, and none is VPC-related

`grep ForceNew` across the schema block returns four hits
([lines 88, 131, 145, 151](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/resource_alicloud_cr_ee_instance.go#L85-L153)):

| Argument | Line | `ForceNew` |
|---|---|---|
| `instance_name` | 85-89 | **true** |
| `payment_type` | 128-133 | **true** |
| `renew_period` | 142-146 | **true** |
| `renewal_status` | 147-153 | **true** |
| `vpc_quota` | 177-187 | false |
| `image_scanner` | 48-52 | false |
| everything else | — | false / computed |

### 2.3 A VPC is attached by a sibling resource, whose `ForceNew` does not reach the instance

[`alicloud/resource_alicloud_cr_vpc_endpoint_linked_vpc.go:27-58`](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/resource_alicloud_cr_vpc_endpoint_linked_vpc.go#L27-L58):

```go
"instance_id": {Type: schema.TypeString, Required: true, ForceNew: true},
"vpc_id":      {Type: schema.TypeString, Required: true, ForceNew: true},
"vswitch_id":  {Type: schema.TypeString, Required: true, ForceNew: true},
"module_name": {Type: schema.TypeString, Required: true, ForceNew: true,
	ValidateFunc: validation.StringInSlice([]string{"Registry", "Chart"}, false)},
"enable_create_dns_record_in_pvzt": {Type: schema.TypeBool, Optional: true},
```

Those `ForceNew`s replace **the link**, not the registry. Create calls
`CreateInstanceVpcEndpointLinkedVpc`
([line 65](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/resource_alicloud_cr_vpc_endpoint_linked_vpc.go#L65));
`DeleteInstanceVpcEndpointLinkedVpc` exists as the inverse. Both are ordinary live-instance
operations — see §4.4.

**Conclusion for Q2: adding a VPC to the Alethia CR instance is not a money event.** The
Subscription resource is not touched, not replaced, and not re-purchased.

---

## 3. Q1 — the VPC prerequisite for an AUTO rule

### 3.1 The sentence exists, and it scopes itself to *batch*

Page: **Container Registry: Container image security scanning** —
<https://www.alibabacloud.com/help/en/acr/user-guide/scan-container-images>
(Chinese twin, 容器镜像安全扫描: <https://help.aliyun.com/zh/acr/user-guide/scan-container-images>).

Verbatim, from the raw page HTML:

> Configure a VPC for your Enterprise Edition instance. For more information, see Configure access
> control for a VPC.
> **You must configure a VPC for the Enterprise Edition instance, which the batch image scanning
> feature uses to scan images.**
> If this is the first time you use the Security Center scan engine, you must access the Security
> Center console. The first time you access the console, you are prompted to create the
> AliyunServiceRoleForSas system role.
> **Note** If you have already configured a VPC for the Enterprise Edition instance, you can skip
> this step.

Chinese, same position:

> 为企业版实例配置VPC网络。具体操作，请参见配置专有网络的访问控制。
> **您需要为企业版实例配置VPC网络，批量扫描镜像功能需要使用该VPC网络扫描镜像。**

### 3.2 Where it sits — verified from the page's heading structure

The page has **no `Prerequisites` section** in either language. Its headings are exactly:

`Background` · `Limitations` · `Scan a single image` · **`Scan images in batches`** ·
`Image scan results` · `Fix system vulnerabilities` · `Related documentation`

The string `VPC` occurs **four times on the whole page, all four inside `Scan images in batches`**,
and all four are the sentence and note quoted above. The `Scan a single image` procedure mentions no
VPC at all.

### 3.3 …but rule creation is a step *inside* that same procedure

This is the trap, and it is why the honest answer is "unresolved" rather than "no". Alibaba does not
give scan rules their own procedure. `Create a scan rule` → `On the Image Scanning page, click Create
Rule` is a numbered step of **`Scan images in batches`**, whose step 1 is the VPC step. And the
`AUTO` trigger is defined in the closing note of that same list:

> **Note** After you create a scan rule, you can trigger image scans manually or automatically. An
> automatic scan triggers whenever an image is successfully pushed or built.
> (「扫描规则创建完成后，支持手动和自动触发镜像扫描。自动触发指只要镜像推送或构建成功，就会自动触发镜像扫描。」)

So the documentation places AUTO-rule creation under a VPC-prefaced heading while wording the
requirement as belonging to "batch image scanning". Both readings survive the text.

### 3.4 The API reference does not settle it either

`CreateScanRule` — <https://help.aliyun.com/zh/acr/developer-reference/api-cr-2018-12-01-createscanrule>,
cross-checked against the machine-readable metadata at
<https://api.aliyun.com/meta/v1/products/cr/versions/2018-12-01/api-docs.json>:

- Parameters are only `InstanceId`, `RuleName`, `ScanScope` (`INSTANCE|NAMESPACE|REPO`),
  `TriggerType` (`MANUAL|AUTO`, `AUTO` = 推送自动触发), `Namespaces`, `RepoNames`,
  `RepoTagFilterPattern`, `ScanType` (`VUL|SBOM`, default `VUL`).
- `systemTags.chargeType` is `free`.
- There is **no interface note and no error-code table** — the operation's `errorCodes` is empty.

The only VPC-quota error in the entire CR product error list is
`INSTANCE_ACCESS_VPC_LIMIT_EXCEED` — *"Instance VPC access endpoint count exceeds the limit."* — and
it belongs to `CreateInstanceVpcEndpointLinkedVpc`, i.e. it fires when you **attach** a VPC without
quota, not when you create a scan rule.

### 3.5 What would settle Q1

Nothing readable will. It needs one observation:

> On an Enterprise **Basic** instance with **zero** linked VPCs, call `CreateScanRule` with
> `ScanScope = REPO`, `TriggerType = AUTO`, `ScanType = VUL`; push an image matching
> `RepoTagFilterPattern`; then poll `GetRepoTagScanStatus` / `ListRepoTagScanResult` for that tag.
> A scan result appearing proves no VPC is needed. Silence — with the rule still present and
> `CreateScanRule` having returned success — proves the rule plans clean and scans nothing.

That is a real apply against a paid instance, which in this repo is main-gated. It is the only
evidence that distinguishes the two readings, and — as #1895 already argued — a green
`check-offer-parity.mjs` is not it: a `REPO`-scoped rule satisfies the carrier probe's L4 emit and L5
read whether or not a scan ever runs.

---

## 4. What Alibaba's product docs do settle

### 4.1 Basic supports scanning — #1845's note is correct

Chinese edition table (个人版 / 经济版 / 基础版 / 标准版 / 高级版):
<https://help.aliyun.com/zh/acr/product-overview/differences-between-personal-edition-instances-and-enterprise-edition-instances>

| 细分项 | 个人版 | 经济版 | 基础版 | 标准版 | 高级版 |
|---|---|---|---|---|---|
| 多引擎扫描 | × | × | **支持** | 支持 | 支持 |
| 漏洞修复 | × | × | **支持** | 支持 | 支持 |
| 风险阻断 | × | × | × | × | 支持 |
| 网络访问控制 | × | 支持 | 支持 | 支持 | 支持 |
| VPC访问控制限额 | × | 单独购买 (one cell spanning all four Enterprise tiers) | | | |

So `instance_type = "Basic"` is **not** a blocker. **Economy (经济版) is** — worth knowing before
anyone "saves money" by downgrading the tier.

> ⚠️ **Do not cite the English edition table.**
> <https://www.alibabacloud.com/help/en/acr/product-overview/differences-between-personal-edition-instances-and-enterprise-edition-instances>
> renders an older three-column table (Personal / Enterprise Basic / Enterprise Advanced — no
> Economy, no Standard) whose `Image scanning with multiple engines` row marks **Personal Edition as
> supported**, which the Chinese page flatly contradicts. It repeats the error for `Risk blocking`
> and `Signing`. The usual "English is thinner" heuristic fails here: the English page is incorrect.

### 4.2 The default engine is Trivy, on, and free

Billing page <https://help.aliyun.com/zh/acr/product-overview/billing-description>, row
「（推荐）安全扫描配额 / Trivy扫描引擎」, price cell `-`:

> 容器镜像服务**默认**提供基于Trivy的安全扫描能力，支持系统漏洞、应用漏洞的风险识别。

Corroborated on the scan page: 「如果您之前未购买云安全扫描引擎，则镜像扫描页面右上角**默认使用Trivy扫描引擎**。」

The Security Center (SAS) engine is **¥800/month**, requires **Security Center Ultimate** to be
purchased, is region-gated, and needs the `AliyunContainerRegistryAccessingSASRole` RAM
authorization plus the `AliyunServiceRoleForSas` SLR. Trivy has one documented limit:
「受扫描引擎限制，建议镜像单层大小不要超过3GB」.

**No `DISABLE` state is documented anywhere in the product docs.** Whether the provider's
`image_scanner = "DISABLE"` maps to anything real is unverified.

### 4.3 VPC access-control quota starts at zero and costs money

<https://help.aliyun.com/zh/acr/user-guide/configure-access-over-vpcs> — 配置专有网络的访问控制,
opening line of 添加专有网络:

> **VPC 访问控制配额需单独购买，初始配额可能为 0。** 如配额不足或遇到配额超额提示，请参见常见问题。

FAQ on the same page:

> VPC 访问控制配额需单独购买，**初始配额可能为 0**。… 如果后续有在 VPC 内（如 ECS、ACK 集群中）拉取
> 镜像的需求，**需先购买配额再执行 VPC 绑定操作**。

Billing page: 「每个专有网络配额需支付**72元/月**。支持在实例列表页面对专有网络配额进行升级、降级。」

The asymmetry in that same billing table is the corroboration: repo and namespace quotas say
「**基础版默认已包含**仓库配额1000 … 命名空间配额15」. There is **no** 默认已包含 line for VPC — only
单独购买. Alibaba states defaults where defaults exist.

### 4.4 A VPC is attached after the fact, not at purchase

The instance purchase page's parameters are 地域 / 实例规格 / 实例名称 / 实例存储 / **安全扫描** /
仓库配额 / 命名空间配额 / 购买时长
(<https://help.aliyun.com/zh/acr/user-guide/create-a-container-registry-enterprise-edition-instance>).
VPC is not among them. Attachment is a live-instance console/API operation in both directions:

- `CreateInstanceVpcEndpointLinkedVpc` — 「为实例添加可访问实例的VPC实例。」 Its entire interface note
  is one sentence: **「VPC 访问控制限额需要单独购买。」**
  <https://help.aliyun.com/zh/acr/developer-reference/api-cr-2018-12-01-createinstancevpcendpointlinkedvpc>
- `DeleteInstanceVpcEndpointLinkedVpc` — 「为实例移除可访问实例的 VPC 实例。」
  <https://help.aliyun.com/zh/acr/developer-reference/api-cr-2018-12-01-deleteinstancevpcendpointlinkedvpc>

It also requires Cloud DNS **PrivateZone** to be activated, auto-creates the SLR
`AliyunServiceRoleForContainerRegistryAccessCustomerPrivateZone`, consumes one IP in the VPC, and is
VPC-wide once bound.

---

## 5. The hazard the issue was looking for is real — but it is on `image_scanner`, not on VPC

`image_scanner` is the actual scan-engine switch, and it lives on the Subscription instance:

```go
// resource_alicloud_cr_ee_instance.go:48-52
"image_scanner": {
	Type:         schema.TypeString,
	Optional:     true,
	ValidateFunc: StringInSlice([]string{"ACR", "SAS", "DISABLE"}, false),
},
```

It is **not** `ForceNew` — and that is worse than if it were, because the provider's own docs say:

> `image_scanner` - (Optional, Available since v1.235.0) The security scan engine used by the
> Enterprise Edition of Container Image Service. … `ACR`: Uses the Trivy scan engine provided by
> default. `SAS`: uses the enhanced cloud security scan engine. `DISABLE`: Disables the image
> security scan engine.
>
> -> **NOTE:** The parameter is immutable after resource creation. It only applies during resource
> creation and has no effect when modified post-creation.

— [`website/docs/r/cr_ee_instance.html.markdown:67-72`](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/website/docs/r/cr_ee_instance.html.markdown)

The source confirms it. `resourceAliCloudCrInstanceUpdate`
([lines 393-476](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/resource_alicloud_cr_ee_instance.go#L393-L476))
handles **only two things** — `ChangeResourceGroup` (line 402) and `ResetLoginPassword` (line 435).
`image_scanner` is sent only from Create, as a BSS purchase parameter (line 257-262,
`"Code": "image_scanner"`). `vpc_quota` is the same shape (line 211-216, `"Code": "vpc_num"`), as are
`instance_type`, `repo_quota` and `namespace_quota`.

So for all of those: **a change plans a diff, applies "successfully", and does nothing.** Not a
replacement, not an error — a silent no-op. That is the failure mode the offer-parity guard exists
to catch, arriving through the provider rather than through our template.

And the only Terraform way to actually change them is to replace the instance. Delete is:

```go
// resource_alicloud_cr_ee_instance.go:478-532
action := "RefundInstance"
...
request["ImmediatelyRelease"] = "1"
request["ProductCode"] = "acr"
request["ProductType"] = "acr_ee_public_cn"   // "acr_ee_public_intl" for international accounts
```

`RefundInstance` against a Subscription product, released immediately. **This** is the money event
#1845 was warning about — it just does not arrive through a VPC argument.

One mitigation, from §4.2: a Basic instance created without `image_scanner` already runs Trivy by
default, on, free. Nothing in the module needs to *set* `image_scanner` for a `scan_type = "VUL"`
rule to have an engine behind it. The ON position of the canvas switch does not require touching the
instance. The OFF position — `DISABLE` — is not expressible at all: undocumented as a product state,
and a create-only no-op on an existing instance.

## 6. The second hazard: `vpc_quota` is create-only and starts at 0

If Q1 turns out to be "yes, an AUTO rule needs the VPC", then the chain is:

1. `alicloud_cr_vpc_endpoint_linked_vpc` needs VPC access-control quota (§4.3, §4.4).
2. A Basic instance's initial quota is **0**, and quota is bought (¥72/mo/VPC).
3. Terraform can only request quota via `vpc_quota` **at create time** (§5), and a post-hoc change to
   `vpc_quota` is a silent no-op.
4. Therefore, on an **already-provisioned** Alethia registry, attaching a VPC would fail at apply with
   `INSTANCE_ACCESS_VPC_LIMIT_EXCEED`, and Terraform has no in-place way to fix it.

Which means: under the "VPC needed" reading, scanning would be deliverable on **newly created**
registries only, and every existing project's registry would need instance replacement — the
`RefundInstance` path — to get it. Under the "VPC not needed" reading, none of this applies and
`alicloud_cr_scan_rule` is a contained addition beside `alicloud_cr_ee_repo`.

The repo also does not currently have the inputs: `modules/cr` receives no `vpc_id`/`vswitch_id`
(`cr.tf:4-10`), and `provision_network` can be off.

---

## Decision implication

**#1895 asked a binary question and the binary resolves to the "can be built" branch — but not for
the reason it expected, and not without a condition.**

- **The `ForceNew` fear is refuted.** There is no VPC argument on `alicloud_cr_ee_instance` to be
  `ForceNew`. VPC attachment is a sibling resource that never replaces the Subscription registry.
  **#1845 must not be withdrawn as infeasible on `ForceNew` grounds** — that ground does not exist.
- **But the prerequisite question that sizes #1845 is unresolved and undocumented.** The docs place
  AUTO-rule creation inside a VPC-prefaced procedure while wording the VPC requirement as belonging
  to batch scanning. Building the rule now, on the reading that no VPC is needed, is precisely the
  "plans clean, scans nothing" outcome #1895 was created to prevent — and the parity guard would go
  green either way.
- **The real money hazard sits on `image_scanner` and `vpc_quota`, not on VPC.** Both are create-only
  in the provider *without* being `ForceNew`, so a change to either applies as a silent no-op, and
  the only way to actually change them is `RefundInstance` on a prepaid instance. Whatever #1845
  eventually builds, it must not put the canvas switch on either argument.
- **Good news that shrinks the ON position:** a Basic instance already runs the Trivy engine by
  default, free. The ON position needs no instance change. Only the OFF position (`DISABLE`) is
  inexpressible, and it is undocumented as a product state.

So the shape of #1845 is decided by one observation nobody has made yet, not by a schema fact. Until
that observation exists, the honest states are "blocked on a real-apply probe" or "documented
partial", not "stubbed" and not "withdrawn".

## Unresolved

| # | Question | What would settle it |
|---|---|---|
| 1 | Does a `REPO`-scoped `AUTO` `VUL` scan rule actually scan on push when the instance has **zero** linked VPCs? | A real apply: `CreateScanRule(AUTO)` on a Basic instance with no VPC → push a matching tag → poll `GetRepoTagScanStatus` / `ListRepoTagScanResult`. Main-gated in this repo. No doc page answers it; the API reference has no prerequisite note and no error-code table. |
| 2 | Does `CreateScanRule` *error* without a VPC, or return success and no-op? | Same apply. `errorCodes` for the operation is empty; `INSTANCE_ACCESS_VPC_LIMIT_EXCEED` attaches to the VPC-attach call, not to this one. |
| 3 | What is a Basic instance's VPC access-control quota *exactly* — 0, or some small included number? | Alibaba says 「初始配额可能为 0」 ("may be 0") and never states an included figure, while stating included figures for repo and namespace quotas. `GetInstanceUsage` returns `VpcQuota`/`VpcUsage` for a live instance and would answer it in one call. |
| 4 | Does `image_scanner = "DISABLE"` correspond to a real product state? | Not documented anywhere in Alibaba's product docs; the code is a BSS purchase parameter, and ACR's API has no `CreateInstance`/`UpdateInstance` operation at all (119 operations in the 2018-12-01 metadata, neither present). Would need a purchase-time experiment or Alibaba support. |
| 5 | Is the engine changeable on a live instance *outside* Terraform? | Partly answered: yes, via the console — 「安全扫描支持从云安全扫描引擎**降级**为Trivy扫描引擎，您可以在实例列表页面进行降配」 (billing page). But there is no ACR API for it and no Terraform path, so Terraform state and reality can diverge silently. |

## Sources

**Provider source, `aliyun/alicloud` v1.286.0**

- `alicloud/resource_alicloud_cr_ee_instance.go` — schema `L30-193`; `image_scanner` `L48-52`;
  `instance_name` ForceNew `L85-89`; `payment_type` ForceNew `L128-133`; `renew_period` ForceNew
  `L142-146`; `renewal_status` ForceNew `L147-153`; `vpc_quota` `L177-187`; Create's BSS parameter
  list `L210-263`; Update `L393-476`; Delete / `RefundInstance` `L478-532`.
  <https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/resource_alicloud_cr_ee_instance.go>
- `alicloud/resource_alicloud_cr_scan_rule.go` — schema `L30-78`.
  <https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/resource_alicloud_cr_scan_rule.go>
- `alicloud/resource_alicloud_cr_vpc_endpoint_linked_vpc.go` — schema `L27-58`; API action `L65`.
  <https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/resource_alicloud_cr_vpc_endpoint_linked_vpc.go>
- `alicloud/provider.go` — `L1019`, `L1472`, `L2090`.
  <https://github.com/aliyun/terraform-provider-alicloud/blob/v1.286.0/alicloud/provider.go>
- `website/docs/r/cr_ee_instance.html.markdown`, `website/docs/r/cr_scan_rule.html.markdown`,
  `website/docs/r/cr_vpc_endpoint_linked_vpc.html.markdown` (same tag).

**Alibaba first-party API**

- CR 2018-12-01 OpenAPI metadata (119 operations):
  <https://api.aliyun.com/meta/v1/products/cr/versions/2018-12-01/api-docs.json>
- `CreateScanRule`: <https://help.aliyun.com/zh/acr/developer-reference/api-cr-2018-12-01-createscanrule>
- `CreateInstanceVpcEndpointLinkedVpc`:
  <https://help.aliyun.com/zh/acr/developer-reference/api-cr-2018-12-01-createinstancevpcendpointlinkedvpc>
- `DeleteInstanceVpcEndpointLinkedVpc`:
  <https://help.aliyun.com/zh/acr/developer-reference/api-cr-2018-12-01-deleteinstancevpcendpointlinkedvpc>

**Alibaba product documentation**

- Container image security scanning (EN):
  <https://www.alibabacloud.com/help/en/acr/user-guide/scan-container-images>
- 容器镜像安全扫描 (ZH): <https://help.aliyun.com/zh/acr/user-guide/scan-container-images>
- 配置专有网络的访问控制: <https://help.aliyun.com/zh/acr/user-guide/configure-access-over-vpcs>
- 个人版与企业版实例的区别 (edition table — authoritative):
  <https://help.aliyun.com/zh/acr/product-overview/differences-between-personal-edition-instances-and-enterprise-edition-instances>
- English edition table (**known incorrect**, see §4.1):
  <https://www.alibabacloud.com/help/en/acr/product-overview/differences-between-personal-edition-instances-and-enterprise-edition-instances>
- 计费说明: <https://help.aliyun.com/zh/acr/product-overview/billing-description>
- 创建企业版实例: <https://help.aliyun.com/zh/acr/user-guide/create-a-container-registry-enterprise-edition-instance>
- 创建交付链 (Advanced-only, for contrast):
  <https://help.aliyun.com/zh/acr/user-guide/create-a-delivery-chain>

**This repo**

- `infra/templates/project/alibaba/.terraform.lock.hcl:5`
- `infra/templates/project/alibaba/main.tf:11`
- `infra/templates/project/alibaba/modules/cr/main.tf:12`, `:19-24`
- `infra/templates/project/alibaba/cr.tf:4-10`
- `infra/templates/project/alibaba/variables.tf:52-56`, `:254-258`
- `infra/templates/project/alibaba/modules/network/outputs.tf`
- `infra/offer-exclusions.yaml:419-424` (the `registry:vulnerability_scanning` / alibaba baseline
  entry, `state: no-carrier`, `issue: #1845`)
- `docs/testing/offer-parity.md:100`, `:216`
