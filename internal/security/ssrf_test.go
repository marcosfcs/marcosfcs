package security

import (
	"net"
	"testing"
)

func TestIsInternalIP(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"127.0.0.1", true},
		{"10.0.0.5", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"172.32.0.1", false}, // fora do /12
		{"192.168.1.1", true},
		{"169.254.169.254", true}, // metadata de nuvem
		{"100.64.0.1", true},      // CGNAT
		{"100.128.0.1", false},    // fora do /10
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"::1", true},
		{"fe80::1", true},
		{"fc00::1", true},
		{"2001:4860:4860::8888", false}, // DNS público (Google) — não interno
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if ip == nil {
			t.Fatalf("IP de teste inválido: %s", c.ip)
		}
		if got := IsInternalIP(ip); got != c.want {
			t.Errorf("IsInternalIP(%s) = %v, want %v", c.ip, got, c.want)
		}
	}
}

func TestIsBlockedHostname(t *testing.T) {
	if !IsBlockedHostname("localhost") {
		t.Error(`esperava bloquear "localhost"`)
	}
	if !IsBlockedHostname("foo.localhost") {
		t.Error(`esperava bloquear "foo.localhost"`)
	}
	if IsBlockedHostname("example.com") {
		t.Error(`não deveria bloquear "example.com"`)
	}
}
