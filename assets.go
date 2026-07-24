// Package assets embeda o frontend (public/) no binário. Precisa viver na
// raiz do módulo porque o padrão do //go:embed não pode subir diretórios
// (".."); embedar a partir de cmd/server exigiria isso, já que public/ é
// irmã de cmd/, não filha.
package assets

import (
	"embed"
	"io/fs"
)

//go:embed all:public
var publicFS embed.FS

// Public é o mesmo conteúdo, mas com a raiz em public/ (sem o prefixo
// "public/" em cada caminho) — o que internal/static.Handler espera.
var Public fs.FS = mustSub(publicFS, "public")

func mustSub(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(err)
	}
	return sub
}
