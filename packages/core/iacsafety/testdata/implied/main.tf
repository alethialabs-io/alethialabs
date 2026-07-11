resource "datadog_monitor" "m" {
  name = "cpu"
}

resource "datadog_dashboard" "d" {
  title = "x"
}
