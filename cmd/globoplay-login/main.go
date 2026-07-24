// Login único no Globoplay para a resolução automática de manifest
// funcionar — porte Go de scripts/globoplay-login.js (mesmo fluxo, mesmo
// formato de saída).
//
// O conteúdo ao vivo do Globoplay exige uma conta logada. Este programa
// abre um Chromium REAL E VISÍVEL, deixa você fazer login manualmente como
// faria normalmente, e salva a sessão (cookies + localStorage) em
// ~/.stream-inspector/globoplay-session.json — o servidor reaproveita esse
// arquivo depois, em modo headless, pra resolver URLs do Globoplay sem
// pedir login de novo (até a sessão expirar, aí é só rodar de novo). Fica
// FORA da pasta do repositório de propósito: um `git clone`/checkout novo
// nunca apaga essa sessão (mesmo caminho usado pelo servidor — ver
// internal/history.DataDir).
//
// Uso:
//
//	go run ./cmd/globoplay-login
//
// A sessão fica só na sua máquina (fora do repo, nunca vai pro git) — nunca
// é enviada a lugar nenhum além do próprio Globoplay.
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mxschmitt/playwright-go"

	"stream-inspector/internal/history"
)

func main() {
	dataDir, err := history.DataDir()
	if err != nil {
		fmt.Println("Erro:", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		fmt.Println("Erro:", err)
		os.Exit(1)
	}
	sessionPath := filepath.Join(dataDir, "globoplay-session.json")

	pw, err := playwright.Run()
	if err != nil {
		fmt.Println("Playwright não está instalado. Rode a instalação do driver/Chromium " +
			"(ver README) antes deste programa.")
		os.Exit(1)
	}
	defer pw.Stop()

	fmt.Println("Abrindo um Chromium visível — faça login no Globoplay normalmente na janela que vai abrir.")
	headless := false
	browser, err := pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{Headless: &headless})
	if err != nil {
		fmt.Println("Erro:", err)
		os.Exit(1)
	}
	defer browser.Close()

	ctx, err := browser.NewContext()
	if err != nil {
		fmt.Println("Erro:", err)
		os.Exit(1)
	}
	page, err := ctx.NewPage()
	if err != nil {
		fmt.Println("Erro:", err)
		os.Exit(1)
	}
	if _, err := page.Goto("https://globoplay.globo.com/", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
	}); err != nil {
		fmt.Println("Erro ao abrir o Globoplay:", err)
		os.Exit(1)
	}

	fmt.Print("\nDepois de terminar o login no navegador, volte aqui e aperte Enter para salvar a sessão... ")
	bufio.NewReader(os.Stdin).ReadString('\n')

	if _, err := ctx.StorageState(playwright.BrowserContextStorageStateOptions{Path: &sessionPath}); err != nil {
		fmt.Println("Erro ao salvar a sessão:", err)
		os.Exit(1)
	}

	// O arquivo guarda cookies de autenticação em texto puro — restringe a
	// leitura ao dono para outros usuários locais não conseguirem lê-lo.
	if err := os.Chmod(sessionPath, 0o600); err != nil {
		fmt.Println("Aviso: não consegui restringir a permissão do arquivo de sessão:", err)
	}

	fmt.Printf("Sessão salva em %s (modo 600 — contém credenciais, não compartilhe).\n", sessionPath)
	fmt.Println("Pronto — o app já pode resolver URLs do Globoplay automaticamente até essa sessão expirar.")
}
