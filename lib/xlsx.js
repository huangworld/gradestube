// Minimal .xlsx reader (no deps): unzip via DecompressionStream, pull shared strings + sheet cells, emit CSV text.
const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50;

async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a zip/xlsx file");
  const count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  const files = {}; const td = new TextDecoder();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== SIG_CEN) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
    const lnlen = dv.getUint16(loff + 26, true), lelen = dv.getUint16(loff + 28, true);
    const start = loff + 30 + lnlen + lelen;
    files[name] = { method, data: u8.subarray(start, start + csize) };
    p += 46 + nlen + elen + clen;
  }
  const read = async name => {
    const f = files[name]; if (!f) return null;
    if (f.method === 0) return td.decode(f.data);
    if (f.method !== 8) throw new Error("Unsupported zip compression");
    const ds = new DecompressionStream("deflate-raw");
    const out = new Response(new Blob([f.data]).stream().pipeThrough(ds));
    return out.text();
  };
  return { names: Object.keys(files), read };
}

const unxml = s => s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-f]+);/gi, (m, e) =>
  e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : e === "apos" ? "'" :
  String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const textOf = xml => unxml([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(""));
const colIdx = ref => { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const csvCell = s => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

export async function xlsxToText(buf) {
  const z = await unzip(buf);
  const ssXml = await z.read("xl/sharedStrings.xml");
  const shared = ssXml ? [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1])) : [];
  const wb = await z.read("xl/workbook.xml");
  const names = wb ? [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(m => unxml(m[1])) : [];
  const sheets = z.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  const out = [];
  for (let si = 0; si < sheets.length; si++) {
    const xml = await z.read(sheets[si]);
    const rows = [];
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c r="([A-Z]+)\d*"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const [, col, attrs, inner = ""] = c;
        const t = (attrs.match(/ t="([^"]+)"/) || [])[1];
        let v = "";
        if (t === "s") v = shared[Number((inner.match(/<v>(.*?)<\/v>/) || [])[1])] ?? "";
        else if (t === "inlineStr") v = textOf(inner);
        else v = unxml((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || "");
        cells[colIdx(col)] = v;
      }
      if (cells.some(x => x != null && x !== "")) rows.push(Array.from(cells, x => csvCell(x ?? "")).join(","));
    }
    if (!rows.length) continue;
    if (sheets.length > 1) out.push(`## Sheet: ${names[si] || si + 1}`);
    out.push(rows.join("\n"));
  }
  return out.join("\n\n");
}
