/**
 * Utilidades de audio: conversión dB ↔ normalizado y parseo de payloads Fairlight.
 */

/**
 * Convierte nivel en dB a valor normalizado 0-1.
 * @param {number} db
 * @param {number} minDb
 * @param {number} maxDb
 * @param {number} curve - curva de suavizado (0.7 típico para lavalieres)
 */
export function dbToNormalizedLevel(db, minDb, maxDb, curve = 0.7) {
  if (db <= minDb || !Number.isFinite(db)) return 0;
  if (db >= maxDb) return 1;
  const linear = Math.pow(10, db / 20);
  const minLinear = Math.pow(10, minDb / 20);
  const maxLinear = Math.pow(10, maxDb / 20);
  let norm = (linear - minLinear) / (maxLinear - minLinear);
  norm = Math.pow(Math.max(0, Math.min(1, norm)), curve);
  return norm;
}

/**
 * Extrae dB y nivel normalizado de un payload Fairlight (levelChanged o FMLv).
 * ATEM envía niveles como Int16BE en formato dB*100 (ej. -3000 = -30 dB).
 */
export function parseFairlightLevels(props, minDb, maxDb) {
  if (!props) return { db: -Infinity, normalized: 0 };
  const left = props.leftLevel ?? 0;
  const right = props.rightLevel ?? 0;
  const maxLevel = Math.max(left, right);
  if (maxLevel <= -32768) return { db: -Infinity, normalized: 0 };
  const db = maxLevel / 100;
  const normalized = dbToNormalizedLevel(db, minDb, maxDb);
  return { db, normalized };
}
