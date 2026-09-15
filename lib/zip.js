(() => {
  const ROOT = typeof globalThis !== "undefined" ? globalThis : window;
  const api = (ROOT.PplxExport = ROOT.PplxExport || {});

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(n) {
    return new Uint8Array([n & 255, (n >>> 8) & 255]);
  }

  function u32(n) {
    return new Uint8Array([
      n & 255,
      (n >>> 8) & 255,
      (n >>> 16) & 255,
      (n >>> 24) & 255,
    ]);
  }

  function concat(parts) {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function encodeUtf8(text) {
    return new TextEncoder().encode(text);
  }

  /**
   * Build an uncompressed (STORE) ZIP from text files.
   * @param {{ name: string, content: string }[]} files
   * @returns {Uint8Array}
   */
  function createZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    files.forEach((file) => {
      const name = String(file.name || "file.txt").replace(/^\/+/, "");
      const nameBytes = encodeUtf8(name);
      const data = encodeUtf8(file.content ?? "");
      const checksum = crc32(data);
      const flags = 0x0800; // UTF-8

      const localHeader = concat([
        u32(0x04034b50),
        u16(20),
        u16(flags),
        u16(0), // store
        u16(0),
        u16(0),
        u32(checksum),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
      ]);

      const centralHeader = concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(flags),
        u16(0),
        u16(0),
        u16(0),
        u32(checksum),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]);

      localParts.push(localHeader, data);
      centralParts.push(centralHeader);
      offset += localHeader.length + data.length;
    });

    const central = concat(centralParts);
    const end = concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(files.length),
      u16(files.length),
      u32(central.length),
      u32(offset),
      u16(0),
    ]);

    return concat([...localParts, central, end]);
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function zipToDataUrl(files) {
    const zip = createZip(files);
    return {
      bytes: zip,
      dataUrl: `data:application/zip;base64,${bytesToBase64(zip)}`,
      size: zip.length,
    };
  }

  api.createZip = createZip;
  api.zipToDataUrl = zipToDataUrl;
  api.bytesToBase64 = bytesToBase64;
  api.MAX_ZIP_DOWNLOAD_BYTES = 20 * 1024 * 1024; // ~20MB raw ZIP before base64 encoding
})();
