resource "null_resource" "hook" {
  provisioner "local-exec" {
    command = "id"
  }
}
