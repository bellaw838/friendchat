// Sign-up verification seam — OFF by default during the testing period.
//
// To enable later:
//   1. Set REQUIRE_VERIFICATION=1 in the environment.
//   2. Implement sendCode/checkCode against a provider. Email is the cheap
//      path (SMTP or an email API); SMS costs real money per message.
//      Generate a 6-digit code, store it with a short expiry (an in-memory
//      Map is fine at friend scale), email/text it to `destination`.
//   3. In the signup route: collect email or phone, create the account with
//      verified = 0, call sendCode; add a /api/verify route that calls
//      checkCode and flips users.verified to 1; block login while
//      verified = 0. Existing users (verified = 1) are unaffected.
function isRequired() {
  const v = String(process.env.REQUIRE_VERIFICATION || '').toLowerCase();
  return v === '1' || v === 'true';
}

function sendCode(destination) {
  throw new Error('Verification is not wired to a provider yet');
}

function checkCode(destination, code) {
  throw new Error('Verification is not wired to a provider yet');
}

module.exports = { isRequired, sendCode, checkCode };
