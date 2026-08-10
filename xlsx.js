/* 最小的 .xlsx 讀寫，不依賴任何外部套件。
   只做這個網站需要的部分：純文字/數字儲存格、多工作表、粗體標題列、欄寬。

   寫入：ZIP 全部用 stored（不壓縮）。Excel 完全接受，省掉實作 deflate。
   讀取：Excel 存出來的檔案一定是 deflate，所以用瀏覽器內建的
         DecompressionStream("deflate-raw") 解壓，不必自己寫 inflate。 */

/* ---------- CRC32（ZIP 需要） ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------- ZIP 寫入 ---------- */

const utf8 = (s) => new TextEncoder().encode(s);

// 固定時間戳，讓同樣內容產生同樣的檔案（也避免依賴 Date）
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function zipStored(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  files.forEach((f) => {
    const nameBytes = utf8(f.name);
    const data = f.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 檔名
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); // central directory header
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, DOS_TIME, true);
    cd.setUint16(14, DOS_DATE, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  });

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/* ---------- ZIP 讀取 ---------- */

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("這個瀏覽器不支援解壓縮 .xlsx，請改用 CSV 格式上傳，或改用 Chrome / Edge。");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  // 由檔尾往前找 End Of Central Directory
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= 0 && i > view.byteLength - 65558; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("這不是有效的 .xlsx（找不到 ZIP 結構）");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map();

  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // 真正的資料起點要看 local header 的檔名／extra 長度
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    out.set(name, method === 0 ? raw : await inflateRaw(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ---------- XML 小工具 ---------- */

function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colLetter(i) {
  let s = "";
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function colIndex(ref) {
  const letters = String(ref).replace(/[0-9]/g, "");
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/* ---------- 產生 .xlsx ---------- */

// sheets: [{ name, rows: [[cell, ...], ...], widths?: [n, ...], headerRows?: 1 }]
// 所有值都以文字寫入（inlineStr），避免日期序號與地區設定的坑。
function buildXlsx(sheets) {
  const sheetXml = sheets.map((sheet) => {
    const cols = (sheet.widths || []).length
      ? `<cols>${sheet.widths
          .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
          .join("")}</cols>`
      : "";

    const headerRows = sheet.headerRows == null ? 1 : sheet.headerRows;
    const rows = sheet.rows
      .map((row, ri) => {
        const style = ri < headerRows ? ' s="1"' : "";
        const cells = row
          .map((val, ci) => {
            if (val == null || val === "") return "";
            return `<c r="${colLetter(ci)}${ri + 1}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(
              val
            )}</t></is></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`;
  });

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join("")}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets
    .map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${
        i + 1
      }.xml"/>`
  )
  .join("")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  // 只需要兩種格式：一般與粗體（標題列）
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`;

  const files = [
    { name: "[Content_Types].xml", data: utf8(contentTypes) },
    { name: "_rels/.rels", data: utf8(rootRels) },
    { name: "xl/workbook.xml", data: utf8(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(workbookRels) },
    { name: "xl/styles.xml", data: utf8(styles) },
    ...sheetXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(xml) })),
  ];

  return zipStored(files);
}

/* ---------- 解析 .xlsx ---------- */

// Excel 的日期是「1899-12-30 起算的天數」。使用者在範本裡打日期時，
// Excel 常會自動轉成這種序號，所以讀回來必須支援。
function excelSerialToISO(n) {
  const serial = Number(n);
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return "";
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

function parseSheetXml(xmlText, sharedStrings) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const rows = [];
  doc.querySelectorAll("sheetData > row").forEach((rowEl) => {
    const rowIndex = Number(rowEl.getAttribute("r") || rows.length + 1) - 1;
    const cells = [];
    rowEl.querySelectorAll("c").forEach((c) => {
      const ref = c.getAttribute("r") || "";
      const ci = ref ? colIndex(ref) : cells.length;
      const type = c.getAttribute("t");
      let value = "";

      if (type === "inlineStr") {
        value = Array.from(c.querySelectorAll("is t")).map((t) => t.textContent).join("");
      } else if (type === "s") {
        const idx = Number(c.querySelector("v")?.textContent);
        value = sharedStrings[idx] == null ? "" : sharedStrings[idx];
      } else if (type === "str") {
        value = c.querySelector("v")?.textContent || "";
      } else {
        // 數字（也可能是日期序號，交由呼叫端依欄位判斷）
        value = c.querySelector("v")?.textContent || "";
      }
      cells[ci] = String(value).trim();
    });
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = "";
    rows[rowIndex] = cells;
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// 回傳 { 工作表名稱: rows[][] }
async function readXlsx(arrayBuffer) {
  const zip = await unzip(arrayBuffer);
  const dec = (name) => (zip.has(name) ? new TextDecoder().decode(zip.get(name)) : "");

  const wbXml = dec("xl/workbook.xml");
  if (!wbXml) throw new Error("這不是有效的 .xlsx（缺少 workbook）");

  const relsXml = dec("xl/_rels/workbook.xml.rels");
  const relDoc = new DOMParser().parseFromString(relsXml, "application/xml");
  const relTarget = {};
  relDoc.querySelectorAll("Relationship").forEach((r) => {
    relTarget[r.getAttribute("Id")] = r.getAttribute("Target");
  });

  const sharedStrings = [];
  const ssXml = dec("xl/sharedStrings.xml");
  if (ssXml) {
    const ssDoc = new DOMParser().parseFromString(ssXml, "application/xml");
    ssDoc.querySelectorAll("si").forEach((si) => {
      sharedStrings.push(Array.from(si.querySelectorAll("t")).map((t) => t.textContent).join(""));
    });
  }

  const wbDoc = new DOMParser().parseFromString(wbXml, "application/xml");
  const out = {};
  const sheetEls = Array.from(wbDoc.querySelectorAll("sheets > sheet"));

  for (let i = 0; i < sheetEls.length; i++) {
    const el = sheetEls[i];
    const name = el.getAttribute("name") || `Sheet${i + 1}`;
    const rid = el.getAttribute("r:id") || el.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    let target = relTarget[rid] || `worksheets/sheet${i + 1}.xml`;
    target = target.replace(/^\//, "");
    const path = target.startsWith("xl/") ? target : `xl/${target}`;
    const xml = dec(path) || dec(`xl/worksheets/sheet${i + 1}.xml`);
    out[name] = xml ? parseSheetXml(xml, sharedStrings) : [];
  }
  return out;
}

/* ---------- CSV / TSV 備援 ---------- */

// 支援引號包裹與跳脫引號
function parseDelimited(text) {
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const delim = clean.split("\n")[0].includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/* ---------- 下載 ---------- */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
