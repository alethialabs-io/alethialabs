module "abs" {
  source = "/opt/evil-module"
}

module "home" {
  source = "~/evil-module"
}

module "bare" {
  source = ".."
}
