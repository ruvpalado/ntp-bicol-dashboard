// Reproduces the exact production bug: "I can upload Camarines Norte but not Catanduanes, both have
// the same format" (HTTP 500, out of memory, but the crash happened on Vercel's side BEFORE the
// request ever reached the consolidation server per Railway's logs - ruling out region-wide
// consolidation as the cause).
//
// ROOT CAUSE: a sheet whose Excel-reported used range (ws['!ref']) extends far beyond its real data -
// typically because a cell was clicked/formatted far down or to the right at some point, which Excel
// silently keeps as part of the sheet's declared dimensions even though it looks empty - forces
// XLSX.utils.sheet_to_json() to materialize an array entry for every row in that whole range BEFORE
// this codebase's own trimTrailingBlankRows() ever gets a chance to cut the empty tail back down.
// Two files can look identical (same sheets, same visible data, similar file size - Excel compresses
// long runs of empty cells extremely well) while one silently carries a used-range reaching into the
// hundreds of thousands of rows.
//
// This test builds exactly that: a sheet with real data in the first few rows, then one cell with a
// real value written far down (simulating an accidental click/paste), and confirms parseUpload()
// rejects it immediately with a clear, actionable message - instead of trying to materialize the
// full range and (in production) OOM-crashing the function with no diagnosable error at all.
const XLSX = require("xlsx");
const template = require(__dirname + "/lib/provinceTemplate");

const results = [];
const check = (n, ok, d) => results.push([n, !!ok, ok ? "" : (d || "")]);

function bookWithBloatedSheet(sheetName, realRows, bloatedRowIndex) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(realRows);
  // Simulate "a cell was accidentally touched far below the real data": write one value at a row far
  // beyond anything real, then manually extend the sheet's declared range to include it - exactly
  // what Excel does internally when this happens for real (the cell need not even be visibly
  // non-blank in every case, but a written value is the simplest, most realistic reproduction).
  const cellRef = XLSX.utils.encode_cell({ r: bloatedRowIndex, c: 0 });
  ws[cellRef] = { t: "s", v: "" }; // an effectively-blank cell, but XLSX still counts it in the range
  const range = XLSX.utils.decode_range(ws["!ref"]);
  range.e.r = Math.max(range.e.r, bloatedRowIndex);
  ws["!ref"] = XLSX.utils.encode_range(range);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

(function run() {
  // 1. A normal, modestly-sized sheet parses fine (this is the "Camarines Norte" case - nothing
  //    should change for well-formed files).
  {
    const wb = XLSX.utils.book_new();
    const rows = [["Date of Notification", "Province", "Screening/Diagnosing Health Facility"]];
    for (let i = 0; i < 500; i++) rows.push(["2026-01-15", "ALBAY", "ALBAY HEALTH CENTER"]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "CNR 2026 ");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    let threw = null, parsed = null;
    try { parsed = template.parseUpload(buf, "normal.xlsx"); } catch (e) { threw = e; }
    check("a normal, modestly-sized file parses fine", !threw && parsed && parsed["CNR 2026 "].length > 0,
      threw && threw.message);
  }

  // 2. A sheet with real data up top, but one stray value written ~200,000 rows down (the
  //    "Catanduanes" case) is rejected immediately with a clear, actionable error - not left to try
  //    materializing 200,000 rows and risk OOMing the process.
  {
    const rows = [["Date of Notification", "Province", "Screening/Diagnosing Health Facility"]];
    for (let i = 0; i < 30; i++) rows.push(["2026-01-15", "CATANDUANES", "CATANDUANES HEALTH CENTER"]);
    const buf = bookWithBloatedSheet("CNR 2026 ", rows, 200000);
    let threw = null, parsed = null;
    const start = Date.now();
    try { parsed = template.parseUpload(buf, "bloated.xlsx"); } catch (e) { threw = e; }
    const elapsedMs = Date.now() - start;
    check("a sheet with a bloated used-range is rejected, not silently parsed", !!threw && !parsed,
      parsed ? `parsed ${parsed["CNR 2026 "] && parsed["CNR 2026 "].length} rows instead of rejecting` : "");
    check("rejection carries the BAD_FORMAT error code (a clean 400, not a crash)",
      threw && threw.code === "BAD_FORMAT", threw && JSON.stringify({ message: threw.message, code: threw.code }));
    check("the error names the sheet and explains what to do about it",
      threw && /CNR 2026/.test(threw.message) && /delete/i.test(threw.message), threw && threw.message);
    check("the check itself is fast - proves it runs BEFORE materializing the bloated range, not after",
      elapsedMs < 2000, `took ${elapsedMs}ms`);
  }

  // 3. A file that's large in ROW COUNT alone (not just one stray far-away cell) is also caught -
  //    guards the "wide sparse range" variant, not just "one accidental cell" specifically.
  {
    const rows = [["Date of Notification", "Province", "Screening/Diagnosing Health Facility"]];
    for (let i = 0; i < 60000; i++) rows.push(["2026-01-15", "ALBAY", "ALBAY HEALTH CENTER"]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "CNR 2026 ");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    let threw = null;
    try { template.parseUpload(buf, "toolarge.xlsx"); } catch (e) { threw = e; }
    check("a sheet genuinely carrying 60,000+ real rows is also rejected (over the sane cap either way)",
      threw && threw.code === "BAD_FORMAT", threw && threw.message);
  }

  const pass = results.filter((r) => r[1]).length;
  const fail = results.filter((r) => !r[1]);
  for (const [n, ok, d] of results) console.log((ok ? "PASS" : "FAIL") + " - " + n + (ok ? "" : "\n         " + d));
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  console.log(fail.length === 0 ? "\nBLOATED SHEET RANGES ARE CAUGHT BEFORE THEY CAN OOM" : "\nISSUES FOUND");
  process.exitCode = fail.length === 0 ? 0 : 1;
})();
