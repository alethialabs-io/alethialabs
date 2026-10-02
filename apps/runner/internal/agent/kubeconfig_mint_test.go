// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	yaml "gopkg.in/yaml.v3"
)

// runMint executes a MINT_KUBECONFIG job for provider with the fixture installed.
func runMint(t *testing.T, f *mintFixture, snapshot map[string]any) error {
	t.Helper()
	f.use(t)
	w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-mint"}, f.api)
	job := &Job{ID: "job-mint", JobType: string(types.JobTypeMintKubeconfig), ConfigSnapshot: snapshot}
	stdout := NewJobLoggerWithTrace(f.api, job.ID, "STDOUT", "")
	stderr := NewJobLoggerWithTrace(f.api, job.ID, "STDERR", "")
	defer stdout.Close()
	defer stderr.Close()
	return w.executeMintKubeconfig(context.Background(), job, "", nil, stdout, stderr)
}

// staticKubeconfig is the slice of a rendered static kubeconfig the assertions read.
type staticKubeconfig struct {
	CurrentContext string `yaml:"current-context"`
	Clusters       []struct {
		Cluster struct {
			Server string `yaml:"server"`
			CA     string `yaml:"certificate-authority-data"`
		} `yaml:"cluster"`
	} `yaml:"clusters"`
	Users []struct {
		User struct {
			Token string `yaml:"token"`
			Cert  string `yaml:"client-certificate-data"`
			Key   string `yaml:"client-key-data"`
		} `yaml:"user"`
	} `yaml:"users"`
}

// TestMintKubeconfig_EveryCloudTierAndShape drives the whole handler for each cloud, tier and shape
// it may mint, opens the sealed result with the client's key, and checks what is inside: the right
// credential, the cloud's pinned endpoint and CA, and the TRUE expiry for that path.
func TestMintKubeconfig_EveryCloudTierAndShape(t *testing.T) {
	ttl := time.Hour
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		certCloud := provider == "alibaba" || provider == "hetzner"
		for _, tier := range []types.KubeconfigMintTier{types.KubeconfigMintTierReadonly, types.KubeconfigMintTierAdmin} {
			for _, shape := range []types.KubeconfigMintShape{types.KubeconfigMintShapeExec, types.KubeconfigMintShapeStatic} {
				if certCloud && shape == types.KubeconfigMintShapeExec {
					continue // refused: TestMintKubeconfig_CertificateCloudsRefuseExec
				}
				t.Run(fmt.Sprintf("%s/%s/%s", provider, tier, shape), func(t *testing.T) {
					f := newMintFixture(t, tier, shape, "s3cr3t")
					start := time.Now()
					if err := runMint(t, f, mintSnapshot(provider)); err != nil {
						t.Fatalf("mint: %v", err)
					}
					res := f.api.results()
					if len(res) != 1 {
						t.Fatalf("want exactly one posted result, got %d", len(res))
					}
					if res[0].MintID != testMintID {
						t.Fatalf("posted for mint %q", res[0].MintID)
					}
					if res[0].PrivateEndpoint == nil || *res[0].PrivateEndpoint {
						t.Fatalf("a public IP endpoint must classify as public, got %v", res[0].PrivateEndpoint)
					}
					cred := f.open(t, res[0])
					if cred.Tier != tier || cred.Shape != shape {
						t.Fatalf("credential is %s/%s, want %s/%s", cred.Tier, cred.Shape, tier, shape)
					}

					// The credential and its expiry, per path.
					var wantToken, wantCert string
					var wantExpiry time.Time
					switch {
					case tier == types.KubeconfigMintTierReadonly:
						wantToken = "sa-s3cr3t"
						wantExpiry = start.Add(ttl)
						if f.kube.tokenSeconds != int64(ttl/time.Second) {
							t.Fatalf("TokenRequest asked for %ds, want %d", f.kube.tokenSeconds, int64(ttl/time.Second))
						}
						if !f.kube.called("/clusterrolebindings/") {
							t.Fatal("read-only identity was not ensured before the token request")
						}
						// The setup calls ran on the ADMIN credential.
						if certCloud {
							if f.kubeConn.ClientCertData != f.pki.certData || f.kubeConn.Token != "" {
								t.Fatal("the read-only setup did not authenticate with the cloud's admin certificate")
							}
						} else if f.kubeConn.Token != f.cloudToken {
							t.Fatal("the read-only setup did not authenticate with the cloud's admin token")
						}
					case certCloud:
						wantCert = f.pki.certData
						wantExpiry = f.pki.notAfter
						if f.kube.called("/") {
							t.Fatal("the admin tier must not touch the cluster")
						}
					default:
						wantToken = f.cloudToken
						wantExpiry = f.cloudExpiry
					}
					if d := cred.ExpiresAt.Sub(wantExpiry); d < -5*time.Second || d > 5*time.Second {
						t.Fatalf("expires_at = %s, want ~%s", cred.ExpiresAt, wantExpiry)
					}

					if shape == types.KubeconfigMintShapeExec {
						if cred.Token != wantToken || cred.Server != "https://203.0.113.10:6443" || cred.CertificateAuthorityData != f.pki.caData {
							t.Fatalf("exec credential does not carry the minted token on the pinned endpoint")
						}
						return
					}
					var kc staticKubeconfig
					if err := yaml.Unmarshal([]byte(cred.Kubeconfig), &kc); err != nil {
						t.Fatalf("static kubeconfig does not parse: %v", err)
					}
					if kc.CurrentContext != "alethia-web-shop-production" {
						t.Fatalf("context = %q", kc.CurrentContext)
					}
					if len(kc.Clusters) != 1 || kc.Clusters[0].Cluster.Server != "https://203.0.113.10:6443" || kc.Clusters[0].Cluster.CA != f.pki.caData {
						t.Fatal("static kubeconfig is not pinned to the cluster's endpoint and CA")
					}
					u := kc.Users[0].User
					if u.Token != wantToken || u.Cert != wantCert {
						t.Fatal("static kubeconfig does not carry the minted credential")
					}
					if certCloud && tier == types.KubeconfigMintTierAdmin && u.Key != f.pki.keyData {
						t.Fatal("static certificate kubeconfig lost its key")
					}
				})
			}
		}
	}
}

// TestMintKubeconfig_ACKDurationFollowsTheTier pins the ACK certificate lifetime: TTL (rounded up to
// minutes) for admin, ACK's 15-minute floor for the read-only tier's setup-only certificate.
func TestMintKubeconfig_ACKDurationFollowsTheTier(t *testing.T) {
	for _, tc := range []struct {
		tier types.KubeconfigMintTier
		ttl  int
		want int
	}{
		{types.KubeconfigMintTierAdmin, 3600, 60},
		{types.KubeconfigMintTierAdmin, 901, 16},
		{types.KubeconfigMintTierReadonly, 28800, cloud.ACKTempKubeconfigMinMinutes},
	} {
		f := newMintFixture(t, tc.tier, types.KubeconfigMintShapeStatic, "x")
		f.api.spec.TTLSeconds = tc.ttl
		if err := runMint(t, f, mintSnapshot("alibaba")); err != nil {
			t.Fatalf("%s ttl=%d: %v", tc.tier, tc.ttl, err)
		}
		if len(f.ackMins) != 1 || f.ackMins[0] != tc.want {
			t.Fatalf("%s ttl=%d: ACK asked for %v minutes, want %d", tc.tier, tc.ttl, f.ackMins, tc.want)
		}
	}
}

// TestMintKubeconfig_CertificateCloudsRefuseExec enforces decision 4 on the runner too: Talos and ACK
// credentials are certificates, which no exec plugin can re-mint.
func TestMintKubeconfig_CertificateCloudsRefuseExec(t *testing.T) {
	for _, p := range []string{"alibaba", "hetzner"} {
		f := newMintFixture(t, types.KubeconfigMintTierAdmin, types.KubeconfigMintShapeExec, "x")
		err := runMint(t, f, mintSnapshot(p))
		assertMintFailed(t, f, err, mintReasonShape)
		if len(f.ackMins) != 0 {
			t.Fatalf("%s: a refused shape still reached the cloud", p)
		}
	}
}

// assertMintFailed checks the handler returned and posted exactly `reason`.
func assertMintFailed(t *testing.T, f *mintFixture, err error, reason string) {
	t.Helper()
	if err == nil || err.Error() != reason {
		t.Fatalf("returned %v, want %q", err, reason)
	}
	res := f.api.results()
	if len(res) != 1 || res[0].Status != types.KubeconfigMintStatusFailed || res[0].Reason != reason || res[0].Sealed != "" {
		t.Fatalf("posted %+v, want one failed result with %q", res, reason)
	}
}

// mintFailureCases are every failure the handler classifies, each with the sentence it must post.
// The canary test drives the same table.
func mintFailureCases() []struct {
	name     string
	provider string
	tier     types.KubeconfigMintTier
	shape    types.KubeconfigMintShape
	setup    func(f *mintFixture, secret string)
	snapshot func(map[string]any)
	reason   string
} {
	ro, adm := types.KubeconfigMintTierReadonly, types.KubeconfigMintTierAdmin
	ex, st := types.KubeconfigMintShapeExec, types.KubeconfigMintShapeStatic
	leak := func(secret string) error {
		return errors.New("presign https://sts.amazonaws.com/?X-Amz-Signature=" + secret)
	}
	return []struct {
		name     string
		provider string
		tier     types.KubeconfigMintTier
		shape    types.KubeconfigMintShape
		setup    func(f *mintFixture, secret string)
		snapshot func(map[string]any)
		reason   string
	}{
		{"bad snapshot", "aws", adm, ex, nil, func(s map[string]any) { s["not_a_snapshot_key_"+"x"] = 1 }, mintReasonUnknown},
		{"namespace placement", "aws", adm, ex, nil, func(s map[string]any) { s["placement_mode"] = "namespace" }, mintReasonSharedCluster},
		{"vcluster placement", "gcp", ro, st, nil, func(s map[string]any) { s["placement_mode"] = "vcluster" }, mintReasonSharedCluster},
		{"unsupported cloud", "digitalocean", adm, st, nil, nil, mintReasonShape},
		{"exec on alibaba", "alibaba", ro, ex, nil, nil, mintReasonShape},
		{"no cluster name, outputs unreadable", "aws", adm, ex, func(f *mintFixture, s string) {
			f.seams.readOutputs = func(context.Context, *Runner, *Job, *types.ProjectConfig, *JobLogger, *JobLogger) (map[string]any, error) {
				return nil, leak(s)
			}
		}, func(m map[string]any) { delete(m, "cluster") }, mintReasonNotFound},
		{"no cluster name anywhere", "azure", adm, ex, func(f *mintFixture, s string) {
			f.seams.readOutputs = func(context.Context, *Runner, *Job, *types.ProjectConfig, *JobLogger, *JobLogger) (map[string]any, error) {
				return map[string]any{"kubeconfig": "secret " + s}, nil
			}
		}, func(m map[string]any) { delete(m, "cluster") }, mintReasonNotFound},
		{"eks describe fails", "aws", adm, ex, func(f *mintFixture, s string) {
			f.seams.eksConn = func(context.Context, string, string) (string, string, error) { return "", "", leak(s) }
		}, nil, mintReasonNotFound},
		{"eks token fails", "aws", ro, st, func(f *mintFixture, s string) {
			f.seams.eksToken = func(context.Context, string, string) (string, time.Time, error) { return "", time.Time{}, leak(s) }
		}, nil, mintReasonIdentity},
		{"gke get fails", "gcp", adm, ex, func(f *mintFixture, s string) {
			f.seams.gkeConn = func(context.Context, *types.ProjectConfig, string) (string, string, error) { return "", "", leak(s) }
		}, nil, mintReasonNotFound},
		{"gke token empty", "gcp", adm, st, func(f *mintFixture, _ string) {
			f.seams.gkeToken = func(context.Context) (string, time.Time, error) { return "", time.Time{}, nil }
		}, nil, mintReasonRefused},
		{"aks endpoint empty", "azure", adm, ex, func(f *mintFixture, _ string) {
			f.seams.aksConn = func(context.Context, *types.ProjectConfig, string) (string, string, error) { return "", "", nil }
		}, nil, mintReasonNotFound},
		{"aks get fails", "azure", ro, ex, func(f *mintFixture, s string) {
			f.seams.aksConn = func(context.Context, *types.ProjectConfig, string) (string, string, error) { return "", "", leak(s) }
		}, nil, mintReasonNotFound},
		{"aks token fails", "azure", adm, ex, func(f *mintFixture, s string) {
			f.seams.aksToken = func(context.Context) (string, time.Time, error) { return "", time.Time{}, leak(s) }
		}, nil, mintReasonIdentity},
		{"ack cluster not found", "alibaba", adm, st, func(f *mintFixture, s string) {
			f.seams.ackKubeconfig = func(context.Context, string, string, int) (string, error) {
				return "", fmt.Errorf("%w: %s", cloud.ErrACKClusterNotReady, s)
			}
		}, nil, mintReasonNotFound},
		{"ack refuses", "alibaba", ro, st, func(f *mintFixture, s string) {
			f.seams.ackKubeconfig = func(context.Context, string, string, int) (string, error) { return "", leak(s) }
		}, nil, mintReasonRefused},
		{"ack answers garbage", "alibaba", adm, st, func(f *mintFixture, s string) {
			f.seams.ackKubeconfig = func(context.Context, string, string, int) (string, error) { return "not: [a kubeconfig " + s, nil }
		}, nil, mintReasonRefused},
		{"talosconfig unreadable", "hetzner", adm, st, func(f *mintFixture, s string) {
			f.api.talosFetchFn = func(string) (string, error) { return "", leak(s) }
		}, nil, mintReasonIdentity},
		{"no talosconfig", "hetzner", ro, st, func(f *mintFixture, _ string) {
			f.api.talosFetchFn = func(string) (string, error) { return "  ", nil }
		}, nil, mintReasonIdentity},
		{"talos apid unreachable", "hetzner", adm, st, func(f *mintFixture, s string) {
			f.seams.talosKubeconfig = func(context.Context, string) ([]byte, error) { return nil, leak(s) }
		}, nil, mintReasonUnreachable},
		{"talos admin cert outlives the 8h cap", "hetzner", adm, st, func(f *mintFixture, _ string) {
			f.pki = newTestPKI(f.t, 24*time.Hour) // the managed hetzner template's certLifetime
		}, nil, mintReasonAdminLifetime},
		{"talos answers a token kubeconfig", "hetzner", adm, st, func(f *mintFixture, s string) {
			f.seams.talosKubeconfig = func(context.Context, string) ([]byte, error) {
				return []byte("clusters:\n- name: c\n  cluster:\n    server: https://203.0.113.10\n    certificate-authority-data: Q0E=\nusers:\n- name: u\n  user:\n    token: " + s + "\n"), nil
			}
		}, nil, mintReasonRefused},
		{"read-only RBAC refused", "aws", ro, ex, func(f *mintFixture, s string) {
			f.kube.failOn = map[string]int{"/clusterroles/": http.StatusForbidden}
			f.kube.failBody = `{"kind":"Status","message":"forbidden ` + s + `"}`
		}, nil, mintReasonReadOnly},
		{"token request fails", "gcp", ro, st, func(f *mintFixture, s string) {
			f.kube.failOn = map[string]int{"/token": http.StatusInternalServerError}
			f.kube.failBody = s
		}, nil, mintReasonReadOnly},
		{"cluster unreachable", "azure", ro, st, func(f *mintFixture, s string) {
			f.kube.transportErr = urlTransportErr(s)
		}, nil, mintReasonUnreachable},
		{"kube client refused", "aws", ro, st, func(f *mintFixture, s string) {
			f.seams.newKube = func(kubeaccess.Conn) (kubeaccess.KubeAPI, error) { return nil, leak(s) }
		}, nil, mintReasonUnknown},
		{"loopback endpoint", "aws", ro, ex, func(f *mintFixture, _ string) {
			f.seams.eksConn = func(context.Context, string, string) (string, string, error) {
				return "https://127.0.0.1:6443", f.pki.caData, nil
			}
		}, nil, mintReasonUnreachable},
		{"metadata endpoint", "hetzner", ro, st, func(f *mintFixture, _ string) {
			f.seams.talosKubeconfig = func(context.Context, string) ([]byte, error) {
				return []byte(certKubeconfigYAML("https://169.254.169.254", f.pki)), nil
			}
		}, nil, mintReasonUnreachable},
		{"endpoint does not resolve", "gcp", ro, ex, func(f *mintFixture, _ string) {
			f.seams.gkeConn = func(context.Context, *types.ProjectConfig, string) (string, string, error) {
				return "https://api.example.invalid", f.pki.caData, nil
			}
		}, nil, mintReasonUnreachable},
		{"low-order client key", "aws", adm, ex, func(f *mintFixture, _ string) {
			f.api.spec.ClientPublicKey = strings.Repeat("A", 43)
		}, nil, mintReasonSeal},
		{"render refuses a bad CA", "azure", adm, st, func(f *mintFixture, _ string) {
			f.seams.aksConn = func(context.Context, *types.ProjectConfig, string) (string, string, error) {
				return "https://203.0.113.10", "bm90IGEgY2E=", nil
			}
		}, nil, mintReasonUnknown},
	}
}

// TestMintKubeconfig_FailuresPostTheirFixedSentence drives every classified failure and checks the
// posted reason is exactly the sentence that failure maps to — and is in the console's set.
func TestMintKubeconfig_FailuresPostTheirFixedSentence(t *testing.T) {
	allowed := map[string]bool{}
	for _, r := range mintFailureReasons {
		allowed[r] = true
	}
	for _, tc := range mintFailureCases() {
		t.Run(tc.name, func(t *testing.T) {
			f := newMintFixture(t, tc.tier, tc.shape, "s3cr3t")
			if tc.setup != nil {
				tc.setup(f, "s3cr3t")
			}
			snap := mintSnapshot(tc.provider)
			if tc.snapshot != nil {
				tc.snapshot(snap)
			}
			err := runMint(t, f, snap)
			assertMintFailed(t, f, err, tc.reason)
			if !allowed[tc.reason] {
				t.Fatalf("%q is not a sentence the console stores", tc.reason)
			}
		})
	}
}

// TestMintKubeconfig_AdminLifetimeCap pins #5326: an admin credential whose REAL lifetime would
// exceed the 8h TTL ceiling is refused with its fixed sentence, whatever cloud issued it, and one at
// or under the ceiling is handed out. The read-only tier only uses the admin certificate in memory to
// prepare its identity, so a long-lived one does not stop a read-only mint.
func TestMintKubeconfig_AdminLifetimeCap(t *testing.T) {
	adm, ro := types.KubeconfigMintTierAdmin, types.KubeconfigMintTierReadonly
	for _, tc := range []struct {
		name     string
		provider string
		tier     types.KubeconfigMintTier
		shape    types.KubeconfigMintShape
		certLife time.Duration // the Talos/ACK admin certificate's lifetime
		tokLife  time.Duration // the bearer clouds' admin token lifetime
		refused  bool
	}{
		{"talos 1h", "hetzner", adm, types.KubeconfigMintShapeStatic, time.Hour, 0, false},
		{"talos exactly 8h", "hetzner", adm, types.KubeconfigMintShapeStatic, 8 * time.Hour, 0, false},
		{"talos 8h1m", "hetzner", adm, types.KubeconfigMintShapeStatic, 8*time.Hour + time.Minute, 0, true},
		{"talos 24h (the template default)", "hetzner", adm, types.KubeconfigMintShapeStatic, 24 * time.Hour, 0, true},
		{"talos 24h read-only setup cert", "hetzner", ro, types.KubeconfigMintShapeStatic, 24 * time.Hour, 0, false},
		{"gcp token 1h", "gcp", adm, types.KubeconfigMintShapeExec, time.Hour, time.Hour, false},
		{"azure token 9h", "azure", adm, types.KubeconfigMintShapeExec, time.Hour, 9 * time.Hour, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMintFixture(t, tc.tier, tc.shape, "x")
			f.pki = newTestPKI(t, tc.certLife)
			if tc.tokLife > 0 {
				f.cloudExpiry = time.Now().Add(tc.tokLife).Truncate(time.Second)
			}
			err := runMint(t, f, mintSnapshot(tc.provider))
			if tc.refused {
				assertMintFailed(t, f, err, mintReasonAdminLifetime)
				return
			}
			if err != nil {
				t.Fatalf("mint: %v", err)
			}
			res := f.api.results()
			if len(res) != 1 {
				t.Fatalf("want one result, got %d", len(res))
			}
			f.open(t, res[0])
		})
	}
}

// TestMintKubeconfig_PrivateEndpointIsReported checks decision 6 end to end: a private API server is
// still minted for, and the result says so — on success, and on a failure after the endpoint is known.
func TestMintKubeconfig_PrivateEndpointIsReported(t *testing.T) {
	f := newMintFixture(t, types.KubeconfigMintTierAdmin, types.KubeconfigMintShapeExec, "x")
	f.seams.eksConn = func(context.Context, string, string) (string, string, error) {
		return "https://10.0.12.7", f.pki.caData, nil
	}
	if err := runMint(t, f, mintSnapshot("aws")); err != nil {
		t.Fatal(err)
	}
	if r := f.api.results(); len(r) != 1 || r[0].PrivateEndpoint == nil || !*r[0].PrivateEndpoint {
		t.Fatalf("private endpoint not reported on success: %+v", r)
	}

	f = newMintFixture(t, types.KubeconfigMintTierReadonly, types.KubeconfigMintShapeExec, "x")
	f.seams.eksConn = func(context.Context, string, string) (string, string, error) {
		return "https://10.0.12.7", f.pki.caData, nil
	}
	f.kube.transportErr = urlTransportErr("x")
	err := runMint(t, f, mintSnapshot("aws"))
	assertMintFailed(t, f, err, mintReasonUnreachable)
	if r := f.api.results(); r[0].PrivateEndpoint == nil || !*r[0].PrivateEndpoint {
		t.Fatal("private endpoint not reported on a failure after classification")
	}
}

// TestMintKubeconfig_ClusterNameFromOutputs proves the first-deploy case: the snapshot has no cluster
// name, so it comes from the environment's tofu outputs.
func TestMintKubeconfig_ClusterNameFromOutputs(t *testing.T) {
	f := newMintFixture(t, types.KubeconfigMintTierAdmin, types.KubeconfigMintShapeExec, "x")
	var gotName string
	f.seams.eksConn = func(_ context.Context, _, name string) (string, string, error) {
		gotName = name
		return "https://203.0.113.10", f.pki.caData, nil
	}
	snap := mintSnapshot("aws")
	delete(snap, "cluster")
	if err := runMint(t, f, snap); err != nil {
		t.Fatal(err)
	}
	if gotName != "c1" {
		t.Fatalf("cluster name = %q, want the eks_cluster_name output", gotName)
	}
}

// TestMintKubeconfig_ConsoleRefusalsEndCleanly covers the channel's status codes on both calls.
func TestMintKubeconfig_ConsoleRefusalsEndCleanly(t *testing.T) {
	notOwned := fmt.Errorf("x: %w", ErrJobNotOwned)
	for _, tc := range []struct {
		name    string
		specErr error
		postErr error
		want    error // nil means the handler returned nil
	}{
		{"spec 410", errMintWindowClosed, nil, errMintWindowClosed},
		{"spec 404", errMintNotFound, nil, errMintNotFound},
		{"spec 409", errMintSettled, nil, nil},
		{"spec 403", notOwned, nil, ErrJobNotOwned},
		{"spec unreadable", errors.New("dial tcp: refused"), nil, errMintSpecUnreadable},
		{"post 410", nil, errMintWindowClosed, errMintWindowClosed},
		{"post 409", nil, errMintSettled, nil},
		{"post 403", nil, notOwned, ErrJobNotOwned},
		{"post network", nil, errors.New("dial tcp: refused"), errMintNotDelivered},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMintFixture(t, types.KubeconfigMintTierAdmin, types.KubeconfigMintShapeExec, "x")
			f.api.specErr, f.api.postErr = tc.specErr, tc.postErr
			err := runMint(t, f, mintSnapshot("aws"))
			if tc.want == nil {
				if err != nil {
					t.Fatalf("want a clean end, got %v", err)
				}
			} else if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
			if tc.specErr != nil && len(f.api.results()) != 0 {
				t.Fatal("a refused spec read must post nothing")
			}
		})
	}

	// A failed mint whose failure post is refused for a network reason still ends with its sentence.
	f := newMintFixture(t, types.KubeconfigMintTierAdmin, types.KubeconfigMintShapeExec, "x")
	f.seams.eksConn = func(context.Context, string, string) (string, string, error) { return "", "", errors.New("x") }
	f.api.postErr = errors.New("dial tcp: refused")
	if err := runMint(t, f, mintSnapshot("aws")); err == nil || err.Error() != mintReasonNotFound {
		t.Fatalf("got %v, want the mint's own sentence", err)
	}
}

// TestDescribeMintCause_NeverQuotesTheError pins the operational log's description of a cause: a
// type or a status code, never the text.
func TestDescribeMintCause_NeverQuotesTheError(t *testing.T) {
	secret := "tok-9f8e7d"
	for _, err := range []error{
		errors.New(secret),
		urlTransportErr(secret),
		&kubeaccess.APIError{Method: "PATCH", Path: "/x", Code: 403, Message: secret},
		fmt.Errorf("wrapped %s: %w", secret, errors.New(secret)),
	} {
		if got := describeMintCause(err); strings.Contains(got, secret) || got == "" {
			t.Fatalf("describeMintCause(%T) = %q", err, got)
		}
	}
	if describeMintCause(nil) != "" {
		t.Fatal("nil cause must describe as empty")
	}
}

// TestAssertMintServerDialable pins the dial guard's boundary: loopback, link-local and unspecified
// are refused (also when a hostname resolves to them, and in the IPv4-mapped form); RFC 1918 is not.
func TestAssertMintServerDialable(t *testing.T) {
	resolveTo := func(addr string) func(context.Context, string) ([]netip.Addr, error) {
		return func(context.Context, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr(addr)}, nil
		}
	}
	for _, tc := range []struct {
		server string
		lookup func(context.Context, string) ([]netip.Addr, error)
		ok     bool
	}{
		{"https://10.0.0.1:6443", nil, true},
		{"https://203.0.113.9", nil, true},
		{"https://api.example.com", resolveTo("192.168.1.4"), true},
		{"https://127.0.0.1", nil, false},
		{"https://[::1]:6443", nil, false},
		{"https://169.254.169.254", nil, false},
		{"https://[::ffff:169.254.169.254]", nil, false},
		{"https://0.0.0.0", nil, false},
		{"https://metadata.internal", resolveTo("169.254.169.254"), false},
		{"https://nowhere.invalid", func(context.Context, string) ([]netip.Addr, error) { return nil, errors.New("nx") }, false},
		{"not a url", nil, false},
	} {
		lookup := tc.lookup
		if lookup == nil {
			lookup = func(context.Context, string) ([]netip.Addr, error) { return nil, errors.New("unexpected lookup") }
		}
		err := assertMintServerDialable(context.Background(), tc.server, lookup)
		if (err == nil) != tc.ok {
			t.Fatalf("%s: err=%v, want ok=%v", tc.server, err, tc.ok)
		}
	}
}

// TestDefaultMintSeams_WireTheRealMinters checks the production seam set is complete and that the
// pieces which need no cloud behave: the kube client refuses a connection with no CA, the dial guard's
// resolver answers for localhost, and the outputs read surfaces a state-token failure.
func TestDefaultMintSeams_WireTheRealMinters(t *testing.T) {
	s := defaultMintSeams()
	if s.readOutputs == nil || s.eksConn == nil || s.eksToken == nil || s.gkeConn == nil || s.gkeToken == nil ||
		s.aksConn == nil || s.aksToken == nil || s.ackKubeconfig == nil || s.talosKubeconfig == nil ||
		s.newKube == nil || s.lookupIP == nil || s.resolver == nil {
		t.Fatal("a production seam is unwired")
	}
	if _, err := s.newKube(kubeaccess.Conn{Server: "https://203.0.113.10", Token: "t"}); err == nil {
		t.Fatal("the production kube client must refuse a connection with no CA")
	}
	if addrs, err := s.lookupIP(context.Background(), "localhost"); err != nil || len(addrs) == 0 {
		t.Fatalf("lookup localhost: %v %v", addrs, err)
	}
	api := newCovRunAPI()
	api.stateTokenErr = errors.New("no state token")
	w := NewWithAPI(Config{RunnerID: "r"}, api)
	if _, err := s.readOutputs(context.Background(), w, &Job{ID: "j"}, &types.ProjectConfig{}, nil, nil); err == nil {
		t.Fatal("a state-token failure must surface from the outputs read")
	}
}
