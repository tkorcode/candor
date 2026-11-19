// A plain ustar archive of text files, so a reader downloads one file and runs `tar -xf` and `candor verify`.

const enc = new TextEncoder();

function header(name, size) {
  const h = new Uint8Array(512);
  const put = (text, at, len) => h.set(enc.encode(text).slice(0, len), at);
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  put(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const sum = h.reduce((a, b) => a + b, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

/** files: { "path/in/archive": "text" }. Returns a Blob of the archive. */
export function tar(files) {
  const parts = [];
  for (const [name, text] of Object.entries(files)) {
    const body = enc.encode(text);
    parts.push(header(name, body.length), body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: "application/x-tar" });
}
