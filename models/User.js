const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const roles = ["superadmin", "admin", "hr", "employee"];

const UserSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    employeeId: { type: Number, required: true, unique: true, index: true },
    cnic: { type: Number, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    department: { type: String, required: true },
    joiningDate: { type: Date, required: true },

    // new fields
    branch: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },

    // normalized "last active"
    lastActiveAt: { type: Date, default: null },
    // optional denormalized snapshot if you really want day/time strings
    lastActiveDay: { type: String, default: null },   // e.g. "Monday"
    lastActiveTime: { type: String, default: null },  // e.g. "14:37"

    // profile image (stored path/URL)
    profileImageUrl: { type: String, default: null },

    role: { type: String, enum: roles, default: "employee" },
    isApproved: { type: Boolean, default: false }, // only superadmin flips this

    // otp
    emailVerified: { type: Boolean, default: false },
    emailOtpHash: { type: String, default: null },
    emailOtpExpiresAt: { type: Date, default: null },

    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

UserSchema.methods.setPassword = async function (password) {
  const salt = await bcrypt.genSalt(10);
  this.passwordHash = await bcrypt.hash(password, salt);
};

UserSchema.methods.validatePassword = async function (password) {
  return bcrypt.compare(password, this.passwordHash);
};

module.exports = mongoose.model("User", UserSchema);
module.exports.roles = roles;
