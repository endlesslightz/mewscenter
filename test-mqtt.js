const net = require("net");

const BROKER = "broker.emqx.io";
const PORT = 1883;
const DEVICE_ID = "2504d4e4-f883-4012-af05-ffcade7aa012";
const TOPIC_DATA = `iot/devices/${DEVICE_ID}/data`;
const TOPIC_STATUS = `iot/devices/${DEVICE_ID}/status`;

const CLIENT_ID = `mews-check-${Math.random().toString(16).slice(2, 10)}`;
const KEEP_ALIVE_SEC = 60;

function encodeString(str) {
  const buf = Buffer.from(str, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function encodeRemainingLength(length) {
  const bytes = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return Buffer.from(bytes);
}

function buildConnectPacket(clientId, keepAliveSec) {
  const variableHeader = Buffer.concat([
    encodeString("MQTT"),
    Buffer.from([0x04, 0x02]), // MQTT 3.1.1, Clean Session
    Buffer.from([(keepAliveSec >> 8) & 0xff, keepAliveSec & 0xff]),
  ]);
  const payload = encodeString(clientId);
  const remaining = Buffer.concat([variableHeader, payload]);
  return Buffer.concat([
    Buffer.from([0x10]),
    encodeRemainingLength(remaining.length),
    remaining,
  ]);
}

function buildSubscribePacket(packetId, topics) {
  const variableHeader = Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]);
  const payloadParts = topics.map((topic) =>
    Buffer.concat([encodeString(topic), Buffer.from([0x00])])
  );
  const remaining = Buffer.concat([variableHeader, ...payloadParts]);
  return Buffer.concat([
    Buffer.from([0x82]),
    encodeRemainingLength(remaining.length),
    remaining,
  ]);
}

function decodeRemainingLength(buffer, offset) {
  let multiplier = 1;
  let value = 0;
  let bytesRead = 0;
  while (true) {
    if (offset + bytesRead >= buffer.length) return null;
    const encodedByte = buffer[offset + bytesRead];
    bytesRead++;
    value += (encodedByte & 127) * multiplier;
    if ((encodedByte & 128) === 0) break;
    multiplier *= 128;
    if (bytesRead > 4) throw new Error("Malformed Remaining Length");
  }
  return { value, bytesRead };
}

function formatPayload(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

console.log(`Menghubungkan ke ${BROKER}:${PORT} ...`);
console.log(`Client ID : ${CLIENT_ID}`);
console.log(`Topics    :\n  - ${TOPIC_DATA}\n  - ${TOPIC_STATUS}\n`);

const socket = net.createConnection({ host: BROKER, port: PORT });
let recvBuffer = Buffer.alloc(0);
let pingTimer = null;

socket.on("connect", () => {
  console.log("[TCP] Terhubung ke broker, mengirim paket MQTT CONNECT...");
  socket.write(buildConnectPacket(CLIENT_ID, KEEP_ALIVE_SEC));
});

socket.on("data", (chunk) => {
  recvBuffer = Buffer.concat([recvBuffer, chunk]);

  while (recvBuffer.length >= 2) {
    const header = recvBuffer[0];
    const packetType = header & 0xf0;
    const rem = decodeRemainingLength(recvBuffer, 1);
    if (!rem) break;

    const totalLen = 1 + rem.bytesRead + rem.value;
    if (recvBuffer.length < totalLen) break;

    const body = recvBuffer.subarray(1 + rem.bytesRead, totalLen);
    recvBuffer = recvBuffer.subarray(totalLen);

    if (packetType === 0x20) {
      // CONNACK
      const returnCode = body[1];
      if (returnCode === 0x00) {
        console.log("[MQTT] Terhubung! (CONNACK OK)");
        console.log("[MQTT] Melakukan subscribe ke topik...");
        socket.write(buildSubscribePacket(1, [TOPIC_DATA, TOPIC_STATUS]));

        pingTimer = setInterval(() => {
          if (!socket.destroyed) {
            socket.write(Buffer.from([0xc0, 0x00])); // PINGREQ
          }
        }, 30000);
      } else {
        console.error(`[MQTT] Koneksi ditolak, return code: ${returnCode}`);
        socket.end();
      }
    } else if (packetType === 0x90) {
      // SUBACK
      const codes = [...body.subarray(2)];
      console.log(`[MQTT] Subscribe berhasil (SUBACK codes: ${codes.join(", ")})`);
      console.log("Menunggu pesan masuk... (Tekan Ctrl+C untuk berhenti)\n");
    } else if (packetType === 0x30) {
      // PUBLISH
      const qos = (header >> 1) & 0x03;
      const topicLen = body.readUInt16BE(0);
      let pos = 2;
      const topic = body.subarray(pos, pos + topicLen).toString("utf8");
      pos += topicLen;

      if (qos > 0) {
        const packetId = body.readUInt16BE(pos);
        pos += 2;
        if (qos === 1) {
          socket.write(
            Buffer.from([0x40, 0x02, (packetId >> 8) & 0xff, packetId & 0xff])
          );
        }
      }

      const payload = body.subarray(pos).toString("utf8");
      const time = new Date().toLocaleTimeString();
      console.log(`=== PESAN MASUK [${time}] ===`);
      console.log(`Topic  : ${topic}`);
      console.log(`Pesan  :\n${formatPayload(payload)}\n`);
    }
  }
});

socket.on("error", (err) => {
  console.error(`[ERROR] ${err.message}`);
});

socket.on("close", () => {
  if (pingTimer) clearInterval(pingTimer);
  console.log("[TCP] Koneksi ditutup.");
});
