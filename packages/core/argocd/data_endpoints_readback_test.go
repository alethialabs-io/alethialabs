// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// cnpgSvcJSON is a CloudNativePG-shaped Service list: a headless peer-discovery Service, the
// read-only `-ro` Service, and the read-write `-rw` Service clients actually connect to.
const cnpgSvcJSON = `{"items":[
 {"metadata":{"name":"pg-headless","namespace":"data"},"spec":{"clusterIP":"None","ports":[{"port":5432}]}},
 {"metadata":{"name":"pg-ro","namespace":"data"},"spec":{"clusterIP":"10.0.0.2","ports":[{"port":5432}]}},
 {"metadata":{"name":"pg-rw","namespace":"data"},"spec":{"clusterIP":"10.0.0.3","ports":[{"port":5432}]}}
]}`

// cnpgSecretJSON pairs the Helm release Secret (never a credential) with CNPG's `-app` credential.
const cnpgSecretJSON = `{"items":[
 {"metadata":{"name":"sh.helm.release.v1.pg.v1","namespace":"data"},"type":"helm.sh/release.v1"},
 {"metadata":{"name":"pg-app","namespace":"data"},"type":"kubernetes.io/basic-auth"}
]}`

// TestReadDataEndpoints covers the in-cluster data-service read-back end to end: which add-ons it
// looks at, which Service becomes the primary, and that only a credential REFERENCE is recorded.
func TestReadDataEndpoints(t *testing.T) {
	tests := []struct {
		name       string
		addons     []types.AddOnInstall
		svcJSON    string
		svcExit    int
		secretJSON string
		want       map[string]DataEndpoint
		wantWarn   string
	}{
		{
			name: "a gitops-mode add-on and a marketplace chart are both skipped",
			addons: []types.AddOnInstall{
				{ID: "db-primary", Mode: "gitops", Namespace: "data"},
				{ID: "kube-prometheus-stack", Mode: "managed", Namespace: "obs"},
			},
			want: map[string]DataEndpoint{},
		},
		{
			name:       "CNPG: the -rw Service wins, -ro is the reader, the -app Secret is referenced",
			addons:     []types.AddOnInstall{{ID: "db-primary", Mode: "managed", Namespace: "data"}},
			svcJSON:    cnpgSvcJSON,
			secretJSON: cnpgSecretJSON,
			want: map[string]DataEndpoint{
				"db-primary": {
					Endpoint:       "pg-rw.data.svc.cluster.local",
					Port:           5432,
					ReaderEndpoint: "pg-ro.data.svc.cluster.local",
					SecretRef:      "data/pg-app",
				},
			},
		},
		{
			name:   "a single-Service chart (Valkey/RabbitMQ shape) with no credential Secret",
			addons: []types.AddOnInstall{{ID: "cache-main", Mode: "managed", Namespace: "cache"}},
			svcJSON: `{"items":[
			 {"metadata":{"name":"valkey","namespace":"cache"},"spec":{"clusterIP":"10.0.0.9","ports":[{"port":6379}]}},
			 {"metadata":{"name":"valkey-read","namespace":"cache"},"spec":{"clusterIP":"10.0.0.10","ports":[{"port":6379}]}}
			]}`,
			secretJSON: `{"items":[]}`,
			want: map[string]DataEndpoint{
				"cache-main": {
					Endpoint:       "valkey.cache.svc.cluster.local",
					Port:           6379,
					ReaderEndpoint: "valkey-read.cache.svc.cluster.local",
				},
			},
		},
		{
			name:     "no Service at all is omitted, never guessed",
			addons:   []types.AddOnInstall{{ID: "queue-jobs", Mode: "managed", Namespace: "mq"}},
			svcJSON:  `{"items":[]}`,
			want:     map[string]DataEndpoint{},
			wantWarn: "no Service found for data service queue-jobs",
		},
		{
			name:     "only headless Services means no client endpoint",
			addons:   []types.AddOnInstall{{ID: "db-primary", Mode: "managed", Namespace: "data"}},
			svcJSON:  `{"items":[{"metadata":{"name":"pg-headless","namespace":"data"},"spec":{"clusterIP":"None"}}]}`,
			want:     map[string]DataEndpoint{},
			wantWarn: "no Service found for data service db-primary",
		},
		{
			name:     "a kubectl failure is best-effort, not a deploy failure",
			addons:   []types.AddOnInstall{{ID: "db-primary", Mode: "managed", Namespace: "data"}},
			svcExit:  1,
			want:     map[string]DataEndpoint{},
			wantWarn: "no Service found for data service db-primary",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			newKubectlStub(t, 0,
				stubRule{Match: "get svc", Stdout: tc.svcJSON, Exit: tc.svcExit},
				stubRule{Match: "get secret", Stdout: tc.secretJSON},
			)
			var stdout, stderr bytes.Buffer
			got := ReadDataEndpoints(tc.addons, &stdout, &stderr)

			if len(got) != len(tc.want) {
				t.Fatalf("ReadDataEndpoints() = %#v, want %#v", got, tc.want)
			}
			for id, want := range tc.want {
				if got[id] != want {
					t.Errorf("endpoint %q = %#v, want %#v", id, got[id], want)
				}
			}
			if tc.wantWarn != "" && !strings.Contains(stderr.String(), tc.wantWarn) {
				t.Errorf("stderr = %q, want it to contain %q", stderr.String(), tc.wantWarn)
			}
		})
	}
}
