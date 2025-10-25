const { allowedIps } = require('../config/attendance');

function extractClientIps(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return String(forwarded)
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
  }
  const remote =
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.ip;
  return remote ? [remote] : [];
}

function normalizeIp(ip) {
  if (!ip) return null;
  let cleaned = String(ip).trim();
  if (!cleaned) return null;
  if (cleaned.startsWith('::ffff:')) {
    cleaned = cleaned.slice(7);
  }
  return cleaned;
}

module.exports = function attendanceIpGuard(req, res, next) {
  if (!allowedIps.length) {
    return next();
  }

  const attemptIps = extractClientIps(req).map(normalizeIp).filter(Boolean);
  const allowed = attemptIps.some((ip) => allowedIps.includes(ip));

  if (!allowed) {
    return res.status(403).json({
      message: 'Attendance marking is not permitted from this network',
    });
  }

  return next();
};
