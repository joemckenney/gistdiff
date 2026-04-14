export function serializeError(err) {
  if (!err || typeof err !== "object") return { raw: String(err) };
  const out = { name: err.name, message: err.message, stack: err.stack };
  for (const key of Object.keys(err)) {
    if (key in out) continue;
    out[key] = safeClone(err[key]);
  }
  if (err.cause) out.cause = safeClone(err.cause);
  return out;
}

function safeClone(v, depth = 0) {
  if (depth > 6) return "[max-depth]";
  if (v === null || v === undefined) return v;
  if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
  if (v instanceof Error) {
    const o = { name: v.name, message: v.message, stack: v.stack };
    for (const k of Object.keys(v)) o[k] = safeClone(v[k], depth + 1);
    if (v.cause) o.cause = safeClone(v.cause, depth + 1);
    return o;
  }
  if (Array.isArray(v)) return v.map((x) => safeClone(x, depth + 1));
  if (typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) {
      try {
        o[k] = safeClone(v[k], depth + 1);
      } catch {
        o[k] = "[unserializable]";
      }
    }
    return o;
  }
  return v;
}
