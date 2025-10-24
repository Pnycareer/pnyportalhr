// models/Attendance.js
const mongoose = require('mongoose');

const STATUSES = ['present', 'absent', 'leave', 'late', 'official_off', 'short_leave'];
const OFF = new Set(['absent', 'leave', 'official_off']);

const AttendanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Anchor date (UTC midnight of the working day)
    date: { type: Date, required: true },
    status: { type: String, enum: STATUSES, required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    note: { type: String },

    // Times stored as Date (UTC); null for off statuses or when not provided
    checkIn: { type: Date, default: null },
    checkOut: { type: Date, default: null },

    checkInSnapshotUrl: { type: String, default: null },
    checkOutSnapshotUrl: { type: String, default: null },

    // Persisted computed duration in HOURS (decimal). null if not applicable.
    workedHours: { type: Number, min: 0, default: null },
  },
  { timestamps: true }
);

AttendanceSchema.index({ user: 1, date: 1 }, { unique: true });

// Guardrails even if someone bypasses controllers
AttendanceSchema.pre('validate', function(next) {
  if (OFF.has(this.status)) {
    this.checkIn = null;
    this.checkOut = null;
    this.checkInSnapshotUrl = null;
    this.checkOutSnapshotUrl = null;
    this.workedHours = null;
  } else if (this.checkIn && this.checkOut) {
    if (this.checkOut < this.checkIn) {
      return next(new Error('checkOut cannot be earlier than checkIn'));
    }
    const hours = (this.checkOut - this.checkIn) / 3600000; // ms -> hours
    const rounded = Math.round(hours * 100) / 100; // 2 decimals
    this.workedHours = Number.isFinite(rounded) && rounded >= 0 ? rounded : null;
  } else {
    this.workedHours = null;
  }
  next();
});


module.exports = mongoose.model('Attendance', AttendanceSchema);
module.exports.STATUSES = STATUSES;
module.exports.OFF = OFF;
