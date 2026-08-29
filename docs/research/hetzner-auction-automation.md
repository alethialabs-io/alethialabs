<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Hetzner Robot server-auction automation — is it worth building, for our fleet (A) or for customers (B)?

Research answer, checked **2026-08-29**. Two questions that must not be conflated:

- **(A)** Grade + buy + cancel Hetzner **Serverbörse** (auction) dedicated machines to run **Alethia's own
  runner fleet** more cheaply than today's ECS Fargate service (`infra/templates/runner/aws/main.tf`).
- **(B)** A **user-facing right-sizing / placement advisor** that recommends the best-value Hetzner machine
  for a customer's declared workload shape. Alethia owns no machine.

Primary sources only: Hetzner's own Robot webservice reference, Hetzner Docs, the **live** auction feed the
Serverbörse page itself reads, Hetzner's own price data files, AWS's published price list, the Terraform
Registry API, and this repo. No secondary write-ups were used for any load-bearing claim.

---

## Verdict, up front

> **(A) Runner fleet on auction metal — NO-GO.** The entire prize is smaller than one machine. The
> self-deployed Fargate runner is **0.5 vCPU / 1 GB, `desired_count = 1`** — **USD 14.42/mo** per service,
> **≈ USD 57.67/mo** across the four services `scripts/deploy-runner.sh` redeploys. The **cheapest listing in
> the entire auction right now is EUR 60.70/mo** with an IPv4. Buying one machine costs *more* than the bill
> it replaces, and adds bare-metal provisioning, an unscopeable account-wide credential, a dead
> Talos/CSI/network carriage, and a spend guard that structurally cannot price it. Auction metal wins on
> EUR/core-hour by 2–5x, but only at ~37% sustained utilisation — and Alethia's runner duty cycle is a
> rounding error above zero.

> **(B) User-facing right-sizing advisor over the auction — NO-GO as posed; a *narrower* thing is arguably a
> GO.** Recommending an **auction** machine is unbuildable-in-spirit: the Robot API has no reservation, no
> price-lock and no scoped credential (HTTP Basic Auth, one account-wide user, IP-blocked after 3 bad
> logins), delivery is *"usually … within 1 business day"*, total global inventory today is **160 machines**,
> and Alethia's Hetzner template provisions `hcloud_server` — so we would recommend hardware **we cannot then
> provision**. What *is* defensible is right-sizing across the **Hetzner Cloud** types the templates already
> emit (`cpx*`/`ccx*`); that needs zero auction data, zero Robot credential, and is a UI/query feature, not a
> procurement system.

Neither half should be built. Section 8 says what would have to become true to reopen (A).

---

## 1. The API surface

### 1.1 Two products, two credentials, two auth schemes

Hetzner's own API index separates them explicitly ([Hetzner API overview](https://docs.hetzner.cloud/)):

> `api.hetzner.cloud` — "Using our Cloud API, you're able to manage all cloud services and resources linked to
> them" · **Servers · Load Balancers · Volumes · Firewalls · Floating IPs · Placement Groups · DNS**
>
> `robot-ws.your-server.de` — "The Robot Web Service allows managements of Dedicated Servers and resources
> related to them." · **Dedicated Server · vSwitches**

**Confirmed: the Cloud API has no auction equivalent and no dedicated-server ordering.** The enumerated Cloud
resource list contains nothing of the kind, and `GET https://api.hetzner.cloud/v1/server_types` returns
`{"error":{"code":"unauthorized"}}` — a *token* API, entirely disjoint from Robot's credential.

**Auth (Robot):** *"Authentication is done via HTTP Basic Auth. The webservice is accessible only via
HTTPS."* The credential is a **web service user** created in the Robot UI under *Settings → Web service and
app settings* — **one username + password, account-wide, no scopes, no read-only mode, no OIDC/federation**.
*"the IP from which you attempt to access will be blocked for 10 minutes after 3 failed login attempts."*
([Robot webservice reference, Preface/General](https://robot.hetzner.com/doc/webservice/en.html))

### 1.2 The auction endpoints (all quoted from the Robot reference)

| Endpoint | Purpose (Hetzner's own wording) | Request limit |
|---|---|---|
| `GET /order/server_market/product` | "Product overview of currently offered server market products" | **500 / 1 hour** |
| `GET /order/server_market/product/{product-id}` | "Query a specific server market product" | 500 / 1 hour |
| `GET /order/server_market/transaction` | list your auction orders | 500 / 1 hour |
| **`POST /order/server_market/transaction`** | **"Order a new server from the server market. If the order is successful, the status code 201 CREATED is returned."** | **20 requests per _day_** |
| `GET /order/server_market/transaction/{id}` | order status | 500 / 1 hour |
| `GET /server/{n}/cancellation` | returns `earliest_cancellation_date`, `cancelled`, `reservation_possible` | 200 / 1 hour |
| **`POST /server/{n}/cancellation`** | "Cancel a server". Input `cancellation_date` = *"Date to which the server should be cancelled or **"now"** to cancel immediately"* | 200 / 1 hour |
| `DELETE /server/{n}/cancellation` | withdraw an active cancellation | 200 / 1 hour |

`POST /order/server_market/transaction` inputs: `product_id`, `authorized_key[]` **or** `password`, `dist`,
`lang`, `comment`, `addon[]`, **`test`** ("The order will not be processed if set to `true`"). Two notes
matter:

- *"Please note that if a comment is supplied, the order will be processed **manually**."* — so a bot must
  never set `comment`.
- *"If you do not specify the parameter `addon`, the server will be ordered **without an IPv4 address** by
  default."* Confirmed in the ordering preamble: *"As of 28 March 2022, the listed prices no longer include
  the 'Primary IPv4' addon. By default, we deploy servers as IPv6-only servers."* Primary IPv4 = **EUR
  1.70/mo net, EUR 0.0027/h**.

Documented failure mode: **`412 PRECONDITION_FAILED` — "Order cannot be accepted. Please place your order via
the web frontend for further details."** The API can refuse and hand you back to a human.

### 1.3 Ordering is genuinely API-driven — but gated, and the docs contradict themselves

- The ordering endpoints must be **switched on by hand first**: *"To use the Robot webservice for ordering
  servers, please activate this function in your Robot administrative interface first via 'Administration;
  Settings; Web Service Settings; Ordering'."*
- The [Server Auction FAQ](https://docs.hetzner.com/robot/general/server-auction-faqs/) says the opposite for
  the *web* path: *"You also need to order servers from the Auction via the Server Auction page. You need to
  use this page to make your bid. **(You can't bid on servers via Robot.)**"* Read against the API reference,
  the consistent reading is *the Robot **web UI** has no bid page; the Robot **webservice** does*. **This is
  an unresolved ambiguity I could not settle without a Robot account** — see §9.
- **Cancellation is genuinely API-driven and immediate.** `cancellation_date="now"`, and Hetzner Docs for
  dedicated servers: *"You can only cancel **immediately**."*

### 1.4 The live auction feed (no credential needed)

The Serverbörse page reads `https://www.hetzner.com/_resources/app/data/bench/cloud_data.json`'s sibling
**`https://www.hetzner.com/_resources/app/data/app/live_data_sb.json`** (found in
`/_resources/themes/hetzner/dist/vendors.js`). It is public, unauthenticated, and carries per-listing
`Prices.monthly`, `Prices.hourly`, `Prices.setup`, `IPPrices`, `Hardware.{CPU,RAM,Storage}`,
`Details.{Traffic,Bandwidth,Datacenter}` and a `Timer.ReduceNext` countdown. Every number in §2 is computed
from a snapshot of this file taken **2026-08-29**.

---

## 2. The real price

### 2.1 The premise of the question is out of date — there is **no** monthly floor

The brief assumed auction servers "bill monthly, not hourly" and carry a cancellation notice period. **Both
are false as of the current Hetzner terms.** Three independent Hetzner pages say so:

- [Billing system at Hetzner](https://docs.hetzner.com/general/billing-and-account-management/billing-at-hetzner/billing-system-hetzner/)
  (last change 2026-08-28): *"Billing begins when we give you access to a product. We will use the **hourly
  price** as long as the product has not been used for almost the entire calendar month… We round up partial
  hours. **The total cost is never more than the monthly price.**"*
- [Cancellations on Robot](https://docs.hetzner.com/general/billing-and-account-management/cancellation/cancellations-robot/)
  (last change 2026-08-06), *Canceling dedicated servers → Notes*: *"You can only cancel **immediately**. We
  bill **by the hour** and never exceed the monthly price cap."*
- [30 days to the end of the month](https://docs.hetzner.com/general/billing-and-account-management/cancellation/30-days-to-the-end-of-the-month/):
  *"It is possible to immediately cancel almost all of our products and to only pay the hourly price."*
- Server Auction FAQ: *"**There are no setup fees for these servers.**"* · *"All dedicated root servers
  (including those from the Server Auction) have **unlimited traffic**."* · *"you get a dedicated uplink with
  guaranteed bandwidth of **1 Gbit/s**."* · *"The cancellation period for these servers is usually
  **immediately**."*

The live feed corroborates: **all 160 listings** have `setup: {EUR: 0}`, `Traffic: "unlimited"`,
`Bandwidth: 1000`, and a non-null `hourly` price.

**So the cost model is:** `min(hours_held × hourly, monthly)`, plus EUR 1.70/mo (EUR 0.0027/h) if you want
IPv4. No setup fee. No traffic overage. No notice period.

**Break-even (the hourly cap kicks in):** every listing has `monthly / hourly = 623.7 h` exactly (e.g. EUR
59.00 / EUR 0.0946 = 623.7; EUR 60.00 / EUR 0.0962 = 623.7). Hetzner Cloud uses the same divisor (CPX42: EUR
69.49 / EUR 0.1114 = 623.8). **≈ 624 hours ≈ 26.0 days.** Past that you are paying the monthly price.

### 2.2 Assumptions stated

1. All EUR figures are **net (excl. VAT)** — Hetzner's `price` vs `price_vat` are identical for a
   non-VAT-liable account, and the auction feed's `Prices.monthly.EUR` is the net figure.
2. **A primary IPv4 is included in every auction figure below** (+EUR 1.70/mo, +EUR 0.0027/h) and in every
   Hetzner Cloud figure (+EUR 0.50/mo, +EUR 0.0008/h —
   [Hetzner Cloud servers overview](https://docs.hetzner.com/cloud/servers/overview/): *"We charge an
   additional cost of € 0.50/month (excl. VAT) for our Primary IPs of type IPv4"*). Omitting it would be
   arguing against a container runtime that can't reach an IPv4-only registry.
3. **Auction CPUs are counted in SMT threads *and* physical cores**, both shown. The feed's
   `Hardware.CPU.CoreCount` is a **socket** count (it is `1` for every listing including the 32-core EPYC),
   so core/thread counts come from the CPU model names in `Hardware.CPU.Name` against vendor spec. A Hetzner
   Cloud `vCPU` is one thread, so **thread-hour is the honest like-for-like column**; core-hour flatters the
   auction, thread-hour does not.
4. USD→EUR at **1 EUR = 1.15 USD**, stated because Hetzner's own list prices imply inconsistent rates (1.18
   for CPX42, 1.12 for an auction listing) — these are list prices, not FX. Every ratio below is 2x or larger,
   so the conclusion is insensitive to ±10% on this.
5. Traffic is free on both sides in-EU at this scale (auction: unlimited; Hetzner Cloud: 20 TB included), so
   it drops out. It would *not* drop out on AWS.

### 2.3 Auction — live listings, 2026-08-29 (incl. IPv4)

| Listing | threads / cores | RAM | EUR/mo | EUR/h | **EUR/thread-h** | EUR/core-h | **EUR/GB-h** |
|---|---|---|---|---|---|---|---|
| Xeon W-2295, HEL1-DC8 | 36t / 18c | 128 GB | 128.70 | 0.2062 | **0.00573** | 0.01146 | **0.001611** |
| Threadripper 2950X, FSN1-DC5 | 32t / 16c | 128 GB | 118.70 | 0.1902 | 0.00594 | 0.01189 | 0.001486 |
| Core i9-13900, HEL1-DC12 | 32t / 24c | 64 GB | 132.70 | 0.2126 | 0.00664 | 0.00886 | 0.003322 |
| EPYC 7502P, HEL1-DC8 | 64t / 32c | 128 GB | 265.70 | 0.4258 | 0.00665 | 0.01331 | 0.003327 |
| Xeon E5-1650V3, FSN1-DC4 | 12t / 6c | 256 GB | 100.70 | 0.1614 | 0.01345 | 0.02690 | **0.000630** |
| *cheapest listing:* i7-6700, FSN1-DC8 | 8t / 4c | 32 GB | **60.70** | 0.0973 | 0.01216 | 0.02432 | 0.003041 |

Whole-market medians over the 160 listings: **EUR 0.01236/thread-h**, **EUR 0.002085/GB-h**, median sticker
**EUR 83.00/mo**.

### 2.4 Hetzner Cloud — what this repo actually provisions (incl. IPv4)

Prices from Hetzner's own `cloud_data.json` (NBG1/HEL1, EUR net); specs from
[hetzner.com/cloud/regular-performance](https://www.hetzner.com/cloud/regular-performance/) and
[/cloud/general-purpose](https://www.hetzner.com/cloud/general-purpose/).

| Type | vCPU | RAM | EUR/mo | EUR/h | **EUR/vCPU-h** | **EUR/GB-h** |
|---|---|---|---|---|---|---|
| CPX22 *(template default)* | 2 | 4 GB | 19.99 | 0.0320 | 0.01600 | 0.008000 |
| CPX32 | 4 | 8 GB | 35.99 | 0.0577 | 0.01443 | 0.007213 |
| CPX42 *(the sandbox box)* | 8 | 16 GB | 69.99 | 0.1122 | 0.01402 | 0.007012 |
| CPX62 | 16 | 32 GB | 130.49 | 0.2091 | 0.01307 | 0.006534 |
| CCX33 *(dedicated vCPU)* | 8 | 32 GB | 138.99 | 0.2227 | 0.02784 | 0.006959 |
| CCX43 | 16 | 64 GB | 276.49 | 0.4431 | 0.02769 | 0.006923 |
| CCX63 | 48 | 192 GB | 853.99 | 1.3686 | 0.02851 | 0.007128 |

### 2.5 AWS / GCP / Azure

**AWS Fargate**, from AWS's own price list
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/<region>/index.json`) — this is
the incumbent, so it is the comparison that decides (A):

| | USD/vCPU-h | USD/GB-h | EUR/vCPU-h @1.15 | EUR/GB-h |
|---|---|---|---|---|
| eu-west-1 ARM64 | 0.032380 | 0.003560 | 0.02816 | 0.003096 |
| eu-west-1 x86 | 0.040480 | 0.004445 | 0.03520 | 0.003865 |
| eu-central-1 ARM64 | 0.037250 | 0.004090 | 0.03239 | 0.003557 |
| eu-central-1 x86 | 0.046560 | 0.005110 | 0.04049 | 0.004443 |

**VM-equivalents.** Hetzner publishes its own cross-provider comparison at
`https://www.hetzner.com/_resources/app/data/bench/cloud_bench_shared.json` (the data behind the CPX page's
price chart). Treat it as a **vendor's own comparison**, not neutral — but the `min_price_ondemand_monthly`
column is the vendors' published on-demand compute:

| vCPU | AWS | Azure | GCP | Hetzner Cloud |
|---|---|---|---|---|
| 2 | t3a.medium — **EUR 15.38/mo** | D2_v5 — EUR 59.99 | e2-standard-2 — EUR 41.87 | cpx22 — EUR 19.47 |
| 4 | t3a.xlarge — EUR 61.62 | D4_v5 — EUR 119.99 | e2-standard-4 — EUR 83.74 | cpx32 — EUR 35.45 |
| 8 | t3a.2xlarge — EUR 123.17 | D8_v5 — EUR 239.98 | e2-standard-8 — EUR 167.49 | cpx42 — EUR 69.40 |
| 16 | m5.4xlarge — EUR 479.96 | D16_v5 — EUR 479.96 | e2-standard-16 — EUR 335.03 | cpx62 — EUR 129.98 |

### 2.6 The ratios — auction really is cheaper per unit

Against the best auction listing (Xeon W-2295: EUR 0.00573/thread-h, EUR 0.001611/GB-h):

| Comparator | EUR/vCPU-h | ratio | EUR/GB-h | ratio |
|---|---|---|---|---|
| Hetzner Cloud CPX62 (shared vCPU) | 0.01307 | **2.28x** | 0.006534 | **4.06x** |
| Hetzner Cloud CCX43 (dedicated vCPU) | 0.02769 | **4.83x** | 0.006923 | **4.30x** |
| AWS Fargate ARM64, eu-west-1 | 0.02816 | **4.92x** | 0.003096 | **1.92x** |

**So the headline is true: 2–5x cheaper per unit of capacity.** It is also irrelevant, for the reason in §3.

### 2.7 The number that actually decides (A): break-even utilisation

An auction box is capacity you **hold**; Hetzner Cloud is capacity you **rent by the hour** with no minimum.
So the comparison is not price-per-unit, it is *how many hours a month you'd actually use it*.

Take the best listing — W-2295, 36 threads / 128 GB, **EUR 128.70/mo held 24/7**. To buy the same 36 threads
on demand you need 2.25 × CPX62 = EUR 0.4705/h:

```
break-even hours = 128.70 / 0.4705 = 274 h/month = 274/730 = 37% utilisation
```

On the RAM axis (4 × CPX62 = 128 GB, EUR 0.8364/h): `128.70 / 0.8364 = 154 h/mo = 21% utilisation`.

**Below ~21–37% duty cycle, on-demand Hetzner Cloud is strictly cheaper than owning the auction box** — before
counting a single hour of engineering.

---

## 3. Workload fit — this is the wrong workload, quantified

The brief asks whether bursty e2e is where auction metal wins or loses worst. **It loses worst**, and the
repo's own numbers say by how much.

**Baseline capacity vs burst capacity.** Auction metal is a *baseline* instrument: a fixed slab you hold and
amortise. It wins when a floor of demand is continuous. Alethia's compute is almost entirely **burst**:

- `.github/workflows/e2e-nightly.yml:44` — one cron, `17 3 * * *`, matrix
  `["hetzner","aws","gcp","azure","alibaba"]`, `max-parallel: 3`. **Up to 5 legs a night**, each a single
  tiny cluster.
- `.github/workflows/e2e-nightly.yml:26-29` — *"Cost per run is a single tiny Talos cluster (1 control plane
  + 1 worker, cpx22 amd64) up for ~15–25 min, torn down at the end — **on the order of a few euro-cents**."*
- `scripts/check-e2e-spend-guard.mjs:74` — *"the measured cost of a hetzner full bar is **cents per run
  (~EUR 0.02-0.10)**"*.
- The clusters under test are provisioned **in the target cloud**, not on the runner. The runner is a
  **0.5 vCPU / 1 GB** control process (`infra/templates/runner/aws/variables.tf:33-43`, `cpu = 512`,
  `memory = 1024`).

**The prize, in full.** `infra/templates/runner/aws/main.tf:188-203` — `desired_count = 1`,
`launch_type = "FARGATE"`, `runtime_platform { cpu_architecture = "ARM64" }`, and **no autoscaling resource
in the file at all**. `apps/docs/content/docs/runner/self-hosted.mdx:148` states the posture:
*"| Scaling | 60s warm-pool loop, by queue depth | ECS `desired_count` (**you**) | You start/stop it |"*.

```
Fargate ARM64, eu-west-1:  0.5 × 0.032380 + 1 × 0.003560 = USD 0.01975 /h
                                                        = USD 14.42 /mo  (730 h)
scripts/deploy-runner.sh force-redeploys 4 services      = USD 57.67 /mo ≈ EUR 50.15 /mo
```

**EUR 50.15/mo is the entire addressable spend for half (A).** The cheapest machine in the auction is
**EUR 60.70/mo**. A single purchase is a **21% cost increase** before any engineering, and it buys 8 threads
where 2 vCPU are in use.

**And the managed fleet is already on Hetzner.** `apps/console/lib/fleet/hcloud.ts:113` —
`DEFAULT_SERVER_TYPES = ["cax21", "cpx31"]`, driven by a 60s warm-pool scaler
(`ARCHITECTURE.md:149-151`); `apps/console/lib/fleet/costs.ts:9-22` prices them at
`cax21: 6.49 / 730` ≈ **EUR 0.0089/h**. The "much more compute per euro by moving to Hetzner" move **was
already made**, on the hourly product, at the right granularity. Auction metal would be a *regression* from
scale-to-zero to a permanently-held slab.

**Delivery latency finishes it.** Server Auction FAQ: *"How long does it take to deploy or deliver a server
from the Auction? **Usually, we can deploy these servers within 1 business day.** It may also go more quickly.
Some orders may take longer."* A capacity source with a business-day SLA cannot serve a workload measured in
`clusterReadyTimeout = "8m"` (`test/e2e/t2_providers.go`). And `POST /order/server_market/transaction` is
capped at **20 requests per day** — a hard ceiling on any buy-per-burst design.

---

## 4. The provisioning path — an entirely new carriage, not an extension

### 4.1 What exists today is `hcloud`-shaped end to end

`infra/templates/project/hetzner/`:

- `image.tf` — Talos Image Factory with **`platform = "hcloud"`**, then `imager_image` (which boots a rescue
  *cloud* server, `dd`s the raw.xz, and snapshots the disk) → an hcloud **snapshot id**.
- `servers.tf` — `resource "hcloud_server"` with `image = <snapshot id>`, **`user_data =
  data.talos_machine_configuration.*.machine_configuration`**, a `network { network_id, ip }` block, and
  `firewall_ids = [hcloud_firewall.this.id]`.
- `network.tf` — `hcloud_network` + `hcloud_network_subnet`, deterministic private IPs via `cidrhost`.
- `csi.tf` — `hcloud-csi` v2.22.0, *"`hcloud-volumes` StorageClass is made the cluster **DEFAULT**"*.

**Not one of those five resources exists for a Robot dedicated server.**

### 4.2 Every layer breaks

| Layer | Hetzner Cloud (today) | Robot dedicated | Source |
|---|---|---|---|
| **OS install** | snapshot id + `user_data` on `hcloud_server` | rescue system → `dd` metal image → reboot → maintenance mode → `talosctl apply-config` over the network | Sidero's Hetzner page documents **Hetzner Cloud only** ("Rescue mode", "Packer", "hcloud-upload-image" — all ending in `hcloud server create … --user-data-from-file`) |
| **Talos platform** | `platform = "hcloud"` (metadata service) | `metal` — no metadata service, so config must be pushed or served by iPXE | `infra/templates/project/hetzner/image.tf` |
| **Private network** | `hcloud_network` + automatic in-guest config | **vSwitch**: VLAN 4000–4091, **MTU 1400**, tagged VLAN configured **by you inside the OS** | [vSwitch](https://docs.hetzner.com/robot/dedicated-server/network/vswitch/) · [Connect Dedicated Servers (vSwitch)](https://docs.hetzner.com/cloud/networks/connect-dedi-vswitch/): *"For cloud servers, the network configuration inside your operating system is automatically done. For dedicated root servers, **you need to do this configuration yourself**."* Also *"limit of **1 vSwitch per Network**"* and *"not yet possible to set up a dedicated server as router for the Private Network"* |
| **Block storage** | `hcloud-csi`, default StorageClass | **impossible** — [Volumes FAQ](https://docs.hetzner.com/cloud/volumes/faq/): *"Can I also mount Hetzner Cloud Volumes on a Hetzner dedicated root server? **Unfortunately not: Volumes only work with cloud servers.**"* | |
| **IaC** | official `hetznercloud/hcloud` provider | **no official provider.** The most-published community one, `strng-solutions/hetzner-robot` v4.0.0 (2026-02-04, *community* tier, 15,574 downloads) exposes resources **`boot`, `firewall`, `vswitch`** and data sources **`boot`, `server`, `vswitch`** — **no server ordering, no cancellation** | Terraform Registry API |
| **Lifecycle** | `tofu apply` / `destroy` | order + cancel are **outside Terraform entirely**; you write a Go client against `robot-ws` | |

### 4.3 Effort

Not an extension of the Hetzner carriage — a **second carriage**. Minimum viable set:

1. A Robot webservice client in `packages/core` (order, poll transaction, cancel, list market) with its own
   credential handling and rate-limit accounting (20 orders/day, 500 GETs/h, 200 cancels/h).
2. A bare-metal Talos install path: rescue boot → write metal image → maintenance mode → apply config →
   verify. (`totalos`, `talos-manager` and `bunnyshell/open-talos-hetzner-builder` all exist as prior art
   precisely because this is non-trivial.)
3. vSwitch creation + attachment + in-Talos VLAN/MTU-1400 machine-config, and the cloud-Network coupling
   (1 vSwitch per Network).
4. A replacement for `hcloud-csi` (local paths, or an over-network CSI), i.e. a different storage story for
   anything stateful.
5. Sweeper/reaper coverage: `scripts/e2e/hcloud-cleanup.sh` sweeps by **hcloud label selector**
   (`cluster=<name>`). Robot servers carry no labels and are not in the hcloud API — **the existing leak
   guarantee does not reach them at all**, and a leak here is a recurring monthly charge, not cents.
6. Order-side and cancel-side approval controls (§5).

**Rough order: weeks, not days — and it lands entirely outside every guard the repo already has.** Against a
prize of EUR 50/mo.

---

## 5. Spend-authority risk — the existing controls cannot bind here

The brief is right that this is a different risk class, and the repo's two guards both miss it.

**The Infracost cost ceiling cannot price it — structurally.**
`packages/core/provisioner/cost_ceiling.go` is fail-closed and correct on its own terms:

> *"a ceiling was requested but we can't price the plan, so we REFUSE rather than let an unpriced plan
> through"* — and it blocks when `cb == nil || cb.Summary == nil`.

But it prices **an OpenTofu plan file** by shelling out to the Infracost CLI
(`packages/core/infracost/infracost.go:232`, `infracost breakdown --path … --format json`). And
[Infracost's own docs](https://www.infracost.io/docs/supported_resources/overview/) state: *"Infracost
supports over **1,100** Terraform resources across **AWS**, **Azure** and **Google**."* **Hetzner is not
supported at all.** The repo already records the consequence — `scripts/check-e2e-spend-guard.mjs:73-75`
carries an `UNPRICED_EXEMPTIONS` entry for hetzner (*"Unproven estimate, and the measured cost of a hetzner
full bar is cents per run"*), and the only ceiling actually wired in
`.github/workflows/e2e-nightly.yml:1440` is **`matrix.provider == 'aws'`** (USD 300 floor / USD 600 heavy);
every other provider gets `''`, i.e. **no gate**.

A Robot auction order is not a Terraform plan at all. **There is no path by which the existing ceiling ever
sees it.**

**The reapers do not reach it either.** `scripts/e2e/hcloud-cleanup.sh` is scoped to
`cluster=<CLUSTER_NAME>` label selectors on the **hcloud** API; `scripts/env.sh`'s `env:reap` snapshots and
deletes an `hcloud_server`. Robot dedicated servers are invisible to both. Today a forgotten resource costs
*"EUR 0.72/mo reaped"* vs *"EUR 69.49"* left up (`infra/sandbox/variables.tf:55-92`) — with an auction box,
a forgotten resource is EUR 60–270/mo, recurring, until someone notices an invoice.

**What would have to bind before anything is bought automatically.** Minimum, all of them:

1. **A hard budget in code, priced from the auction feed itself** — Infracost can never do this, so a
   Hetzner-native ceiling (sum of `Prices.monthly` for held machines + the candidate) must exist and
   fail-closed the same way `cost_ceiling.go` does.
2. **A per-order cap and a fleet-wide cap on machines *and* on EUR/month**, checked against the *live
   inventory read back from Robot*, not against local state (state can be stale; the invoice cannot).
3. **`test=true` dry-run first, every time** — the API supports it; a real order must be the second call.
4. **A credential the harness can constrain.** Robot Basic Auth is account-wide with no scopes: the same
   credential that orders a machine can cancel every existing one and reset every server. Under this repo's
   deny-rule model (`.claude/settings.json` — `deny` covers reads/edits of credential files, `tofu apply`,
   pushes to `main`), an agent-reachable Robot password is a strictly worse primitive than an hcloud token,
   which is itself already deny-listed for destructive ops.
5. **A reaper that enumerates `GET /server` and cross-references an owner ledger**, with the same
   CLEAN/LEAKED/UNVERIFIABLE probe contract as `scripts/e2e/lib/sweep-probe.sh` — a Robot leak is recurring,
   so the existing "guards that report green" failure mode is far more expensive here.
6. **A human approval step on the order path**, because §1.2's `412 PRECONDITION_FAILED` means Hetzner itself
   sometimes routes an order back to a human, and because an agent that can create recurring contracts is
   exactly the class `.claude/hooks/guard-iac.sh` exists to refuse for IaC.

Items 1, 2, 5 and 6 are all **new** — none of them can be got by reusing what exists.

---

## 6. Prior art

| Project | What it does | Verdict |
|---|---|---|
| [elsbrock/hetzner-radar](https://github.com/elsbrock/hetzner-radar) ("Server Radar") | AGPL-3.0, ~385 stars. Tracks auction prices/volumes over time, filters configurations, alerts when a target price is met. Pulls the auction feed every 5 min. **Does not order, buy, or cancel.** | **The grading half of (A)/(B) is already a solved, maintained, free product.** |
| [madfam-org/server-auction-tracker](https://github.com/madfam-org/server-auction-tracker) | MIT, 0 stars / 0 forks. `foundry-scout` CLI: scan, price history, watch, simulate cluster impact, and *"Auto-order via Hetzner Robot API with safety gates"* (behind an `order.enabled` flag + Robot creds). Cancellation not mentioned. | **The auto-buy half already exists too** — as an unproven single-author project. Its existence proves feasibility and simultaneously proves it isn't a moat. |
| [ytspar/hetzner-cli](https://github.com/ytspar/hetzner-cli) | Node CLI/library for the Robot API | commodity client |
| `totalos`, `talos-manager`, `bunnyshell/open-talos-hetzner-builder` | Bare-metal Talos bootstrap on Hetzner (rescue → maintenance mode) | the §4 carriage exists as prior art, but as *tools we'd integrate*, not a path our template can take |

If Alethia ever wanted auction *visibility*, Server Radar is a hosted free product and a 5-minute browser tab.
Building a grader is re-implementing it.

---

## 7. Half (B) specifically — why the advisor as posed fails, and what survives

The brief's framing for (B) is that it "does NOT require Alethia to own any machine." True — and still
no-go, for four reasons that are each independently fatal:

1. **We would recommend hardware we cannot provision.** `infra/templates/project/hetzner/` emits
   `hcloud_server` only. A recommendation for `Xeon W-2295, HEL1-DC8, EUR 128.70/mo` terminates in "now go do
   it by hand, and also re-do our whole Talos/CSI/network story yourself." The advice is unactionable inside
   the product.
2. **The recommendation is stale on arrival.** The auction is Dutch: *"The prices start high, and go down over
   time… **If you wait too long, someone else might buy the server you want.**"* There is no reservation
   endpoint and no price lock. In my snapshot the median time to the next price drop was ~12.4 h, with one
   listing at 0 s. Total global inventory is **160 machines**; only **33** have ≥128 GB; **66** have any NVMe;
   **53** have ECC. A recommendation engine over a 160-row, first-come-first-served, single-tenant pool is a
   lottery ticket generator.
3. **No delegable credential.** Robot is HTTP Basic Auth on one account-wide user with no scopes and no
   read-only mode. Alethia would have to ask customers for a credential that can cancel their entire estate —
   the exact opposite of the keyless / no-key-leakage posture in
   `.claude/skills/alethia-security-review/SKILL.md`. There is no "read the auction on the customer's behalf"
   that is weaker than "control everything".
4. **The repo has no advisor surface to hang it on.** Confirmed: no right-sizing / recommendation feature
   exists. `placement` in this codebase means **cloud/fabric placement**
   (`packages/core/provisioner/placement.go`, `apps/console/components/design-project/placement-selector.tsx`);
   `advisor` means **the AI model tier** (`apps/console/lib/config/ai.ts:36`); the only "right-size" string is
   the third-party **goldilocks** Helm add-on in `apps/console/lib/addons/catalog.ts:1000-1013`
   (*"recommends CPU/memory requests + limits from actual usage (needs VPA)"*) — a chart we install, not a
   feature we own. Half (B) is a greenfield feature, not an increment.

**What survives.** "Pick the best-value machine for your declared workload shape" is a real user need, and it
is answerable **entirely within Hetzner Cloud**, whose full price/spec table is public
(`cloud_data.json` + the CPX/CCX pages), whose types the template already accepts
(`control_plane_server_type` / `worker_server_type`), whose capacity is on-demand, and which needs **no Robot
credential at all**. §2.4 is the whole dataset. That is a query + a UI affordance on the existing canvas,
and it is a different (much smaller) proposal — worth writing up separately if wanted, not worth conflating
with an auction procurement system.

---

## 8. What would have to change to reopen (A)

All four, together — any one alone is insufficient:

1. **Sustained runner demand above ~37% of a 36-thread box** — i.e. roughly 270+ machine-hours a month of
   continuous runner compute. Today it is a 0.5-vCPU control process and five nightly clusters.
2. **A build/CI workload that is genuinely CPU-bound and continuous** (e.g. compiling every PR on self-hosted
   runners, or a persistent Kubernetes lab), where the slab amortises.
3. **A Hetzner-native cost ceiling**, because Infracost will never price this (§5).
4. **A reaper that enumerates `GET /server`**, because a Robot leak is recurring and invisible to every
   sweeper that exists.

Even then, the honest first move is **Hetzner Cloud CCX/CPX held continuously** (same account, same token,
same template, same reaper, same labels, hourly, no business-day delivery) — which recovers most of the
saving at ~0 engineering. Auction metal is the *last* 2x, bought with a whole new carriage.

---

## 9. What I could not establish

- **The Robot-vs-web ordering contradiction is unresolved.** The API reference documents
  `POST /order/server_market/transaction` and an activation switch for it; the Server Auction FAQ says
  *"You can't bid on servers via Robot."* I read this as *web UI vs webservice*, but **I have no Robot account
  and could not test it**. If ordering is in fact web-only, half (A) is dead on arrival for an additional
  reason. This is the single fact I would verify first if anyone revisits this.
- **Real delivery latency is unmeasured.** Hetzner says *"usually … within 1 business day"*; I could not
  observe an actual auction order's `in process → ready` transition. It may routinely be minutes. The
  business-day figure is the only *documented* number and is the one I costed against.
- **Auction inventory dynamics are a single snapshot.** 160 listings, 2026-08-29. I did not observe
  restock rate, time-to-sale, or how often a given shape is available. Hetzner is explicit that supply is
  driven by other customers' cancellations (*"We only add servers to the Auction once the previous user has
  cancelled them"*), so a "buy shape X on demand" design has an availability risk I have not quantified.
- **Core counts are inferred from CPU model names**, because the feed's `CoreCount` is a socket count. A
  mis-mapped model would move a single row of §2.3, not the conclusion (the thread-hour ratios are 2–5x).
- **AWS/GCP/Azure VM prices in §2.5 come from Hetzner's own comparison file**, not from each vendor's price
  list. Only the **Fargate** numbers are first-party AWS — and Fargate is the incumbent, so the decisive
  comparison is first-party. Treat the §2.5 table as directional.
- **VAT and account currency.** All figures are net. Hetzner bills in the account's currency
  (`GET /order/currency`); I assumed EUR. A USD-denominated account pays Hetzner's USD list, which is *not*
  a straight FX conversion (§2.2 assumption 4).
- **I did not verify Talos's `metal` platform against a Hetzner dedicated NIC layout.** Sidero's Hetzner page
  covers Cloud only; the bare-metal path is documented by third-party tooling, which I did not read in depth
  because it does not change the "new carriage" conclusion.
- **The Hetzner Cloud `cpx11/21/31` types priced in `apps/console/lib/fleet/costs.ts:9-22` have no EU price in
  Hetzner's current `cloud_data.json`** (only the newer `cpx12…62` generation does). That is a possible stale
  cost model in the fleet COGS view — out of scope here, but worth a separate look.

---

## Sources

Hetzner (primary):
- Robot webservice reference — https://robot.hetzner.com/doc/webservice/en.html
- Hetzner API overview (Cloud vs Robot split) — https://docs.hetzner.cloud/
- Server Auction FAQs — https://docs.hetzner.com/robot/general/server-auction-faqs/
- Billing system at Hetzner — https://docs.hetzner.com/general/billing-and-account-management/billing-at-hetzner/billing-system-hetzner/
- Cancellations on Robot — https://docs.hetzner.com/general/billing-and-account-management/cancellation/cancellations-robot/
- 30 days to the end of the month — https://docs.hetzner.com/general/billing-and-account-management/cancellation/30-days-to-the-end-of-the-month/
- vSwitch — https://docs.hetzner.com/robot/dedicated-server/network/vswitch/
- Connect Dedicated Servers (vSwitch) to Cloud Networks — https://docs.hetzner.com/cloud/networks/connect-dedi-vswitch/
- Cloud Volumes FAQ — https://docs.hetzner.com/cloud/volumes/faq/
- Cloud servers overview (IPv4 EUR 0.50/mo) — https://docs.hetzner.com/cloud/servers/overview/
- Live auction feed — https://www.hetzner.com/_resources/app/data/app/live_data_sb.json (snapshot 2026-08-29)
- Cloud price data — https://www.hetzner.com/_resources/app/data/bench/cloud_data.json
- Cross-provider comparison data — https://www.hetzner.com/_resources/app/data/bench/cloud_bench_shared.json
- CPX specs — https://www.hetzner.com/cloud/regular-performance/ · CCX specs — https://www.hetzner.com/cloud/general-purpose/
- Server Auction listing page — https://www.hetzner.com/sb/

Other primary:
- AWS price list, ECS/Fargate — https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/eu-west-1/index.json and `.../eu-central-1/index.json`
- Infracost supported clouds — https://www.infracost.io/docs/supported_resources/overview/
- Terraform Registry API — https://registry.terraform.io/v1/providers/strng-solutions/hetzner-robot
- Sidero Talos, Hetzner platform install — https://docs.siderolabs.com/talos/v1.11/platform-specific-installations/cloud-platforms/hetzner
- Server Radar — https://github.com/elsbrock/hetzner-radar
- server-auction-tracker — https://github.com/madfam-org/server-auction-tracker

This repo (paths absolute from repo root):
- `infra/templates/runner/aws/{main.tf,variables.tf}` · `scripts/deploy-runner.sh`
- `infra/templates/project/hetzner/{image.tf,servers.tf,network.tf,csi.tf,variables.tf}`
- `packages/core/provisioner/cost_ceiling.go` · `packages/core/infracost/infracost.go`
- `scripts/check-e2e-spend-guard.mjs` · `.github/workflows/e2e-nightly.yml`
- `scripts/e2e/hcloud-cleanup.sh` · `scripts/env.sh` · `infra/sandbox/variables.tf`
- `apps/console/lib/fleet/{hcloud.ts,costs.ts}` · `apps/console/lib/addons/catalog.ts`
- `apps/docs/content/docs/runner/self-hosted.mdx` · `ARCHITECTURE.md`
