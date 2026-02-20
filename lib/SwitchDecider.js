/**
 * Decide a qué cámara cortar según niveles de audio y reglas de negocio.
 * - Silencio prolongado → cámara amplia
 * - 2+ cámaras con audio → cámara amplia
 * - 1 cámara con audio → esa cámara
 */

export class SwitchDecider {
  /**
   * @param {object} config - CONFIG completo (audio, wideCameraId, silenceToWideMs, cameraMapping)
   */
  constructor(config) {
    this.config = config;
    this.wideId = config.wideCameraId;
    this.wideConfig =
      Number.isFinite(this.wideId) && config.cameraMapping[this.wideId];
  }

  /**
   * Decide si hay que hacer switch y a qué cámara.
   * Cooldown más corto cuando el destino es cámara amplia (multi/silencio).
   */
  decide(tracker, currentCameraId, now, lastSwitchTime) {
    const { cooldownTime, cooldownWideMs } = this.config.audio;
    const camerasWithAudio = tracker.getCamerasWithAudio(now);
    const silenceDuration = tracker.getSilenceDuration(now);

    let candidate = null;

    // Silencio → cámara amplia
    if (
      camerasWithAudio.length === 0 &&
      this.wideConfig &&
      currentCameraId !== this.wideId &&
      tracker.lastTimeAnyAudio > 0 &&
      silenceDuration >= this.config.silenceToWideMs
    ) {
      candidate = {
        switchTo: this.wideId,
        reason: 'silence',
        silenceDuration,
      };
    }

    // 2+ hablan → cámara amplia
    if (
      !candidate &&
      this.wideConfig &&
      camerasWithAudio.length >= 2 &&
      currentCameraId !== this.wideId
    ) {
      candidate = {
        switchTo: this.wideId,
        reason: 'multi',
        cameraNames: camerasWithAudio.map(
          (c) => this.config.cameraMapping[c.inputId]?.name
        ),
      };
    }

    // 1 cámara hablando (solo si realmente hay exactamente una con audio; si hay 2+ no considerar "single")
    if (!candidate && camerasWithAudio.length === 1) {
      const best = tracker.getBestSingleCamera(now, currentCameraId);
      if (
        best &&
        best.inputId !== currentCameraId &&
        best.inputId !== undefined &&
        best.inputId !== null
      ) {
        candidate = {
          switchTo: best.inputId,
          reason: 'single',
          avgVolume: best.avgVolume,
          levels: best.levels,
        };
      }
    }

    if (!candidate) return null;

    const isWide = candidate.reason === 'silence' || candidate.reason === 'multi';
    // Cooldown corto al ir a amplia (multi/silencio). Si estamos ya en amplia y queremos ir a una cámara (single), también cooldown corto para no bloquear el hold de 4s.
    const goingToSingleFromWide =
      currentCameraId === this.wideId && candidate.reason === 'single';
    const cooldown =
      isWide || goingToSingleFromWide
        ? (cooldownWideMs ?? 400)
        : cooldownTime;
    if (lastSwitchTime > 0 && now - lastSwitchTime < cooldown) {
      return null;
    }

    return candidate;
  }
}
