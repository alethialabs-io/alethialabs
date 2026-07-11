check "endpoint" {
  data "http" "probe" {
    url = "https://example.com/health"
  }

  assert {
    condition     = data.http.probe.status_code == 200
    error_message = "unhealthy"
  }
}
