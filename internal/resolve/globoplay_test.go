package resolve

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestGloboplayHandlerInvalidHost(t *testing.T) {
	g := &GloboplayResolver{SessionPath: filepath.Join(t.TempDir(), "globoplay-session.json")}
	req := httptest.NewRequest("GET", "/resolve-globoplay?url=https://example.com/x", nil)
	rec := httptest.NewRecorder()
	g.Handler(rec, req)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
}

func TestGloboplayHandlerNoSession(t *testing.T) {
	g := &GloboplayResolver{SessionPath: filepath.Join(t.TempDir(), "globoplay-session.json")}
	req := httptest.NewRequest("GET", "/resolve-globoplay?url=https://globoplay.globo.com/tv-globo/ao-vivo/6120663/", nil)
	rec := httptest.NewRecorder()
	g.Handler(rec, req)
	if rec.Code != 412 {
		t.Fatalf("status = %d, want 412, body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body["code"] != "NO_SESSION" {
		t.Fatalf("code = %v, want NO_SESSION", body["code"])
	}
}

func TestGloboplayHandlerBusyGuard(t *testing.T) {
	g := &GloboplayResolver{SessionPath: filepath.Join(t.TempDir(), "globoplay-session.json")}
	g.resolving.Store(true) // simula uma resolução já em andamento
	req := httptest.NewRequest("GET", "/resolve-globoplay?url=https://globoplay.globo.com/tv-globo/ao-vivo/6120663/", nil)
	rec := httptest.NewRecorder()
	g.Handler(rec, req)
	if rec.Code != 429 {
		t.Fatalf("status = %d, want 429, body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body["code"] != "BUSY" {
		t.Fatalf("code = %v, want BUSY", body["code"])
	}
}
