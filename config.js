/**
 * Configuración del auto-switch (variables de entorno y valores por defecto).
 */

// Fija aquí la IP de tu ATEM para no depender del descubrimiento (ej. si hay varios en la red)
const ATEM_IP_FIJA = null; // ej: '192.168.68.111'

export const CONFIG = {
  atemIp: process.env.ATEM_IP || ATEM_IP_FIJA || null,

  cameraMapping: {
    1: { name: 'Cámara 1' },
    2: { name: 'Cámara 2' },
    3: { name: 'Cámara 3' },
    4: { name: 'Cámara 4' },
  },

  wideCameraId: process.env.WIDE_CAMERA_ID ? parseInt(process.env.WIDE_CAMERA_ID, 10) : 3,
  silenceToWideMs: parseInt(process.env.SILENCE_TO_WIDE_MS || '2000'),

  transition: {
    type: process.env.TRANSITION_TYPE || 'cut',
    duration: parseInt(process.env.TRANSITION_DURATION || '30'),
  },

  audio: {
    minDb: parseFloat(process.env.AUDIO_MIN_DB || '-40'),
    maxDb: parseFloat(process.env.AUDIO_MAX_DB || '0'),
    volumeThreshold: parseFloat(process.env.VOLUME_THRESHOLD || '0.11'),
    holdTime: parseInt(process.env.HOLD_TIME || '300'),
    cooldownTime: parseInt(process.env.COOLDOWN_TIME || '2000'),
    /** Cooldown más corto al ir a cámara amplia (2+ hablan o silencio), para que no tarde ~2 s */
    cooldownWideMs: parseInt(process.env.COOLDOWN_WIDE_MS || '400'),
    minVolumeDifference: parseFloat(process.env.MIN_VOLUME_DIFFERENCE || '0.02'),
    /** Retraso en ms antes de ejecutar el corte (evita cambios bruscos). */
    switchDelayMs: parseInt(process.env.SWITCH_DELAY_MS || '800'),
    /** Retraso más corto al ir a cámara amplia (2+ hablan o silencio). */
    switchDelayWideMs: parseInt(process.env.SWITCH_DELAY_WIDE_MS || '300'),
  },

  detection: {
    updateInterval: 100,
    samplesForAverage: 30,
  },

  debug: process.env.DEBUG === 'true' || false,
};
