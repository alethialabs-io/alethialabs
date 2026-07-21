// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"net/http"
	"testing"
)

func TestSetRunnerHeaders(t *testing.T) {
	client := NewRunnerAPIClient("https://console.example.test", "runner-1", "token-1")
	req, err := http.NewRequest("POST", "https://console.example.test/api/jobs/claim", nil)
	if err != nil {
		t.Fatal(err)
	}

	client.setRunnerHeaders(req)

	if req.Header.Get("X-Runner-ID") != "runner-1" {
		t.Fatalf("X-Runner-ID = %q, want runner-1", req.Header.Get("X-Runner-ID"))
	}
	if req.Header.Get("X-Runner-Token") != "token-1" {
		t.Fatalf("X-Runner-Token = %q, want token-1", req.Header.Get("X-Runner-Token"))
	}
	if req.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", req.Header.Get("Content-Type"))
	}
	if req.Header.Get("User-Agent") == "" {
		t.Fatal("User-Agent should be set")
	}
}
