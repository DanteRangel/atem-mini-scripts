# Auto-Switch ATEM Mini Pro (audio)

Cambio automático de cámara en **ATEM Mini Pro** según quién hable. Usa el audio de las entradas HDMI (lavalieres en cámara) que el ATEM ya recibe; **no hace falta Companion** ni micrófonos del sistema.

## Comportamiento

- **Una cámara con audio** → corta a esa cámara.
- **Dos o más con audio** → corta a la **cámara amplia** (p. ej. Cámara 3).
- **Nadie habla** (silencio unos segundos) → corta a la **cámara amplia**.
- Hay un **retraso de 800 ms** antes de ejecutar el corte para que el cambio no sea brusco.

## Requisitos

- Node.js 18+
- ATEM Mini Pro (o compatible) en la misma red
- Audio en las entradas HDMI del ATEM (p. ej. lavalieres en cámara)

## Instalación

```bash
npm install
```

## Uso

```bash
# Con IP del ATEM
ATEM_IP=192.168.68.111 npm start

# Sin IP: busca ATEM en la red y elige uno
npm start
```

## Configuración (variables de entorno)

| Variable | Descripción | Por defecto |
|----------|-------------|-------------|
| `ATEM_IP` | IP del ATEM. Si no se define, se busca en la red. | — |
| `VOLUME_THRESHOLD` | Umbral 0–1 para considerar “hablando” (ej. 0.11 = 11%). | `0.11` |
| `AUDIO_MIN_DB` | dB mínimo del rango (por debajo = silencio). | `-40` |
| `AUDIO_MAX_DB` | dB máximo del rango. | `0` |
| `HOLD_TIME` | ms con nivel por encima del umbral antes de contar. | `300` |
| `COOLDOWN_TIME` | ms entre cortes permitidos. | `2000` |
| `MIN_VOLUME_DIFFERENCE` | Diferencia mínima (0–1) para cambiar de cámara. | `0.02` |
| `SWITCH_DELAY_MS` | ms de espera antes de ejecutar el corte. | `800` |
| `WIDE_CAMERA_ID` | Input usado como “cámara amplia” (silencio o 2+ hablan). | `3` |
| `SILENCE_TO_WIDE_MS` | ms de silencio para ir a cámara amplia. | `2000` |
| `TRANSITION_TYPE` | `cut` o otro tipo de transición. | `cut` |
| `DEBUG` | `true` para ver niveles por input y más detalle. | `false` |

Ejemplo:

```bash
ATEM_IP=192.168.68.111 VOLUME_THRESHOLD=0.10 SWITCH_DELAY_MS=1000 npm start
```

## Estructura del proyecto

- `auto-switch-atem.js` — Punto de entrada y lógica de conexión/monitoreo.
- `config.js` — Configuración (env + defaults).
- `discover-atem.js` — Descubrimiento de ATEM en la red.
- `lib/audio.js` — Conversión dB ↔ normalizado y parseo Fairlight.
- `lib/AudioLevelTracker.js` — Historial de niveles por input.
- `lib/SwitchDecider.js` — Reglas de decisión (silencio / 2+ / 1 cámara).

## Logs

- **Modo normal:** solo se muestra un log por **cambio real** de cámara, con la razón (silencio, 2+ hablan, 1 cámara).
- **Modo debug** (`DEBUG=true`): niveles por input (🎧) y resumen periódico (📊).

## Solución de problemas

**No se conecta al ATEM**

- Misma red que el ATEM; puertos UDP 20595 (descubrimiento) y TCP 9910 (control) libres.
- Probar con ATEM Software Control y, si hace falta, fijar la IP: `ATEM_IP=192.168.x.x npm start`.

**No hace corte**

- Comprobar que haya audio en las entradas (ATEM Software Control).
- Bajar un poco el umbral: `VOLUME_THRESHOLD=0.08` o `0.07`.
- Con `DEBUG=true` ver si llegan niveles (🎧) y si se cumple hold/delay.

**Corta con ruido o demasiado**

- Subir umbral: `VOLUME_THRESHOLD=0.12` o `0.13`.
- Subir `AUDIO_MIN_DB` (ej. `-38`) para ignorar más ruido bajo.

**Cambios muy bruscos o muy lentos**

- Ajustar `SWITCH_DELAY_MS` (ej. `500` más rápido, `1200` más suave).
- Ajustar `HOLD_TIME` y `COOLDOWN_TIME` según necesidad.

## Licencia

MIT
