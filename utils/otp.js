// utils/otp.js
const crypto = require('crypto');

function generateOtp(length = 6) {
  // 6-digit, no leading zeros issue
  const code = (Math.floor(100000 + Math.random() * 900000)).toString().slice(0, length);
  return code;
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function expiryFromNow(minutes = 10) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

module.exports = { generateOtp, hashOtp, expiryFromNow };
