const mongoose = require("mongoose");

const overtimeSlotSchema = new mongoose.Schema(
  {
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    durationMinutes: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const InstructorOvertimeSchema = new mongoose.Schema(
  {
    instructor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    instructorName: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    designation: {
      type: String,
      required: true,
      trim: true,
    },
    branchName: {
      type: String,
      required: true,
      trim: true,
    },
    overtimeSlots: {
      type: [overtimeSlotSchema],
      default: [],
      validate: {
        validator(slots) {
          return (
            Array.isArray(slots) &&
            slots.every((slot) => slot.durationMinutes >= 0)
          );
        },
        message: "Invalid overtime slot",
      },
    },
    totalDurationMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalDurationHours: {
      type: Number,
      default: 0,
      min: 0,
    },
    salary: {
      type: Number,
      default: 0,
      min: 0,
    },
    verified: { type: Boolean, default: false, index: true },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

InstructorOvertimeSchema.pre("validate", function computeTotals(next) {
  const doc = this;
  if (!Array.isArray(doc.overtimeSlots)) {
    doc.overtimeSlots = [];
  }
  const totalMinutes = doc.overtimeSlots.reduce(
    (sum, slot) =>
      sum + (Number.isFinite(slot.durationMinutes) ? slot.durationMinutes : 0),
    0
  );
  doc.totalDurationMinutes = totalMinutes;
  doc.totalDurationHours = Math.round((totalMinutes / 60) * 100) / 100;
  next();
});

module.exports = mongoose.model("InstructorOvertime", InstructorOvertimeSchema);
