// Stream Inspector — servidor estático + proxy de CORS, em Go.
//
// Porta 1:1 de server.js: frontend embedado (public/), proxy /p/ com
// bloqueio de SSRF, throttle, histórico persistente (SQLite), resolução de
// YouTube (yt-dlp) e Globoplay (Playwright) — mesmas rotas, mesmos formatos
// de resposta, mesmas variáveis de ambiente.
//
//	go run ./cmd/server            → http://localhost:8787
//	PORT=3000 go run ./cmd/server  → porta customizada
package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"

	assets "stream-inspector"
	"stream-inspector/internal/history"
	"stream-inspector/internal/proxy"
	"stream-inspector/internal/resolve"
	"stream-inspector/internal/security"
	"stream-inspector/internal/static"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8787"
	}
	// Escuta só em loopback por padrão — mesmo racional de server.js:36-40:
	// o proxy /p/ e os endpoints de resolução são poderosos e não devem
	// ficar expostos à rede sem intenção explícita (override: HOST=0.0.0.0).
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}

	hist := history.Open()
	dataDir, err := history.DataDir()
	if err != nil {
		log.Fatal(err)
	}
	globoplay := &resolve.GloboplayResolver{SessionPath: filepath.Join(dataDir, "globoplay-session.json")}

	mux := http.NewServeMux()
	mux.Handle("GET /p/", http.HandlerFunc(proxy.Handler))
	mux.HandleFunc("GET /throttle", withSameOriginGuard(proxy.ThrottleHandler))
	mux.HandleFunc("GET /resolve", withSameOriginGuard(resolve.YouTubeHandler))
	mux.HandleFunc("GET /resolve-globoplay", withSameOriginGuard(globoplay.Handler))
	// POST /api/history muda estado (grava) → guard de mesma-origem, igual a
	// server.js:808-811. GET /api/history é só leitura, sem guard, igual a
	// server.js:832.
	mux.HandleFunc("POST /api/history", withSameOriginGuard(hist.SaveHandler))
	mux.HandleFunc("GET /api/history", hist.ListHandler)
	mux.Handle("/", static.Handler(assets.Public))

	addr := host + ":" + port
	log.Printf("Stream Inspector rodando em http://localhost:%s (host: %s)", port, host)
	log.Printf("Proxy de CORS ativo em /p/<scheme>/<host>/<caminho>")
	log.Fatal(http.ListenAndServe(addr, recoverMiddleware(withMethodGate(mux))))
}

// withMethodGate reproduz o topo de server.js:routeRequest (linhas 806-815),
// que roda ANTES de qualquer roteamento por path:
//  1. OPTIONS em qualquer caminho → preflight.
//  2. POST em /api/history é a única exceção de escrita permitida (o
//     próprio handler faz o guard de mesma-origem) — deixa passar pro mux.
//  3. Qualquer outro método que não seja GET/HEAD → 405, mesmo em
//     caminhos desconhecidos.
//
// Sem isto, o "/" catch-all do ServeMux (a rota estática, sem restrição de
// método) aceitaria PUT/DELETE/etc. em qualquer caminho não registrado —
// as rotas "MÉTODO /caminho" específicas (GET /p/, etc.) já dão 405
// automático do próprio ServeMux (Go 1.22+) para outros métodos NELAS, mas
// isso não cobre caminhos arbitrários fora de qualquer padrão registrado.
func withMethodGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			security.HandlePreflight(w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/history" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Método não permitido", http.StatusMethodNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// withSameOriginGuard bloqueia endpoints caros/que mudam estado quando
// acionados por uma origem externa explícita — igual ao guard em
// server.js:818-831 (isSameOrigin antes de handleThrottle/handleResolve*/POST /api/history).
func withSameOriginGuard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !security.IsSameOrigin(r) {
			security.DenyCrossOrigin(w)
			return
		}
		next(w, r)
	}
}

// recoverMiddleware é defesa em profundidade: o net/http do Go já isola
// panics por goroutine de requisição (não derruba o processo, ao contrário
// do Node — ver server.js:790-799), mas sem isto a conexão simplesmente
// cairia sem resposta; aqui devolve 500 e loga, para paridade de
// comportamento observável com o server.js.
func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				log.Printf("panic em %s %s: %v", r.Method, r.URL.Path, err)
				http.Error(w, "Erro interno", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}
