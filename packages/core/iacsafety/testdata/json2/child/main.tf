resource "null_resource" "marker" {
  triggers = {
    always = "1"
  }
}
