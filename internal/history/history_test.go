package history

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSaveAndListRoundTrip(t *testing.T) {
	t.Setenv("STREAM_INSPECTOR_DATA_DIR", t.TempDir())
	s := Open()
	if s.err != nil {
		t.Fatalf("Open() falhou: %v", s.err)
	}
	defer s.db.Close()

	body, _ := json.Marshal(map[string]any{
		"url":      "http://example.com/master.m3u8",
		"protocol": "hls",
		"live":     true,
		"summary":  map[string]any{"video": []int{1, 2, 3}},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/history", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.SaveHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("SaveHandler status = %d, body = %s", rec.Code, rec.Body.String())
	}

	req2 := httptest.NewRequest(http.MethodGet, "/api/history?limit=5", nil)
	rec2 := httptest.NewRecorder()
	s.ListHandler(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("ListHandler status = %d, body = %s", rec2.Code, rec2.Body.String())
	}
	var out struct {
		Items []item `json:"items"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &out); err != nil {
		t.Fatalf("resposta inválida: %v", err)
	}
	if len(out.Items) != 1 {
		t.Fatalf("esperava 1 item, veio %d", len(out.Items))
	}
	if out.Items[0].URL != "http://example.com/master.m3u8" || !out.Items[0].Live {
		t.Fatalf("item inesperado: %+v", out.Items[0])
	}
}

func TestPruneToMaxRows(t *testing.T) {
	t.Setenv("STREAM_INSPECTOR_DATA_DIR", t.TempDir())
	s := Open()
	if s.err != nil {
		t.Fatalf("Open() falhou: %v", s.err)
	}
	defer s.db.Close()

	insert := func(url string) {
		body, _ := json.Marshal(map[string]any{"url": url, "summary": map[string]any{}})
		req := httptest.NewRequest(http.MethodPost, "/api/history", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		s.SaveHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("insert falhou: %s", rec.Body.String())
		}
	}
	// Reduz o teto só para o teste rodar rápido sem inserir 500+1 linhas.
	orig := MaxRows
	MaxRows = 3
	defer func() { MaxRows = orig }()

	for i := 0; i < 5; i++ {
		insert("http://example.com/x")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/history?limit=100", nil)
	rec := httptest.NewRecorder()
	s.ListHandler(rec, req)
	var out struct {
		Items []item `json:"items"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Items) != 3 {
		t.Fatalf("esperava poda pra 3 linhas, veio %d", len(out.Items))
	}
}
