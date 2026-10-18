// Minimal protobuf wire format reader/writer, enough for the KoinDX and token messages this adapter reads.

export function decode(bytes) {
  const fields = new Map();
  let i = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= bytes.length) throw new Error('protobuf: truncated varint');
      const b = bytes[i++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 63n) throw new Error('protobuf: varint too long');
    }
  };
  while (i < bytes.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0) throw new Error('protobuf: field number 0');
    let value;
    if (wire === 0) {
      value = readVarint();
    } else if (wire === 2) {
      const len = Number(readVarint());
      if (i + len > bytes.length) throw new Error('protobuf: truncated length-delimited field');
      value = bytes.subarray(i, i + len);
      i += len;
    } else if (wire === 1 || wire === 5) {
      const len = wire === 1 ? 8 : 4;
      if (i + len > bytes.length) throw new Error('protobuf: truncated fixed field');
      value = bytes.subarray(i, i + len);
      i += len;
    } else {
      throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push({ wire, value });
  }
  return fields;
}

// proto3 scalar: the last occurrence wins, an absent field is the default value
const last = (fields, n) => {
  const list = fields.get(n);
  return list ? list[list.length - 1] : undefined;
};

export function getUint(fields, n) {
  const f = last(fields, n);
  if (!f) return 0n;
  if (f.wire !== 0) throw new Error(`protobuf: field ${n} is not a varint`);
  return f.value;
}

export function getBytes(fields, n) {
  const f = last(fields, n);
  if (!f) return new Uint8Array(0);
  if (f.wire !== 2) throw new Error(`protobuf: field ${n} is not length-delimited`);
  return f.value;
}

export function getString(fields, n) {
  return new TextDecoder('utf-8', { fatal: true }).decode(getBytes(fields, n));
}

const varint = (n) => {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};

// fields: [[fieldNumber, 'varint' | 'bytes', value], ...]
export function encode(fields) {
  const out = [];
  for (const [n, type, value] of fields) {
    if (type === 'varint') {
      out.push(...varint((BigInt(n) << 3n) | 0n), ...varint(value));
    } else if (type === 'bytes') {
      out.push(...varint((BigInt(n) << 3n) | 2n), ...varint(value.length), ...value);
    } else {
      throw new Error(`protobuf: unknown field type ${type}`);
    }
  }
  return Uint8Array.from(out);
}
