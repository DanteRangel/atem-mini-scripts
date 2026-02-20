#!/usr/bin/env node

import dgram from 'dgram';
import readline from 'readline';
import os from 'os';
import multicastdns from 'multicast-dns';

/**
 * Descubrimiento automático de dispositivos ATEM en la red.
 * Companion usa Bonjour (mDNS) con el servicio _blackmagic._tcp; nosotros usamos
 * Bonjour primero (como Companion) y además UDP broadcast en puerto 20595.
 */

const ATEM_DISCOVERY_PORT = 20595;
const ATEM_CONTROL_PORT = 9910;
const BONJOUR_SERVICE = '_blackmagic._tcp.local';
const DISCOVERY_TIMEOUT = 5000; // 5 segundos
const PROBE_TIMEOUT_MS = 400;

/** Paquete "hello" que usa atem-connection para conectar (UDP 9910). */
const ATEM_HELLO = Buffer.from([
  0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * Descubre ATEM por Bonjour/mDNS en una interfaz (o la predeterminada).
 * Companion usa el Bonjour del sistema en todas las interfaces; nosotros lanzamos
 * una instancia por interfaz local para no perder respuestas.
 * @param {string|null} bindAddress - IP de la interfaz a la que atar mDNS (null = por defecto)
 * @returns {Promise<Array<{ip: string, model: string, name: string}>>}
 */
function discoverATEMsViaBonjourOnInterface(bindAddress = null) {
  return new Promise((resolve) => {
    const devices = new Map();
    const opts = bindAddress ? { bind: bindAddress } : {};
    const mdns = multicastdns(opts);

    const finish = () => {
      mdns.destroy();
      resolve(Array.from(devices.values()));
    };

    mdns.on('response', (response) => {
      let name = 'ATEM';
      const ips = new Set();
      const records = [...(response.answers || []), ...(response.additionals || [])];

      for (const r of records) {
        if (r.type === 'PTR' && r.name === BONJOUR_SERVICE && r.data) {
          const instance = String(r.data).replace(/\._blackmagic\._tcp\.local\.?$/i, '').trim();
          if (instance) name = instance;
        }
        if (r.type === 'A' && r.data) {
          const ip = String(r.data);
          if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) ips.add(ip);
        }
      }

      ips.forEach((ip) => {
        if (!devices.has(ip)) {
          devices.set(ip, { ip, model: name, name });
        }
      });
    });

    mdns.on('error', (err) => {
      if (process.env.DEBUG === 'true') console.error('Bonjour error:', err.message);
    });

    mdns.query(
      { questions: [{ name: BONJOUR_SERVICE, type: 'PTR', class: 'IN' }] },
      (err) => {
        if (err && process.env.DEBUG === 'true') console.error('Bonjour query error:', err.message);
      }
    );

    setTimeout(finish, DISCOVERY_TIMEOUT);
  });
}

/**
 * Prueba si en una IP hay un ATEM enviando el "hello" al puerto 9910.
 * Si responde, es un ATEM (aunque no aparezca por Bonjour).
 * @param {string} ip - ej. 192.168.68.111
 * @returns {Promise<boolean>}
 */
function probeATEMAt(ip) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let resolved = false;
    const done = (yes) => {
      if (resolved) return;
      resolved = true;
      try { socket.close(); } catch (_) {}
      resolve(yes);
    };

    let t = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    const clear = () => { if (t) clearTimeout(t); t = null; };

    socket.on('message', () => { clear(); done(true); });
    socket.on('error', () => { clear(); done(false); });

    socket.bind(() => {
      socket.send(ATEM_HELLO, 0, ATEM_HELLO.length, ATEM_CONTROL_PORT, ip, (err) => {
        if (err) done(false);
      });
    });
  });
}

/**
 * Por cada interfaz local (ej. 192.168.68.106), prueba IPs típicas en la misma subred
 * (ej. .111, .240) para encontrar ATEM que no respondan a Bonjour. Probes en paralelo.
 * @param {string[]} localIps - IPs de esta máquina
 * @returns {Promise<Array<{ip: string, model: string, name: string}>>}
 */
async function discoverATEMsViaProbe(localIps) {
  const lastOctets = [111, 240, 107, 102, 100, 101, 103, 50, 200, 1];
  const candidates = new Set();

  for (const local of localIps) {
    const parts = local.split('.');
    if (parts.length !== 4) continue;
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;
    for (const last of lastOctets) {
      const ip = `${prefix}${last}`;
      if (ip !== local) candidates.add(ip);
    }
  }

  const results = await Promise.all(
    [...candidates].map(async (ip) => ((await probeATEMAt(ip)) ? ip : null))
  );
  return results.filter(Boolean).map((ip) => ({ ip, model: 'ATEM', name: `ATEM ${ip}` }));
}

/**
 * Descubre ATEM por UDP broadcast (puerto 20595).
 * @returns {Promise<Array<{ip: string, model: string, name: string}>>}
 */
function discoverATEMsViaUDP() {
  return new Promise((resolve) => {
    const devices = new Map();
    const socket = dgram.createSocket('udp4');

    socket.on('message', (msg, rinfo) => {
      try {
        let model = 'ATEM';
        let name = '';
        if (msg.length > 0x50) {
          const modelStr = msg.slice(0x50, 0x58).toString('utf8').replace(/\0/g, '').trim();
          if (modelStr) model = modelStr;
        }
        if (msg.length > 0x40) {
          const nameStr = msg.slice(0x40, 0x50).toString('utf8').replace(/\0/g, '').trim();
          if (nameStr) name = nameStr;
        }
        if (!devices.has(rinfo.address)) {
          devices.set(rinfo.address, {
            ip: rinfo.address,
            model: model || 'ATEM',
            name: name || `ATEM ${rinfo.address}`,
          });
        }
      } catch (_) {
        if (!devices.has(rinfo.address)) {
          devices.set(rinfo.address, { ip: rinfo.address, model: 'ATEM', name: `ATEM ${rinfo.address}` });
        }
      }
    });

    socket.on('error', (err) => {
      if (process.env.DEBUG === 'true') console.error('UDP discovery error:', err.message);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      const discoveryPacket = Buffer.from([
        0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x01, 0x00,
      ]);
      const broadcastAddresses = getBroadcastAddresses();
      broadcastAddresses.forEach((addr) => {
        try {
          socket.send(discoveryPacket, 0, discoveryPacket.length, ATEM_DISCOVERY_PORT, addr, () => {});
        } catch (_) {}
      });
      setTimeout(() => {
        socket.close();
        resolve(Array.from(devices.values()));
      }, DISCOVERY_TIMEOUT);
    });
  });
}

/**
 * Descubre dispositivos ATEM en la red local.
 * - Bonjour en cada interfaz (como hace Companion en todas), UDP broadcast, y
 *   probe por subred (puerto 9910) para encontrar ATEM que no respondan a mDNS.
 * @returns {Promise<Array<{ip: string, model: string, name: string}>>}
 */
export async function discoverATEMs() {
  const localIps = getLocalIps();
  if (localIps.length > 0) {
    console.log(`🖥️  Esta máquina: ${localIps.join(', ')}`);
  }

  // Bonjour: una instancia por interfaz + una por defecto (por si no acepta bind)
  const bonjourPromises = [
    discoverATEMsViaBonjourOnInterface(null),
    ...localIps.map((ip) => discoverATEMsViaBonjourOnInterface(ip)),
  ];
  const [udpDevices, ...bonjourResults] = await Promise.all([
    discoverATEMsViaUDP(),
    ...bonjourPromises,
  ]);
  const bonjourDevices = bonjourResults.flat();
  const probeDevices = await discoverATEMsViaProbe(localIps);

  const byIp = new Map();
  for (const d of bonjourDevices) {
    byIp.set(d.ip, d);
  }
  for (const d of udpDevices) {
    if (!byIp.has(d.ip)) byIp.set(d.ip, d);
    else if ((d.model && d.model !== 'ATEM') || (d.name && !byIp.get(d.ip).name)) {
      byIp.set(d.ip, { ...byIp.get(d.ip), ...d });
    }
  }
  for (const d of probeDevices) {
    if (!byIp.has(d.ip)) byIp.set(d.ip, d);
  }

  const found = Array.from(byIp.values());
  if (process.env.DEBUG === 'true') {
    console.log(`📊 Bonjour: ${bonjourDevices.length}, UDP: ${udpDevices.length}, probe: ${probeDevices.length} → total: ${found.length}`);
  }
  return found;
}

/**
 * Obtiene las IP(s) locales de esta máquina (IPv4, no loopback).
 * @returns {string[]}
 */
function getLocalIps() {
  const ips = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && iface.address) {
          if (!ips.includes(iface.address)) ips.push(iface.address);
        }
      }
    }
  } catch (_) {}
  return ips;
}

/**
 * Obtiene direcciones de broadcast a partir de la IP local.
 * Solo busca en la(s) red(es) donde está esta máquina.
 */
function getBroadcastAddresses() {
  const addresses = [];

  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const addr = iface.address;
          const parts = addr.split('.');
          if (parts.length === 4) {
            const broadcast = `${parts[0]}.${parts[1]}.${parts[2]}.255`;
            if (!addresses.includes(broadcast)) {
              addresses.push(broadcast);
            }
          }
        }
      }
    }
  } catch (error) {
    if (process.env.DEBUG === 'true') {
      console.error('Error leyendo interfaces:', error.message);
    }
  }

  // Fallback solo si no hay ninguna interfaz IPv4 externa (ej. sin red)
  if (addresses.length === 0) {
    const fallback = ['192.168.1.255', '192.168.0.255', '10.0.0.255'];
    if (process.env.DEBUG === 'true') {
      console.log('Sin IP local; usando rangos de fallback:', fallback);
    }
    return fallback;
  }

  return addresses;
}

/**
 * Prefiere un ATEM Mini Pro cuando hay varios dispositivos
 */
function preferMiniPro(devices) {
  if (devices.length <= 1) return devices[0] || null;
  const miniPro = devices.find(
    (d) =>
      (d.model && /mini\s*pro/i.test(d.model)) ||
      (d.name && /mini\s*pro/i.test(d.name))
  );
  return miniPro || devices[0];
}

/**
 * Obtiene la IP del ATEM: descubre en la red y elige uno (Mini Pro si hay varios).
 * @param {boolean} interactive - si hay varios, preguntar (true) o usar el primero/Mini Pro (false)
 * @returns {Promise<string|null>} IP o null
 */
export async function getATEMIpAuto(interactive = true) {
  const devices = await discoverATEMs();
  if (devices.length === 0) return null;
  const chosen = preferMiniPro(devices);
  if (devices.length === 1 || !interactive) {
    return chosen ? chosen.ip : null;
  }
  return null; // varios y no interactivo: devolver null para que main() use selectATEMInteractively
}

/**
 * Interfaz interactiva para seleccionar un ATEM de la lista.
 * Si solo hay uno (o uno es Mini Pro entre varios), lo usa automáticamente.
 */
export async function selectATEMInteractively() {
  console.log('🔍 Buscando ATEM (Bonjour + UDP)...\n');
  const devices = await discoverATEMs();

  if (devices.length === 0) {
    console.log('❌ No se encontraron dispositivos ATEM');
    console.log('\n💡 Verifica: ATEM encendido, misma red que esta máquina.');
    console.log('   Companion usa Bonjour (_blackmagic._tcp); si Companion lo ve, prueba de nuevo.');
    console.log('   O especifica IP: ATEM_IP=192.168.x.x npm start\n');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question('¿Ingresar IP manualmente? (o Enter para cancelar): ', (answer) => {
        rl.close();
        const ip = answer.trim();
        if (ip && ip.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
          console.log(`\n✅ Usando IP: ${ip}`);
          resolve(ip);
        } else {
          resolve(null);
        }
      });
    });
  }

  console.log(`✅ Encontrados ${devices.length} ATEM:\n`);
  devices.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.name || d.model} (${d.model}) - ${d.ip}`);
  });

  const chosen = preferMiniPro(devices);
  if (devices.length === 1) {
    console.log(`\n✅ Usando: ${chosen.name} (${chosen.ip})\n`);
    return chosen.ip;
  }
  if (chosen && (chosen.model || '').toLowerCase().includes('mini')) {
    console.log(`\n✅ Usando ATEM Mini Pro: ${chosen.ip}\n`);
    return chosen.ip;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`\nElige número (1-${devices.length}): `, (answer) => {
      rl.close();
      const index = parseInt(answer, 10) - 1;
      if (index >= 0 && index < devices.length) {
        const selected = devices[index];
        console.log(`\n✅ ${selected.name} (${selected.ip})\n`);
        resolve(selected.ip);
      } else {
        resolve(null);
      }
    });
  });
}

// Si se ejecuta directamente, mostrar dispositivos encontrados
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1].includes('discover-atem.js')) {
  selectATEMInteractively().then((ip) => {
    if (ip) {
      console.log(`\n📝 Para usar este ATEM, ejecuta:`);
      console.log(`   export ATEM_IP="${ip}"`);
      console.log(`   npm run start:atem`);
    }
    process.exit(ip ? 0 : 1);
  });
}

