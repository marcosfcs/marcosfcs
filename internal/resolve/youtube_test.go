package resolve

import (
	"encoding/json"
	"net/http/httptest"
	"os/exec"
	"testing"
)

func TestYouTubeHandlerInvalidHost(t *testing.T) {
	req := httptest.NewRequest("GET", "/resolve?url=https://example.com/watch", nil)
	rec := httptest.NewRecorder()
	YouTubeHandler(rec, req)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestYouTubeHandlerNoYtDlp(t *testing.T) {
	if _, err := exec.LookPath("yt-dlp"); err == nil {
		t.Skip("yt-dlp está instalado neste ambiente — este teste só cobre o caminho NO_YTDLP")
	}
	req := httptest.NewRequest("GET", "/resolve?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ", nil)
	rec := httptest.NewRecorder()
	YouTubeHandler(rec, req)
	if rec.Code != 501 {
		t.Fatalf("status = %d, want 501, body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body["code"] != "NO_YTDLP" {
		t.Fatalf("code = %v, want NO_YTDLP", body["code"])
	}
}
