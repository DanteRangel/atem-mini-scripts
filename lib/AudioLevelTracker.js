/**
 * Rastrea niveles de audio por input: almacena muestras recientes y expone
 * qué cámaras tienen audio por encima del umbral (con hold time).
 */

export class AudioLevelTracker {
  /**
   * @param {object} config - CONFIG.audio y CONFIG.detection
   * @param {object} cameraMapping - CONFIG.cameraMapping (solo inputs válidos)
   */
  constructor(config) {
    this.config = config;
    this.cameraMapping = config.cameraMapping;
    /** @type {Map<number, Array<{ volume: number, db: number, timestamp: number, raw?: any }>>} */
    this.levels = new Map();
    this.lastTimeAnyAudio = 0;
  }

  /**
   * Registra una muestra de nivel para un input.
   */
  store(inputId, normalizedLevel, db, raw = null) {
    if (normalizedLevel > this.config.audio.volumeThreshold) {
      this.lastTimeAnyAudio = Date.now();
    }
    if (!this.levels.has(inputId)) {
      this.levels.set(inputId, []);
    }
    const list = this.levels.get(inputId);
    list.push({
      volume: normalizedLevel,
      db,
      timestamp: Date.now(),
      raw,
    });
    const maxSamples = this.config.detection?.samplesForAverage ?? 30;
    if (list.length > maxSamples) {
      list.shift();
    }
  }

  /**
   * Cámaras que superan umbral y hold time (candidatas a "hablando").
   * @param {number} now
   * @returns {{ inputId: number, avgVolume: number, levels: Array }[]}
   */
  getCamerasWithAudio(now) {
    const { volumeThreshold, holdTime } = this.config.audio;
    const result = [];

    for (const [key, list] of this.levels) {
      const inputId = Number(key);
      if (list.length === 0 || !this.cameraMapping[inputId]) continue;

      const avgVolume = list.reduce((s, l) => s + l.volume, 0) / list.length;
      if (avgVolume <= volumeThreshold) continue;

      const timeSinceFirst = now - list[0].timestamp;
      if (timeSinceFirst < holdTime) continue;

      result.push({ inputId, avgVolume, levels: list });
    }

    return result;
  }

  /**
   * Para "una sola cámara hablando": la de mayor nivel que supere diferencia mínima respecto a la actual.
   */
  getBestSingleCamera(now, currentCameraId) {
    const cameras = this.getCamerasWithAudio(now);
    const { minVolumeDifference } = this.config.audio;
    let maxVolume = 0;
    let best = null;

    for (const { inputId, avgVolume, levels } of cameras) {
      if (currentCameraId != null) {
        const currentList = this.levels.get(currentCameraId) || [];
        const currentAvg =
          currentList.length > 0
            ? currentList.reduce((s, l) => s + l.volume, 0) / currentList.length
            : 0;
        if (avgVolume - currentAvg < minVolumeDifference) continue;
      }
      if (avgVolume > maxVolume) {
        maxVolume = avgVolume;
        best = { inputId, avgVolume, levels };
      }
    }

    return best;
  }

  /** Para logs: tiempo desde la última vez que alguien superó el umbral */
  getSilenceDuration(now) {
    return now - this.lastTimeAnyAudio;
  }
}
