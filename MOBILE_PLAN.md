# Plan de adaptación móvil: Poker Trainer

Documento de planificación. No contiene cambios de código. Estado del build analizado: archivos de `public/` tal como estaban en el momento de la captura (otros agentes editan la UI en paralelo; las anclas de código pueden moverse).

Capturas de referencia: `.e2e-shots/mobile-*.png` (SE 375x667, 14 390x844, Pixel 412x915, landscape 844x390, tablet 768x1024; estados: menu, settings, rules, progress, help, mp-lobby, practice-table, exam-table, quick-table, table-mode).

---

## 0. Diagnóstico general (estado actual en móvil)

| Hallazgo | Evidencia | Severidad |
|---|---|---|
| El menú principal es una columna de tarjetas altas; la última (Progress) queda cortada y hay que hacer scroll. Las descripciones de cada tarjeta se cortan a la mitad ("One table with bots. Play until you run out of…"). | `mobile-se-menu.png` | Alta |
| La mesa solo-jugador en portrait pone el botón "Finish game" encima del asiento superior (CPU 2): se solapan. | `mobile-se-table-mode.png`, `mobile-se-exam-table.png` | Alta |
| Los asientos laterales (CPU 1, CPU 2 y CPU 3) tocan o se salen del borde izquierdo/derecho; el anillo no respeta el ancho del viewport en 375px. | `mobile-se-practice-table.png` (CPU 1, CPU 7 cortado a la derecha) | Alta |
| Las cartas de la mesa (hero) son grandes y ocupan el centro inferior, pero el tablero comunitario (flop/turn/river) queda casi vacío y sin jerarquía; el pot está a la altura de los asientos. | `mobile-se-practice-table.png` | Media |
| La barra de acciones en portrait muestra "Raise to 3 BB" en dos líneas y el importe no cabe; en modo práctica los botones están deshabilitados sin explicación. | `mobile-se-table-mode.png`, `mobile-se-practice-table.png` | Media |
| En landscape (844x390) la mesa funciona bien: barra de acciones abajo, asientos bien distribuidos, teclas F/C/R visibles (teclas de atajo que en móvil no sirven, ver §4). | `mobile-land-table-mode.png` | Baja (pero ruido) |
| El panel de Rules se abre como sheet a pantalla completa con el ranking legible; el botón "Close" arriba a la derecha. Bien, pero "Why" no tiene paginación táctil. | `mobile-se-rules.png` | Baja |
| Multijugador (lobby): los cuatro iconos de cabecera (cámara, chat, personas, ayuda) son grandes, pero el formulario de entrada ocupa solo la mitad superior y el resto de la pantalla queda vacío. "Offline" aparece antes de que haya conexión. | `mobile-se-mp-lobby.png` | Media |
| Errores de consola en tiempo de captura: `pageerror: chatVisible is not defined` (mp.js:3346 llama a `chatVisible()` definida en mp.js:3402; posible edición en curso). Bloqueó los clics de Settings y del botón de barra lateral en la captura. | log de captura | Alta (bloqueante si persiste) |
| No hay `manifest`, `theme-color`, iconos, ni service worker. El `<meta viewport>` ya tiene `viewport-fit=cover`, pero no hay `env(safe-area-inset-*)` en la barra superior ni en la barra de acciones. | `public/index.html:5`, grep sin resultados | Alta para PWA |
| Hay un `@media (max-width: 600px)` en `style.css:825` y `:901` y varios en `mp.css`, con ~40 reglas de breakpoints mezcladas. No hay un sistema de breakpoints único. | grep `@media` | Media (deuda) |

---

## 1. Principios de diseño móvil

1. **Pulgar primero.** Acciones primarias (Fold/Call/Raise, Next, Play, chat input, mic/cam) en el tercio inferior. Navegación secundaria (volver, progreso, ayuda) en la esquina superior derecha, a alcance del pulgar derecho.
2. **Un foco por pantalla.** En portrait, la mesa ocupa el 100% del alto disponible; paneles (sidebar, chat, rules, progress, ayuda) son hojas (sheets) o pantallas completas, nunca columnas al lado de la mesa.
3. **Nada depende de hover.** Todo tooltip tiene equivalente táctil (tap o long-press).
4. **Tamaños mínimos.** Objetivos táctiles >= 44x44 CSS px (iOS HIG) con separación >= 8px. Texto >= 16px en inputs (evita zoom automático de iOS).
5. **Dinámico, no fijo.** `100dvh`, `env(safe-area-inset-*)`, `visualViewport` para teclado.
6. **Degradación.** Multijugador con vídeo es el caso más pesado: siempre debe existir modo solo audio o solo chat.

---

## 2. Sistema de breakpoints y capas

Propuesta: consolidar en tres ejes, no en anchos fijos dispersos.

| Nombre | Condición CSS | Uso |
|---|---|---|
| `phone-portrait` | `(max-width: 480px) and (orientation: portrait)` | Layout de teléfono principal |
| `phone-landscape` | `(max-height: 500px) and (orientation: landscape)` | Mesa apaisada, barra lateral de acciones |
| `tablet` | `(min-width: 481px) and (max-width: 1024px)` | Mesa centrada, sidebar como columna colapsable |
| `desktop` | `(min-width: 1025px)` | Layout actual |

Regla de implementación: añadir `<html data-layout="phone-portrait|phone-landscape|tablet|desktop">` desde un listener de `matchMedia` en un único módulo `public/layout.js` (nuevo). Así los CSS usan `[data-layout=...]` y no duplican media queries de `mp.css`.

Breakpoints de altura: `max-height: 700px` (SE, 667px) activa compactación (padding, tamaño de fuente de cartas); `max-height: 500px` (landscape) activa la barra lateral de acciones.

Anclas existentes a reemplazar gradualmente: `game-mode.css:39` (`max-width:480px`), `game-mode.css:42` (`max-height:500px` + landscape), `mp.css:419-556` (serie de breakpoints), `style.css:816-1031`.

---

## 3. Shell global y safe areas

### 3.1 Estado actual
- `index.html:5`: `viewport-fit=cover` ya está. Bien.
- `style.css:1296`: `.app { height: 100dvh }`. Bien.
- La cabecera (`.topbar`) no usa `padding-top: env(safe-area-inset-top)`: en iPhone con notch el logo y los botones quedan bajo la muesca.

### 3.2 Diseño objetivo

```css
:root {
  --safe-t: env(safe-area-inset-top, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);
  --safe-l: env(safe-area-inset-left, 0px);
  --safe-r: env(safe-area-inset-right, 0px);
  --touch: 44px;
  --gutter: 16px;
}
.topbar {
  padding-top: calc(var(--safe-t) + 8px);
  padding-left: calc(var(--safe-l) + var(--gutter));
  padding-right: calc(var(--safe-r) + var(--gutter));
  min-height: calc(var(--touch) + var(--safe-t) + 8px);
}
.action-bar, .mp-actions {
  padding-bottom: calc(var(--safe-b) + 8px);
}
```

Ancla: `style.css` bloque `.topbar` y `.app` (líneas ~1068-1300). Landscape con notch lateral: `padding-left/right` con `--safe-l/--safe-r` para que la barra de acciones no quede bajo el notch.

### 3.3 Wireframe cabecera portrait (objetivo)

```
+--------------------------------------------+
|  ♠ Poker        [EN|ES]   [📊]   [?]       |  <- 56px + safe-top
+--------------------------------------------+
```
En pantallas <= 360px: colapsar el selector de idioma en un menú de 1 botón ("EN ▾").

### 3.4 Cabecera en pantallas de juego (solo-jugador y MP)
Objetivo: un único botón "volver" (flecha) a la derecha (alcance del pulgar), y "Finish game" pasa a la barra inferior, no a la cabecera.

```
+--------------------------------------------+
|  Pot 4.5 BB                        [ ← ]  |
|            (mesa)                          |
|                                            |
+--------------------------------------------+
| [Fold]    [Call 2.9]      [Raise 8.5 BB]   |
|  (menu: Finish · Rules · Progress)  (⋯)    |
+--------------------------------------------+
```

---

## 4. Viewport dinámico: barra de direcciones y teclado

### 4.1 100dvh y barra de direcciones
- Ya usamos `dvh`. Añadir fallback `height: 100vh; height: 100dvh;` (ya existe en `style.css:1296`). Mantener.
- No bloquear el scroll del body: el juego no debe scrollear (ya lo hace `mp.css:2`). Añadir `overscroll-behavior: none` en `html, body`.

### 4.2 Teclado en pantalla (chat MP y campo de importe)
Problema: en iOS Safari, al abrir el teclado el `100dvh` no cambia; el input queda debajo del teclado.

Solución:
```js
// public/layout.js (nuevo)
const vv = window.visualViewport;
function onVV() {
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty('--kb', kb + 'px');
  document.documentElement.classList.toggle('kb-open', kb > 80);
}
if (vv) { vv.addEventListener('resize', onVV); vv.addEventListener('scroll', onVV); }
```
CSS: `.chat-sheet { padding-bottom: calc(var(--kb, 0px) + var(--safe-b)); }` y `.kb-open .action-bar { display:none }` (en chat abierto no hace falta la barra de acciones).

Campo de chat: `font-size: 16px` (evita zoom en iOS), `enterkeyhint="send"`, `autocomplete="off"`.

### 4.3 Atajos de teclado
Las teclas F/C/R visibles en landscape (`mobile-land-table-mode.png`) no sirven en móvil. Ocultarlas con `@media (hover: none) and (pointer: coarse) { .kbd-hint { display:none } }`.

---

## 5. Orientación

- No bloquear orientación con `screen.orientation.lock` (no funciona en iOS y es mala práctica). En cambio:
- Si el juego se abre en portrait en un teléfono de <= 480px y la sesión es de mesa (solo o MP), mostrar una pista no bloqueante (banner de 1 línea arriba): "Gira el teléfono para ver la mesa completa" con botón "Entendido" (se guarda en localStorage, es preferencia por usuario).
- Manifest: `"orientation": "any"`.
- En landscape (`max-height: 500px`) la mesa se muestra a pantalla completa con la barra de acciones en una sola fila (`mobile-land-table-mode.png` ya lo hace bien).

---

## 6. PWA

### 6.1 Manifest (`public/manifest.webmanifest`, nuevo)
```json
{
  "name": "Poker Trainer",
  "short_name": "Poker",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#0e0f12",
  "theme_color": "#0e0f12",
  "icons": [
    {"src":"icons/icon-192.png","sizes":"192x192","type":"image/png"},
    {"src":"icons/icon-512.png","sizes":"512x512","type":"image/png"},
    {"src":"icons/icon-maskable-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}
  ]
}
```
Iconos: generar a partir del símbolo ♠ (`.suit-logo`) sobre fondo oscuro, con área segura del 80% para maskable.

### 6.2 Head de `index.html` (líneas 1-14)
```html
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#0e0f12" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
```
Nota: `black-translucent` obliga a usar `padding-top: env(safe-area-inset-top)` (§3.2). Obligatorio.

### 6.3 Service worker (`public/sw.js`, nuevo)
- Cache-first para shell estático: `index.html`, `style.css`, `theme.css`, `seats.css`, `mp.css`, `game-mode.css`, `*.js` del juego, fuentes de Google (cache de 30 días).
- Network-first para `/mp`, WebSocket y `/api` (nunca cachear).
- Offline: mostrar el modo solo (`Single spots`, `Practice`, `Exam`, `Quick`) porque no requiere red; MP muestra el banner "Sin conexión" (§12).
- Versionado: `CACHE = 'pt-v' + BUILD_ID` y `skipWaiting` solo con confirmación del usuario ("Hay una nueva versión: Actualizar").
- Registro en `app.js` (bootstrap): `if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js')`.

### 6.4 Install prompt
- Escuchar `beforeinstallprompt`, guardar el evento y mostrar un botón en el menú "Instalar app" solo tras la 2ª sesión.
- En iOS (sin `beforeinstallprompt`): mostrar una hoja con "Pulsa Compartir y luego Añadir a pantalla de inicio" (una vez, con cierre).

### 6.5 Wake lock (mantener la pantalla encendida)
```js
let wl = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wl = await navigator.wakeLock.request('screen');
    else if (!on && wl) { await wl.release(); wl = null; }
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && inGame) keepAwake(true);
});
```
Activar al entrar a una mesa (solo-jugador o MP), desactivar al salir. Ajuste "Mantener pantalla encendida" en Settings, por defecto ON en móvil. Ancla: `app.js` (entrada a `view-game`) y `mp.js` (entrada a MP).

---

## 7. Menú principal (`#view-menu`, `#menu-format`)

### 7.1 Actual
Columna de 6 tarjetas de ~140px de alto con descripciones cortadas. El scroll esconde Progress. Mismo tamaño de tarjeta que en desktop.

### 7.2 Objetivo portrait
Grid 2x3 compacto + carrusel de descripción, o lista compacta de filas de 64px (icono + nombre + subtítulo de una línea). Recomiendo **lista de filas** en <= 480px porque el texto de cada modo es largo y se lee mejor.

```
+--------------------------------------------+
| ♠ Poker                    [📊] [EN] [?]   |
+--------------------------------------------+
|  Elige un modo                             |
|  ┌────────────────────────────────────────┐|
|  │ ◉  Quick game        Mesa con bots  › │|  64px
|  ├────────────────────────────────────────┤|
|  │ ◇  Single spots      Una decisión    › │|
|  ├────────────────────────────────────────┤|
|  │ ▮▮ Practice          Manos completas › │|
|  ├────────────────────────────────────────┤|
|  │ ⌛ Exam              Sin feedback    › │|
|  ├────────────────────────────────────────┤|
|  │ 👥 Multiplayer       Mesa compartida › │|
|  ├────────────────────────────────────────┤|
|  │ 📄 Rules             Ranking y por qué › │|
|  │ ▮▮ Progress          Tu historial    › │|
|  └────────────────────────────────────────┘|
|  [        Jugar        ]    <- bottom bar   |
+--------------------------------------------+
```
- Filas: `min-height: 64px`, `padding: 12px 16px`, descripción `line-clamp: 1` con `text-overflow: ellipsis` (si el usuario quiere la descripción completa, long-press muestra sheet con el texto entero).
- Selección: tap = selecciona (y muestra en la barra inferior "Jugar" con el modo activo); doble tap o tap en "Jugar" = empieza.
- Pantalla de Rules/Progress/Settings: §11.

### 7.3 Landscape (844x390)
Dos columnas: izquierda lista de modos (scroll interno), derecha panel de detalle del modo seleccionado (descripción completa + ajustes + botón Jugar). Esto evita que el menú ocupe 390px de alto.

### 7.4 Tablet (768x1024)
Dos columnas siempre: lista de modos a la izquierda (320px) y detalle a la derecha.

### 7.5 Tarjetas en desktop
Sin cambios en >= 1025px.

Ancla: `index.html:45-70` (`#menu-format`, `.mode-cards`), `style.css` bloque `.mode-card`.

---

## 8. Mesa solo-jugador (`#view-game`, `#table`, `#seats`, `#board`, `#pot`, `#actions`)

### 8.1 Actual (portrait 375x667)
- Anillo de asientos en óvalo, con CPUs que se salen del viewport en los extremos (CPU 1 y CPU 7).
- "Finish game" se solapa con el asiento superior.
- Hero abajo (BTN, D), cartas grandes.
- Barra de acciones abajo: Fold / Call 1 BB / Raise to 3 BB (texto en 2 líneas).
- En práctica, el anillo es de 9 asientos: en 375px no caben bien.

### 8.2 Layout objetivo portrait

```
+--------------------------------------------+
|  Pot 4.5 BB                        [ ← ]  |  56px + safe
|                                            |
|       [CPU 3]     [CPU 4]    [CPU 5]       |  asientos superiores
|   [CPU 2]    ( ovalo )         [CPU 6]     |  asientos laterales
|   [CPU 1]    | A♦ K♠ Q♥ |      [CPU 7]     |  board 5 cartas, 36px cada
|          [pot]  [bet chips]                |
|                                            |
|           [BTN] You  (hero)                |  zona de hero: cartas 56px
|           [ A♣ ][ 9♦ ]                     |
+--------------------------------------------+
| [ Fold ]   [ Call 2.9 ]   [ Raise 8.5 ]    |  >= 56px alto
|  ⋯ Finish · Rules · Progress · Sidebar     |
+--------------------------------------------+
```

Reglas:
- Asientos: en portrait, usar tamaño base 64x56px (no 96px). Asientos laterales: `left` = `max(8px, safe-l)` y `right` = `calc(100% - 8px - safe-r)`. Nunca `left < 0`.
- Anillo: radio horizontal = `min(44vw, 160px)`, vertical = `min(38dvh, 260px)`. Para 9 asientos usar posiciones fijas en %, no trigonométricas, para evitar solapes.
- Board: 5 cartas en fila con `width: min(15vw, 56px)` y `gap: 4px`; en <= 360px bajar a 13vw.
- Pot: chip de 36px, fuente mono, centrado sobre el board.
- Hero: panel de 56px de alto con cartas de 56x78px mínimo.

### 8.3 Barra de acciones (`#actions`, `#btn-fold`, `#btn-call`, `#btn-raise`)
- Alto 56px (objetivo táctil), 3 botones de ancho `1fr`.
- El importe de Call y Raise se muestra en la segunda línea en fuente 12px, y el texto principal ("Call", "Raise") en 16px. Así no se rompe "Raise to 3 BB".
- Fold: rojo con icono y texto. Check/Call: azul. Raise: verde. Mantener colores actuales (`theme.css`).
- Deshabilitados: mostrar tooltip al tap ("No es tu turno") en lugar de solo opacidad.
- Long-press en Raise (400ms): abre el selector de importe (§15).
- Haptics: `navigator.vibrate(10)` en tap de Fold/Call/Raise (opt-in, §14).

### 8.4 Sidebar (`#sidebar-right`, `#btn-right`) como bottom sheet con pestañas
Actual: `#btn-right` abre la barra derecha (hand info, equity, stats, settings) con `.sidebar-toggle` oculto en desktop.

Objetivo:
```
+-----------------------------------------------+
|  ▬▬  (drag handle)                            |
|  [ Mano ] [ Equity ] [ Stats ] [ Ajustes ]    |  pestañas 44px
|  ───────────────────────────────────────────  |
|  Contenido de la pestaña                      |
|                                               |
+-----------------------------------------------+
```
- Altura: 60dvh por defecto; drag handle permite 30dvh (peek) o 90dvh (full).
- Gestos: swipe horizontal entre pestañas, swipe vertical (drag del handle) para cambiar altura, tap en backdrop cierra.
- Implementación: `<section class="sheet-bottom">` con `transform: translateY()`, animar solo `transform`. Snap a 3 puntos.
- Ancla: `style.css:1027-1032` (ya hay `.sheet` en bottom para <= 900px); reutilizar, pero añadir la pestaña y el drag.

### 8.5 Finish game / back
- "Finish game" pasa al menú de la barra inferior (§3.4) o a un botón flotante de 44px sobre el board. Nunca encima de un asiento.
- `#btn-back` (flecha) queda en la esquina superior derecha, 44x44.

### 8.6 Exam (`#exam-live`, `#btn-finish-exam`)
Actual: igual que solo, con "Finish exam" arriba (`mobile-se-exam-table.png`). Sin ranges ni feedback.
Objetivo:
- Mismo layout que §8.2.
- Tira de métricas (`#xl-hands`, `#xl-decisions`, `#xl-avg`, `#xl-streak`) en una sola línea debajo de la cabecera, `font-size: 12px`, scroll horizontal si no cabe.
- "Finish exam" en barra inferior: en exam es acción destructiva, usar confirmación (sheet con 2 botones).

### 8.7 Quick game (`#table-end`, `#te-*`)
- Pantalla de fin (`table-end`) como sheet de pantalla completa: título, 4 métricas en grid 2x2, botones "Play again" (primario, 56px, en la parte inferior) y "Menu" (secundario).
- Ancla: `game-mode.css:20-45` ya tiene `max-height: calc(100dvh - ...)` para el panel de fin; reutilizar.

### 8.8 Practice (`#fb-practice`, `#feedback`, `#btn-next`)
- Feedback (`#verdict`, `#explanation`) sale como sheet desde abajo al tomar la decisión, con botón "Siguiente" (`#btn-next`) de 56px en la parte inferior.
- `#btn-more` abre explicación larga en sheet.

### 8.9 Single spots (quick spots)
Igual que practice, sin mesa completa: tarjeta de spot centrada, acciones abajo.

---

## 9. Glosario y tooltips (badges de posición y etiquetas de estilo)

Problema: `#helper-panel`, `#hi-pos`, badges BTN/SB/BB/CO, y el tooltip de estilo (`#theme-settings`) usan hover.

Objetivo:
- **Tap** en un badge de posición (BTN, CO, HJ...) abre un bottom sheet de 1/3 de pantalla con: nombre completo, rango orientativo y "cuándo juega" (una línea).
- **Long-press** (500ms) en cualquier asiento abre ficha del jugador (estilo, stats) en el mismo sheet.
- Glosario de estilos (TAG, LAG, Nit, Fish...): pantalla completa con paginación (§11), accesible desde `#btn-help`.
- Cerrar: tap fuera, swipe hacia abajo, o botón "Cerrar" 44px.
- Tooltips de escritorio (`title`/hover) se mantienen para ratón: usar `@media (hover: hover)`.

Ancla: `helper-panel` y `hi-pos` en `index.html`; `i18n.js` para textos.

---

## 10. Multijugador en móvil (`#mp-root`, `mp.js`, `mp.css`)

### 10.1 Actual
- Lobby: cabecera con 4 botones circulares (cámara, chat, personas, ayuda) y "Offline" (`mobile-se-mp-lobby.png`). El formulario de nombre ocupa solo la mitad superior; el resto queda vacío.
- Mesa MP: no capturada en esta sesión por falta de segundo cliente. Analizar en pruebas con `test/mp-mock-server.js` o con dos navegadores. Reglas de `mp.css:419-556` y `mp.css:853` son los breakpoints existentes.

### 10.2 Lobby móvil
- Formulario anclado arriba, botón "Unirse a la mesa" anclado abajo (bottom bar, 56px).
- Avatar: tap = foto, long-press = opciones (subir, cámara). Botones "Subir foto" / "Hacer foto" en fila de 2 con 44px.
- Estado de conexión: pill "Sin conexión" solo si está offline (ocultar cuando hay conexión). Hoy aparece siempre, lo que confunde.
- `input` de nombre con `font-size:16px`, `autocapitalize="words"`, `enterkeyhint="go"`.
- `Join` por Enter del teclado.

### 10.3 Tira de cámaras (`layoutCams` en mp.js:3829)
Objetivo:
- **Modo tira**: fila horizontal con scroll-snap de tiles 4:3 de 96x72px (portrait), altura fija 88px, arriba de la mesa.
- **Modo PiP (picture-in-picture)**: cámara propia en esquina inferior derecha de 96x72px, arrastrable (Pointer Events), sobre la mesa.
- **Hablando**: borde verde 2px + animación de `opacity` del anillo (no de `box-shadow`).
- Máximo 6 tiles visibles; el resto en "+3" que abre sheet con grid.
- Modo solo audio: cuando `navigator.connection.effectiveType` es `2g/3g` o el usuario lo activa, las tiles se sustituyen por avatar + indicador de volumen.

Pseudocódigo:
```js
function layoutCamsMobile(n) {
  const tile = { w: 96, h: 72, gap: 6 };
  const perRow = Math.max(1, Math.floor((window.innerWidth - 32) / (tile.w + tile.gap)));
  return { mode: n <= perRow ? 'strip' : 'strip-scroll', perRow, tileW: tile.w, tileH: tile.h };
}
```
Ancla: `mp.js:3829 layoutCams()`, `mp.css:419-556` (tiles y breakpoints).

### 10.4 Chat como bottom sheet con badge y toast
- Botón de chat en barra inferior con badge de no leídos (`#mp-chat-badge`, 18px, máx "9+").
- Toast: al llegar un mensaje con el chat cerrado, toast de 1 línea arriba del board, 3s, tap = abre chat. Ancla: `mp.js:779 chatEffects` (ya existe la lógica de toast/bubble) y `mp.js:3364 clearToast`.
- Chat sheet: 50dvh, lista scroll, input fijo al borde superior del teclado (§4.2).
- Emojis: picker en fila horizontal de 8 favoritos + botón "+" que abre grid. Tap enviar.

### 10.5 Bubbles
- En móvil, burbuja de 12-14px, máximo 2 líneas, `max-width: 40vw`. Ancla: `mp.css` burbujas (buscar `.mp-bubble`).
- Mostrar solo 1 burbuja por asiento (la última), desaparece en 3s.

### 10.6 Spectator corner y pause banner
- Espectadores: contador en esquina superior izquierda (`#mp-spec-count`, pill 28px), tap = lista en sheet.
- Pausa: banner de pantalla completa translúcido con el motivo y botón "Reanudar" (si eres host). Sin hover.

### 10.7 Blinds chip y RTT
- Chip de blinds (`1/2 · +ante`) junto al pot, 24px alto, `font-size: 12px`.
- RTT (latencia) como punto de color (verde < 150ms, ámbar < 400ms, rojo > 400ms) con tap = número exacto.

### 10.8 Permisos de cámara y micrófono (UX)
- Antes del `getUserMedia`: pantalla explicativa (1 frase + botón "Permitir cámara"). Motivo: iOS pide permiso solo una vez y en gesto de usuario.
- Si denegado: mensaje con instrucciones por plataforma y botón "Entrar solo con audio" / "Entrar solo con chat".
- Botón de mic y cam siempre visibles en la barra inferior (56px), con estado (on/off) por color y icono.

### 10.9 Segundo plano y reconexión
- `visibilitychange`: al volver a `visible`, comprobar WebSocket; si está cerrado, reconectar con backoff (0.5s, 1s, 2s, 4s, máx 8s) y mostrar "Reconectando…".
- Al ir a segundo plano > 30s, pausar vídeo de cámara propia (ahorra batería) y mantener audio (si el SO lo permite). Al volver, reanudar.
- Wake lock solo mientras hay mesa activa (§6.5).

### 10.10 Ahorro de datos y batería
- `navigator.connection` (Chrome Android): si `saveData === true` o `effectiveType` en `2g|3g|slow-2g`, bajar vídeo a 240p/10fps, o pasar a audio-only.
- Modo "Ahorro" en Settings: switch manual siempre disponible.
- Si la app no tiene `navigator.connection` (iOS Safari), usar el switch manual.
- Presupuesto: MP con 6 cámaras a 360p/15fps ~ 1.5-2 Mbps total (ajustar tras medir).

---

## 11. Rules, Help, Progress: pantallas completas con paginación

### 11.1 Actual
- `#sheet-rules` (`mobile-se-rules.png`): sheet a pantalla casi completa, pestañas "Hand ranking / Why", botón Close arriba derecha. Bueno.
- `#sheet-progress`: sheet con filtros (`#filter-group`), KPIs, tendencia (`#pg-trend`).
- `#helper-panel` y Help: texto largo en scroll.

### 11.2 Objetivo
- Cada una pantalla completa con cabecera de 56px (flecha "volver" a la izquierda en iOS, "X" a la derecha en Android: usar la flecha en ambos por consistencia, a la derecha según §3, *nota*: el botón Close actual está a la derecha, mantener).
- **Paginación táctil**: `scroll-snap-type: x mandatory` con páginas de 100vw. Puntos (`#rule-dots`) de 8px con área táctil de 44px. Swipe horizontal = siguiente/anterior. Botones "Anterior/Siguiente" en la barra inferior.
- Rules: página 1 = ranking (lista de 10 manos), página 2 = "Why" (explicación), página 3 = ejemplos.
- Progress: KPIs en grid 2x2, filtros como chips horizontales con scroll, tendencia como sparkline de altura 120px.
- Help: acordeón con secciones; búsqueda por encima del teclado.

### 11.3 Wireframe Rules (portrait)
```
+--------------------------------------------+
|  Rulebook                        [ ✕ ]     |
|  [ Hand ranking ] [ Why ]                  |
|  ─────────────────────────────────────────  |
|  1  Royal flush      A♠ K♠ Q♠ J♠ 10♠       |
|  2  Straight flush   9♥ 8♥ 7♥ 6♥ 5♥       |
|  ...                                       |
|             ●  ○                           |  <- swipe
+--------------------------------------------+
```
Cartas del ranking: 32x44px (actual ~44x58px; en 375px son 5 cartas por fila de 44px = 220px + etiqueta; ok).

Ancla: `index.html:346` (`#sheet-rules`), `index.html:411` (`#sheet-progress`), `help.js`, `style.css:912` (`.sheet`).

---

## 12. Red inestable, túnel y offline

### 12.1 Problema
- Tunnel de Cloudflare (`public-url.txt`) cambia de URL si se reinicia: el usuario guardó un enlace caducado.
- 4G con cortes: el WebSocket se cae sin evento inmediato (puede tardar 30-60s en detectarse).

### 12.2 Diseño
- Banner superior de 36px (no bloquea la mesa): "Sin conexión · reintentando…" con contador. Sin modal.
- Heartbeat cada 5s; si no hay pong en 10s, marcar offline.
- Al reconectar: volver a enviar `join` y pedir snapshot de la mesa (ya existe en el protocolo; ver `MP_PROTOCOL.md`).
- Enlace caducado (404 o `/` redirigido): pantalla "Este enlace ya no funciona. Pide el nuevo a quien te invitó." con botón "Ir al menú solo".
- Modo offline de solo juego (§6.3).

---

## 13. Accesibilidad

- **Escala de fuente hasta 200%**: todas las medidas de texto en `rem`/`clamp()`, no `px`. Los contenedores de la mesa deben crecer o truncar con `text-overflow: ellipsis`. Test: `font-size` del `html` a 200% en el navegador.
- **Dynamic type (iOS)**: respetar `prefers-reduced-motion`; no bloquear zoom (`user-scalable` nunca `no`; el meta actual no lo tiene, mantener).
- **Alto contraste**: `@media (prefers-contrast: more)` aumenta borde de cartas y asientos a 2px y sube el contraste de texto secundario (`--muted`).
- **Reduced motion**: ya hay `prefers-reduced-motion` en `anim.css:67`, `style.css:805`, `mp.css:345`. Unificar en `--motion` = `0ms` si reduced.
- **Lectura de pantalla**: asientos con `aria-label` "Asiento BTN, tú, 101.5 BB".
- **Focus visible** para teclado externo (iPad), no solo en pointer.

---

## 14. Gestos, long-press, haptics

| Gesto | Dónde | Acción |
|---|---|---|
| Tap | Acciones, asientos | Acción primaria |
| Long-press 400-500ms | Raise, asiento, badge de posición | Selector de importe / ficha / glosario |
| Swipe horizontal | Sheet de sidebar, Rules, Progress | Cambiar pestaña / página |
| Drag handle vertical | Bottom sheets | Cambiar altura (peek 30dvh / 60dvh / 90dvh) |
| Swipe hacia abajo | Cualquier sheet | Cerrar |
| Pull-to-refresh | Desactivado (`overscroll-behavior: none`) | No usar |

Implementación de long-press: Pointer Events, `pointerdown` + `setTimeout(500)`, cancelar en `pointermove > 8px`. Evitar `contextmenu` en el juego: `-webkit-touch-callout: none; user-select: none` en la mesa.

Haptics: opt-in, por defecto **ON** solo si el usuario lo activa en Settings ("Vibración al actuar"). `navigator.vibrate` no existe en iOS Safari (solo Android Chrome): degradar sin error.
```js
const haptic = (ms) => { try { if (settings.haptics && navigator.vibrate) navigator.vibrate(ms); } catch (_) {} };
```
Patrones: acción (10ms), turno tuyo (15-30-15), error (50).

---

## 15. Entrada de importe (raise)

Actual: `#raise-label` dentro del botón. Sin selector en móvil; el importe se fija en el botón.

Objetivo: **selector bottom sheet** que se abre al long-press de Raise o tap en un chip:
```
+--------------------------------------------+
|  Subir a                       8.5 BB      |
|  [ 2.5x ] [ 3x ] [ Pot ] [ ½ pot ] [ All-in ]|  presets 44px
|  [ −0.5 ]   ━━━━━━●━━━━━━━━   [ +0.5 ]     |  stepper 56px + slider
|  [        Confirmar 8.5 BB        ]         |  56px
+--------------------------------------------+
```
- Stepper: botones 56x56px con auto-repeat (300ms inicial, 60ms después).
- Slider: `input type=range`, `step` = 0.5 BB, thumb 28px, track 6px.
- Presets: 5 chips en fila; scroll horizontal si no caben.
- Campo numérico (`inputmode="decimal"`) solo en tablet/desktop; en teléfono usar stepper + slider.
- Confirmar: 56px, botón en la parte inferior.

Ancla: `#btn-raise`, `#raise-label`, `engine.js` (cálculo de tamaños legales; no tocar).

---

## 16. Compartir e invitación

- Botón "Invitar" en lobby MP y en menú de ajustes:
  - `navigator.share({ title, text, url })` si existe (iOS/Android). Fallback: copiar.
  - Botón "Copiar enlace" (44px) con feedback "Copiado" (toast 2s).
  - QR: generar en cliente (librería ligera o canvas) de 200x200 px, mostrar en sheet. Permite entrar desde otro móvil sin escribir la URL del túnel.
- Mostrar la URL corta sin esquema para lectura y el QR para escaneo.
- Aviso si la URL es el túnel temporal (`public-url.txt`): "Este enlace cambia si el servidor se reinicia".

---

## 17. Rendimiento para móviles de gama media

### 17.1 Presupuesto
| Métrica | Objetivo | Medición |
|---|---|---|
| FPS animación de cartas/fichas | 60 fps en gama alta; 30 fps en gama media (modo adaptativo) | `requestAnimationFrame` delta |
| INP | < 200 ms | Chrome DevTools / web-vitals |
| JS inicial | < 300 KB gzip | build |
| Imágenes | < 40 KB cada una (cartas en SVG; avatares en WebP 96px) | |
| Memoria | < 150 MB en MP con 6 cámaras | Chrome task manager |

### 17.2 Reglas de animación
- Solo `transform` y `opacity` en animaciones (cartas, fichas, sheets, toasts). No animar `left/top/width/height/box-shadow` en bucle.
- `will-change: transform` solo mientras la animación corre (añadir en `animationstart`, quitar en `animationend`). No dejarlo permanente.
- Fallback de FPS: medir 2s de `rAF`; si < 45 fps, activar `data-perf="low"` que desactiva el glow de la mesa y reduce la duración de animaciones a la mitad.
- `prefers-reduced-motion` o `data-perf="low"` → `--motion: 0ms`.

### 17.3 Imágenes y fuentes
- Fuentes de Google (Fraunces, IBM Plex): `font-display: swap` (ya presente, `index.html:12`). Limitar a pesos usados (ya limitado).
- Cartas: SVG inline o sprite; evitar PNG de cartas grandes.

---

## 18. Pruebas

### 18.1 Matriz de dispositivos
| Dispositivo | Viewport | Navegador | Prioridad |
|---|---|---|---|
| iPhone SE (3ª gen) | 375x667 | Safari iOS 17+ | P0 (peor caso alto) |
| iPhone 14 | 390x844 | Safari iOS | P0 |
| Pixel 7 | 412x915 | Chrome Android | P0 |
| Samsung A-series (gama media) | 360x800 | Chrome Android | P1 |
| iPad / tablet | 768x1024 | Safari iPadOS | P1 |
| Landscape | 844x390 | iOS y Android | P0 |
| Desktop (regresión) | 1280x800 | Chrome | P0 |

### 18.2 Playwright con emulación
- Ya disponible: `playwright-core` + Chrome del sistema. Script de captura usado: `scratchpad/shots.js` (no versionado).
- Añadir `test/e2e-mobile.js` con `devices` de Playwright (iPhone 14, Pixel 7) y `isMobile: true, hasTouch: true`.
- Verificaciones automáticas por pantalla: sin scroll horizontal (`document.documentElement.scrollWidth <= innerWidth`), sin elementos fuera del viewport (`getBoundingClientRect`), tamaño mínimo de botones (>= 44px), sin errores de consola (`pageerror`).
- Estado de captura de hoy: **falló por `chatVisible is not defined`** en todas las viewports: bloquear merge hasta corregir.

### 18.3 Checklist en dispositivo real
- [ ] Notch: la barra superior no queda bajo la muesca.
- [ ] Chat: el input sube con el teclado y es visible.
- [ ] Rotar en mitad de una mano: la mesa se reajusta sin perder el estado.
- [ ] Bloquear pantalla 30s y volver: reconexión y mesa correcta.
- [ ] Cambiar de WiFi a 4G: sin pérdida de mano.
- [ ] Cámara: permiso denegado muestra alternativa.
- [ ] Batería 20%: modo ahorro sugerido.
- [ ] Zoom del sistema 200%: textos legibles, sin solapes.

### 18.4 Lighthouse (objetivos)
- PWA: installable = sí; theme-color = sí; service worker = sí.
- Performance (móvil simulado): >= 80.
- Accesibilidad: >= 95.
- Best practices: >= 90.

### 18.5 Servicios externos (opcional)
- BrowserStack / Sauce Labs: usar para iOS real con Safari. Coste: plan mensual; alternativa gratuita: dos iPhones/Androids propios.

---

## 19. Roadmap por fases

### P0: quick wins (bloqueantes y visibles)
1. Corregir `chatVisible is not defined` (mp.js:3346/3402). Esfuerzo: 0.5 h.
2. Safe areas en `.topbar` y barra de acciones (§3.2). 1 h.
3. "Finish game" fuera del anillo de asientos en portrait (§8.5). 2 h.
4. Asientos dentro del viewport en <= 480px (§8.2): clamp de `left/right`. 2-3 h.
5. Barra de acciones: importe en 2ª línea, 56px, no envolver "Raise to 3 BB". 1 h.
6. Menú en lista compacta de filas (§7.2). 3 h.
7. Lobby MP: formulario arriba, botón abajo; "Offline" solo cuando aplica (§10.2). 2 h.
8. Meta/manifest/theme-color/apple-touch (§6.1, §6.2). 1 h.
9. Ocultar hints de teclado (F/C/R) en pantallas táctiles (§4.3). 0.5 h.
10. `visualViewport` para teclado en chat (§4.2). 2 h.

Subtotal P0: ~16 h.

### P1: experiencia completa
11. Sidebar como bottom sheet con pestañas y drag (§8.4). 6 h.
12. Selector de importe (§15). 5 h.
13. Rules/Progress/Help paginados (§11). 5 h.
14. Tira de cámaras y PiP (§10.3). 6 h.
15. Chat sheet con badge, toast, emojis (§10.4). 5 h.
16. Service worker offline shell (§6.3). 4 h.
17. Wake lock (§6.5). 1 h.
18. Long-press y tooltips táctiles (§9, §14). 4 h.
19. Compartir: navigator.share + copiar + QR (§16). 3 h.
20. Banner de conexión y reconexión (§12, §10.9). 4 h.

Subtotal P1: ~43 h.

### P2: pulido y avanzado
21. Install prompt iOS y Android (§6.4). 2 h.
22. Ahorro de datos y audio-only (§10.10). 5 h.
23. Modo perf adaptativo y will-change policy (§17). 3 h.
24. Alto contraste y escala 200% (§13). 4 h.
25. Permisos de cámara UX completos (§10.8). 3 h.
26. Tablet layout (§2, §7.4). 4 h.
27. Landscape menú dos columnas (§7.3). 3 h.
28. Suite de pruebas móviles y Lighthouse en CI (§18). 5 h.

Subtotal P2: ~29 h.

**Esfuerzo total estimado: ~88 h** (P0 ~16 h, P1 ~43 h, P2 ~29 h), más ~20% para QA en dispositivo real.

---

## 20. Riesgos

1. **Edición concurrente de UI** (varios agentes tocando `style.css`, `mp.css`, `mp.js`): alto riesgo de regresiones y de conflictos. Mitigación: congelar los archivos de layout durante P0, un solo responsable de `layout.js`.
2. **Límites de iOS Safari**: sin `navigator.vibrate`, sin `screen.orientation.lock`, `beforeinstallprompt` ausente, wake lock solo desde iOS 16.4+. Mitigación: todo opcional con fallback.
3. **Vídeo en móviles de gama media + 6 cámaras**: CPU y batería. Mitigación: modo ahorro, límite de tiles, audio-only (§10.10).
4. **Túnel de Cloudflare inestable / URL cambiante**: enlaces que caducan. Mitigación: aviso en §16 y pantalla de §12.2.
5. **Service worker mal versionado**: sirve UI vieja tras desplegar. Mitigación: `BUILD_ID` en cada cache, actualización con confirmación.

Otros: rendimiento de `layoutCams` con muchas cámaras; escala de fuente 200% rompiendo asientos (ver §13).

---

## 21. Dependencias en archivos actuales (anclas)

| Cambio | Archivo | Ancla |
|---|---|---|
| Safe areas topbar | `public/style.css` | `.topbar`, `.app` (~1068-1300) |
| Breakpoints móviles | `public/style.css` | `@media` 816, 819, 825, 901, 1027, 1031 |
| Breakpoints juego | `public/game-mode.css` | 20-45 (`max-height`, `max-width:480px`, landscape) |
| Breakpoints MP | `public/mp.css` | 419-556, 617-622, 778-825, 853 |
| Layout de mesa | `public/app.js` | `fitTableBox` (377), `layoutTable` (389) |
| Layout de mesa MP | `public/mp.js` | `layoutTable` (2494), `layoutCams` (3829) |
| Chat, toast, bubbles | `public/mp.js` | `chatEffects` (779), `chatVisible` (3402), `clearToast` (3364) |
| Bottom sheet genérico | `public/style.css` | `.sheet` (912), 1032 |
| Rules/Progress/Help | `public/index.html` | 346 (`#sheet-rules`), 411 (`#sheet-progress`) |
| Menú de modos | `public/index.html` | 45-70 (`#menu-format`) |
| Lobby MP | `public/index.html` | 338 (`#mp-root`) y `mp.js` |
| Head/PWA | `public/index.html` | 1-14 |
| Manifest/SW (nuevos) | `public/manifest.webmanifest`, `public/sw.js` | nuevos |
| Viewport dinámico (nuevo) | `public/layout.js` | nuevo, cargar antes de `app.js` |
| Wake lock, haptics | `public/app.js` y `public/mp.js` | entrada a `view-game` y `#mp-root` |
| Raise selector | `public/app.js` | `#btn-raise`, `#raise-label` |
| Textos nuevos | `public/i18n.js` | añadir claves `mobile.*` |
| Motion/reduced | `public/anim.css:67`, `style.css:805`, `mp.css:345` | unificar |

---

## 22. Checklists de aceptación por función

**Menú**
- [ ] En 375x667 se ven los 6 modos sin scroll, o con scroll solo dentro de la lista.
- [ ] Ninguna descripción se corta a media línea sin elipsis.
- [ ] Botón Jugar visible en la parte inferior, 56px.

**Mesa solo-jugador (portrait)**
- [ ] Ningún asiento sale del viewport (375, 390, 412 px).
- [ ] "Finish game" no tapa ningún asiento.
- [ ] Action bar: 3 botones de >= 56px, importe visible sin cortar.
- [ ] Board visible con 5 cartas en 360px.

**Sidebar**
- [ ] Se abre como sheet inferior, cierra con swipe y con tap fuera.
- [ ] Cambio de pestaña con swipe horizontal.

**Exam / Quick / Practice**
- [ ] Métricas de exam en una línea o scroll horizontal.
- [ ] Pantalla de fin de quick con botón primario en la parte inferior.
- [ ] Feedback de practice como sheet con botón Siguiente de 56px.

**Rules / Progress / Help**
- [ ] Paginación con swipe; dots de 44px de área.
- [ ] Ninguna pantalla requiere hover.

**MP**
- [ ] Lobby: botón Unirse abajo; "Offline" solo cuando procede.
- [ ] Chat: input visible con teclado abierto (iOS y Android).
- [ ] Toast de mensaje nuevo con chat cerrado; badge de no leídos.
- [ ] Tira de cámaras con 6 participantes sin solapes en 375px.
- [ ] Permiso de cámara denegado: alternativa funciona.
- [ ] Desconexión 10s + reconexión: el estado de mesa se recupera.

**PWA**
- [ ] Manifest válido; instalable en Android Chrome; añadir a inicio en iOS con icono correcto.
- [ ] Shell offline carga el modo solo sin red.
- [ ] Wake lock activo en mesa y liberado al salir.

**Accesibilidad**
- [ ] Escala de fuente 200%: sin solapes en mesa y menú.
- [ ] Alto contraste: bordes de cartas y asientos visibles.

**Rendimiento**
- [ ] Lighthouse móvil: performance >= 80, accesibilidad >= 95.
- [ ] Sin animaciones de `left/top/box-shadow` en bucle (revisión en DevTools Performance).
