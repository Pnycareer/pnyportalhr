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
    designation: {
      type: String,
      required: function () {
        return this.isNew;
      },
      trim: true,
    },
    joiningDate: { type: Date, required: true },

    // new fields
    branch: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    salary: { type: Number, min: 0, default: null }, // monthly or whatever your unit is
    bloodGroup: {
      type: String,
      trim: true,
      set: (val) => (val ? String(val).toUpperCase() : val),
    },
    dutyRoster: {
      type: String,
      trim: true,
      default: "10am to 7pm",
    },
    officialOffDays: {
      type: [String],
      default: [],
      set: (val) => {
        if (!val) return [];
        const arr = Array.isArray(val) ? val : String(val).split(",");
        return arr
          .map((day) => String(day || "").trim())
          .filter(Boolean)
          .map(
            (day) => day.charAt(0).toUpperCase() + day.slice(1).toLowerCase()
          );
      },
    },
    contactNumber: { type: String, required: true, trim: true },

    // profile image (stored path/URL)
    profileImageUrl: { type: String, default: null },
    signatureImageUrl: { type: String, default: null },
    signatureUpdatedAt: { type: Date, default: null },

    role: { type: String, enum: roles, default: "employee" },
    isApproved: { type: Boolean, default: false }, // only superadmin flips this
    isTeamLead: { type: Boolean, default: false },

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
