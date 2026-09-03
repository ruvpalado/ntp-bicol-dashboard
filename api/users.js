// Admin-only: list accounts and approve/reject/revoke them. Mirrors the auth-gating pattern used by
// api/province-data.js and api/awards.js (isAuthenticated(req) check first, everything else after).
const { isAuthenticated, getSessionIdentity } = require("../lib/auth");
const userStore = require("../lib/userStore");
const email = require("../lib/email");

module.exports = async (req, res) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }

  if (req.method === "GET") {
    try {
      const users = await userStore.getAllUsers();
      res.status(200).json({ users: users.map(userStore.publicUser), blobConfigured: userStore.blobConfigured() });
    } catch (err) {
      console.error("GET /api/users failed:", err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const action = body.action;
    const targetEmail = body.email;
    if (!targetEmail || !["approve", "reject", "revoke", "delete"].includes(action)) {
      res.status(400).json({ error: "Provide email and a valid action (approve/reject/revoke/delete)." });
      return;
    }
    try {
      const actor = getSessionIdentity(req) || "master";
      let result;
      if (action === "approve") {
        result = await userStore.approveUser(targetEmail, actor);
        if (result.ok && email.configured()) {
          // Best-effort - approval itself already succeeded and is not rolled back if the
          // notification email fails to send.
          try {
            const baseUrl = email.baseUrlFromReq(req);
            await email.sendEmail({
              to: result.user.email,
              subject: "Your account has been approved - NTP Bicol Region Dashboard",
              html: email.accountApprovedEmailHtml({ name: result.user.name, baseUrl }),
            });
          } catch (mailErr) {
            console.error("POST /api/users approve: notification email failed:", mailErr);
          }
        }
      } else if (action === "reject") {
        result = await userStore.rejectUser(targetEmail);
      } else if (action === "delete") {
        result = await userStore.deleteUser(targetEmail);
      } else {
        result = await userStore.revokeUser(targetEmail);
      }
      if (!result.ok) {
        const msg = result.reason === "not_found" ? "No account with that email."
          : result.reason === "wrong_status" ? "That account is not in a state this action applies to."
          : "Action failed.";
        res.status(400).json({ error: msg });
        return;
      }
      res.status(200).json({ ok: true, user: userStore.publicUser(result.user) });
    } catch (err) {
      console.error("POST /api/users failed:", err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
