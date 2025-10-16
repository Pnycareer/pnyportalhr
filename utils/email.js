// utils/email.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

// Simple text email
async function sendEmail({ to, subject, text, html }) {
  const mail = {
    from: `"HR Portal" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
    html: html || text
  };
  return transporter.sendMail(mail);
}

// Opinionated OTP email
async function sendOtpEmail(to, code, name = 'User') {
  const subject = 'Your verification code';
  const text = `Hi ${name},\n\nYour verification code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, please ignore this email.`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <p>Hi ${name},</p>
      <p>Your verification code is:</p>
      <div style="font-size:22px;font-weight:700;letter-spacing:2px;margin:12px 0;padding:12px 16px;border:1px solid #e5e7eb;border-radius:10px;display:inline-block">
        ${code}
      </div>
      <p>This code expires in <b>10 minutes</b>.</p>
      <p>If you didn’t request this, you can ignore this email.</p>
    </div>
  `;
  return sendEmail({ to, subject, text, html });
}

module.exports = { sendEmail, sendOtpEmail };
