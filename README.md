# 📡 Stream Inspector — HLS / MPEG-DASH

Ferramenta de inspeção e diagnóstico de streaming adaptativo. Recebe a URL de um
manifest (`.m3u8` ou `.mpd`), reproduz o conteúdo com os mesmos motores usados em
produção e expõe, lado a lado, tudo que normalmente fica espalhado entre o manifest
bruto, o inspetor de rede do navegador e um scope de forma de onda: ladder de
variantes, DRM, segmentação real, telemetria de ABR, rede/CDN, CMCD/CMSD, loudness
(BS.1770-4), colorimetria SDR/HDR e QoE de sessão.

Não é um player de demonstração — é uma bancada de testes. Cole a URL, clique em
**Inspecionar**, e cada seção abaixo é preenchida a partir de dados reais (o
manifest parseado, o motor de playback instrumentado, o `<video>` amostrado
quadro a quadro), não de heurísticas sobre o que o manifest *deveria* conter.

| Seção | O que é medido | Como |
|---|---|---|
| Visão geral | protocolo, VOD/ao vivo, perfis, duração, períodos, buffer mínimo, HDR/DRM em badge | parse estático do manifest |
| Vídeo | ladder completo: resolução, bitrate pico/médio, FPS, codec (nome amigável + string exata), faixa dinâmica por variante (SDR/PQ/HLG/Dolby Vision), HDCP | tabela por variante |
| Áudio | faixas: idioma, canais (estéreo/5.1/Atmos), codec, taxa de amostragem, bitrate, papéis (dublagem, comentário, acessibilidade) | tabela por faixa |
| Legendas & DRM | legendas/CC (idioma, WebVTT/TTML/CEA-608, forçada/padrão); Widevine, PlayReady, FairPlay, ClearKey, AES-128 (`EXT-X-KEY`/`ContentProtection`), `default_KID` | tabela + inspeção binária |
| Segmentação | modo (SegmentTemplate/Timeline/playlist), contagem, duração, descontinuidades; para os últimos segmentos, leitura binária real do container (PAT/PMT do MPEG-TS; `moov`/`tenc`/`pssh` do fMP4) — streams e KID reais, não só o que o manifest declara | tabela + timeline |
| Telemetria & rede | buffer real (`video.buffered`), bitrate do nível ativo, banda estimada, frames perdidos, latência live (edge e end-to-end via `PROGRAM-DATE-TIME`), FPS real × nominal, trocas de ABR, TTFB/throughput por segmento, breakdown DNS/TCP/TLS/download, headers de CDN (`x-cache`, `cf-ray`, `via`…), CMCD (o que o player envia) e CMSD (o que o CDN responde) | gráficos temporais + tabelas + teste de banda no proxy |
| Áudio ao vivo | VU meter L/R com peak-hold, RMS temporal, espectro, e loudness **ITU-R BS.1770-4** (Momentary/Short-term/Integrated, com K-weighting e gating reais) e true peak (dBTP) | medidores + gráficos |
| Cor & HDR | histogramas R/G/B e luminância, APL e clipping ao longo do tempo, diagrama de cromaticidade CIE xyY 3D (Rec.709/P3/Rec.2020), sinalização HDR do manifest × capacidade do display × espaço de cor **realmente decodificado** (WebCodecs) | gráficos 3D + tabela — ver seção própria abaixo |
| QoE | startup (primeiro frame), rebuffering (contagem/duração/ratio), trocas de ABR, bitrate médio ponderado, exportação completa da sessão | tiles + JSON/CSV |
| Alertas | congelamento, tela preta (com gate de silêncio), silêncio, buffer baixo, banda insuficiente, FPS baixo, loudness acima do limite, playlist ao vivo estagnada — thresholds ajustáveis em runtime | painel + log |
| Baixa latência / anúncios | LL-HLS (`EXT-X-PART`/`PRELOAD-HINT`/`SERVER-CONTROL`) e LL-DASH (`ServiceDescription/Latency`); marcadores SCTE-35 (`EXT-X-DATERANGE`/`CUE-OUT`, DASH `EventStream`) | badge + tabela condicional |
| Qualidade (PSNR/SSIM) | comparação em tempo real entre uma mezzanine de referência e uma variante do stream, amostrada via canvas | tiles + gráficos temporais |

## Player e motores de playback

O `<video>` é envelopado pelo **Clappr** (`@clappr/core`, BSD-3-Clause) — o mesmo
player usado internamente na Globo — que padroniza controles de transporte
(play/pause/seek/volume) sobre qualquer motor de decodificação plugado nele.
Dois motores são suportados, cada um em **duas versões instanciáveis** (a
usada em produção e a mais recente do projeto), trocáveis em runtime por um
combo-box sem precisar recarregar a página:

| Manifest | Motor padrão | Versões disponíveis |
|---|---|---|
| HLS (`.m3u8`) | `hls.js` | `1.5.14` (produção) · `1.6.16` (mais recente) |
| DASH (`.mpd`) | `Shaka Player` | `3.1.8` (produção) · `5.2.2` (mais recente) |

A troca de motor reinicia o playback na mesma posição do manifest, preservando
CMCD (`sessionId`/`contentId` estáveis pela sessão) e reaplicando os listeners
de telemetria (nível ativo, tracks de áudio/legenda, erros) diretamente na
instância real do motor — o inspetor nunca lê apenas o que o Clappr expõe de
alto nível, sempre a API nativa de cada player por baixo.

## Colorimetria e HDR

Amostragem de cor tem dois caminhos, escolhidos automaticamente pelo que o
navegador suporta:

- **WebCodecs (`VideoFrame` bruto)**, quando disponível (Chromium/Edge hoje):
  lê o frame decodificado *antes* de qualquer conversão do compositor,
  aplicando a matriz de primárias real (Rec.709/DCI-P3/Rec.2020) e a EOTF
  inversa correta por `transfer` (sRGB/BT.709/**PQ (SMPTE 2084)/HLG (ARIB
  STD-B67)**) — inclusive normalizando a luminância absoluta de PQ/HLG para
  luz referida ao display (branco difuso a 203 cd/m², ITU-R BT.2408), sem o
  que HDR10 real renderizaria praticamente preto num diagrama ingênuo.
- **Canvas 2D**, como fallback universal (e único caminho em navegadores sem
  WebCodecs) — sempre limitado a SDR/Rec.709, documentado como tal na própria
  UI (nunca finge precisão que não tem).

O gráfico usa **Display-P3** quando o navegador concede (Chromium/Safari
recentes, sem flag nenhuma), com fallback automático a sRGB — cobrindo mais
gamut do que sRGB sozinho consegue expressar. Dois modos de cor, trocáveis
sem reamostrar:

- **Tom mapeado** — aproxima o que o vídeo realmente mostra (curva de
  compressão de realces, aplicada só em conteúdo HDR).
- **Saturação máxima** — normaliza cada ponto pelo canal de pico, já que a
  luminância real ocupa o eixo Y do diagrama 3D; existe para tornar o uso de
  gamut largo visualmente óbvio, não para parecer "natural".

Um painel de diagnóstico (dentro de Cor & HDR) expõe qual caminho de leitura
foi usado, o `colorSpace` real do frame decodificado e o gamut concedido ao
canvas — importante porque HDR de verdade não é testável neste tipo de
ambiente de desenvolvimento sem um display e conteúdo HDR reais; o painel
existe para o usuário confirmar o comportamento na própria máquina.

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

Histórico via `modernc.org/sqlite` (driver SQLite 100% Go, sem cgo) — mesmo schema e
mesmo `~/.stream-inspector/history.sqlite` (ou `STREAM_INSPECTOR_DATA_DIR`) do
server.js; não precisa migrar nada entre as duas versões. As duas versões
(`server.js` e `go run ./cmd/server`) podem conviver no mesmo checkout — nenhuma
delas apaga ou depende de arquivos da outra.

### Segurança / rede

O `server.js`/backend Go são ferramentas locais single-user, endurecidas com isso em mente:

- **Escuta só em `127.0.0.1` por padrão.** Para expor na rede (só faça em rede
  confiável): `HOST=0.0.0.0 node server.js`.
- **O proxy `/p/` bloqueia alvos internos** (loopback, `169.254.0.0/16` de
  metadata de nuvem, faixas privadas) antes de conectar — e de novo a cada
  redirect seguido. Para inspecionar streams de uma rede interna de propósito:
  `ALLOW_PRIVATE_PROXY=1 node server.js` (de novo, só em rede confiável). As
  respostas do proxy **não** trazem `Access-Control-Allow-Origin`, então
  nenhum site externo consegue ler o que o proxy buscou por ele.
- **Endpoints caros/de escrita** (`/resolve`, `/throttle`, `POST /api/history`)
  recusam requisições de origem externa explícita — defesa contra um site
  aberto no navegador do usuário acionando essas rotas por engano (CSRF/abuso
  cross-origin), não uma fronteira de autenticação.
- Corpo de requisição, tamanho de manifest e linhas de histórico têm teto —
  defesa em profundidade contra DoS trivial num processo local.

### Onde ficam os dados (histórico)

Por padrão em `~/.stream-inspector/` (fora da pasta do repositório) — override via
`STREAM_INSPECTOR_DATA_DIR=/algum/caminho node server.js`. Fica fora do clone de
propósito: uma pasta *dentro* do repositório seria apagada a cada `git clone`/
checkout novo.

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
  formato **combinado** disponível (progressivo, tipicamente ≤720p). Como a URL de
  mídia real do YouTube não carrega extensão de arquivo, o player recebe um
  `mimeType` explícito (derivado do `ext` do yt-dlp) — sem isso o motor nativo do
  Clappr não consegue selecionar o playback correto.

Uso sujeito aos Termos do YouTube — a ferramenta destina-se a inspeção técnica e a
responsabilidade é de quem a opera.

## Sobre PSNR/SSIM/VMAF

**PSNR e SSIM estão implementados de verdade** (seção "Qualidade" dentro de
Cor & HDR) — mas são métricas *com referência*: só fazem sentido quando a
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

## Arquitetura

```
server.js                servidor estático + proxy de CORS (Node puro, zero dependências)
public/
  index.html              UI (cockpit: menu lateral de 10 seções + quadro de player/telemetria)
  css/style.css           tokens de design (light/dark automático)
  css/cockpit.css         layout do cockpit (menu lateral + quadro de monitoração)
  js/parsers.js           parsers próprios de M3U8 e MPD → modelo normalizado
  js/container.js         inspeção binária de segmentos (MPEG-TS PAT/PMT; fMP4 moov/tenc/pssh)
  js/charts.js            gráficos em canvas (séries temporais, curvas, degraus)
  js/chromaticity.js       diagramas de cromaticidade 2D/3D (CIE 1931 xy / CIE xyY)
  js/colorspace.js        amostragem WebCodecs + matemática de cor HDR (PQ/HLG/primárias)
  js/analyzer.js          histogramas RGB/luma, APL, clipping (fallback canvas 2D)
  js/audiometer.js        VU meter, RMS, espectro, loudness BS.1770-4, true peak
  js/netmon.js            TTFB/throughput por segmento, breakdown DNS/TCP/TLS, headers de CDN
  js/qoe.js               startup, rebuffering, trocas de ABR, exportação de sessão
  js/alerts.js            motor de alertas com thresholds ajustáveis
  js/quality.js           comparador PSNR/SSIM (canvas + dois <video> sincronizados)
  js/youtube.js           mapeia o JSON do yt-dlp → modelo do inspetor (YouTube)
  js/app.js               orquestração: fetch → parse → tabelas → playback → telemetria
  vendor/clappr/          Clappr core + plugins (MediaControl, hls.js/Shaka playback) — envelope do player
  vendor/hls-*.min.js     hls.js, 2 versões (produção + mais recente — trocáveis no combo-box)
  vendor/shaka-*.compiled.js  Shaka Player, 2 versões (idem)
  vendor/dash.all.min.js  dash.js — usado só pelo comparador de qualidade PSNR/SSIM, não pelo player principal
  samples/                manifests de exemplo (HLS com HDR/legendas/Atmos; MPD com DRM)
scripts/color-math-test.js teste headless da matemática de cor HDR (sem navegador)
cmd/server/, internal/    porta do backend para Go (mesmo comportamento observável do server.js)
```

### Proxy de CORS (`/p/…`)

Manifests de origens sem CORS são buscados automaticamente via
`/p/<scheme>/<host>/<caminho>`. O formato por caminho (em vez de `?url=`) faz as
URLs **relativas** dos manifests resolverem naturalmente através do proxy;
URLs **absolutas** internas (variantes, chaves, `BaseURL`, `media=`) são
reescritas pelo servidor. `HTTP(S)_PROXY` do ambiente é respeitado (túnel CONNECT).

### Observações

- Streams com DRM: os metadados e a telemetria de manifest funcionam; a leitura de
  pixels (curvas de cor) é bloqueada pelo navegador e a UI informa isso.
- Playlists de mídia (variante única) também são aceitas diretamente.
- Para live, os gráficos usam janela deslizante de 120 s e o tile de latência é exibido.
