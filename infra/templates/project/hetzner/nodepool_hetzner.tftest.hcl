# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# What the Hetzner template BUILDS from node_labels, node_taints and extra_node_pools (#5536). The
# contract's own cases (nodepool_contract.tftest.hcl) prove the shared rules and the render; this file
# proves the Talos half: which servers exist, what they join with, and what machine-config patch
# carries each label and taint. The mocks are checks_dns_and_network.tftest.hcl's (see its header).

mock_provider "hcloud" {
  mock_resource "hcloud_network" {
    defaults = { id = "4141" }
  }
  mock_resource "hcloud_firewall" {
    defaults = { id = "4142" }
  }
  mock_resource "hcloud_primary_ip" {
    defaults = { id = "4143" }
  }
  # The extra pools' subnet ledger (#5595) reads as on a FRESH cluster: no firewall, no pool servers.
  # Runs that need a recorded ledger override these per run. Pinned rather than left to the mock, so
  # a generated value can never be read as a record.
  mock_data "hcloud_firewalls" {
    defaults = { firewalls = [] }
  }
  mock_data "hcloud_servers" {
    defaults = { servers = [] }
  }
}

mock_provider "talos" {}
mock_provider "imager" {}

# Each architecture's Talos snapshot gets its OWN id, so a pool that boots the wrong architecture's
# image is told apart from one that boots the right one. (Left to mock_provider, both ids are the
# same generated value, and the per-arch image assertion below could not fail.)
override_resource {
  target = imager_image.arm64
  values = { image_id = "talos-arm64-snapshot" }
}

override_resource {
  target = imager_image.amd64
  values = { image_id = "talos-amd64-snapshot" }
}

# imager_image validates that its image_url is https, which a generated mock string is not. Only the
# subnet runs below APPLY, and they need it.
override_data {
  target = data.talos_image_factory_urls.amd64
  values = {
    urls = {
      disk_image            = "https://factory.talos.dev/image/mock/amd64/disk_image"
      disk_image_secureboot = "https://factory.talos.dev/image/mock/amd64/disk_image_secureboot"
      initramfs             = "https://factory.talos.dev/image/mock/amd64/initramfs"
      installer             = "https://factory.talos.dev/image/mock/amd64/installer"
      installer_secureboot  = "https://factory.talos.dev/image/mock/amd64/installer_secureboot"
      iso                   = "https://factory.talos.dev/image/mock/amd64/iso"
      iso_secureboot        = "https://factory.talos.dev/image/mock/amd64/iso_secureboot"
      kernel                = "https://factory.talos.dev/image/mock/amd64/kernel"
      kernel_command_line   = "https://factory.talos.dev/image/mock/amd64/kernel_command_line"
      pxe                   = "https://factory.talos.dev/image/mock/amd64/pxe"
      uki                   = "https://factory.talos.dev/image/mock/amd64/uki"
    }
  }
}

override_data {
  target = data.talos_image_factory_urls.arm64
  values = {
    urls = {
      disk_image            = "https://factory.talos.dev/image/mock/arm64/disk_image"
      disk_image_secureboot = "https://factory.talos.dev/image/mock/arm64/disk_image_secureboot"
      initramfs             = "https://factory.talos.dev/image/mock/arm64/initramfs"
      installer             = "https://factory.talos.dev/image/mock/arm64/installer"
      installer_secureboot  = "https://factory.talos.dev/image/mock/arm64/installer_secureboot"
      iso                   = "https://factory.talos.dev/image/mock/arm64/iso"
      iso_secureboot        = "https://factory.talos.dev/image/mock/arm64/iso_secureboot"
      kernel                = "https://factory.talos.dev/image/mock/arm64/kernel"
      kernel_command_line   = "https://factory.talos.dev/image/mock/arm64/kernel_command_line"
      pxe                   = "https://factory.talos.dev/image/mock/arm64/pxe"
      uki                   = "https://factory.talos.dev/image/mock/arm64/uki"
    }
  }
}
mock_provider "minio" {}

variables {
  project_name      = "acme"
  environment       = "dev"
  region            = "fsn1"
  talos_image_cache = "disabled"
}

# ── Defaults: the plan is the one the template made before these variables existed. ───────────────
#
# Every Hetzner cluster in the field runs this shape, so each thing the feature could have moved is
# pinned: the default workers' Talos patches are exactly the two they always were (the control
# plane's, which this change does not touch), no pool resource of any kind exists, and no extra
# Talos image architecture is needed.
run "hetzner_defaults_plan_unchanged" {
  command = plan

  assert {
    condition     = jsonencode(data.talos_machine_configuration.worker.config_patches) == jsonencode([yamlencode(local.common_machine_patch), yamlencode(local.cluster_patch)])
    error_message = "With defaults, the default workers must carry exactly the two Talos patches they had before #5536 (common machine + cluster)."
  }

  assert {
    condition     = jsonencode(data.talos_machine_configuration.worker.config_patches) == jsonencode(data.talos_machine_configuration.control_plane.config_patches)
    error_message = "With defaults, the worker patches must equal the control plane's, as before #5536."
  }

  assert {
    condition = (
      length(hcloud_server.node_pools) == 0 && length(hcloud_primary_ip.node_pool_ipv4) == 0 &&
      length(hcloud_network_subnet.node_pools) == 0 && length(data.talos_machine_configuration.node_pool) == 0 &&
      length(talos_machine_configuration_apply.node_pool) == 0 && length(terraform_data.node_pool_subnets_guard) == 0
    )
    error_message = "With defaults, no extra-pool server, IP, subnet, Talos config, Talos apply or guard may be planned."
  }

  assert {
    condition     = jsonencode(hcloud_firewall.this.labels) == jsonencode(local.default_labels) && length(data.hcloud_firewalls.node_pool_ledger) == 0 && length(data.hcloud_servers.node_pool_ledger) == 0
    error_message = "With defaults, the firewall's labels must be exactly the default labels (no subnet ledger), and neither ledger data source may be read (#5595)."
  }

  assert {
    condition     = length(hcloud_server.workers) == 1 && hcloud_server.workers["acme-dev-worker-1"].server_type == "cpx22"
    error_message = "With defaults, the one default worker must be planned as before."
  }

  assert {
    condition     = jsonencode(local.architectures) == jsonencode(["amd64"]) && !local.need_arm64
    error_message = "With defaults, only the amd64 Talos image may be needed."
  }

  assert {
    condition     = !strcontains(join("\n", data.talos_machine_configuration.worker.config_patches), "nodeLabels") && !strcontains(join("\n", data.talos_machine_configuration.worker.config_patches), "registerWithTaints") && !strcontains(join("\n", data.talos_machine_configuration.worker.config_patches), "register-with-taints")
    error_message = "With defaults, no label or taint may reach the default workers' Talos config."
  }
}

# ── node_labels reach every default worker through machine.nodeLabels. ─────────────────────────────
run "hetzner_node_labels_reach_the_default_workers" {
  command = plan

  variables {
    worker_count = 2
    node_labels = {
      team                      = "payments"
      "example.com/cost-centre" = "cc-1042"
    }
    node_taints = [
      {
        key    = "dedicated"
        value  = "batch"
        effect = "NoSchedule"
      },
    ]
  }

  assert {
    condition     = length(data.talos_machine_configuration.worker.config_patches) == 3
    error_message = "node_labels must add exactly one patch to the default workers' Talos config."
  }

  assert {
    condition = yamldecode(data.talos_machine_configuration.worker.config_patches[2]) == {
      machine = {
        nodeLabels = {
          team                      = "payments"
          "example.com/cost-centre" = "cc-1042"
        }
      }
    }
    error_message = "The default workers' third patch must be machine.nodeLabels = node_labels, and nothing else."
  }

  # One machine config (data.talos_machine_configuration.worker) serves every default worker, so the
  # label reaches both. (A server's user_data is that config's output, unknown at plan under mocks,
  # so the count is what is asserted here.)
  assert {
    condition     = length(hcloud_server.workers) == 2
    error_message = "Both default workers must be planned."
  }

  # node_taints reach extra pools only (contract): the default pool runs the platform's add-ons.
  assert {
    condition     = !strcontains(join("\n", data.talos_machine_configuration.worker.config_patches), "registerWithTaints")
    error_message = "node_taints must not reach the default workers."
  }

  assert {
    condition     = jsonencode(data.talos_machine_configuration.control_plane.config_patches) == jsonencode([yamlencode(local.common_machine_patch), yamlencode(local.cluster_patch)])
    error_message = "node_labels must not reach the control plane."
  }
}

# ── Two extra pools: one amd64, one arm64. ─────────────────────────────────────────────────────────
run "hetzner_builds_an_amd64_and_an_arm64_pool" {
  command = plan

  variables {
    node_labels = {
      team = "payments"
    }
    node_taints = [
      {
        key    = "dedicated"
        value  = "db"
        effect = "NoSchedule"
      },
    ]
    extra_node_pools = [
      {
        name          = "db"
        instance_type = "ccx23"
        min_size      = 2
        max_size      = 2
        labels = {
          workload = "db"
        }
        taints = [
          {
            key    = "gpu"
            value  = "true"
            effect = "NoSchedule"
          },
          {
            key    = "gpu"
            value  = "true"
            effect = "NoExecute"
          },
        ]
      },
      {
        name          = "arm"
        instance_type = "cax21"
        min_size      = 1
        max_size      = 5
        desired_size  = 3
        arch          = "arm64"
      },
    ]
  }

  # Keyed "<pool>-<index>", desired_size servers (min_size when desired_size is unset).
  assert {
    condition     = toset(keys(hcloud_server.node_pools)) == toset(["db-0", "db-1", "arm-0", "arm-1", "arm-2"])
    error_message = "Expected servers db-0, db-1 (min_size 2, no desired_size) and arm-0..arm-2 (desired_size 3), got ${jsonencode(keys(hcloud_server.node_pools))}."
  }

  assert {
    condition     = hcloud_server.node_pools["db-0"].server_type == "ccx23" && hcloud_server.node_pools["arm-2"].server_type == "cax21"
    error_message = "Each pool's servers must be its instance_type."
  }

  assert {
    condition     = hcloud_server.node_pools["arm-0"].name == "acme-dev-arm-0" && hcloud_server.node_pools["db-1"].name == "acme-dev-db-1"
    error_message = "Pool server names must be <cluster>-<pool>-<index>."
  }

  # The image follows the pool's arch, as worker_arch picks the default workers' image. The ids are
  # the literal per-arch values of the overrides above, so a pool on the other arch's image fails.
  assert {
    condition = (
      local.need_arm64 && local.need_amd64 &&
      alltrue([for k in ["arm-0", "arm-1", "arm-2"] : hcloud_server.node_pools[k].image == "talos-arm64-snapshot"]) &&
      alltrue([for k in ["db-0", "db-1"] : hcloud_server.node_pools[k].image == "talos-amd64-snapshot"])
    )
    error_message = "An arm64 pool must boot the arm64 Talos image (and get it built or reused), an amd64 pool the amd64 one."
  }

  # Joined the same way as the default workers: same firewall, same network, a public IPv4 + IPv6
  # (the default workers have both, and talos_machine_configuration_apply reaches nodes over it).
  assert {
    condition = alltrue([for k, s in hcloud_server.node_pools :
      tolist(s.firewall_ids) == tolist(hcloud_server.workers["acme-dev-worker-1"].firewall_ids) &&
      one(s.network).network_id == one(hcloud_server.workers["acme-dev-worker-1"].network).network_id &&
      one(s.public_net).ipv4_enabled && one(s.public_net).ipv6_enabled &&
      one(s.public_net).ipv4 == hcloud_primary_ip.node_pool_ipv4[k].id
    ])
    error_message = "Every pool server must carry the default workers' firewall and network, and the same public IPv4 + IPv6 shape."
  }

  assert {
    condition = alltrue([for k, s in hcloud_server.node_pools :
      s.labels["cluster"] == "acme-dev" && s.labels["role"] == "worker" && s.labels["pool"] == split("-", k)[0]
    ])
    error_message = "Pool servers must carry the cluster label (the teardown sweep's selector), role=worker and pool=<name>."
  }

  # Each pool has its own /24, chosen from its NAME (servers.tf, ADDRESSING): on the default network
  # 10.0.0.0/16 the free /24s are 1..95 (96..255 are the service and pod CIDRs), and sha256("db")
  # lands on 15, sha256("arm") on 23. Its servers take .101 onwards.
  assert {
    condition = (
      hcloud_network_subnet.node_pools["db"].ip_range == "10.0.15.0/24" && hcloud_network_subnet.node_pools["arm"].ip_range == "10.0.23.0/24" &&
      one(hcloud_server.node_pools["db-1"].network).ip == "10.0.15.102" && one(hcloud_server.node_pools["arm-0"].network).ip == "10.0.23.101"
    )
    error_message = "Pool db must take 10.0.15.0/24 and pool arm 10.0.23.0/24, with servers from .101: got ${jsonencode({ for k, s in hcloud_network_subnet.node_pools : k => s.ip_range })}."
  }

  # The same secrets bundle as every other node: the pool joins THIS cluster.
  assert {
    condition = alltrue([for k, c in data.talos_machine_configuration.node_pool :
      c.machine_type == "worker" && c.cluster_name == "acme-dev" && c.cluster_endpoint == local.cluster_endpoint &&
      c.machine_secrets == talos_machine_secrets.this.machine_secrets
    ])
    error_message = "Every pool's Talos config must be a worker config of this cluster, from talos_machine_secrets.this."
  }

  # The pool's patch: labels from the contract render (node_labels, the pool's own, alethia.io/pool),
  # its node IP from its own subnet, and taints at registration, every effect of a key kept.
  assert {
    condition = yamldecode(data.talos_machine_configuration.node_pool["db"].config_patches[2]) == {
      machine = {
        nodeLabels = {
          team              = "payments"
          workload          = "db"
          "alethia.io/pool" = "db"
        }
        kubelet = {
          nodeIP = {
            validSubnets = ["10.0.15.0/24"]
          }
          extraConfig = {
            registerWithTaints = [
              { key = "dedicated", value = "db", effect = "NoSchedule" },
              { key = "gpu", value = "true", effect = "NoSchedule" },
              { key = "gpu", value = "true", effect = "NoExecute" },
            ]
          }
        }
      }
    }
    error_message = "Pool db's Talos patch is wrong: ${data.talos_machine_configuration.node_pool["db"].config_patches[2]}"
  }

  # An arm64 pool carries the platform's arch taint, last.
  assert {
    condition = yamldecode(data.talos_machine_configuration.node_pool["arm"].config_patches[2]) == {
      machine = {
        nodeLabels = {
          team              = "payments"
          "alethia.io/pool" = "arm"
        }
        kubelet = {
          nodeIP = {
            validSubnets = ["10.0.23.0/24"]
          }
          extraConfig = {
            registerWithTaints = [
              { key = "dedicated", value = "db", effect = "NoSchedule" },
              { key = "alethia.io/arch", value = "arm64", effect = "NoSchedule" },
            ]
          }
        }
      }
    }
    error_message = "Pool arm's Talos patch is wrong: ${data.talos_machine_configuration.node_pool["arm"].config_patches[2]}"
  }

  # The pools start from the default workers' own base patches (registries, kubelet, CNI).
  assert {
    condition     = alltrue([for k, c in data.talos_machine_configuration.node_pool : jsonencode(slice(c.config_patches, 0, 2)) == jsonencode(local.worker_base_patches) && length(c.config_patches) == 3])
    error_message = "Every pool's Talos config must be the default workers' two base patches plus its own."
  }

  assert {
    condition     = toset(keys(talos_machine_configuration_apply.node_pool)) == toset(keys(hcloud_server.node_pools))
    error_message = "Every pool server must get its Talos config applied."
  }

  # The default workers are untouched by the pools apart from node_labels.
  assert {
    condition     = length(hcloud_server.workers) == 1 && yamldecode(data.talos_machine_configuration.worker.config_patches[2]) == { machine = { nodeLabels = { team = "payments" } } }
    error_message = "The default workers must get node_labels and nothing from the pools."
  }
}

# A pool with no taints and an amd64 type gets no registerWithTaints at all.
run "hetzner_untainted_amd64_pool_registers_no_taints" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "web"
        instance_type = "cpx31"
        min_size      = 1
        max_size      = 1
      },
    ]
  }

  assert {
    condition     = !strcontains(data.talos_machine_configuration.node_pool["web"].config_patches[2], "registerWithTaints") && !strcontains(data.talos_machine_configuration.node_pool["web"].config_patches[2], "extraConfig")
    error_message = "An untainted amd64 pool must not set registerWithTaints."
  }

  assert {
    condition     = !local.need_arm64 && length(hcloud_server.node_pools) == 1
    error_message = "An amd64-only cluster must not need the arm64 image."
  }
}

# ── Hetzner's own refusals. ────────────────────────────────────────────────────────────────────────

# Hetzner Cloud has no interruptible capacity.
run "hetzner_refuses_a_spot_pool" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cpx31"
        min_size      = 1
        max_size      = 1
        capacity_type = "spot"
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

# Another cloud's instance type is refused at plan, not by the hcloud API at apply.
run "hetzner_refuses_a_non_hetzner_instance_type" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "m7g.large"
        min_size      = 1
        max_size      = 1
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "hetzner_refuses_an_exponent_server_size" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx1e2"
        min_size      = 1
        max_size      = 1
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

# cax is arm64: an amd64 pool on a cax type would boot the wrong image.
run "hetzner_refuses_cax_as_amd64" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cax21"
        min_size      = 1
        max_size      = 1
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "hetzner_refuses_cpx_as_arm64" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cpx31"
        min_size      = 1
        max_size      = 1
        arch          = "arm64"
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

# On a /22, the pod and service CIDRs take every /24 after the node subnet, so a pool has nowhere to
# go: refused at plan with a sentence, not by the hcloud API.
run "hetzner_refuses_a_pool_when_the_network_has_no_free_subnet" {
  command = plan

  variables {
    network_cidr = "10.0.0.0/22"
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cpx31"
        min_size      = 1
        max_size      = 1
      },
    ]
  }

  expect_failures = [hcloud_network_subnet.node_pools]
}

# ── Subnet allocation: stable AND clash-free, through the firewall-label ledger (#5595). ───────────
#
# servers.tf, ADDRESSING. On the default 10.0.0.0/16 the free /24s are 1..95 and sha256 hashes "a" to
# 81, "b" to 22, "c" to 74, and BOTH "edge" and "search" to 41. On a 10.0.0.0/20 the free /24s are
# 1..5 and "a", "edge" and "f" all hash to 1, "b" and "h" to 2.
#
# The ledger is read through data.hcloud_firewalls, so a run that stands for "a later plan" overrides
# that data source with the labels the earlier run asserted the firewall was given. A mock apply does
# not feed a resource's labels back into a data source, so each hand-off is asserted on both sides:
# the run that WRITES checks hcloud_firewall.this.labels, and the next run READS exactly those labels.

# First apply, no ledger: two names on one hash slot no longer clash. The first by name keeps its hash
# slot; the other takes the lowest free /24. Nothing needs node_pool_subnet_index.
run "hetzner_two_names_on_one_hash_slot_plan_without_an_index" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "search", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "edge", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition     = hcloud_network_subnet.node_pools["edge"].ip_range == "10.0.41.0/24" && hcloud_network_subnet.node_pools["search"].ip_range == "10.0.1.0/24"
    error_message = "With no ledger, edge (first by name) must keep its hash slot 10.0.41.0/24 and search take the lowest free /24, 10.0.1.0/24."
  }

  assert {
    condition     = jsonencode(hcloud_firewall.this.labels) == jsonencode(merge(local.default_labels, { "subnet.alethia.io/edge" = "41", "subnet.alethia.io/search" = "1" }))
    error_message = "The plan must record each pool's /24 NUMBER on the firewall as subnet.alethia.io/<pool>, beside the default labels."
  }
}

# Five pools on a /20, which has exactly five free /24s and where three of the names share one hash
# slot and two share another: every pool still gets its own /24, and all five are used.
run "hetzner_five_pools_fill_a_20_without_a_clash" {
  command = plan

  variables {
    network_cidr = "10.0.0.0/20"
    extra_node_pools = [
      { name = "h", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "f", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "edge", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "b", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "a", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition = jsonencode({ for k, v in hcloud_network_subnet.node_pools : k => v.ip_range }) == jsonencode({
      a = "10.0.1.0/24", b = "10.0.2.0/24", edge = "10.0.3.0/24", f = "10.0.4.0/24", h = "10.0.5.0/24"
    })
    error_message = "On a /20, a and b keep their hash slots (1, 2) and edge, f and h take the free /24s 3, 4 and 5 in name order."
  }
}

# A sixth pool on that /20 has nowhere to go, and the refusal says the other pools hold every free /24.
run "hetzner_refuses_a_sixth_pool_on_a_20" {
  command = plan

  variables {
    network_cidr = "10.0.0.0/20"
    extra_node_pools = [
      { name = "a", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "b", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "edge", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "f", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "h", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "g", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  expect_failures = [hcloud_network_subnet.node_pools]
}

# Ten pools, the most extra_node_pools allows, on the default network, with edge and search on one
# hash slot: ten distinct /24s, every one free, and no node_pool_subnet_index.
run "hetzner_ten_pools_plan_without_a_clash" {
  command = plan

  variables {
    extra_node_pools = [
      for n in ["web", "search", "gpu", "edge", "db", "c", "batch", "b", "arm", "a"] :
      { name = n, instance_type = "cpx31", min_size = 1, max_size = 1 }
    ]
  }

  assert {
    condition     = length(hcloud_network_subnet.node_pools) == 10 && length(distinct([for v in hcloud_network_subnet.node_pools : v.ip_range])) == 10
    error_message = "Ten pools must plan onto ten distinct /24s."
  }

  assert {
    condition     = alltrue([for name, ok in local.node_pool_subnet_fits : ok]) && alltrue([for name, others in local.node_pool_subnet_clashes : length(others) == 0])
    error_message = "Each of the ten /24s must fit the network and clash with no other pool."
  }

  assert {
    condition     = hcloud_network_subnet.node_pools["edge"].ip_range == "10.0.41.0/24" && hcloud_network_subnet.node_pools["search"].ip_range == "10.0.1.0/24" && hcloud_network_subnet.node_pools["a"].ip_range == "10.0.81.0/24"
    error_message = "edge keeps its hash slot 41, search takes the lowest free /24 (1), and a keeps its hash slot 81."
  }
}

# The case a name-order or hash rule alone gets WRONG: search was created first and holds 41 (its
# hash slot). Adding edge, which sorts before search and hashes to 41 too, must not take it from
# search. The ledger says search holds 41, so edge takes the lowest free /24.
run "hetzner_an_added_pool_never_takes_a_recorded_pools_subnet" {
  command = plan

  override_data {
    target = data.hcloud_firewalls.node_pool_ledger
    values = {
      firewalls = [{ id = 4142, apply_to = [], rule = [], name = "acme-dev", labels = { cluster = "acme-dev", "subnet.alethia.io/search" = "41" } }]
    }
  }

  variables {
    extra_node_pools = [
      { name = "search", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "edge", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition     = hcloud_network_subnet.node_pools["search"].ip_range == "10.0.41.0/24" && hcloud_network_subnet.node_pools["edge"].ip_range == "10.0.1.0/24"
    error_message = "search must keep its recorded 10.0.41.0/24; edge, added, must take 10.0.1.0/24."
  }
}

# A pool that is NOT on its hash slot (it lost a hash tie when it was created) keeps the /24 the ledger
# records once the pool that beat it is removed, and the removed pool's record is dropped.
run "hetzner_removing_a_pool_moves_no_other_pool" {
  command = plan

  override_data {
    target = data.hcloud_firewalls.node_pool_ledger
    values = {
      firewalls = [{ id = 4142, apply_to = [], rule = [], name = "acme-dev", labels = { cluster = "acme-dev", "subnet.alethia.io/edge" = "41", "subnet.alethia.io/search" = "1" } }]
    }
  }

  variables {
    extra_node_pools = [
      { name = "search", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition     = keys(hcloud_network_subnet.node_pools) == ["search"] && hcloud_network_subnet.node_pools["search"].ip_range == "10.0.1.0/24"
    error_message = "With edge removed, search must stay on its recorded 10.0.1.0/24, not move to its hash slot 41."
  }

  assert {
    condition     = jsonencode(hcloud_firewall.this.labels) == jsonencode(merge(local.default_labels, { "subnet.alethia.io/search" = "1" }))
    error_message = "Removing edge must drop its ledger label and keep search's."
  }
}

# Upgrade from the hash-only template: the firewall carries no ledger yet, but search's server already
# sits in 10.0.41.0/24. Adding edge in that same plan must not take search's /24 from it.
run "hetzner_upgrade_keeps_a_pool_where_its_servers_are" {
  command = plan

  override_data {
    target = data.hcloud_firewalls.node_pool_ledger
    values = {
      firewalls = [{ id = 4142, apply_to = [], rule = [], name = "acme-dev", labels = { cluster = "acme-dev" } }]
    }
  }

  override_data {
    target = data.hcloud_servers.node_pool_ledger
    values = {
      servers = [{
        id                = 9001, name = "acme-dev-search-0", status = "running", server_type = "cpx31", image = "", location = "fsn1", datacenter = "fsn1-dc14",
        backup_window     = "", backups = false, delete_protection = false, rebuild_protection = false, rescue = "", iso = "", placement_group_id = 0,
        primary_disk_size = 160, ipv4_address = "", ipv6_address = "", ipv6_network = "", firewall_ids = [4142],
        labels            = { cluster = "acme-dev", role = "worker", pool = "search" }
        network           = [{ ip = "10.0.41.101", network_id = 4141, alias_ips = [], mac_address = "" }]
      }]
    }
  }

  variables {
    extra_node_pools = [
      { name = "search", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "edge", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition     = hcloud_network_subnet.node_pools["search"].ip_range == "10.0.41.0/24" && hcloud_network_subnet.node_pools["edge"].ip_range == "10.0.1.0/24"
    error_message = "On upgrade, search must keep the 10.0.41.0/24 its server is in, and edge take 10.0.1.0/24."
  }

  assert {
    condition     = jsonencode(hcloud_firewall.this.labels) == jsonencode(merge(local.default_labels, { "subnet.alethia.io/edge" = "1", "subnet.alethia.io/search" = "41" }))
    error_message = "The upgrade plan must start the ledger with both pools."
  }
}

# A record that is not a free /24 number (hand-edited, or inside the pod CIDR) is not a record, and a
# firewall of another NAME that carries the cluster label is never read as the ledger.
run "hetzner_ignores_an_unusable_or_foreign_record" {
  command = plan

  override_data {
    target = data.hcloud_firewalls.node_pool_ledger
    values = {
      firewalls = [
        { id = 4142, apply_to = [], rule = [], name = "acme-dev", labels = { cluster = "acme-dev", "subnet.alethia.io/a" = "x7", "subnet.alethia.io/b" = "200" } },
        { id = 4199, apply_to = [], rule = [], name = "acme-dev-old", labels = { cluster = "acme-dev", "subnet.alethia.io/c" = "5" } },
      ]
    }
  }

  variables {
    extra_node_pools = [
      { name = "a", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "b", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "c", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition     = hcloud_network_subnet.node_pools["a"].ip_range == "10.0.81.0/24" && hcloud_network_subnet.node_pools["b"].ip_range == "10.0.22.0/24" && hcloud_network_subnet.node_pools["c"].ip_range == "10.0.74.0/24"
    error_message = "Unusable records and another firewall's labels must be ignored: a, b and c take their hash slots."
  }
}

# node_pool_subnet_index still wins, and a NEW pool steps around a pinned /24 rather than clashing.
run "hetzner_subnet_index_resolves_a_collision" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "edge", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "search", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
    node_pool_subnet_index = { search = 42 }
  }

  assert {
    condition     = hcloud_network_subnet.node_pools["edge"].ip_range == "10.0.41.0/24" && hcloud_network_subnet.node_pools["search"].ip_range == "10.0.42.0/24"
    error_message = "edge must keep its hash slot 10.0.41.0/24 and search take the 10.0.42.0/24 its node_pool_subnet_index names."
  }
}

run "hetzner_a_new_pool_steps_around_a_pinned_subnet" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "a", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "b", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
    node_pool_subnet_index = { b = 81 }
  }

  assert {
    condition     = hcloud_network_subnet.node_pools["b"].ip_range == "10.0.81.0/24" && hcloud_network_subnet.node_pools["a"].ip_range == "10.0.1.0/24"
    error_message = "b is pinned to 81, a's hash slot, so a (new) must take the lowest free /24, 10.0.1.0/24."
  }
}

# A pin onto a /24 another pool already HOLDS is refused: moving a held pool replaces its servers.
run "hetzner_refuses_a_subnet_index_on_a_recorded_pools_subnet" {
  command = plan

  override_data {
    target = data.hcloud_firewalls.node_pool_ledger
    values = {
      firewalls = [{ id = 4142, apply_to = [], rule = [], name = "acme-dev", labels = { cluster = "acme-dev", "subnet.alethia.io/search" = "41" } }]
    }
  }

  variables {
    extra_node_pools = [
      { name = "search", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "edge", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
    node_pool_subnet_index = { edge = 41 }
  }

  expect_failures = [hcloud_network_subnet.node_pools]
}

# Two overrides onto the same /24 are refused.
run "hetzner_refuses_two_subnet_indexes_on_one_subnet" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "a", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "b", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
    node_pool_subnet_index = { a = 5, b = 5 }
  }

  expect_failures = [hcloud_network_subnet.node_pools]
}

# An override inside the pod CIDR (10.0.128.0/17 on the default network) is refused.
run "hetzner_refuses_a_subnet_index_in_the_pod_cidr" {
  command = plan

  variables {
    extra_node_pools       = [{ name = "a", instance_type = "cpx31", min_size = 1, max_size = 1 }]
    node_pool_subnet_index = { a = 200 }
  }

  expect_failures = [hcloud_network_subnet.node_pools]
}

# An override for a pool that does not exist is refused, never silently ignored.
run "hetzner_refuses_a_subnet_index_for_an_unknown_pool" {
  command = plan

  variables {
    extra_node_pools       = [{ name = "a", instance_type = "cpx31", min_size = 1, max_size = 1 }]
    node_pool_subnet_index = { typo = 5 }
  }

  expect_failures = [terraform_data.node_pool_subnets_guard]
}

# The #5582 repro, as applies on mocks sharing one state: create [a, b], reorder, remove a, then add c
# AT THE END. Each later run reads back the ledger the run before it asserted it wrote.
run "hetzner_subnets_create_a_and_b" {
  command = apply

  variables {
    extra_node_pools = [
      { name = "a", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "b", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition     = hcloud_network_subnet.node_pools["a"].ip_range == "10.0.81.0/24" && hcloud_network_subnet.node_pools["b"].ip_range == "10.0.22.0/24"
    error_message = "a must take 10.0.81.0/24 and b 10.0.22.0/24."
  }

  assert {
    condition     = jsonencode(hcloud_firewall.this.labels) == jsonencode(merge(local.default_labels, { "subnet.alethia.io/a" = "81", "subnet.alethia.io/b" = "22" }))
    error_message = "The first apply must write the ledger for a and b."
  }
}

# A reorder changes nothing: every pool, subnet, server address and ledger label is where it was.
run "hetzner_subnets_reorder_changes_nothing" {
  command = plan

  override_data {
    target = data.hcloud_firewalls.node_pool_ledger
    values = {
      firewalls = [{ id = 4142, apply_to = [], rule = [], name = "acme-dev", labels = { cluster = "acme-dev", "subnet.alethia.io/a" = "81", "subnet.alethia.io/b" = "22" } }]
    }
  }

  variables {
    extra_node_pools = [
      { name = "b", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "a", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition = (
      hcloud_network_subnet.node_pools["a"].ip_range == "10.0.81.0/24" && hcloud_network_subnet.node_pools["b"].ip_range == "10.0.22.0/24" &&
      one(hcloud_server.node_pools["a-0"].network).ip == "10.0.81.101" && one(hcloud_server.node_pools["b-0"].network).ip == "10.0.22.101" &&
      jsonencode(hcloud_firewall.this.labels) == jsonencode(merge(local.default_labels, { "subnet.alethia.io/a" = "81", "subnet.alethia.io/b" = "22" }))
    )
    error_message = "Reordering extra_node_pools must not move any pool's subnet, server address or ledger label."
  }
}

run "hetzner_subnets_remove_a" {
  command = apply

  override_data {
    target = data.hcloud_firewalls.node_pool_ledger
    values = {
      firewalls = [{ id = 4142, apply_to = [], rule = [], name = "acme-dev", labels = { cluster = "acme-dev", "subnet.alethia.io/a" = "81", "subnet.alethia.io/b" = "22" } }]
    }
  }

  variables {
    extra_node_pools = [
      { name = "b", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition     = keys(hcloud_network_subnet.node_pools) == ["b"] && hcloud_network_subnet.node_pools["b"].ip_range == "10.0.22.0/24"
    error_message = "Removing a must leave b on 10.0.22.0/24."
  }

  assert {
    condition     = jsonencode(hcloud_firewall.this.labels) == jsonencode(merge(local.default_labels, { "subnet.alethia.io/b" = "22" }))
    error_message = "Removing a must drop a's ledger label."
  }
}

run "hetzner_subnets_add_c_at_the_end" {
  command = plan

  override_data {
    target = data.hcloud_firewalls.node_pool_ledger
    values = {
      firewalls = [{ id = 4142, apply_to = [], rule = [], name = "acme-dev", labels = { cluster = "acme-dev", "subnet.alethia.io/b" = "22" } }]
    }
  }

  variables {
    extra_node_pools = [
      { name = "b", instance_type = "cpx31", min_size = 1, max_size = 1 },
      { name = "c", instance_type = "cpx31", min_size = 1, max_size = 1 },
    ]
  }

  assert {
    condition     = hcloud_network_subnet.node_pools["b"].ip_range == "10.0.22.0/24" && hcloud_network_subnet.node_pools["c"].ip_range == "10.0.74.0/24"
    error_message = "Adding c after removing a must plan cleanly: b stays on 10.0.22.0/24 and c takes 10.0.74.0/24."
  }
}
