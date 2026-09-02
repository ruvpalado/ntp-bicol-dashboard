function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Was reimplemented identically in province-upload.js, province-data.js and reference-upload.js.
function query(req, key) {
  return new URL(req.url, "http://localhost").searchParams.get(key);
}

module.exports = { readRawBody, query };
