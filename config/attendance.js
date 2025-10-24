const raw = process.env.ATTENDANCE_ALLOWED_IPS || "";

function normalizeIp(ip) {
  if (!ip) return null;
  const cleaned = String(ip).trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("::ffff:")) {
    return cleaned.slice(7);
  }
  return cleaned;
}

const allowedIps = raw
  .split(/[,;\s]+/)
  .map(normalizeIp)
  .filter(Boolean);

module.exports = {
  allowedIps,
};
