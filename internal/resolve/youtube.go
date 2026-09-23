// Resolução de URL do YouTube via yt-dlp LOCAL — mesmo racional de
// server.js:handleResolve. O sistema não decodifica assinaturas/DRM;
// delega inteiramente ao yt-dlp, que o usuário instala (pip install
// yt-dlp). Restrito a uma allowlist de hosts conhecidos para não virar um
// resolvedor/downloader genérico.
package resolve

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var ytHostsRe = regexp.MustCompile(`(?i)^(?:www\.|m\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$`)

const ytdlpTimeout = 30 * time.Second

// ytFormat espelha os campos do JSON do yt-dlp que a UI realmente usa —
// mesma projeção "slim" de server.js:handleResolve (o JSON completo do
// yt-dlp é enorme).
type ytFormat struct {
	FormatID       string  `json:"format_id"`
	Ext            string  `json:"ext"`
	Protocol       string  `json:"protocol"`
	Vcodec         string  `json:"vcodec"`
	Acodec         string  `json:"acodec"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	FPS            float64 `json:"fps"`
	TBR            float64 `json:"tbr"`
	VBR            float64 `json:"vbr"`
	ABR            float64 `json:"abr"`
	AudioChannels  int     `json:"audio_channels"`
	ASR            int     `json:"asr"`
	Language       string  `json:"language"`
	DynamicRange   string  `json:"dynamic_range"`
	Filesize       float64 `json:"filesize"`
	FilesizeApprox float64 `json:"filesize_approx"`
	ManifestURL    string  `json:"manifest_url"`
	URL            string  `json:"url"`
	FormatNote     string  `json:"format_note"`
}

type ytChapter struct {
	Title     string  `json:"title"`
	StartTime float64 `json:"start_time"`
}

// ytInfo é o subconjunto do JSON completo do yt-dlp (`-J`) que nos importa.
type ytInfo struct {
	ID                string         `json:"id"`
	Title             string         `json:"title"`
	Uploader          string         `json:"uploader"`
	IsLive            bool           `json:"is_live"`
	WasLive           bool           `json:"was_live"`
	LiveStatus        string         `json:"live_status"`
	Duration          float64        `json:"duration"`
	WebpageURL        string         `json:"webpage_url"`
	Formats           []ytFormat     `json:"formats"`
	Subtitles         map[string]any `json:"subtitles"`
	AutomaticCaptions map[string]any `json:"automatic_captions"`
	Chapters          []ytChapter    `json:"chapters"`
}

func writeJSONErr(w http.ResponseWriter, status int, payload map[string]any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("access-control-allow-origin", "*")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

// YouTubeHandler implementa GET /resolve?url=<youtube-url> — mesmo formato
// de resposta de server.js:handleResolve.
func YouTubeHandler(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || !ytHostsRe.MatchString(u.Hostname()) {
		writeJSONErr(w, http.StatusBadRequest, map[string]any{
			"error": "URL do YouTube inválida ou host não suportado.",
		})
		return
	}

	if _, err := exec.LookPath("yt-dlp"); err != nil {
		writeJSONErr(w, http.StatusNotImplemented, map[string]any{
			"error": `yt-dlp não encontrado. Instale com "pip install yt-dlp" (ou "pipx install yt-dlp") na máquina que roda o servidor.`,
			"code":  "NO_YTDLP",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), ytdlpTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "yt-dlp", "-J", "--no-warnings", "--no-playlist", raw)
	stdout, err := cmd.Output()
	if err != nil {
		var stderr string
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderr = string(exitErr.Stderr)
		}
		writeJSONErr(w, http.StatusBadGateway, map[string]any{
			"error":  "yt-dlp falhou ao resolver a URL.",
			"detail": truncateDetail(stderr, err),
		})
		return
	}

	var info ytInfo
	if err := json.Unmarshal(stdout, &info); err != nil {
		writeJSONErr(w, http.StatusBadGateway, map[string]any{"error": "Saída do yt-dlp não é JSON válido."})
		return
	}

	webpageURL := info.WebpageURL
	if webpageURL == "" {
		webpageURL = raw
	}
	resp := map[string]any{
		"id": info.ID, "title": info.Title, "uploader": info.Uploader,
		"is_live": info.IsLive, "was_live": info.WasLive,
		"live_status":        nullIfEmptyStr(info.LiveStatus),
		"duration":           nullIfZero(info.Duration),
		"webpage_url":        webpageURL,
		"formats":            info.Formats,
		"subtitles":          keysOf(info.Subtitles),
		"automatic_captions": keysOf(info.AutomaticCaptions),
		"chapters":           info.Chapters,
	}
	writeJSONErr(w, http.StatusOK, resp)
}

func keysOf(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

func nullIfEmptyStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullIfZero(f float64) any {
	if f == 0 {
		return nil
	}
	return f
}

func truncateDetail(stderr string, err error) string {
	src := stderr
	if strings.TrimSpace(src) == "" {
		src = err.Error()
	}
	lines := strings.Split(strings.TrimRight(src, "\n"), "\n")
	if len(lines) > 4 {
		lines = lines[len(lines)-4:]
	}
	detail := strings.Join(lines, " ")
	if len(detail) > 400 {
		detail = detail[:400]
	}
	return detail
}
