# Auditoría de bots (public/bots.js)

Estado: mejora parcial. Los bots son más difíciles en varios puntos (all-ins, faroles, estrategias de explotación), pero el bot de referencia "solid" sigue ganando en mesas 1 contra 1 frente a `loose` y `aggressive`. Quedan errores pendientes (ver al final).

## 1. Cómo se mide

- `test/bots-sim.js`: simulador headless sobre el flujo real de `public/game.js`. Cada decisión de los bots pasa por `decide()` del módulo indicado (`BOTS=ruta`). Semilla fija (20260610).
- Configuraciones: heads-up round robin (bot contra bot, 10 parejas), mesas mixtas de 3, 6 y 9 asientos con personalidades aleatorias, y estrategias de explotación (una plaza contra 5 bots en 6-max y heads-up contra cada personalidad).
- Heroes de referencia: `solid` (TAG por probabilidad de ganar contra rango aleatorio y cuota de pot), `station` (llama casi todo), `maniac` (apuesta casi siempre), `shover` (all-in siempre que puede), `caller` (llama siempre), `nit` (solo apuesta lo muy fuerte).
- Muestra: 1200 manos por configuración (`SIM_HANDS=1200 node test/bots-sim.js full`), unos 70 s por ejecución. El error estándar de un BB/100 en heads-up es grande (del orden de ±15-20), así que las diferencias pequeñas no son significativas.
- `test/_bots-old.js`: copia de `bots.js` original (require ajustado a `../public/engine.js`) para la comparación.

## 2. Errores encontrados, ordenados por gravedad

Medidos con el simulador sobre el bot original (antes del cambio):

1. **All-ins llamados sin rango del rival (todas las personalidades).** Preflop, el umbral de llamada era el percentil de la mano (`play * posición * 0.6`), sin mirar el rango de quien hace all-in. Resultado: entre el 10% (tight) y el 21% (aggressive) de los all-ins se llamaban con menos win chance que la cuota de pot exigida frente a un rango de shove top-20%. Loose llegaba a llamar con las 42% superiores de manos desde el botón.
2. **Faroles demasiado frecuentes en aggressive y balanced.** `aggressive` apostaba como farol el 95% de las veces con win chance >= 13% y hacía raise-farol el 40% de las veces con ese mismo mínimo. `balanced` (80%/25%) y `tight` (75%) tenían la misma pauta. Un rival que llama o que paga marca pierde dinero con esto, y un bot que farolea a todas horas es explotable.
3. **Defensa preflop insensible al rango del abridor.** Se llamaba la misma anchura contra una apertura UTG que contra una BTN, y el BB defendía más estrecho (0.8x) cuando tiene el descuento de pot odds.
4. **Loose llama demasiado con mano marginal.** Margen de llamada -0.03 y 60% de llamadas "naturales" justo por debajo de la línea de pot odds. Loose pierde frente a value-betting razonable (ver tabla).
5. **Sin distinción de posición en las apuestas postflop.** Un bot en posición y fuera de posición apuesta igual (sin cambio en esta ronda).
6. **Tamaños de apuesta predecibles y overbets sin mucha justificación.** Los overbets se limitan a nuts/aire, pero los tamaños son fijos por personalidad (sin cambio en esta ronda).

Por personalidad (orden de gravedad):
- **tight**: all-ins llamados sin buena mano (10% de los all-ins, corregido a 0%). Sigue cediendo frente a `solid` (+12.8 BB/100 en heads-up).
- **aggressive**: faroles excesivos (19.6% de raises con win chance < 35% antes, 9% ahora); all-ins por debajo de cuota 20.8% -> 18%. Sigue perdiendo frente a `solid` (+71 BB/100 para solid en heads-up).
- **balanced**: all-ins por debajo de cuota 15.4% -> 9.6%; calls demasiado anchos (margen de llamada 0.03 -> 0.06).
- **loose**: llamadas demasiado anchas (fold to bet 22%, marginal 0.60 -> 0.35); all-ins por debajo de cuota 14.1% -> 10.7%. Empeora frente a `solid` heads-up (+62.7 -> +105.9). Error sin resolver.
- **passive**: el más rentable en mesas mixtas (+196 antes, +145 después) porque el resto de bots le regala dinero. Pierde frente a `solid` heads-up (-10.7 -> -15.2). No es un error grave, pero explota a los bots pasivos en el resto.

## 3. Cambios en bots.js

- Nuevo `shoveCall`: preflop, si la apuesta que se enfrenta es el total de un rival (all-in, `shoveIn`), se llama solo con win chance frente a su rango de shove (anchura por posición: `SHOVE_OPEN`; 3-bet 8%; short stack amplio; limp/call 30%) por encima de la cuota más `allInMargin`.
- Postflop: un all-in rival (`shoveIn`) usa el margen `allInMargin` por personalidad (tight 0.05, passive 0.06, aggressive 0.03, balanced 0.03, loose 0.02) en lugar de `callMargin` y su rango se estrecha también en el flop (30%).
- Defensa preflop contra apertura: anchura por posición del abridor (`OPENER_MULT`) y BB defiende a anchura plena.
- Faroles: `bluff` aggressive 0.95 -> 0.40, `bluffRaise` 0.40 -> 0.10; tight 0.75 -> 0.50; balanced 0.80 -> 0.45 (raise 0.25 -> 0.08); loose 0.65 -> 0.45. `BLUFF_FLOOR` 0.13 -> 0.18.
- Loose: `callMargin` -0.03 -> 0.02, `marginal` 0.60 -> 0.35.
- Balanced: `callMargin` 0.03 -> 0.06.
- Sin cambio: rangos preflop (VPIP/PFR), tamaños de apuesta, reglas de 0.5 BB y mínimos de raise, evaluación del motor.

## 4. Resultados antes/después (1200 manos por configuración)

### Mesas mixtas 6-max (BB/100, VPIP, PFR, all-ins)

| tipo | BB/100 antes | después | VPIP antes/después | PFR antes/después | all-ins llamados antes/después | all-ins llamados por debajo de cuota antes/después |
|---|---|---|---|---|---|---|
| tight | 162.7 | 122.5 | 14.1 / 14.2 | 8.3 / 8.3 | 20 / 15 | 5.0% / 0.0% |
| loose | -135.7 | -82.0 | 44.5 / 44.6 | 11.1 / 11.1 | 135 / 103 | 14.1% / 10.7% |
| aggressive | -69.2 | -34.6 | 29.3 / 29.9 | 22.0 / 22.0 | 53 / 44 | 20.8% / 18.2% |
| passive | 196.0 | 144.9 | 31.5 / 32.0 | 3.4 / 3.4 | 46 / 38 | 2.2% / 2.6% |
| balanced | -74.6 | -82.2 | 25.7 / 25.8 | 16.0 / 16.0 | 91 / 73 | 15.4% / 9.6% |

Los VPIP y PFR no cambian: los rangos preflop se mantienen y las personalidades siguen siendo reconocibles.

### Otras métricas (antes / después)

| tipo | fold a apuesta | SD win % | agresión (AF) | faroles % de raises | apuesta media (x pot) | calls con <40% y >40% stack |
|---|---|---|---|---|---|---|
| tight | 39.9 / 36.6 | 55.1 / 47.8 | 2.60 / 2.64 | 2.4 / 3.4 | 0.68 / 0.64 | 13.6 / 15.8 |
| loose | 21.9 / 26.2 | 44.4 / 44.1 | 0.99 / 1.25 | 9.7 / 8.3 | 0.64 / 0.63 | 18.3 / 13.4 |
| aggressive | 24.3 / 30.1 | 41.3 / 42.9 | 4.38 / 3.60 | 19.6 / 9.0 | 0.82 / 0.80 | 15.6 / 9.8 |
| passive | 30.4 / 29.2 | 65.3 / 63.2 | 0.15 / 0.19 | 0.0 / 0.0 | 0.61 / 0.53 | 0.0 / 0.0 |
| balanced | 27.1 / 33.0 | 41.6 / 40.8 | 2.36 / 2.12 | 16.6 / 7.7 | 0.69 / 0.63 | 8.4 / 3.8 |

Nota: en el simulador el "fold a apuesta" se refiere a decisiones postflop frente a apuesta.

### Explotación (BB/100 del héroe de referencia)

| héroe | 6-max antes | 6-max después | HU vs tight | HU vs loose | HU vs aggressive | HU vs passive | HU vs balanced |
|---|---|---|---|---|---|---|---|
| solid | +60.7 | +0.3 | 11.3 -> 12.8 | 62.7 -> 105.9 | 109.6 -> 71.2 | -10.7 -> -15.2 | -25.2 -> -72.2 |
| station | -1561.3 | -1533.8 | -90.2 -> -51.8 | -94.9 -> -202.4 | -518 -> -686.7 | -55.2 -> -21.7 | -49.2 -> -101.9 |
| maniac | -1618.3 | -1843.4 | -261.5 -> -512.8 | -1086 -> -1204 | -704 -> -838 | -534 -> -576 | -526 -> -377 |
| shover | -1271.5 | -546.6 | -367.6 -> -347.9 | -706 -> -440 | -410 -> -178 | -350.5 -> -147 | -144.7 -> -117.2 |
| caller | -1775.1 | -1745.2 | -267.7 -> -251.7 | -334.7 -> -327.6 | -688 -> -730 | -27.3 -> -27.3 | -189.8 -> -239.1 |
| nit | -18.2 | -12.7 | -25.8 -> -14.2 | 5.8 -> -5.7 | -11.1 -> 2.2 | -43.9 -> -43.8 | 20.0 -> -0.4 |

Las estrategias de explotación pierden (station, maniac, caller, shover, nit en mesa). El héroe `solid` pasa de +61 a +0.3 en 6-max, pero sigue ganando en heads-up contra loose y aggressive. Los números de heads-up son de una muestra corta (1200 manos), con mucha varianza.

Pendiente: el objetivo "solid no gana" no se cumple en heads-up contra loose (+106) ni aggressive (+71).

### Rendimiento

- Decisiones por segundo (medidas dentro del simulador, por personalidad): tight 9928 -> 8668, loose 5307 -> 4890, aggressive 7070 -> 6319, passive 5858 -> 4900, balanced 7235 -> 6503. Baja alrededor de un 10% por el cálculo de probabilidad de ganar frente a rango en all-ins preflop (`shoveCall`). El número de muestras Monte Carlo (SAMPLES = 160) no cambia.
- RAM: el simulador es un único proceso, sin navegador.

## 5. Tests

- `node test/engine.test.js`: PASS.
- `node test/game.test.js`: PASS.
- `node test/bots-audit.js`: PASS (todas las propiedades).
- `node test/mp-rooms.test.js`: PASS.
- `node test/mp-client.test.js`: PASS.
- `node test/mp.test.js`: FAIL en la prueba "soak" (timeout "game restarted"). Falla también con los bots originales, así que es un fallo previo del test (de tiempo). Un reintento anterior pasó.

## 6. Pendiente

1. Loose: reducir llamadas postflop con mano marginal y ampliar la cuota de llamadas frente a apuestas grandes.
2. Aggressive: sizing con más varianza y menos faroles con win chance bajo cuando el rival llama.
3. Posición postflop: apuestas en posición vs fuera de posición (no implementado).
4. Aumentar la muestra del simulador (3000+ manos) para reducir la varianza antes de tomar decisiones de ajuste fino.
5. El método de cálculo de rango del rival en all-in asume anchuras por posición; un bot que hace all-in con cualquier mano (shover) sigue siendo leído como rango estrecho.

## 7. Ronda 2 y 3 (medidas finales)

Cambios de la ronda 2 (sobre la ronda 1): loose `callMargin` 0.04 y `marginal` 0.20 (más estrecho que antes para llamar por debajo de la cuota); estrechamiento del rango rival ante apuestas >= medio bote; escala de faroles por calle, posición, multiway y tablero coordinado; guardia `bluffAllInOk` (ningún farol all-in en el river salvo que el bote sea pequeño); dispersión de tamaños +-25%; defensa 3-bet x0.4; `allInMargin` por personalidad.

Ronda 3 (dirigida): aggressive `bluff` 0.40 -> 0.30, `bluffRaise` 0.10 -> 0.06, `callMargin` 0.05 -> 0.07; loose `callMargin` 0.04 -> 0.07, `marginal` 0.20 -> 0.12; river sin apuesta de valor cuando la mano solo tiene valor de tablero (`boardOnlyValue`); tamaños de apuesta redondeados hacia abajo a 0.5 BB y limitados a 1.5 bote (el test D1 fallaba con 8-14 apuestas de más de 1.5 bote). Se probó bajar `callMargin` de tight (0.16 -> 0.13) y se revirtió: solid ganaba más contra tight.

### 7.1 Mesa 6-max (BB/100), original (3000 manos) / ronda 2 (3000) / final (2000)

| tipo | original | ronda 2 | final |
|---|---|---|---|
| tight | -3.1 | 13.3 | 0.8 |
| loose | 50.7 | 63.1 | 17.7 |
| aggressive | -53.3 | -16.5 | -5.9 |
| passive | 77.8 | 5.3 | 22.2 |
| balanced | -96.8 | -71.9 | -33.8 |

### 7.2 Métricas clave (original / ronda 2 / final)

| tipo | all-ins llamados bajo cuota | shove de río sin valor (% raises de río) | faroles (% raises) | AGG |
|---|---|---|---|---|
| tight | 3.7 / 0 / 0 | 0.8 / 0 / 0 | 2.5 / 1.7 / 1.6 | 3.61 / 3.80 / 3.42 |
| loose | 14.7 / 7.5 / 6.1 | 0.8 / 0 / 0 | 8.4 / 3.8 / 4.2 | 1.11 / 1.50 / 1.80 |
| aggressive | 19.5 / 5.9 / 5.7 | 2.6 / 1.1 / 0 | 18.8 / 5.6 / 4.4 | 4.78 / 3.93 / 4.52 |
| passive | 6.8 / 3.1 / 6.1 | 0 / 0 / 0 | 0 / 0 / 0 | 0.19 / 0.24 / 0.21 |
| balanced | 16.8 / 5.7 / 14.5 | 1.1 / 0 / 0.6 | 15.1 / 3.4 / 2.5 | 2.13 / 1.92 / 1.83 |

VPIP y PFR no cambian (final: tight 14.6/9.5, loose 43.3/9.8, aggressive 31.8/24.5, passive 32.6/3.7, balanced 25.5/15.8).

### 7.3 Héroe solid, heads-up (BB/100)

| rival | original | ronda 2 | final |
|---|---|---|---|
| tight | 18.5 | 14.7 | 48.3 |
| loose | 15.0 | 12.5 | 20.7 |
| aggressive | 36.2 | 30.5 | -6.8 |
| passive | -17.7 | -24.2 | -26.8 |
| balanced | 29.9 | 11.9 | -7.8 |

Con 2000 manos, el error estándar en heads-up es de unos ±15-20 BB/100: las diferencias de ±10 no son concluyentes. Tight y loose siguen dando beneficio al solid, sobre todo tight (folds 44% a apuestas).

### 7.4 Héroes de explotación (6-max, BB/100)

| héroe | original | ronda 2 | final |
|---|---|---|---|
| solid | 14.8 | -41.6 | -94.3 |
| station | -1476.4 | -1400.2 | -1362.7 |
| maniac | -1880.1 | -2032.3 | -1835.1 |
| shover | -1179.9 | -499.2 | -497.1 |
| caller | -1794.5 | -1847.1 | -1680.7 |
| nit | 33.1 | -3.5 | -11.7 |

### 7.5 Caso del río: 8s Th sobre 7h 6s 3h Ks 5h, 67 BB detrás

Medido con `river-shove.js` (scratchpad, 1000 claves por personalidad y escenario): en 9 escenarios (acción primero o frente a apuesta, en y fuera de posición, bote 20/66/100 BB, frente a apuesta de medio bote y frente a all-in) ninguna personalidad hace all-in ni raise: 0% antes y después. La mano tiene 4.5% de equity contra rango aleatorio, así que el bot nunca apuesta. El cambio de ronda 3 (no apostar por valor con mano solo de tablero) es una salvaguarda adicional.

### 7.6 Tests

- `engine`, `game` (tras corregir D1), `bots-audit`, `mp-rooms`, `mp-client`: PASS dos veces.
- `mp.test.js`, prueba "soak": FALLA en 4 de 5 ejecuciones con los bots nuevos ("timed out waiting for game restarted", ventana de 3 s tras `start`). Con los bots originales pasó 2 de 2 (copia del proyecto con `_bots-old.js`). En una ejecución falló "kick mid-hand" (timeout de 3 s). Es un fallo de temporización del test relacionado con la secuencia de partidas que producen los bots; no está resuelto.

### 7.7 Pendiente

1. Solid sigue ganando heads-up contra tight (+48) y loose (+21): reducir la tasa de fold de tight a apuestas sin disparar los all-ins.
2. Diagnosticar el timeout del soak en `server/room.js` (`_start` lanza si `_startHand` falla y el autoplay queda en false).
