// controllers/auth.controller.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { requiredFields } = require("../utils/validate");
const { sendOtpEmail } = require("../utils/email");
const { generateOtp, hashOtp, expiryFromNow } = require("../utils/otp");

async function register(req, res) {
  try {
    const {
      fullName,
      employeeId,
      cnic,
      email,
      department,
      joiningDate,
      branch,
      city,
      password,
    } = req.body;

    requiredFields(req.body, [
      "fullName",
      "employeeId",
      "cnic",
      "email",
      "department",
      "joiningDate",
      "branch",
      "city",
      "password",
    ]);

    const exists = await User.findOne({
      $or: [{ email }, { employeeId }, { cnic }],
    });
    if (exists) return res.status(409).json({ message: "User already exists" });

    const user = new User({
      fullName,
      employeeId,
      cnic,
      email,
      department,
      joiningDate,
      branch,
      city,
      role: "employee",
      isApproved: false,
      emailVerified: false,
    });

    await user.setPassword(password);

    // handle avatar from multer (optional)
    if (req.file) {
      // store a web-accessible path
      user.profileImageUrl = `/uploads/avatars/${req.file.filename}`;
    }

    // email OTP
    const code = generateOtp(6);
    user.emailOtpHash = hashOtp(code);
    user.emailOtpExpiresAt = expiryFromNow(10); // 10 minutes

    await user.save();
    await sendOtpEmail(user.email, code, user.fullName);

    return res.status(201).json({
      message:
        "Registered. Check your email for the verification code (expires in 10 minutes).",
      userId: user._id,
      profileImageUrl: user.profileImageUrl || null,
    });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
}

async function verifyEmailOtp(req, res) {
  try {
    const { email, code } = req.body;
    requiredFields(req.body, ["email", "code"]);

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid email" });
    if (user.emailVerified)
      return res.status(200).json({ message: "Email already verified" });

    if (!user.emailOtpHash || !user.emailOtpExpiresAt)
      return res
        .status(400)
        .json({ message: "No OTP pending for this account" });

    if (new Date() > new Date(user.emailOtpExpiresAt))
      return res
        .status(400)
        .json({ message: "OTP expired. Please request a new one." });

    const ok = user.emailOtpHash === hashOtp(code);
    if (!ok) return res.status(400).json({ message: "Invalid OTP" });

    user.emailVerified = true;
    user.emailOtpHash = null;
    user.emailOtpExpiresAt = null;
    await user.save();

    res.json({ message: "Email verified successfully" });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
}

async function resendEmailOtp(req, res) {
  try {
    const { email } = req.body;
    requiredFields(req.body, ["email"]);

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid email" });
    if (user.emailVerified)
      return res.status(200).json({ message: "Email already verified" });

    // (Optional) cooldown: only allow resend if previous OTP expired or after N seconds
    // if (user.emailOtpExpiresAt && new Date() < new Date(user.emailOtpExpiresAt)) {
    //   return res.status(429).json({ message: 'OTP already sent. Please wait until it expires.' });
    // }

    const code = generateOtp(6);
    user.emailOtpHash = hashOtp(code);
    user.emailOtpExpiresAt = expiryFromNow(10);
    await user.save();

    await sendOtpEmail(user.email, code, user.fullName);

    res.json({
      message: "A new verification code has been sent to your email.",
    });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
}

async function login(req, res) {
  const { email, password } = req.body;
  try {
    requiredFields(req.body, ["email", "password"]);
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const ok = await user.validatePassword(password);
    if (!ok) return res.status(400).json({ message: "Invalid credentials" });

    if (!user.emailVerified)
      return res
        .status(403)
        .json({ message: "Please verify your email via OTP first" });
    if (!user.isApproved)
      return res.status(403).json({ message: "Account awaiting approval" });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res
      .cookie("token", token, {
        httpOnly: true,
        secure: true, // browser sees HTTPS (Cloudflare) → set true
        sameSite: "lax", // same-origin app; use 'none' only if cross-site
        domain: "hr.pnytrainings.com", // lock to your subdomain
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      .json({
        id: user._id,
        role: user.role,
        fullName: user.fullName,
        employeeId: user.employeeId,
        department: user.department,
      });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
}

async function getMe(req, res) {
  try {
    const user = await User.findById(req.user.id).select(
      "_id fullName profileImageUrl email employeeId department role isApproved emailVerified createdAt updatedAt"
    );

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
}

function logout(req, res) {
  res.clearCookie("token").json({ message: "Logged out" });
}

module.exports = {
  register,
  verifyEmailOtp,
  resendEmailOtp,
  login,
  logout,
  getMe,
};
