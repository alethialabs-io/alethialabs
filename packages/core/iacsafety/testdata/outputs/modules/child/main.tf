resource "null_resource" "marker" {}

# A CHILD-module output must NOT surface in the report: `tofu output` only
# returns root outputs, so a binding could never resolve against this name.
output "internal" {
  value = null_resource.marker.id
}
