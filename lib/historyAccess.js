// Single source of truth for who may see/use the Admin page's "Clear History" action - it removes
// every recorded upload/delete entry irreversibly, so it is restricted to one specific account
// rather than every admin (shared "master" password included). Shared between api/admin.js (hides
// the button from anyone else) and api/province-data.js (rejects the DELETE ?clearHistory=1 call
// server-side even if someone reaches it directly) so the two can never drift out of sync.
const HISTORY_OWNER_EMAIL = "ruvpalado@gmail.com";

// getSessionIdentity() returns "master" or the signed-in user's lowercased email - see lib/auth.js.
function canClearHistory(signedInAs) {
  return signedInAs === HISTORY_OWNER_EMAIL;
}

module.exports = { canClearHistory };
