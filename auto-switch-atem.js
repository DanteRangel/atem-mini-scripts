#!/usr/bin/env node

/**
 * Auto-switch de cámaras en ATEM Mini Pro por audio (lavalieres en cámara).
 * Control directo del ATEM vía atem-connection; sin Companion.
 */

// Ocultar mensaje informativo de ThreadedClass (atem-connection)
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, enc, cb) => {
  const s = typeof chunk === 'string' ? chunk : (chunk && chunk.toString?.());
  if (s && /ThreadedClass.*Skipping exit handler/i.test(s)) return cb ? cb() : true;
  return stderrWrite(chunk, enc, cb);
};

import { Atem } from 'atem-connection';
import { selectATEMInteractively } from './discover-atem.js';
import { CONFIG } from './config.js';
import { parseFairlightLevels } from './lib/audio.js';
import { AudioLevelTracker } from './lib/AudioLevelTracker.js';
import { SwitchDecider } from './lib/SwitchDecider.js';

// ==================== CLASE PRINCIPAL ====================

class AtemAutoSwitch {
  constructor() {
    this.atem = null;
    this.currentCamera = null;
    this.lastSwitchTime = 0;
    this.isConnected = false;
    this.updateInterval = null;

    this.tracker = new AudioLevelTracker(CONFIG);
    this.decider = new SwitchDecider(CONFIG);
    /** Cambio pendiente: solo se ejecuta tras switchDelayMs si la decisión se mantiene */
    this.pendingSwitch = null;
    /** Estamos en plano: tiempo que lleva solo una persona hablando antes de permitir corte a su cámara */
    this.wideHoldSingleStartedAt = null;
    this.wideHoldSingleTargetId = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      console.log(`🔌 Conectando al ATEM en ${CONFIG.atemIp}...`);
      this.atem = new Atem();

      this.atem.on('connected', async () => {
        console.log('✅ Conectado al ATEM Mini Pro');
        this.isConnected = true;
        try {
          console.log('\n🔧 Habilitando niveles de audio en tiempo real...');
          await this.atem.startFairlightMixerSendLevels();
          console.log('✅ Niveles de audio habilitados\n');
        } catch (err) {
          console.error('❌ Error al habilitar niveles:', err.message);
        }
        this.printAtemInfo();
        resolve();
      });

      this.atem.on('disconnected', () => {
        console.log('⚠️  Desconectado del ATEM');
        this.isConnected = false;
      });

      this.atem.on('error', (err) => reject(err));
      this.atem.connect(CONFIG.atemIp);
    });
  }

  printAtemInfo() {
    if (!this.atem?.state) return;
    const s = this.atem.state;
    console.log(`   Modelo: ${s.info?.modelName || 'Desconocido'}`);
    console.log(`   Versión: ${s.info?.apiVersion || '?'}`);
    if (s.inputs) {
      console.log('\n📹 Inputs:');
      Object.values(s.inputs).forEach((inp) => {
        const id = inp.inputId ?? inp.index;
        const name = inp.shortName || inp.longName || `Input ${id}`;
        console.log(`   ${id}: ${name}`);
      });
    }
    if (s.fairlight?.inputs) {
      console.log(`\n📊 Fairlight: ${Object.keys(s.fairlight.inputs).length} inputs de audio`);
    }
    console.log('');
  }

  startMonitoring() {
    const { audio, detection, wideCameraId, silenceToWideMs } = CONFIG;
    console.log('🎤 Monitoreo de audio');
    console.log(`   Rango dB: ${audio.minDb} a ${audio.maxDb}`);
    console.log(`   Umbral: ${(audio.volumeThreshold * 100).toFixed(1)}%`);
    console.log(`   Hold: ${audio.holdTime}ms | Cooldown: ${audio.cooldownTime}ms (amplia: ${audio.cooldownWideMs ?? 400}ms)`);
    console.log(`   Delay corte: ${audio.switchDelayMs}ms (amplia: ${audio.switchDelayWideMs ?? 300}ms)`);
    const wideHold = audio.wideHoldBeforeSingleMs ?? 0;
    if (wideHold > 0) {
      console.log(`   Plano: esperar ${(wideHold / 1000).toFixed(1)}s con 1 hablante antes de cortar a cámara`);
    }
    if (CONFIG.cameraMapping[wideCameraId]) {
      console.log(`   Amplia: ${CONFIG.cameraMapping[wideCameraId].name} (silencio >${silenceToWideMs / 1000}s o 2+ hablan)`);
    }
    console.log(`   Intervalo: ${detection.updateInterval}ms\n`);
    this.tracker.lastTimeAnyAudio = Date.now();

    this.setupLevelListeners();
    this.updateInterval = setInterval(() => {
      this.updateAudioLevelsFromState();
      this.evaluateSwitch();
    }, detection.updateInterval);
    this.startPeriodicLogging();
  }

  setupLevelListeners() {
    const { minDb, maxDb } = CONFIG.audio;

    const processLevel = (inputIndex, props) => {
      if (inputIndex <= 0 || !props) return;
      const { db, normalized } = parseFairlightLevels(props, minDb, maxDb);
      this.tracker.store(inputIndex, normalized, db, props);
      if (CONFIG.debug) {
        const name = CONFIG.cameraMapping[inputIndex]?.name || `Input ${inputIndex}`;
        const dbStr = Number.isFinite(db) ? `${db.toFixed(1)} dB` : '-∞ dB';
        const pct = normalized > 0 ? `${(normalized * 100).toFixed(1)}%` : '0%';
        console.log(`🎧 ${name}: ${pct} (${dbStr})`);
      }
      this.evaluateSwitch();
    };

    this.atem.on('levelChanged', (payload) => {
      if (payload?.system === 'fairlight' && payload?.type === 'source' && payload?.levels) {
        try {
          processLevel(payload.index, payload.levels);
        } catch (e) {
          if (CONFIG.debug) console.error('levelChanged:', e);
        }
      }
    });

    this.atem.on('receivedCommands', (commands) => {
      if (!Array.isArray(commands)) return;
      for (const cmd of commands) {
        const isFmlv =
          cmd.constructor?.rawName === 'FMLv' ||
          cmd.constructor?.name === 'FairlightMixerSourceLevelsUpdateCommand';
        if (isFmlv && cmd.properties && cmd.index !== undefined) {
          try {
            processLevel(cmd.index, cmd.properties);
          } catch (e) {
            if (CONFIG.debug) console.error('FMLv:', e);
          }
        }
      }
    });

    this.atem.on('stateChanged', (_state, path) => {
      if (path.includes('fairlight') || path.includes('audio') || path.includes('level')) {
        this.updateAudioLevelsFromState();
      }
    });
  }

  updateAudioLevelsFromState() {
    if (!this.atem?.state?.fairlight?.inputs) return;
    const fairlightInputs = this.atem.state.fairlight.inputs;
    const { minDb, maxDb } = CONFIG.audio;

    for (const inputId of Object.keys(CONFIG.cameraMapping)) {
      const inputNum = parseInt(inputId, 10);
      const fi = fairlightInputs[inputNum];
      if (!fi) continue;

      let rawLevel = 0;
      const src = fi.sources && Object.values(fi.sources)[0];
      if (src?.peakLevels?.length) {
        rawLevel = Math.max(...src.peakLevels);
      } else if (src?.peakLevel != null) {
        rawLevel = src.peakLevel;
      } else if (fi.peakLevels?.length) {
        rawLevel = Math.max(...fi.peakLevels);
      } else if (fi.peakLevel != null) {
        rawLevel = fi.peakLevel;
      }

      let normalized = 0;
      let db = -Infinity;
      if (typeof rawLevel === 'number' && rawLevel !== 0) {
        if (rawLevel < 0) {
          db = rawLevel;
          const min = rawLevel < -60 ? -100 : -60;
          normalized = Math.max(0, Math.min(1, (rawLevel - min) / -min));
        } else if (rawLevel <= 1) {
          normalized = rawLevel;
          db = normalized > 0 ? 20 * Math.log10(normalized) : -Infinity;
        } else if (rawLevel <= 100) {
          normalized = rawLevel / 100;
          db = normalized > 0 ? 20 * Math.log10(normalized) : -Infinity;
        } else {
          normalized = Math.min(1, rawLevel / 65535);
          db = normalized > 0 ? -60 + normalized * 60 : -Infinity;
        }
      }
      this.tracker.store(inputNum, normalized, db, rawLevel);
    }
  }

  evaluateSwitch() {
    if (!this.isConnected) return;
    const now = Date.now();
    const wideId = CONFIG.wideCameraId;
    const wideHoldMs = CONFIG.audio.wideHoldBeforeSingleMs ?? 0;

    const decision = this.decider.decide(
      this.tracker,
      this.currentCamera,
      now,
      this.lastSwitchTime
    );

    if (!decision?.switchTo) {
      this.pendingSwitch = null;
      // No reiniciar el hold del plano cuando estamos en cámara amplia y hay un flicker (null): así el contador de 4s puede completarse
      if (this.currentCamera !== wideId) {
        this.wideHoldSingleStartedAt = null;
        this.wideHoldSingleTargetId = null;
      }
      return;
    }

    const switchTo = decision.switchTo;
    if (switchTo === this.currentCamera) {
      this.pendingSwitch = null;
      this.wideHoldSingleStartedAt = null;
      this.wideHoldSingleTargetId = null;
      return;
    }

    // Estamos en plano amplio y quieren cortar a una sola persona: esperar wideHoldBeforeSingleMs antes de permitir el corte.
    // No reiniciar el contador cuando solo cambia qué cámara es "la que habla" (flicker); solo reiniciar si hay 2+ hablando o silencio.
    const onWide = this.currentCamera === wideId;
    const toSingle = decision.reason === 'single';
    if (onWide && toSingle && wideHoldMs > 0) {
      if (this.wideHoldSingleStartedAt == null) {
        this.wideHoldSingleStartedAt = now;
        this.wideHoldSingleTargetId = switchTo;
        const name = CONFIG.cameraMapping[switchTo]?.name || switchTo;
        const delaySingle = CONFIG.audio.switchDelayMs ?? 800;
        if (CONFIG.debug) {
          console.log(`   [timing] Plano: cortar a "${name}" en ${(wideHoldMs / 1000).toFixed(1)}s + ${delaySingle}ms`);
        }
      }
      const holdElapsed = now - this.wideHoldSingleStartedAt;
      if (holdElapsed < wideHoldMs) {
        this.pendingSwitch = null;
        return;
      }
    } else {
      this.wideHoldSingleStartedAt = null;
      this.wideHoldSingleTargetId = null;
    }

    const isWide = decision.reason === 'multi' || decision.reason === 'silence';
    const switchDelayMs = isWide
      ? (CONFIG.audio.switchDelayWideMs ?? 300)
      : (CONFIG.audio.switchDelayMs ?? 800);

    if (switchDelayMs <= 0) {
      this.switchToCamera(switchTo, decision);
      return;
    }

    if (!this.pendingSwitch || this.pendingSwitch.targetId !== switchTo) {
      this.pendingSwitch = { targetId: switchTo, decision, scheduledAt: now };
      return;
    }

    const elapsed = now - this.pendingSwitch.scheduledAt;
    if (elapsed < switchDelayMs) {
      if (CONFIG.debug && (!this._lastDelayLog || now - this._lastDelayLog > 600)) {
        this._lastDelayLog = now;
        console.log(`   [debug] Esperando: ${elapsed}/${switchDelayMs}ms`);
      }
      return;
    }

    this.switchToCamera(
      this.pendingSwitch.targetId,
      this.pendingSwitch.decision,
      switchDelayMs
    );
    this.pendingSwitch = null;
    this._lastDelayLog = 0;
  }

  async switchToCamera(inputId, decision = null, delayMs = null) {
    const id = Number(inputId);
    const cameraConfig = CONFIG.cameraMapping[id];
    if (!cameraConfig) {
      console.warn(`Input ${id} no configurado`);
      return;
    }
    if (!this.atem || !this.isConnected) {
      console.error('❌ Sin conexión ATEM');
      return;
    }

    try {
      let actualId = id;
      const state = this.atem.state;
      if (state?.inputs) {
        const entry = state.inputs[id] ?? state.inputs[String(id)];
        if (entry?.inputId !== undefined) actualId = entry.inputId;
      }
      actualId = Number(actualId);

      // Enviar comando al ATEM (fire-and-forget; el corte se aplica cuando el ATEM responde)
      this.currentCamera = id;
      this.lastSwitchTime = Date.now();
      const reasonText = this._reasonToText(decision);
      console.log(`✅ ${cameraConfig.name}${reasonText}`);
      if (CONFIG.debug && delayMs != null) {
        console.log(`   [timing] delay ${delayMs}ms`);
      }

      const doCut = async () => {
        const t0 = Date.now();
        if (CONFIG.debug) {
          console.log(`   [ATEM] → changeProgramInput(${actualId}) "${cameraConfig.name}"`);
        }
        try {
          if (CONFIG.transition.type === 'cut') {
            await this.atem.changeProgramInput(actualId);
          } else {
            await this.atem.changePreviewInput(actualId);
            await this.atem.autoTransition();
          }
          const ms = Date.now() - t0;
          if (CONFIG.debug) {
            console.log(`   [ATEM] ← ack en ${ms}ms`);
          }
        } catch (err) {
          console.error(`❌ Error al cambiar a ${cameraConfig.name}:`, err.message);
        }
      };
      doCut();
    } catch (err) {
      console.error(`❌ Error al cambiar a ${cameraConfig.name}:`, err.message);
    }
  }

  _reasonToText(decision) {
    if (!decision?.reason) return '';
    const { reason } = decision;
    if (reason === 'silence') {
      const s = (decision.silenceDuration / 1000).toFixed(1);
      return ` (silencio ${s}s)`;
    }
    if (reason === 'multi') {
      const names = (decision.cameraNames || []).join(', ');
      return ` (2+ hablan: ${names})`;
    }
    if (reason === 'single') return ' (1 cámara habla)';
    return '';
  }

  startPeriodicLogging() {
    setInterval(() => {
      if (!this.isConnected || !CONFIG.debug) return;
      const lines = [];
      for (const [inputId, list] of this.tracker.levels) {
        const cfg = CONFIG.cameraMapping[Number(inputId)];
        if (!cfg || list.length === 0) continue;
        const avg = list.reduce((s, l) => s + l.volume, 0) / list.length;
        const latestDb = list[list.length - 1]?.db ?? -Infinity;
        const dbStr = Number.isFinite(latestDb) ? `${latestDb.toFixed(1)} dB` : '-∞ dB';
        const mark = Number(inputId) === this.currentCamera ? '▶' : ' ';
        const active = avg > CONFIG.audio.volumeThreshold ? ' 🔊' : '';
        lines.push(`${mark} ${cfg.name}: ${(avg * 100).toFixed(1)}% | ${dbStr}${active}`);
      }
      if (lines.length) {
        console.log(`[${new Date().toLocaleTimeString()}] 📊`);
        lines.forEach((l) => console.log(`   ${l}`));
      }
    }, 1000);
  }

  stop() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.atem) this.atem.disconnect();
  }
}

// ==================== MAIN ====================

async function main() {
  console.log('🚀 Auto-Switch ATEM Mini Pro (audio)');
  console.log('='.repeat(50));

  let atemIp = CONFIG.atemIp;
  if (!atemIp) {
    console.log('\n🔍 Buscando ATEM en la red (IP automática)...\n');
    atemIp = await selectATEMInteractively();
    if (!atemIp) {
      console.error('❌ No se encontró ATEM. Conéctalo a la red o usa: ATEM_IP=192.168.x.x npm start');
      process.exit(1);
    }
  }
  console.log(`\n📍 ATEM: ${atemIp}`);
  CONFIG.atemIp = atemIp;

  const app = new AtemAutoSwitch();
  try {
    await app.connect();
    await new Promise((r) => setTimeout(r, 500));
    app.printAtemInfo();
    app.startMonitoring();
  } catch (err) {
    console.error('\n❌ Conexión fallida:', err.message);
    console.error('   Comprueba IP, red y puerto 9910.');
    process.exit(1);
  }

  console.log('='.repeat(50));
  console.log('✅ En marcha. Ctrl+C para salir.\n');

  process.on('SIGINT', () => {
    console.log('\n🛑 Cerrando...');
    app.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
