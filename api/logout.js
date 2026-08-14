const { SESSION_COOKIE } = require("../lib/auth");

module.exports = async (req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.writeHead(303, { Location: "/login" });
  res.end();
};
