# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# A CONFORMING lane's nodepool_contract.tftest.hcl (fixture for nodepool_contract_test.go): every
# reference run, with this lane's own instance types substituted (the one substitution allowed),
# plus what a lane adds: file-level values for its own variables, an assert block, and a run of its
# own. A real lane also declares its mock providers here; this fixture has nothing to mock, so
# `tofu test` runs it as it stands.

variables {
  worker_count = 3
}

run "hetzner_refuses_a_spot_pool" {
  command = plan

  variables {
    extra_node_pools = [{ name = "batch", instance_type = "cax21", min_size = 1, max_size = 2, capacity_type = "spot" }]
  }

  expect_failures = [var.extra_node_pools]
}

# Nothing set: the three variables take {}, [] and [] and the plan succeeds.
run "nodepool_defaults_plan" {
  command = plan

  # A lane asserts what it rendered; the contract does not read assert blocks.
  assert {
    condition     = var.worker_count == 3
    error_message = "the default pool is unchanged"
  }
}

# The docs example (cluster.mdx): a label on every node, a taint for the extra pools, and an arm64 batch pool. capacity_type is left at on-demand because Hetzner refuses spot in a validation of its own.
run "nodepool_accepts_the_portable_example" {
  command = plan

  variables {
    node_labels = {
      team                      = "payments"
      "example.com/cost-centre" = "cc-1042"
      empty                     = ""
    }
    node_taints = [
      {
        key    = "dedicated"
        value  = "batch"
        effect = "NoSchedule"
      },
    ]
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 4
        max_size      = 4
        arch          = "arm64"
        desired_size  = 4
        labels = {
          workload = "batch"
        }
        taints = [
          {
            key    = "example.com/batch"
            effect = "PreferNoSchedule"
          },
        ]
      },
      {
        name          = "gpu"
        instance_type = "ccx13"
        min_size      = 0
        max_size      = 2
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
    ]
  }
}

# The edges are inside the contract: 10 pools, a 12-character name, max_size 100, min_size 0, a 63-character label name and value, every taint effect.
run "nodepool_accepts_the_limits" {
  command = plan

  variables {
    node_labels = {
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv"
    }
    node_taints = [
      {
        key    = "a"
        effect = "NoSchedule"
      },
      {
        key    = "a"
        effect = "PreferNoSchedule"
      },
      {
        key    = "a"
        effect = "NoExecute"
      },
    ]
    extra_node_pools = [
      {
        name          = "abcdefghijk1"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p0"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p1"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p2"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p3"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p4"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p5"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p6"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p7"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p8"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
    ]
  }
}

# A prefix that merely CONTAINS a reserved domain is the user's own: kubernetes.io.example.com does not end in kubernetes.io.
run "nodepool_accepts_a_lookalike_outside_the_reserved_domains" {
  command = plan

  variables {
    node_labels = {
      "kubernetes.io.example.com/team" = "a"
    }
    node_taints = [
      {
        key    = "alethia.io.example.com/x"
        effect = "NoSchedule"
      },
    ]
  }
}

run "nodepool_refuses_a_label_key_starting_with_a_dash" {
  command = plan

  variables {
    node_labels = {
      "-team" = "a"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_name_over_63" {
  command = plan

  variables {
    node_labels = {
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = "a"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_dns_label_over_63" {
  command = plan

  variables {
    node_labels = {
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com/team" = "a"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_prefix_over_253" {
  command = plan

  variables {
    node_labels = {
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/team" = "a"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_value_with_a_space" {
  command = plan

  variables {
    node_labels = {
      team = "pay ments"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_value_over_63" {
  command = plan

  variables {
    node_labels = {
      team = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_kubernetes_io" {
  command = plan

  variables {
    node_labels = {
      "kubernetes.io/role" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_node_role" {
  command = plan

  variables {
    node_labels = {
      "node-role.kubernetes.io/worker" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_node_restriction" {
  command = plan

  variables {
    node_labels = {
      "node-restriction.kubernetes.io/team" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_no_dot_boundary" {
  command = plan

  variables {
    node_labels = {
      "examplekubernetes.io/x" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_k8s_io" {
  command = plan

  variables {
    node_labels = {
      "k8s.io/x" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_karpenter_sh" {
  command = plan

  variables {
    node_labels = {
      "karpenter.sh/nodepool" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_karpenter_k8s_aws" {
  command = plan

  variables {
    node_labels = {
      "karpenter.k8s.aws/instance-family" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_amazonaws_com" {
  command = plan

  variables {
    node_labels = {
      "eks.amazonaws.com/nodegroup" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_cloud_google_com" {
  command = plan

  variables {
    node_labels = {
      "cloud.google.com/gke-nodepool" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_gke_io" {
  command = plan

  variables {
    node_labels = {
      "iam.gke.io/gke-metadata-server-enabled" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_azure_com" {
  command = plan

  variables {
    node_labels = {
      "kubernetes.azure.com/agentpool" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_hetzner_cloud" {
  command = plan

  variables {
    node_labels = {
      "csi.hetzner.cloud/location" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_label_in_alethia_io" {
  command = plan

  variables {
    node_labels = {
      "alethia.io/pool" = "x"
    }
  }

  expect_failures = [var.node_labels]
}

run "nodepool_refuses_a_taint_effect" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "gpu"
        effect = "NoScheduled"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_duplicate_taint" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "gpu"
        value  = "a"
        effect = "NoSchedule"
      },
      {
        key    = "gpu"
        value  = "b"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_taint_key_with_a_space" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "g pu"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_taint_value_over_63" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "gpu"
        value  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

# alethia.io/arch is the platform's arm64 taint (#5534); a user may not set or spoof it.
run "nodepool_refuses_the_platform_arch_taint" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "alethia.io/arch"
        value  = "arm64"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_taint_in_kubernetes_io" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "node.kubernetes.io/unschedulable"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_taint_in_azure_com" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "kubernetes.azure.com/scalesetpriority"
        value  = "spot"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

run "nodepool_refuses_a_pool_name_uppercase" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "Batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_over_12" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "abcdefghijklm"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_leading_digit" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "1batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_hyphen" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "bat-ch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_default" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "default"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_system" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "system"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_spot" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "spot"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_duplicate_pool_name" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_eleventh_pool" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "p0"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p1"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p2"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p3"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p4"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p5"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p6"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p7"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p8"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p9"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p10"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_empty_instance_type" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = ""
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_instance_type_with_a_space" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "m7g large"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_unknown_arch" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        arch          = "x86_64"
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_an_unknown_capacity_type" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        capacity_type = "preemptible"
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_min_over_max" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 5
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_desired_under_min" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 2
        max_size      = 4
        desired_size  = 1
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_desired_over_max" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        desired_size  = 5
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_max_zero" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 0
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_max_over_100" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 101
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_negative_min" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = -1
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_fractional_max" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 1.5
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_pool_sizes_fractional_desired" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        desired_size  = 1.5
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_label_key" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        labels = {
          "-x" = "a"
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_label_value" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        labels = {
          x = "a b"
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

# alethia.io/pool is the platform's portable pool selector; a pool may not override it.
run "nodepool_refuses_the_platform_pool_label" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        labels = {
          "alethia.io/pool" = "other"
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_label_in_kubernetes_io" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        labels = {
          "node-role.kubernetes.io/batch" = ""
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_taint_effect" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "x"
            effect = "Never"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_duplicate_pool_taint" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "x"
            effect = "NoSchedule"
          },
          {
            key    = "x"
            value  = "y"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_taint_key" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "x y"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_taint_value" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "x"
            value  = "a b"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_the_platform_arch_taint_on_a_pool" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        arch          = "arm64"
        taints = [
          {
            key    = "alethia.io/arch"
            value  = "arm64"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_taint_in_gke_io" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cx32"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "node.gke.io/x"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

