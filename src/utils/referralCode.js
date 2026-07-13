// Generates short, URL-friendly referral codes for distributors, e.g.
// "BONCHRIS-4X7Q". Uniqueness is enforced by the caller re-checking against
// the DB (see generateUniqueReferralCode below).

function slugify(text) {
  return (text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 10);
}

function randomSuffix(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O, 1/I)
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function buildReferralCode(seedText) {
  const base = slugify(seedText) || "DIST";
  return `${base}-${randomSuffix()}`;
}

// db: the pg client/pool to check uniqueness against (must support .query)
async function generateUniqueReferralCode(db, seedText, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = buildReferralCode(seedText);
    const existing = await db.query(
      "SELECT id FROM distributors WHERE referral_code = $1",
      [candidate]
    );
    if (existing.rows.length === 0) return candidate;
  }
  // Extremely unlikely fallback: timestamp-based code, always unique enough
  return `DIST-${Date.now().toString(36).toUpperCase()}`;
}

module.exports = { buildReferralCode, generateUniqueReferralCode };
