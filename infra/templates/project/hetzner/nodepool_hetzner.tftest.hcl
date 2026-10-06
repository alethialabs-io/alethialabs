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
}

mock_provider "talos" {}
mock_provider "imager" {}
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
    condition     = length(hcloud_server.workers) == 1 && hcloud_server.workers["acme-dev-worker-1"].server_type == "cpx22"
    error_message = "With defaults, the one default worker must be planned as before."
  }

  assert {
    condition     = jsonencode(local.architectures) == jsonencode(["amd64"]) && !local.need_arm64
    error_message = "With defaults, only the amd64 Talos image may be needed."
  }

  assert {
    condition     = !strcontains(join("\n", data.talos_machine_configuration.worker.config_patches), "nodeLabels") && !strcontains(join("\n", data.talos_machine_configuration.worker.config_patches), "register-with-taints")
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
    condition     = !strcontains(join("\n", data.talos_machine_configuration.worker.config_patches), "register-with-taints")
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

  # The image follows the pool's arch, as worker_arch picks the default workers' image.
  assert {
    condition     = local.need_arm64 && local.need_amd64 && hcloud_server.node_pools["arm-1"].image == local.image_id_arm64 && hcloud_server.node_pools["db-0"].image == local.image_id_amd64
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

  # Each pool has its own /24 after the node subnet; its servers take .101 onwards.
  assert {
    condition = (
      hcloud_network_subnet.node_pools["db"].ip_range == "10.0.1.0/24" && hcloud_network_subnet.node_pools["arm"].ip_range == "10.0.2.0/24" &&
      one(hcloud_server.node_pools["db-1"].network).ip == "10.0.1.102" && one(hcloud_server.node_pools["arm-0"].network).ip == "10.0.2.101"
    )
    error_message = "Pool db must take 10.0.1.0/24 and pool arm 10.0.2.0/24, with servers from .101."
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
            validSubnets = ["10.0.1.0/24"]
          }
          extraArgs = {
            "register-with-taints" = "dedicated=db:NoSchedule,gpu=true:NoSchedule,gpu=true:NoExecute"
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
            validSubnets = ["10.0.2.0/24"]
          }
          extraArgs = {
            "register-with-taints" = "dedicated=db:NoSchedule,alethia.io/arch=arm64:NoSchedule"
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

# A pool with no taints and an amd64 type gets no register-with-taints flag at all.
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
    condition     = !strcontains(data.talos_machine_configuration.node_pool["web"].config_patches[2], "register-with-taints")
    error_message = "An untainted amd64 pool must not set --register-with-taints."
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
run "hetzner_refuses_a_pool_subnet_that_overlaps_the_service_cidr" {
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
