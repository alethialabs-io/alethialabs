# Structurally odd but parseable HCL: label-less blocks that real OpenTofu
# would reject. The gate must not crash, and anything it cannot pin down must
# fail closed.

terraform {
}

resource {
}

data {
}

provider {
}

module {
}

resource "null_resource" "x" {
  provisioner {
    command = "id"
  }
}
