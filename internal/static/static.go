// Package static serve o frontend (public/) embedado no binário — não
// precisa mais copiar a pasta separadamente para rodar o servidor, ao
// contrário do server.js (que lê do disco em PUBLIC_DIR).
package static

import (
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// mimeTypes espelha a tabela MIME de server.js — extensões de streaming
// (.m3u8/.mpd/.ts/.m4s/.vtt) não têm um tipo consistente garantido nos
// bancos de mime.types de todo SO, então declaramos explicitamente.
var mimeTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".ico":  "image/x-icon",
	".m3u8": "application/vnd.apple.mpegurl",
	".mpd":  "application/dash+xml",
	".ts":   "video/mp2t",
	".m4s":  "video/iso.segment",
	".mp4":  "video/mp4",
	".vtt":  "text/vtt; charset=utf-8",
}

func contentType(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if ct, ok := mimeTypes[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// Handler serve arquivos de publicFS (normalmente um embed.FS com raiz em
// public/), com "/" servindo index.html — igual ao handleStatic do
// server.js. Ao contrário do handler do Node, não precisa de proteção
// manual contra path traversal/null byte: fs.FS (e o roteamento do
// http.ServeMux, que já limpa ".."), fecham essa classe de bug por
// construção — um fs.FS embedado nem sequer enxerga fora da sua raiz.
func Handler(publicFS fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/")
		if rel == "" {
			rel = "index.html"
		}
		data, err := fs.ReadFile(publicFS, rel)
		if err != nil {
			http.Error(w, "Não encontrado: /"+rel, http.StatusNotFound)
			return
		}
		w.Header().Set("content-type", contentType(rel))
		w.Header().Set("cache-control", "no-cache")
		w.Write(data)
	}
}
