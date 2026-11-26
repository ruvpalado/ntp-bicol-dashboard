// Retired NTP Network endpoint. Do not read or recreate stored directory records.
module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.status(410).json({ error: "NTP Network has been removed." });
};
