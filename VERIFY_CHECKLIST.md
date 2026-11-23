# Checklist de verificación (últimos puntos pedidos, más reciente primero)

Cada punto lo revisa un agente de solo lectura (sin editar código): prueba en navegador real contra http://localhost:3000, cuenta qué está bien / mal / no implementado, con evidencia. En caso de choque entre dos peticiones manda la más reciente.

1. Sonidos: reparto, carta siguiente, movimiento de fichas (apuestas y victoria); indicador de turno leve (jugador y rival); ajuste de volumen en el menú (persistente, 0 = silencio).
2. Símbolos en vez de palabras para estilo (ajustado, agresivo...) y última acción (check...), con hover que explica; avatar de bots = icono de su estilo; en multi, si cambia la foto el hover sigue mostrando estilo y explicación.
3. Mesa centrada en la ventana en todos los modos y tamaños (1024 a 3440 de ancho), sin quedarse a la izquierda.
4. Forma de mesa tipo pista olímpica (estadio), no cuadrada ni elipse; colores de mesa, borde y fondo configurables (botón de aspecto en todos los modos) y aplicados en vivo.
5. Nuevo aspecto según la imagen de referencia: tarjeta de jugador (avatar, nombre, stack en BB, cartas boca abajo asomando por detrás, Folded, brillo verde al turno), fichas 3D con etiqueta, bote con pila de colores, huecos discontinuos del tablero.
6. Multijugador: expulsión a mitad de mano limpia (sin segundo kick al repartir).
7. Multijugador: un bot eliminado no reaparece con su dinero.
8. Multijugador: manos ganadoras visibles al final de la mano (cartas, mejores 5, nombre de mano).
9. Multijugador: cámaras abajo con conmutador Usuarios/Chat que reemplaza la cuadrícula; columna derecha eliminada; botón de ajustes con usuarios + ajustes; perfil arriba a la derecha (foto y nombre); flecha atrás arriba a la izquierda junto al modo; nombres nunca usados como identificadores (dos jugadores con el mismo nombre funcionan).
10. Tope de apuesta: nadie apuesta más que el mayor stack rival que aún puede pagar (1v1v1 con 30k: máximo 30k), en UI, reglas y bots.
11. Sin límite de tiempo en ningún modo offline.
12. Análisis: se puede hacer scroll vertical para ver todas las manos y rondas (y solo ahí hay scroll).
13. Partida rápida: sin barra lateral de análisis (pantalla entera = mesa, análisis solo como desplegable).
14. Examen: panel lateral como desplegable que se superpone a la mesa, cerrado por defecto, sin evaluación mientras se juega.
15. Cantidad libre al subir solo en Partida rápida; Examen, Práctica y Single spots solo con los 3 botones.
16. Nueva Partida rápida reinicia los stacks.
17. Se enseñan las cartas y el nombre de la mano ganadora si se llegó a la última ronda.
18. CPU retiradas siguen mostrando personalidad y dinero.
19. Scrollbar en la página con 4 jugadores (no debe haber ninguna).
20. Header: Reglas y Progreso ocupan toda la altura por encima del header.
21. Tarjeta de bots: sin scroll interno, cartas boca abajo sin recortar por arriba, icono de cartas limpio.
22. Última mano de una partida rápida se ve entera antes de la pantalla de fin.
23. All-in aceptado en 1v1: se enseñan ambas manos y el resto del tablero sale por calles.
24. Animaciones de apuestas/bote/reparto sin parpadeo, lentas y suaves; mismo estilo en todos los modos.
25. Lógica: win% solo contra rivales activos; outs correctas; rangos coherentes (monotonía); selector Facing sincronizado; texto "yet to act"; foldear pudiendo pasar = peor error; apuestas de bots redondeadas; bots no pagan river con solo la pareja de la mesa.
26. Fold desactivado cuando se puede pasar; etiqueta "Bet" sin apuesta previa; sin parpadeo de "Check" viejo; etiqueta de acción del rival actualizada.
27. Starting stack validado (no negativos); ajustes de modo no se arrastran entre modos.
28. Progress: "Hands played" cuenta manos.
29. Flecha de volver pide confirmación en mitad de partida; pantalla "Game finished" centrada.
30. Accesibilidad: nombres accesibles de Play y checkboxes; pestañas con flechas; atajo R respeta el botón desactivado.
31. Chat multijugador: aviso arriba pequeño, burbujas junto a cámara y en mesa, espectadores en rincón, emoticonos PNG propios.
32. Pausa multijugador: temporizador parado y cartel grande "Partida pausada".
33. Fin de partida en multijugador devuelve a todos al lobby.
34. Ajustes MP: doblar ciegas + ciegas progresivas cada X min (1–10).
35. Espectadores ven todas las cartas; cámaras de espectadores se quedan con indicación de jugador/espectador.
36. Doble clic en Check no expulsa; pulsar en las propias cartas tras la mano las enseña.
37. Cámara/micro/WebSocket solo dentro de Multijugador y se apagan al salir.
38. Mesa en todos los tamaños de pantalla: sin solapes ni recortes (1366x768, 1920x1080, 390x844, 844x390, 1024x600).
39. Sin scroll en ninguna pantalla excepto Análisis (360x640 incluido).
40. Popup de evaluación: OK/Next y botones F/C/R nunca se mueven.
41. Header oculto dentro de los modos con flecha pequeña; menú con header mínimo permanente.
42. Idioma: mismos números y mensajes en EN y ES; nunca la palabra "equity".
43. Rulebook: botones "Por qué" y "desglose" funcionan; pagers de Reglas y Progreso.
44. Money (stacks) cambia de verdad el juego de los bots; stacks variados por defecto.
45. Modo Quick game completo (mesa con bots, hasta quedarse sin fichas o ganar).
46. Latencia/continuidad MP: reconexión, recarga a mitad de mano reentra al mismo asiento, indicador de ping.
47. Seguridad MP: token de asiento (no se puede suplantar), asientos abandonados se liberan.
48. Enlace público accesible (HTTP 200 + wss).
49. Cabeceras/tarjetas del menú: Quick game, Single spots, Practice, Exam, Multiplayer, Rules, Progress con textos correctos.
50. Móvil: tamaños táctiles, safe-area, rotación (verificación parcial; plan en MOBILE_PLAN.md).
