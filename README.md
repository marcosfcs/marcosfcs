# 📡 Stream Inspector — HLS / MPEG-DASH

Sistema web para inspeção completa de transmissões de streaming a partir da URL do
manifest (`.m3u8` ou `.mpd`). Cole a URL, clique em **Inspecionar** e o sistema
apresenta tudo o que a transmissão contém:

| Camada | O que é apresentado | Formato |
|---|---|---|
| Metadados | protocolo, tipo (VOD/ao vivo), versão, perfis, duração, períodos, buffer mínimo | tabela estática |
| Vídeo | variantes/representações: resolução, bitrate pico/médio, FPS, codec (nome amigável + string), faixa de vídeo (SDR/PQ/HLG/Dolby Vision), HDCP | tabela estática |
| Áudio | faixas: idioma, canais (estéreo/5.1/Atmos), codec, amostragem, bitrate, papéis | tabela estática |
| Legendas | legendas e closed captions: idioma, formato (WebVTT/TTML/CEA-608), forçada/padrão | tabela estática |
| DRM | Widevine, PlayReady, FairPlay, ClearKey, AES (via `EXT-X-KEY`/`ContentProtection`), default_KID | tabela estática |
| Segmentação | modo (SegmentTemplate/Timeline/playlist), contagem, durações, descontinuidades | tabela + **gráfico temporal estático** |
| Container real | inspeção binária de um segmento (PAT/PMT do MPEG-TS; moov/tenc/pssh do fMP4): streams reais, idiomas, KID/esquema de criptografia | tabela + indicadores |
| Telemetria | buffer de reprodução (escalar + **timeline real de `video.buffered`**), bitrate do nível ativo, banda estimada, frames perdidos, latência live (edge e E2E via PROGRAM-DATE-TIME), FPS real vs nominal, trocas de ABR | **gráficos temporais dinâmicos** + tiles |
| Rede/CDN | TTFB e throughput por segmento (via adaptador do motor **e** via Resource Timing API — independente do motor, cobre Shaka e o progressivo do YouTube); **breakdown DNS/TCP/TLS/TTFB/download**; headers de **CDN/edge** (x-cache, cf-ray, via…); **teste de rede** com limite de banda ajustável no proxy para provocar trocas de ladder ABR | gráficos + tabelas + seletor de throttle |
| CMCD / CMSD | CMCD habilitado nos três motores (o que o player envia ao CDN) e leitura de CMSD (o que o CDN responde), quando presente | painel |
| Áudio | VU meter L/R com peak-hold, nível RMS temporal (rápido), espectro de frequências, e **LUFS real (ITU-R BS.1770-4)** — Momentary/Short-term/Integrated com K-weighting e gating de verdade | medidores + gráficos |
| Alertas | congelamento de vídeo, tela preta, silêncio, buffer baixo, banda insuficiente, FPS baixo, loudness acima do limite, playlist live estagnada — com thresholds ajustáveis | painel de alertas + log |
| QoE | startup (1º frame), rebuffering (contagem/duração/ratio), trocas ABR, bitrate médio ponderado; **exportação da sessão** completa | tiles + JSON/CSV |
| Baixa latência / anúncios | detecção de LL-HLS (`EXT-X-PART`/`PRELOAD-HINT`/`SERVER-CONTROL`) e LL-DASH (`ServiceDescription/Latency`); marcadores SCTE-35 do manifest (`EXT-X-DATERANGE`/`CUE-OUT`, DASH `EventStream`) | linha na visão geral + tabela condicional |
| Análise de cor | **curvas de cor por canal RGB**, distribuição de luminância, luminância média (APL) e clipping de sombras/realces ao longo do tempo, diagrama de cromaticidade CIE 1931 xy com gamuts Rec.709/P3/Rec.2020, sinalização SDR/HDR do manifest × capacidade do display × **espaço de cor realmente decodificado (WebCodecs)** | **gráficos de curva** + tabela |
| Qualidade (PSNR/SSIM) | comparação em tempo real entre uma referência (mezzanine) e uma variante específica do stream — dois `<video>` ocultos sincronizados por `currentTime`, amostrados via canvas | tiles + gráficos temporais |

### Sobre PSNR/SSIM/VMAF

**PSNR e SSIM estão implementados de verdade** (seção "Análise de qualidade" dentro de
Player e telemetria) — mas são métricas *com referência*: só fazem sentido quando a
referência é o **mesmo conteúdo-fonte** usado para codificar o stream. Comparar Big Buck
Bunny contra um telejornal ao vivo produz números sem significado (mede diferença de
conteúdo, não perda de qualidade). Use a lista de presets (filmes CC-BY da Blender
Foundation, tocáveis direto no navegador) quando o stream inspecionado for codificado a
partir desse conteúdo (ex.: `dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd`, um dos
exemplos do topo da página, é literalmente Big Buck Bunny), ou **envie um arquivo local**
quando você tiver a mezzanine do seu próprio conteúdo (inclusive esporte/telejornalismo —
não existe hoje um acervo livre e pronto para navegador nessas categorias).

**VMAF real não está implementado** — o modelo certificado da Netflix (VIF + DLM + motion
via SVM) exige `libvmaf`, tipicamente via ffmpeg, como processo *offline*. Se você tiver
ffmpeg com libvmaf compilado, gere o score comparando o master local contra um segmento
baixado do stream:

```bash
ffmpeg -i distorcido.mp4 -i referencia.mp4 \
  -lavfi "[0:v]scale=1920:1080[dist];[1:v]scale=1920:1080[ref];[dist][ref]libvmaf" \
  -f null -
```

## Como rodar

Requer apenas Node.js (≥16). O core do inspetor não tem dependências externas —
`node server.js` funciona direto, sem `npm install`:

```bash
node server.js
# → http://localhost:8787
```

Também funciona hospedado como página estática (`public/`), porém **sem o proxy
de CORS** — nesse modo só é possível inspecionar streams cuja origem envie
cabeçalhos CORS (`Access-Control-Allow-Origin`).

`npm install` só é necessário para a resolução automática de URLs do Globoplay
(único recurso que usa uma dependência real, ver seção abaixo) — todo o resto do
app roda sem ele.

### Backend alternativo em Go

Existe também uma reescrita do backend (`server.js`) em Go, com o mesmo comportamento
observável: mesmas rotas, mesmos formatos de resposta, mesmas variáveis de ambiente.
O frontend (`public/`) é o mesmo para as duas versões — ele é servido embedado no
binário Go via `//go:embed` (`assets.go`), não precisa copiar a pasta separadamente.

```bash
go run ./cmd/server
# → http://localhost:8787

# ou, pra gerar um binário único:
go build -o stream-inspector-server ./cmd/server
./stream-inspector-server
```

- Histórico: `modernc.org/sqlite` (driver SQLite 100% Go, sem cgo) — mesmo schema e
  mesmo `~/.stream-inspector/history.sqlite` (ou `STREAM_INSPECTOR_DATA_DIR`) do
  server.js; não precisa migrar nada entre as duas versões.
- Resolução do Globoplay usa `github.com/mxschmitt/playwright-go`, compatível com a
  MESMA sessão salva (`globoplay-session.json`) do fluxo Node — o login só precisa
  ser refeito se a sessão expirar, nunca por causa da troca de backend. Pra fazer
  login pela primeira vez com esta versão: `go run ./cmd/globoplay-login`. O
  `playwright-go` ainda depende de um passo de instalação único que roda um driver
  Node por baixo pra baixar o Chromium (`go run github.com/mxschmitt/playwright-go/cmd/playwright install chromium`)
  — o runtime das requisições fica 100% Go, só o setup inicial toca Node.
- As duas versões (`server.js` e `go run ./cmd/server`) podem conviver no mesmo
  checkout — nenhuma delas apaga ou depende de arquivos da outra.

### Segurança / rede

O `server.js` é uma ferramenta local single-user e foi endurecido com isso em mente:

- **Escuta só em `127.0.0.1` por padrão.** Para expor na rede (só faça em rede
  confiável): `HOST=0.0.0.0 node server.js`.
- **O proxy `/p/` bloqueia alvos internos** (loopback, `169.254.0.0/16` de metadata
  de nuvem, faixas privadas). Para inspecionar streams de uma rede interna de
  propósito: `ALLOW_PRIVATE_PROXY=1 node server.js` (de novo, só em rede confiável).
  As respostas do proxy **não** trazem `Access-Control-Allow-Origin`, então nenhum
  site externo consegue ler o que o proxy buscou.
- **Endpoints caros/de escrita** (`/resolve`, `/resolve-globoplay`, `/throttle`,
  `POST /api/history`) recusam requisições de origem externa explícita (defesa
  contra um site aberto no navegador acionar essas rotas).
- **A sessão do Globoplay** (`globoplay-session.json`, ver local abaixo) contém
  cookies de autenticação em texto puro; é gravada com modo `600`, fica fora do git
  e nunca é servida como arquivo estático. Não compartilhe esse arquivo.

### Onde ficam os dados (histórico e sessão do Globoplay)

Por padrão em `~/.stream-inspector/` (fora da pasta do repositório) — override via
`STREAM_INSPECTOR_DATA_DIR=/algum/caminho node server.js`. É de propósito que essa
pasta fique fora do clone: como ela guarda credenciais (sessão do Globoplay), nunca
deve ir pro git, e uma pasta *dentro* do repositório seria apagada a cada
`git clone`/checkout novo — ficando fora do repo, o histórico e o login do
Globoplay sobrevivem a qualquer re-clone.

## YouTube (opcional)

URLs do YouTube (`youtube.com/watch`, `youtu.be`, lives) são suportadas através de
um **resolvedor local** que delega ao [`yt-dlp`](https://github.com/yt-dlp/yt-dlp).
O sistema **não** decodifica assinaturas do YouTube — apenas chama o yt-dlp (que
você instala) e consome o JSON que ele produz. Pré-requisitos:

```bash
pip install yt-dlp       # ou pipx install yt-dlp
node server.js           # o endpoint /resolve precisa do servidor
```

- **Ao vivo**: o yt-dlp extrai o master HLS real → o inspetor roda o pipeline
  completo (variantes, segmentação, container, telemetria, cor) com paridade total.
- **VOD**: o yt-dlp devolve formatos separados (não há manifest único). As tabelas
  de vídeo/áudio/legendas são montadas do JSON do yt-dlp (inclusive formatos 4K/HDR
  adaptativos), e a telemetria/cor/áudio/alertas/QoE rodam reproduzindo o melhor
  formato **combinado** disponível (progressivo, tipicamente ≤720p).

Uso sujeito aos Termos do YouTube — a ferramenta destina-se a inspeção técnica e a
responsabilidade é de quem a opera.

## Globoplay (opcional)

URLs do Globoplay (`globoplay.globo.com/.../ao-vivo/<id>/`, por exemplo) são
suportadas de um jeito diferente do YouTube: o `yt-dlp` não tem suporte a esse
conteúdo, e a URL do manifest não está no HTML da página — ela só aparece numa
requisição de rede depois que o player da página carrega e roda seu próprio
JavaScript. Por isso o resolvedor usa um **navegador Chromium headless de
verdade** ([Playwright](https://playwright.dev)) para carregar a página e
escutar a rede até encontrar a URL do manifest (`.m3u8`/`.mpd`).

Conteúdo ao vivo do Globoplay exige uma conta logada (gratuita ou assinante).
Em vez de pedir para colar cookies manualmente, você faz login **uma única
vez** numa janela de navegador real que um script abre, e a sessão fica salva
localmente (nunca é enviada a lugar nenhum além do próprio Globoplay):

```bash
npm install
npx playwright install chromium
node scripts/globoplay-login.js   # abre um Chromium visível — faça login normalmente
node server.js                    # o endpoint /resolve-globoplay precisa do servidor
```

A partir daí, colar uma URL do Globoplay e clicar em "Inspecionar" resolve o
manifest automaticamente e roda o pipeline completo (paridade total com
qualquer outra URL de manifest). A sessão salva expira com o tempo — quando
isso acontecer, a UI avisa e basta rodar `node scripts/globoplay-login.js` de
novo.

**Sem garantias:** o sistema não decodifica DRM/tokens do Globoplay nem tenta
contornar bloqueios de automação — se a página mudar de estrutura, bloquear
navegadores headless, ou o conteúdo estiver protegido de um jeito que o
Playwright não consiga acessar mesmo logado, a resolução falha com uma
mensagem clara em vez de tentar burlar. Conteúdo com DRM continua podendo ser
**inspecionado** (estrutura do manifest, variantes, DRM declarado), só não
**reproduzido** de fato sem uma licença válida.

## Arquitetura

```
server.js                 servidor estático + proxy de CORS (Node puro; Playwright é opcional,
                           só para /resolve-globoplay)
scripts/globoplay-login.js login único do Globoplay (salva sessão em ~/.stream-inspector/, fora do repo/git)
public/
  index.html              UI (campo de URL + botão + seções de resultado)
  css/style.css           tokens de design (light/dark automático)
  js/parsers.js           parsers próprios de M3U8 e MPD → modelo normalizado
  js/charts.js            gráficos em canvas (séries temporais, curvas, degraus)
  js/analyzer.js          análise de cor por frame (histogramas RGB/luma, clipping)
  js/youtube.js           mapeia o JSON do yt-dlp → modelo do inspetor (YouTube)
  js/globoplay.js         detecção de URL do Globoplay (resolução em si é 100% server-side)
  js/app.js               orquestração: fetch → parse → tabelas → playback → telemetria
  vendor/hls.min.js       playback HLS (hls.js)
  vendor/dash.all.min.js  playback DASH (dash.js)
  samples/                manifests de exemplo (HLS com HDR/legendas/Atmos; MPD com DRM)
```

### Proxy de CORS (`/p/…`)

Manifests de origens sem CORS são buscados automaticamente via
`/p/<scheme>/<host>/<caminho>`. O formato por caminho (em vez de `?url=`) faz as
URLs **relativas** dos manifests resolverem naturalmente através do proxy;
URLs **absolutas** internas (variantes, chaves, `BaseURL`, `media=`) são
reescritas pelo servidor. `HTTP(S)_PROXY` do ambiente é respeitado (túnel CONNECT).

### Análise SDR/HDR

- **Sinalização**: `VIDEO-RANGE` (HLS), CICP `TransferCharacteristics`/`ColourPrimaries`
  (DASH) e codecs (Dolby Vision, HEVC Main 10) → exibida por variante e em badge.
- **Capacidade do display**: `dynamic-range`, `color-gamut` e profundidade de cor.
- **Curvas**: frames são amostrados em canvas e geram histogramas por canal R/G/B e
  de luminância (Rec.709), além da evolução temporal de APL e clipping.
  *Limitação documentada na UI*: o canvas entrega pixels 8-bit já tone-mapped pelo
  navegador — para conteúdo PQ/HLG as curvas refletem o resultado renderizado.

### Observações

- Streams com DRM: os metadados e a telemetria de manifest funcionam; a leitura de
  pixels (curvas de cor) é bloqueada pelo navegador e a UI informa isso.
- Playlists de mídia (variante única) também são aceitas diretamente.
- Para live, os gráficos usam janela deslizante de 120 s e o tile de latência é exibido.
