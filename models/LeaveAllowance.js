const mongoose = require("mongoose");

const LeaveAllowanceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    year: {
      type: Number,
      required: true,
      min: 1970,
      index: true,
    },
    allowed: {
      type: Number,
      required: true,
      min: 0,
    },
    used: {
      type: Number,
      required: true,
      min: 0,
    },
    remaining: {
      type: Number,
      required: true,
      min: 0,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

LeaveAllowanceSchema.index({ user: 1, year: 1 }, { unique: true });

module.exports = mongoose.model("LeaveAllowance", LeaveAllowanceSchema);
