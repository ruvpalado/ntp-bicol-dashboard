const crypto = require("crypto");
const { isAuthenticated, parseCookies } = require("../lib/auth");
const { COOKIE, recordVisit, getReport } = require("../lib/visitorStore");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "GET") {
    // Same server-side gate as /admin. Never return counts or blob locations to public callers.
    if (!isAuthenticated(req)) return res.status(401).json({ error: "Not authenticated." });
    try {
      return res.status(200).json(await getReport());
    } catch (err) {
      console.error("Visitor report unavailable:", err.message);
      return res.status(503).json({ error: "Visitor report unavailable. Check private Blob storage and try again." });
    }
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  // Cross-site forms and scripts must not be able to inflate the report. No CORS is enabled.
  let sameOrigin = false;
  try {
    const origin = new URL(req.headers.origin);
    sameOrigin = /^(https?:)$/.test(origin.protocol) && origin.host === req.headers.host;
  } catch (_) { /* missing or malformed origin */ }
  if (!sameOrigin || req.headers["sec-fetch-site"] === "cross-site" ||
      !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
    return res.status(403).json({ error: "Same-origin JSON request required." });
  }
  if (isAuthenticated(req) || req.headers.dnt === "1" || req.headers["sec-gpc"] === "1" ||
      /bot|crawler|spider|headless/i.test(req.headers["user-agent"] || "")) {
    return res.status(204).end();
  }
  try {
    let cookies = {};
    try { cookies = parseCookies(req.headers.cookie); } catch (_) { /* replace malformed cookie */ }
    const existing = cookies[COOKIE];
    const visitor = /^[a-f0-9]{64}$/.test(existing || "") ? existing : crypto.randomBytes(32).toString("hex");
    await recordVisit(visitor);
    const secure = process.env.VERCEL || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie", `${COOKIE}=${visitor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`);
    return res.status(204).end();
  } catch (err) {
    console.error("Visitor tracking unavailable:", err.message);
    return res.status(503).json({ error: "Visitor tracking unavailable." });
  }
};
