const mongoose = require("mongoose");

const leaveTypes = ["full", "short", "half"];
const leaveCategories = ["casual", "medical", "annual", "sick", "unpaid", "other"];
const leaveStatuses = ["pending", "accepted", "rejected", "on_hold"];
const employmentStatuses = ["intern", "apprentice", "permanent", "probation", "contract"];
const decisionTypes = ["paid", "unpaid", "partially_paid", "not_applicable"];

const LeaveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    employeeSnapshot: {
      fullName: { type: String, required: true },
      employeeId: { type: Number, required: true },
      email: { type: String, required: true },
      department: { type: String },
      branch: { type: String },
      city: { type: String },
      joiningDate: { type: Date },
      role: { type: String },
      profileImageUrl: { type: String, default: null },
      signatureImageUrl: { type: String, default: null },
    },

    employerName: { type: String, default: "" },
    designation: { type: String, default: "" },
    contactNumber: { type: String, default: "" },

    leaveType: { type: String, enum: leaveTypes, required: true },
    leaveCategory: { type: String, enum: leaveCategories, required: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    durationDays: { type: Number, min: 0, default: null },
    durationHours: { type: Number, min: 0, default: null },
    shortLeaveWindow: {
      type: new mongoose.Schema(
        {
          startTime: { type: String, default: "" },
          endTime: { type: String, default: "" },
        },
        { _id: false }
      ),
      default: null,
    },
    halfDaySession: { type: String, enum: ["first_half", "second_half"], default: null },
    leaveReason: { type: String, required: true },

    applicantSignedAt: { type: Date, default: null },

    tasksDuringAbsence: { type: String, default: "" },
    teamLeadAssignee: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    backupStaff: {
      name: { type: String, default: "" },
    },
    teamLead: {
      remarks: { type: String, default: "" },
      status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
      reviewedAt: { type: Date, default: null },
      reviewer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },

    hrSection: {
      receivedBy: { type: String, default: "" },
      receivedAt: { type: Date, default: null },
      employmentStatus: { type: String, enum: employmentStatuses, default: null },
      decisionForForm: { type: String, enum: decisionTypes, default: "not_applicable" },
      annualAllowance: new mongoose.Schema(
        {
          allowed: { type: Number, default: 12 },
          used: { type: Number, default: 0 },
          remaining: { type: Number, default: 12 },
        },
        { _id: false }
      ),
    },

    attachments: [{ type: String }],

    status: { type: String, enum: leaveStatuses, default: "pending", index: true },
    statusHistory: [
      new mongoose.Schema(
        {
          status: { type: String, enum: leaveStatuses, required: true },
          remark: { type: String, default: "" },
          changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          changedAt: { type: Date, default: Date.now },
        },
        { _id: false }
      ),
    ],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

LeaveSchema.index({ user: 1, fromDate: 1, toDate: 1 });

module.exports = mongoose.model("Leave", LeaveSchema);
module.exports.leaveTypes = leaveTypes;
module.exports.leaveCategories = leaveCategories;
module.exports.leaveStatuses = leaveStatuses;
module.exports.employmentStatuses = employmentStatuses;
module.exports.decisionTypes = decisionTypes;
