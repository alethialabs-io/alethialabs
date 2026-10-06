# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The cross-cloud node-pool contract's cases (#5533), run against the REAL Hetzner template (#5536).
# Every run below is copied from packages/core/cloud/testdata/nodepool/reference/nodepool_contract.tftest.hcl
# under the same name, with the same node_labels / node_taints / extra_node_pools values, the same
# expect_failures and every reference `assert`; packages/core/cloud/nodepool_hetzner_test.go
# (assertNodePoolContract) fails if one drifts. Regenerate by copying the reference again.
#
# The one substitution the contract allows: a pool's instance_type. m7g.large becomes cax21 on an
# arm64 pool and cpx31 on an amd64 one, and g5.xlarge becomes ccx23, so that every acceptance plans on
# Hetzner's own server types (the template refuses a non-Hetzner type) and every refusal fails for the
# rule it names. The two instance_type refusals keep the reference's broken values exactly.
#
# What Hetzner itself builds from these values (servers, Talos patches, the default pool unchanged)
# is asserted in nodepool_hetzner.tftest.hcl. The mocks and the file-level variables below are the
# ones checks_dns_and_network.tftest.hcl uses, and its header says why helm is not mocked.

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

# Nothing set: the default pool renders with no labels and no taints, and there is no other pool.
run "nodepool_defaults_plan" {
  command = plan

  assert {
    condition = jsonencode(output.nodepool_contract_render) == jsonencode({
      default = {
        labels = {}
        taints = []
      }
    })
    error_message = "nodepool_contract_render differs from the contract's render for this case (render.tf)."
  }
}

# The shape of the docs example (cluster.mdx), widened: a label on every node, a taint for the extra pools, an arm64 batch pool and an amd64 GPU pool. capacity_type stays on-demand because Hetzner refuses spot in a validation of its own.
run "nodepool_accepts_the_portable_example" {
  command = plan

  variables {
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
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cax21"
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
        instance_type = "ccx23"
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

  assert {
    condition = jsonencode(output.nodepool_contract_render) == jsonencode({
      default = {
        labels = {
          team                      = "payments"
          "example.com/cost-centre" = "cc-1042"
        }
        taints = []
      }
      batch = {
        labels = {
          team                      = "payments"
          "example.com/cost-centre" = "cc-1042"
          workload                  = "batch"
          "alethia.io/pool"         = "batch"
        }
        taints = [
          {
            key    = "dedicated"
            value  = "batch"
            effect = "NoSchedule"
          },
          {
            key    = "example.com/batch"
            value  = ""
            effect = "PreferNoSchedule"
          },
          {
            key    = "alethia.io/arch"
            value  = "arm64"
            effect = "NoSchedule"
          },
        ]
      }
      gpu = {
        labels = {
          team                      = "payments"
          "example.com/cost-centre" = "cc-1042"
          "alethia.io/pool"         = "gpu"
        }
        taints = [
          {
            key    = "dedicated"
            value  = "batch"
            effect = "NoSchedule"
          },
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
      }
    })
    error_message = "nodepool_contract_render differs from the contract's render for this case (render.tf)."
  }
}

# A pool's label wins over node_labels; a pool's taint replaces the node_taint with the same key and effect; node_taints never reach the default pool; alethia.io/pool and the arm64 taint come last.
run "nodepool_renders_the_merge_rules" {
  command = plan

  variables {
    node_labels = {
      team = "a"
    }
    node_taints = [
      {
        key    = "dedicated"
        value  = "x"
        effect = "NoSchedule"
      },
      {
        key    = "keep"
        effect = "NoExecute"
      },
    ]
    extra_node_pools = [
      {
        name          = "p"
        instance_type = "cax21"
        min_size      = 0
        max_size      = 4
        arch          = "arm64"
        labels = {
          team = "b"
        }
        taints = [
          {
            key    = "dedicated"
            value  = "y"
            effect = "NoSchedule"
          },
        ]
      },
    ]
  }

  assert {
    condition = jsonencode(output.nodepool_contract_render) == jsonencode({
      default = {
        labels = {
          team = "a"
        }
        taints = []
      }
      p = {
        labels = {
          team              = "b"
          "alethia.io/pool" = "p"
        }
        taints = [
          {
            key    = "keep"
            value  = ""
            effect = "NoExecute"
          },
          {
            key    = "dedicated"
            value  = "y"
            effect = "NoSchedule"
          },
          {
            key    = "alethia.io/arch"
            value  = "arm64"
            effect = "NoSchedule"
          },
        ]
      }
    })
    error_message = "nodepool_contract_render differs from the contract's render for this case (render.tf)."
  }
}

# The edges are inside the contract: 10 pools, a 12-character name, max_size 100, min_size 0, a 63-character key and value, 24 node_labels and node_taints, 25 labels and taints on a pool, every taint effect.
run "nodepool_accepts_the_limits" {
  command = plan

  variables {
    node_labels = {
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv"
      l0                                                              = "v"
      l1                                                              = "v"
      l2                                                              = "v"
      l3                                                              = "v"
      l4                                                              = "v"
      l5                                                              = "v"
      l6                                                              = "v"
      l7                                                              = "v"
      l8                                                              = "v"
      l9                                                              = "v"
      l10                                                             = "v"
      l11                                                             = "v"
      l12                                                             = "v"
      l13                                                             = "v"
      l14                                                             = "v"
      l15                                                             = "v"
      l16                                                             = "v"
      l17                                                             = "v"
      l18                                                             = "v"
      l19                                                             = "v"
      l20                                                             = "v"
      l21                                                             = "v"
      l22                                                             = "v"
    }
    node_taints = [
      {
        key    = "t0"
        effect = "NoSchedule"
      },
      {
        key    = "t0"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t0"
        effect = "NoExecute"
      },
      {
        key    = "t1"
        effect = "NoSchedule"
      },
      {
        key    = "t1"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t1"
        effect = "NoExecute"
      },
      {
        key    = "t2"
        effect = "NoSchedule"
      },
      {
        key    = "t2"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t2"
        effect = "NoExecute"
      },
      {
        key    = "t3"
        effect = "NoSchedule"
      },
      {
        key    = "t3"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t3"
        effect = "NoExecute"
      },
      {
        key    = "t4"
        effect = "NoSchedule"
      },
      {
        key    = "t4"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t4"
        effect = "NoExecute"
      },
      {
        key    = "t5"
        effect = "NoSchedule"
      },
      {
        key    = "t5"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t5"
        effect = "NoExecute"
      },
      {
        key    = "t6"
        effect = "NoSchedule"
      },
      {
        key    = "t6"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t6"
        effect = "NoExecute"
      },
      {
        key    = "t7"
        effect = "NoSchedule"
      },
      {
        key    = "t7"
        effect = "PreferNoSchedule"
      },
      {
        key    = "t7"
        effect = "NoExecute"
      },
    ]
    extra_node_pools = [
      {
        name          = "abcdefghijk1"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
        labels = {
          l0  = "v"
          l1  = "v"
          l2  = "v"
          l3  = "v"
          l4  = "v"
          l5  = "v"
          l6  = "v"
          l7  = "v"
          l8  = "v"
          l9  = "v"
          l10 = "v"
          l11 = "v"
          l12 = "v"
          l13 = "v"
          l14 = "v"
          l15 = "v"
          l16 = "v"
          l17 = "v"
          l18 = "v"
          l19 = "v"
          l20 = "v"
          l21 = "v"
          l22 = "v"
          l23 = "v"
          l24 = "v"
        }
        taints = [
          {
            key    = "example.com/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"
            effect = "NoSchedule"
          },
          {
            key    = "p0"
            effect = "NoSchedule"
          },
          {
            key    = "p1"
            effect = "NoSchedule"
          },
          {
            key    = "p2"
            effect = "NoSchedule"
          },
          {
            key    = "p3"
            effect = "NoSchedule"
          },
          {
            key    = "p4"
            effect = "NoSchedule"
          },
          {
            key    = "p5"
            effect = "NoSchedule"
          },
          {
            key    = "p6"
            effect = "NoSchedule"
          },
          {
            key    = "p7"
            effect = "NoSchedule"
          },
          {
            key    = "p8"
            effect = "NoSchedule"
          },
          {
            key    = "p9"
            effect = "NoSchedule"
          },
          {
            key    = "p10"
            effect = "NoSchedule"
          },
          {
            key    = "p11"
            effect = "NoSchedule"
          },
          {
            key    = "p12"
            effect = "NoSchedule"
          },
          {
            key    = "p13"
            effect = "NoSchedule"
          },
          {
            key    = "p14"
            effect = "NoSchedule"
          },
          {
            key    = "p15"
            effect = "NoSchedule"
          },
          {
            key    = "p16"
            effect = "NoSchedule"
          },
          {
            key    = "p17"
            effect = "NoSchedule"
          },
          {
            key    = "p18"
            effect = "NoSchedule"
          },
          {
            key    = "p19"
            effect = "NoSchedule"
          },
          {
            key    = "p20"
            effect = "NoSchedule"
          },
          {
            key    = "p21"
            effect = "NoSchedule"
          },
          {
            key    = "p22"
            effect = "NoSchedule"
          },
          {
            key    = "p23"
            effect = "NoSchedule"
          },
        ]
      },
      {
        name          = "p0"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p1"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p2"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p3"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p4"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p5"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p6"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p7"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
      {
        name          = "p8"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 100
        desired_size  = 100
      },
    ]
  }

  assert {
    condition     = length(output.nodepool_contract_render) == 11
    error_message = "nodepool_contract_render must hold the default pool and every extra pool."
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

  assert {
    condition = jsonencode(output.nodepool_contract_render) == jsonencode({
      default = {
        labels = {
          "kubernetes.io.example.com/team" = "a"
        }
        taints = []
      }
    })
    error_message = "nodepool_contract_render differs from the contract's render for this case (render.tf)."
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

# EKS caps the WHOLE key at 63: a valid Kubernetes key of 64 is refused.
run "nodepool_refuses_a_label_key_over_63_with_its_prefix" {
  command = plan

  variables {
    node_labels = {
      "example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" = "a"
    }
  }

  expect_failures = [var.node_labels]
}

# EKS refuses an empty label value.
run "nodepool_refuses_an_empty_label_value" {
  command = plan

  variables {
    node_labels = {
      team = ""
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

run "nodepool_refuses_a_25th_node_label" {
  command = plan

  variables {
    node_labels = {
      l0  = "v"
      l1  = "v"
      l2  = "v"
      l3  = "v"
      l4  = "v"
      l5  = "v"
      l6  = "v"
      l7  = "v"
      l8  = "v"
      l9  = "v"
      l10 = "v"
      l11 = "v"
      l12 = "v"
      l13 = "v"
      l14 = "v"
      l15 = "v"
      l16 = "v"
      l17 = "v"
      l18 = "v"
      l19 = "v"
      l20 = "v"
      l21 = "v"
      l22 = "v"
      l23 = "v"
      l24 = "v"
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

run "nodepool_refuses_a_25th_node_taint" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "t0"
        effect = "NoSchedule"
      },
      {
        key    = "t1"
        effect = "NoSchedule"
      },
      {
        key    = "t2"
        effect = "NoSchedule"
      },
      {
        key    = "t3"
        effect = "NoSchedule"
      },
      {
        key    = "t4"
        effect = "NoSchedule"
      },
      {
        key    = "t5"
        effect = "NoSchedule"
      },
      {
        key    = "t6"
        effect = "NoSchedule"
      },
      {
        key    = "t7"
        effect = "NoSchedule"
      },
      {
        key    = "t8"
        effect = "NoSchedule"
      },
      {
        key    = "t9"
        effect = "NoSchedule"
      },
      {
        key    = "t10"
        effect = "NoSchedule"
      },
      {
        key    = "t11"
        effect = "NoSchedule"
      },
      {
        key    = "t12"
        effect = "NoSchedule"
      },
      {
        key    = "t13"
        effect = "NoSchedule"
      },
      {
        key    = "t14"
        effect = "NoSchedule"
      },
      {
        key    = "t15"
        effect = "NoSchedule"
      },
      {
        key    = "t16"
        effect = "NoSchedule"
      },
      {
        key    = "t17"
        effect = "NoSchedule"
      },
      {
        key    = "t18"
        effect = "NoSchedule"
      },
      {
        key    = "t19"
        effect = "NoSchedule"
      },
      {
        key    = "t20"
        effect = "NoSchedule"
      },
      {
        key    = "t21"
        effect = "NoSchedule"
      },
      {
        key    = "t22"
        effect = "NoSchedule"
      },
      {
        key    = "t23"
        effect = "NoSchedule"
      },
      {
        key    = "t24"
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

run "nodepool_refuses_a_taint_key_over_63_with_its_prefix" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        effect = "NoSchedule"
      },
    ]
  }

  expect_failures = [var.node_taints]
}

# Leave value out instead; an empty value is refused so that "" can only mean none.
run "nodepool_refuses_an_empty_taint_value" {
  command = plan

  variables {
    node_taints = [
      {
        key    = "gpu"
        value  = ""
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_pool1" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "pool1"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_pool_name_pool12" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "pool12"
        instance_type = "cpx31"
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
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "batch"
        instance_type = "cpx31"
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
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p1"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p2"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p3"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p4"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p5"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p6"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p7"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p8"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p9"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
      },
      {
        name          = "p10"
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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

run "nodepool_refuses_an_empty_pool_label_value" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
        labels = {
          x = ""
        }
      },
    ]
  }

  expect_failures = [var.extra_node_pools]
}

run "nodepool_refuses_a_26th_pool_label" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
        labels = {
          l0  = "v"
          l1  = "v"
          l2  = "v"
          l3  = "v"
          l4  = "v"
          l5  = "v"
          l6  = "v"
          l7  = "v"
          l8  = "v"
          l9  = "v"
          l10 = "v"
          l11 = "v"
          l12 = "v"
          l13 = "v"
          l14 = "v"
          l15 = "v"
          l16 = "v"
          l17 = "v"
          l18 = "v"
          l19 = "v"
          l20 = "v"
          l21 = "v"
          l22 = "v"
          l23 = "v"
          l24 = "v"
          l25 = "v"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
        labels = {
          "node-role.kubernetes.io/batch" = "x"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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

run "nodepool_refuses_a_26th_pool_taint" {
  command = plan

  variables {
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "cpx31"
        min_size      = 0
        max_size      = 4
        taints = [
          {
            key    = "t0"
            effect = "NoSchedule"
          },
          {
            key    = "t1"
            effect = "NoSchedule"
          },
          {
            key    = "t2"
            effect = "NoSchedule"
          },
          {
            key    = "t3"
            effect = "NoSchedule"
          },
          {
            key    = "t4"
            effect = "NoSchedule"
          },
          {
            key    = "t5"
            effect = "NoSchedule"
          },
          {
            key    = "t6"
            effect = "NoSchedule"
          },
          {
            key    = "t7"
            effect = "NoSchedule"
          },
          {
            key    = "t8"
            effect = "NoSchedule"
          },
          {
            key    = "t9"
            effect = "NoSchedule"
          },
          {
            key    = "t10"
            effect = "NoSchedule"
          },
          {
            key    = "t11"
            effect = "NoSchedule"
          },
          {
            key    = "t12"
            effect = "NoSchedule"
          },
          {
            key    = "t13"
            effect = "NoSchedule"
          },
          {
            key    = "t14"
            effect = "NoSchedule"
          },
          {
            key    = "t15"
            effect = "NoSchedule"
          },
          {
            key    = "t16"
            effect = "NoSchedule"
          },
          {
            key    = "t17"
            effect = "NoSchedule"
          },
          {
            key    = "t18"
            effect = "NoSchedule"
          },
          {
            key    = "t19"
            effect = "NoSchedule"
          },
          {
            key    = "t20"
            effect = "NoSchedule"
          },
          {
            key    = "t21"
            effect = "NoSchedule"
          },
          {
            key    = "t22"
            effect = "NoSchedule"
          },
          {
            key    = "t23"
            effect = "NoSchedule"
          },
          {
            key    = "t24"
            effect = "NoSchedule"
          },
          {
            key    = "t25"
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
        instance_type = "cpx31"
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
        instance_type = "cpx31"
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
        instance_type = "cax21"
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
        instance_type = "cpx31"
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

