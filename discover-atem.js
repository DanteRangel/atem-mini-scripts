#!/usr/bin/env node

import dgram from 'dgram';
import readline from 'readline';
import os from 'os';

/**
 * Descubrimiento automático de dispositivos ATEM en la red
 * Similar a como lo hace Companion
 */

const ATEM_DISCOVERY_PORT = 20595;
const DISCOVERY_TIMEOUT = 5000; // 5 segundos (aumentado)

/**
 * Descubre dispositivos ATEM en la red local
 * @returns {Promise<Array<{ip: string, model: string, name: string}>>}
 */
export async function discoverATEMs() {
  return new Promise((resolve) => {
    const devices = new Map();
    const socket = dgram.createSocket('udp4');
    
    socket.on('message', (msg, rinfo) => {
      try {
        // Parsear respuesta del ATEM
        // El formato puede variar, intentamos múltiples métodos
        let model = 'ATEM';
        let name = '';
        
        // Intentar leer el nombre del modelo (posición variable según firmware)
        if (msg.length > 0x50) {
          const modelBytes = msg.slice(0x50, 0x58);
          const modelStr = modelBytes.toString('utf8').replace(/\0/g, '').trim();
          if (modelStr && modelStr.length > 0) {
            model = modelStr;
          }
        }
        
        // Intentar leer el nombre del dispositivo
        if (msg.length > 0x40) {
          const nameBytes = msg.slice(0x40, 0x50);
          const nameStr = nameBytes.toString('utf8').replace(/\0/g, '').trim();
          if (nameStr && nameStr.length > 0) {
            name = nameStr;
          }
        }
        
        // Almacenar dispositivo (usar IP como clave única)
        if (!devices.has(rinfo.address)) {
          devices.set(rinfo.address, {
            ip: rinfo.address,
            model: model || 'ATEM',
            name: name || `ATEM ${rinfo.address}`,
            port: rinfo.port
          });
        }
      } catch (error) {
        // Ignorar errores de parsing, pero registrar dispositivo por IP
        if (!devices.has(rinfo.address)) {
          devices.set(rinfo.address, {
            ip: rinfo.address,
            model: 'ATEM',
            name: `ATEM ${rinfo.address}`,
            port: rinfo.port
          });
        }
      }
    });
    
    socket.on('error', (error) => {
      // Ignorar errores de red, continuar con lo que encontramos
      if (process.env.DEBUG === 'true') {
        console.error('Error en descubrimiento:', error.message);
      }
    });
    
    socket.bind(() => {
      socket.setBroadcast(true);
      
      // Paquete de descubrimiento ATEM
      // Este es el formato estándar que usa el protocolo ATEM
      const discoveryPacket = Buffer.from([
        0x10, 0x14, 0x53, 0xAB, // Header ATEM
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x01, 0x00
      ]);
      
      // Obtener direcciones de broadcast comunes
      const broadcastAddresses = getBroadcastAddresses();
      
      // Enviar paquete de descubrimiento a todas las interfaces de red
      if (process.env.DEBUG === 'true') {
        console.log(`📡 Enviando paquetes de descubrimiento a ${broadcastAddresses.length} direcciones...`);
      }
      
      broadcastAddresses.forEach((addr) => {
        try {
          socket.send(discoveryPacket, 0, discoveryPacket.length, ATEM_DISCOVERY_PORT, addr, (err) => {
            if (err && process.env.DEBUG === 'true') {
              console.error(`Error enviando a ${addr}:`, err.message);
            }
          });
        } catch (error) {
          // Continuar con otras direcciones
        }
      });
      
      if (process.env.DEBUG === 'true') {
        console.log(`⏳ Esperando respuestas por ${DISCOVERY_TIMEOUT}ms...`);
      }
      
      // Esperar respuestas
      setTimeout(() => {
        socket.close();
        const foundDevices = Array.from(devices.values());
        if (process.env.DEBUG === 'true') {
          console.log(`📊 Descubrimiento completado. Dispositivos encontrados: ${foundDevices.length}`);
        }
        resolve(foundDevices);
      }, DISCOVERY_TIMEOUT);
    });
  });
}

/**
 * Obtiene direcciones de broadcast comunes en la red local
 */
function getBroadcastAddresses() {
  const addresses = [];
  
  // Direcciones de broadcast comunes
  const commonRanges = [
    '192.168.1.255',
    '192.168.0.255',
    '192.168.2.255',
    '10.0.0.255',
    '10.0.1.255',
    '172.16.0.255',
    '172.17.0.255',
  ];
  
  // Intentar obtener la IP local y calcular broadcast
  try {
    const interfaces = os.networkInterfaces();
    
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const ipParts = iface.address.split('.');
          if (ipParts.length === 4) {
            const broadcast = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.255`;
            if (!addresses.includes(broadcast)) {
              addresses.push(broadcast);
            }
          }
        }
      }
    }
  } catch (error) {
    // Si falla, usar direcciones comunes
  }
  
  // Agregar direcciones comunes si no están ya incluidas
  commonRanges.forEach(addr => {
    if (!addresses.includes(addr)) {
      addresses.push(addr);
    }
  });
  
  return addresses;
}

/**
 * Interfaz interactiva para seleccionar un ATEM de la lista
 */
export async function selectATEMInteractively() {
  console.log('🔍 Buscando dispositivos ATEM en la red...\n');
  
  const devices = await discoverATEMs();
  
  if (devices.length === 0) {
    console.log('❌ No se encontraron dispositivos ATEM en la red');
    console.log('\n💡 Verifica que:');
    console.log('   - El ATEM esté encendido');
    console.log('   - Esté conectado a la red (Ethernet o Wi-Fi)');
    console.log('   - Esté en la misma red que tu computadora');
    console.log('   - No haya firewall bloqueando el puerto UDP 20595');
    console.log('\n   Puedes especificar la IP manualmente con:');
    console.log('   export ATEM_IP="192.168.1.XXX"');
    
    // Ofrecer ingresar IP manualmente
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      rl.question('\n¿Conoces la IP del ATEM? Ingrésala ahora (o presiona Enter para cancelar): ', (answer) => {
        rl.close();
        const ip = answer.trim();
        if (ip && ip.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
          console.log(`\n✅ Usando IP manual: ${ip}`);
          resolve(ip);
        } else if (ip) {
          console.log('❌ IP inválida');
          resolve(null);
        } else {
          resolve(null);
        }
      });
    });
  }
  
  console.log(`✅ Se encontraron ${devices.length} dispositivo(s) ATEM:\n`);
  devices.forEach((device, index) => {
    console.log(`  ${index + 1}. ${device.name} (${device.model})`);
    console.log(`     IP: ${device.ip}`);
  });
  
  // Si solo hay uno, usarlo automáticamente
  if (devices.length === 1) {
    console.log(`\n✅ Usando automáticamente: ${devices[0].name} (${devices[0].ip})`);
    return devices[0].ip;
  }
  
  // Si hay múltiples, preguntar al usuario
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(`\nSelecciona el número del dispositivo (1-${devices.length}): `, (answer) => {
      rl.close();
      const index = parseInt(answer) - 1;
      
      if (index >= 0 && index < devices.length) {
        const selected = devices[index];
        console.log(`\n✅ Seleccionado: ${selected.name} (${selected.ip})`);
        resolve(selected.ip);
      } else {
        console.log('❌ Selección inválida');
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

