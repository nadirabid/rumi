/** Read-only Bambu printer telemetry over the printer's local MQTT endpoint. */

import { randomUUID } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'
import { mqttConnectPacket } from './probe.js'

/** MQTT remaining-length varint. */
function varint(value) {
  const bytes = []
  let length = value
  do {
    let byte = length % 128
    length = Math.floor(length / 128)
    if (length > 0) byte |= 0x80
    bytes.push(byte)
  } while (length > 0)
  return Buffer.from(bytes)
}

/** MQTT UTF-8 string field. */
function stringField(value) {
  const bytes = Buffer.from(value)
  return Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes])
}

/** One MQTT control packet with a fixed header byte and body. */
function packet(header, body) {
  return Buffer.concat([Buffer.from([header]), varint(body.length), body])
}

/** Publish one JSON command at QoS 0. */
function publishPacket(topic, value) {
  return packet(0x30, Buffer.concat([stringField(topic), Buffer.from(JSON.stringify(value))]))
}

/** Subscribe to one topic at QoS 0. */
function subscribePacket(topic, id = 1) {
  return packet(0x82, Buffer.concat([Buffer.from([id >> 8, id & 0xff]), stringField(topic), Buffer.from([0])]))
}

/** Read one MQTT remaining length. */
function readVarint(buffer, offset) {
  let value = 0
  let multiplier = 1
  let index = offset
  for (;;) {
    if (index >= buffer.length) return null
    const byte = buffer[index]
    value += (byte & 0x7f) * multiplier
    index += 1
    if ((byte & 0x80) === 0) return { value, next: index }
    multiplier *= 128
    if (multiplier > 128 ** 3) return null
  }
}

/**
 * Read one fresh printer report.
 * @param {{ host: string, accessCode: string, serial: string, timeoutMs?: number }} options
 * @returns {Promise<object>} sanitized print, AMS, and error state.
 */
export function readPrinterStatus(options) {
  const timeoutMs = options.timeoutMs ?? 8_000
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: options.host, port: 8883, rejectUnauthorized: false })
    let settled = false
    let buffer = Buffer.alloc(0)
    let subscribed = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error !== null) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Printer did not answer'), undefined), timeoutMs)
    socket.once('secureConnect', () => {
      socket.write(mqttConnectPacket(options.accessCode, `print-studio-${randomUUID().slice(0, 8)}`))
    })
    socket.once('error', error => finish(error, undefined))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const length = readVarint(buffer, 1)
        if (length === null) return
        const end = length.next + length.value
        if (buffer.length < end) return
        const type = buffer[0] >> 4
        const body = buffer.subarray(length.next, end)
        buffer = buffer.subarray(end)
        if (type === 2) {
          // CONNACK: subscribe and request a full status once.
          if (subscribed) continue
          subscribed = true
          socket.write(subscribePacket(`device/${options.serial}/report`))
          socket.write(publishPacket(`device/${options.serial}/request`, { pushing: { command: 'pushall' } }))
        } else if (type === 3 && body.length >= 2) {
          const topicLength = body.readUInt16BE(0)
          const payload = body.subarray(2 + topicLength)
          let message
          try { message = JSON.parse(payload.toString()) } catch { continue }
          if (message.print !== undefined) finish(null, sanitize(message.print))
        }
      }
    })
  })
}

/** Keep only fields the UI and the agent need. */
export function sanitize(print) {
  return {
    state: print.gcode_state ?? null,
    percent: print.mc_percent ?? null,
    remainingMinutes: print.mc_remaining_time ?? null,
    layer: print.layer_num ?? null,
    totalLayers: print.total_layer_num ?? null,
    job: print.subtask_name ?? null,
    printType: print.print_type ?? null,
    bedTemperature: print.bed_temper ?? null,
    nozzleTemperature: print.nozzle_temper ?? null,
    nozzleDiameter: print.nozzle_diameter ?? null,
    bedTarget: print.bed_target_temper ?? null,
    nozzleTarget: print.nozzle_target_temper ?? null,
    printError: print.print_error ?? null,
    failReason: print.fail_reason ?? null,
    hms: Array.isArray(print.hms) ? print.hms.map(entry => ({ code: entry.code, attr: entry.attr })) : [],
    ams: print.ams === undefined ? null : {
      trays: (print.ams.ams ?? []).flatMap(unit => (unit.tray ?? []).map(tray => ({
        id: tray.id, type: tray.tray_type ?? null, color: tray.tray_color ?? null, remain: tray.remain ?? null,
      }))),
      now: print.ams.tray_now ?? null,
      target: print.ams.tray_tar ?? null,
    },
  }
}
