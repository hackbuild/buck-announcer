// Getting a line to BUCK. CLASP over WebSocket first (wss://relay.clasp.to),
// MQTT over TCP (relay.clasp.chat:1883) if that fails. BUCK listens on both, so
// one is enough; sending on both would make it speak twice.
//
// Each path ends with a ping and waits for the pong. The relay answers in order,
// so the pong means it has already routed the line.

import { connect } from "cloudflare:sockets";

const enc = new TextEncoder();

function str16(s: string): Uint8Array {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ------------------------------------------------------------------ CLASP

function claspFrame(payload: Uint8Array, qos = 1): Uint8Array {
  return concat([0x53, (qos << 6) | 0x01, payload.length >> 8, payload.length & 0xff], payload);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);
}

export async function sayViaClasp(url: string, address: string, text: string): Promise<void> {
  const resp = await fetch(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "clasp" },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`relay refused the WebSocket (${resp.status})`);
  ws.accept();

  // Message types we wait for: 0x02 WELCOME, 0x42 PONG, 0x51 ERROR.
  const waiters = new Map<number, () => void>();
  let failed: Error | null = null;
  const onFrame = (f: Uint8Array) => {
    if (f.length < 5 || f[0] !== 0x53) return;
    const type = f[f[1] & 0x20 ? 12 : 4];
    if (type === 0x51) failed = new Error("relay sent an error");
    waiters.get(type)?.();
  };
  ws.addEventListener("message", (ev) => {
    // Binary messages arrive as a Blob on current compatibility dates and as an
    // ArrayBuffer on older ones; text frames are not CLASP.
    const d = ev.data as unknown;
    if (d instanceof ArrayBuffer) onFrame(new Uint8Array(d));
    else if (d instanceof Blob) d.arrayBuffer().then((b) => onFrame(new Uint8Array(b)));
  });
  const next = (type: number) => new Promise<void>((resolve) => waiters.set(type, resolve));

  try {
    const welcome = next(0x02);
    ws.send(claspFrame(concat([0x01, 1, 0xe0], str16("buck-announcer"), str16(""))));
    await withTimeout(welcome, 8000, "WELCOME");

    const pong = next(0x42);
    // PUBLISH, signal event, value present, string
    ws.send(claspFrame(concat([0x20, 0x20], str16(address), [0x01, 0x08], str16(text))));
    ws.send(claspFrame(new Uint8Array([0x41]), 0)); // PING
    await withTimeout(pong, 8000, "PONG");
    if (failed) throw failed;
  } finally {
    try {
      ws.close(1000, "done");
    } catch {
      // already closed
    }
  }
}

// ------------------------------------------------------------------ MQTT

function remainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function mqttPacket(first: number, body: Uint8Array): Uint8Array {
  return concat([first], remainingLength(body.length), body);
}

export async function sayViaMqtt(host: string, port: number, topic: string, text: string): Promise<void> {
  const socket = connect({ hostname: host, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let buf: Uint8Array = new Uint8Array(0);

  // Reads until `want` bytes starting with `first` have arrived; returns them.
  async function expect(first: number, want: number, what: string): Promise<Uint8Array> {
    const read = async (): Promise<Uint8Array> => {
      for (;;) {
        const at = buf.indexOf(first);
        if (at >= 0 && buf.length - at >= want) {
          const packet = buf.slice(at, at + want);
          buf = buf.slice(at + want);
          return packet;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error(`broker closed before ${what}`);
        buf = concat(buf, value);
      }
    };
    return withTimeout(read(), 8000, what);
  }

  try {
    const id = `buck-announcer-${Date.now().toString(36)}`;
    await writer.write(mqttPacket(0x10, concat(str16("MQTT"), [4, 0x02, 0, 30], str16(id))));
    const ack = await expect(0x20, 4, "CONNACK");
    if (ack[3] !== 0) throw new Error(`broker refused the connection (code ${ack[3]})`);
    await writer.write(mqttPacket(0x30, concat(str16(topic), enc.encode(text))));
    await writer.write(new Uint8Array([0xc0, 0x00])); // PINGREQ
    await expect(0xd0, 2, "PINGRESP");
    await writer.write(new Uint8Array([0xe0, 0x00])); // DISCONNECT
  } finally {
    await socket.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ either

export interface Target {
  claspUrl: string;
  mqttHost: string;
  mqttPort: number;
  buckId: string;
}

/**
 * Sends one line. Returns which door delivered it, with the reason the first
 * door failed when the second one was used; throws if neither delivered.
 */
export async function say(t: Target, text: string): Promise<string> {
  const errors: string[] = [];
  if (t.claspUrl) {
    try {
      await sayViaClasp(t.claspUrl, `/hackbuild/buck/${t.buckId}/say`, text);
      return "clasp";
    } catch (e) {
      errors.push(`clasp: ${(e as Error).message}`);
    }
  }
  if (t.mqttHost) {
    try {
      await sayViaMqtt(t.mqttHost, t.mqttPort, `hackbuild/buck/${t.buckId}/say`, text);
      return errors.length ? `mqtt (${errors.join("; ")})` : "mqtt";
    } catch (e) {
      errors.push(`mqtt: ${(e as Error).message}`);
    }
  }
  throw new Error(errors.join("; ") || "no relay configured");
}
