// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// TestParseCertKubeconfig reads the shape Talos and ACK return, raw and base64-wrapped, and takes the
// certificate's own NotAfter as the expiry.
func TestParseCertKubeconfig(t *testing.T) {
	p := newTestPKI(t, 90*time.Minute)
	raw := certKubeconfigYAML("https://203.0.113.10:6443", p)
	for name, in := range map[string]string{
		"raw":     raw,
		"wrapped": base64.StdEncoding.EncodeToString([]byte(raw)),
	} {
		got, err := parseCertKubeconfig(in)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got.Server != "https://203.0.113.10:6443" || got.CAData != p.caData || got.ClientCertData != p.certData || got.ClientKeyData != p.keyData {
			t.Fatalf("%s: wrong pieces", name)
		}
		if !got.NotAfter.Equal(p.notAfter) {
			t.Fatalf("%s: NotAfter = %s, want %s", name, got.NotAfter, p.notAfter)
		}
	}

	// A bare host gets its scheme; no current-context is fine when there is exactly one of each.
	noCtx := strings.Replace(raw, "current-context: admin@c1\n", "", 1)
	noCtx = strings.Replace(noCtx, "server: https://203.0.113.10:6443", "server: 203.0.113.10:6443", 1)
	got, err := parseCertKubeconfig(noCtx)
	if err != nil || got.Server != "https://203.0.113.10:6443" {
		t.Fatalf("got %q, %v", got.Server, err)
	}
}

// TestParseCertKubeconfig_Refusals: every malformed shape is refused, and no error quotes the input.
func TestParseCertKubeconfig_Refusals(t *testing.T) {
	p := newTestPKI(t, time.Hour)
	good := certKubeconfigYAML("https://203.0.113.10", p)
	secret := "PRIVATE-KEY-MATERIAL-42"
	two := good + "" // a second cluster and user without a current context
	two = strings.Replace(two, "current-context: admin@c1\n", "", 1)
	two = strings.Replace(two, "users:\n", "- name: c2\n  cluster:\n    server: https://203.0.113.11\n    certificate-authority-data: "+p.caData+"\nusers:\n- name: u2\n  user:\n    client-certificate-data: "+p.certData+"\n    client-key-data: "+p.keyData+"\n", 1)
	cases := map[string]string{
		"not yaml":            "::: " + secret,
		"not base64 either":   "%%%" + secret,
		"base64 of garbage":   base64.StdEncoding.EncodeToString([]byte("[" + secret)),
		"no clusters":         "users: []\nkind: " + secret,
		"ambiguous":           two,
		"no server":           strings.Replace(good, "server: https://203.0.113.10", "server: ''", 1),
		"token user":          strings.Replace(good, "client-certificate-data: "+p.certData, "token: "+secret, 1),
		"cert not base64":     strings.Replace(good, p.certData, "!!"+secret, 1),
		"cert not pem":        strings.Replace(good, p.certData, base64.StdEncoding.EncodeToString([]byte(secret)), 1),
		"cert does not parse": strings.Replace(good, p.certData, base64.StdEncoding.EncodeToString([]byte("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")), 1),
		"current ctx missing": strings.Replace(good, "cluster: c1\n    user: admin@c1", "cluster: other\n    user: admin@c1", 1),
	}
	for name, in := range cases {
		_, err := parseCertKubeconfig(in)
		if err == nil {
			t.Fatalf("%s: expected a refusal", name)
		}
		if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), p.keyData) {
			t.Fatalf("%s: the error quotes its input: %v", name, err)
		}
	}
}
