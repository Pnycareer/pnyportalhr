const mongoose = require("mongoose");
const Leave = require("../models/Leave");
const User = require("../models/User");
const { leaveStatuses } = require("../models/Leave");
const LeaveAllowance = require("../models/LeaveAllowance");
const { toPublicUrl } = require("../utils/url");
const { emitToUser } = require("../services/socket.service");

const ALLOWED_LEAVES_PER_YEAR = 12;
const ADMIN_ROLES = ["superadmin", "admin", "hr"];
const TEAM_LEAD_REVIEW_STATUSES = ["pending", "approved", "rejected"];
const HALF_DAY_SESSIONS = ["first_half", "second_half"];
const SHORT_LEAVE_MAX_MINUTES = 120;
const HOURS_PER_WORK_DAY = 8;
const HALF_DAY_DURATION = 0.5;
const SHORT_LEAVE_DURATION = 0.25;

function isAdmin(role) {
  return ADMIN_ROLES.includes(role);
}

async function resolveTargetUser(req, explicitUserId) {
  const isEmployee = req.user?.role === "employee";
  const targetId = isEmployee ? req.user.id : (explicitUserId || req.user.id);

  const user = await User.findById(targetId);
  if (!user) {
    return { error: { status: 404, message: "User not found" } };
  }

  if (isEmployee && String(user._id) !== String(req.user.id)) {
    return { error: { status: 403, message: "Forbidden" } };
  }

  return { targetId: user._id, user };
}

function computeDurationDays(leave) {
  if (Number.isFinite(leave?.durationDays) && leave.durationDays >= 0) {
    return leave.durationDays;
  }
  if (Number.isFinite(leave?.durationHours) && leave.durationHours >= 0) {
    return Math.round((leave.durationHours / HOURS_PER_WORK_DAY) * 100) / 100;
  }
  return 1;
}

function yearKey(date) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}`;
}

function yearRange(date) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const end = new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1));
  return { start, end };
}

function monthRangeUTC(year, month1to12) {
  const y = parseInt(year, 10);
  const m = parseInt(month1to12, 10) - 1;
  if (Number.isNaN(y) || Number.isNaN(m) || m < 0 || m > 11) return null;
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  return { start, end };
}

async function computeYearlyUsage(userId, referenceDate, excludeIds = []) {
  const range = yearRange(referenceDate);
  if (!range) return 0;
  const query = {
    user: new mongoose.Types.ObjectId(userId),
    status: "accepted",
    fromDate: { $gte: range.start, $lt: range.end },
  };
  if (excludeIds.length) {
    query._id = { $nin: excludeIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  const accepted = await Leave.find(query)
    .select("durationDays durationHours")
    .lean();

  return accepted.reduce((sum, doc) => sum + computeDurationDays(doc), 0);
}

async function getAnnualAllowance(userId, referenceDate, cache, overrideCache = new Map()) {
  if (!referenceDate) {
    return {
      allowed: ALLOWED_LEAVES_PER_YEAR,
      used: 0,
      remaining: ALLOWED_LEAVES_PER_YEAR,
      actualUsed: 0,
    };
  }
  const key = `${String(userId)}::${yearKey(referenceDate)}`;
  if (cache.has(key)) return cache.get(key);
  const year = new Date(referenceDate).getUTCFullYear();

  const overrideKey = `${String(userId)}::${year}`;
  let override = overrideCache.get(overrideKey);
  if (override === undefined) {
    override = await LeaveAllowance.findOne({
      user: userId,
      year,
    }).lean();
    overrideCache.set(overrideKey, override || null);
  }

  const baseUsed = await computeYearlyUsage(userId, referenceDate);
  let allowed = ALLOWED_LEAVES_PER_YEAR;
  const candidateUsedValues = [baseUsed];
  if (override) {
    if (Number.isFinite(override.allowed)) {
      allowed = Math.max(override.allowed, 0);
    }
    if (Number.isFinite(override.used)) {
      candidateUsedValues.push(Math.max(override.used, 0));
    }
    if (Number.isFinite(override.remaining)) {
      const remainingFromOverride = Math.max(override.remaining, 0);
      const derivedUsed = allowed - remainingFromOverride;
      if (Number.isFinite(derivedUsed)) {
        candidateUsedValues.push(Math.max(derivedUsed, 0));
      }
    }
  }
  const normalizedAllowed = Math.max(allowed, 0);
  const normalizedUsed = Math.max(...candidateUsedValues);
  const allowance = {
    allowed: normalizedAllowed,
    used: normalizedUsed,
    remaining: Math.max(normalizedAllowed - normalizedUsed, 0),
    actualUsed: baseUsed,
  };
  cache.set(key, allowance);
  return allowance;
}

function toDateOrNull(value) {
  if (!value) return null;
  const dt = new Date(value);
  return isNaN(dt) ? null : dt;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toStringOrEmpty(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function formatDaysValue(value) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function parseTimeToMinutes(value) {
  if (!value || typeof value !== "string") return null;
  const [hourStr, minuteStr] = value.split(":");
  if (hourStr === undefined || minuteStr === undefined) return null;
  const hours = Number(hourStr);
  const minutes = Number(minuteStr);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

async function applyLeave(req, res) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const {
      userId,
      employerName,
      designation,
      contactNumber,
      leaveType,
      leaveCategory,
      fromDate,
      toDate,
      durationDays,
      durationHours,
      leaveReason,
      shortLeaveWindow,
      halfDaySession,
      tasksDuringAbsence,
      backupStaff = {},
      teamLead = {},
      teamLeadId,
      attachments = [],
      statusRemark,
      hrSection,
    } = req.body || {};

    if (!leaveType || !leaveCategory || !fromDate || !toDate || !leaveReason) {
      return res.status(400).json({ message: "leaveType, leaveCategory, fromDate, toDate, and leaveReason are required" });
    }

    const requesterId = req.user.id;
    const targetUserId = userId && userId !== requesterId ? userId : requesterId;

    if (userId && userId !== requesterId && !isAdmin(req.user.role)) {
      return res.status(403).json({ message: "You do not have permission to apply leave for another user" });
    }

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    let assignedTeamLeadId = null;
    if (teamLeadId) {
      if (!mongoose.Types.ObjectId.isValid(teamLeadId)) {
        return res.status(400).json({ message: "Invalid team lead selected" });
      }
      const assigned = await User.findOne({ _id: teamLeadId, isTeamLead: true, isApproved: true })
        .select("_id fullName");
      if (!assigned) {
        return res.status(400).json({ message: "Selected team lead is not available" });
      }
      assignedTeamLeadId = assigned._id;
    } else if (req.user.role === "employee") {
      return res.status(400).json({ message: "Team lead selection is required" });
    }

    const start = toDateOrNull(fromDate);
    const end = toDateOrNull(toDate);
    if (!start || !end) {
      return res.status(400).json({ message: "Invalid fromDate or toDate" });
    }
    if (end < start) {
      return res.status(400).json({ message: "toDate cannot be earlier than fromDate" });
    }

    let normalizedDurationDays = toNumberOrNull(durationDays);
    if (normalizedDurationDays === null) {
      const diffMs = end.setHours(0, 0, 0, 0) - start.setHours(0, 0, 0, 0);
      const diffDays = diffMs / 86400000;
      normalizedDurationDays = diffDays >= 0 ? diffDays + 1 : null;
    }

    let normalizedDurationHours = toNumberOrNull(durationHours);
    let normalizedShortLeaveWindow = null;
    let normalizedHalfDaySession = null;

    if (leaveType === "short") {
      if (normalizedDurationHours === null) {
        return res.status(400).json({ message: "Duration hours are required for short leave" });
      }
      if (normalizedDurationHours > 2) {
        return res.status(400).json({ message: "Short leave duration cannot exceed 2 hours" });
      }
      const windowInput =
        shortLeaveWindow && typeof shortLeaveWindow === "object"
          ? shortLeaveWindow
          : req.body?.shortLeaveWindow;
      const startTime =
        windowInput && typeof windowInput.startTime === "string"
          ? windowInput.startTime.trim()
          : "";
      const endTime =
        windowInput && typeof windowInput.endTime === "string"
          ? windowInput.endTime.trim()
          : "";
      if (!startTime || !endTime) {
        return res
          .status(400)
          .json({ message: "Start and end times are required for short leave" });
      }
      const startMinutes = parseTimeToMinutes(startTime);
      const endMinutes = parseTimeToMinutes(endTime);
      if (startMinutes === null || endMinutes === null) {
        return res.status(400).json({ message: "Invalid short leave time format" });
      }
      if (endMinutes <= startMinutes) {
        return res.status(400).json({ message: "Short leave end time must be after start time" });
      }
      const diffMinutes = endMinutes - startMinutes;
      if (diffMinutes % 30 !== 0) {
        return res.status(400).json({ message: "Short leave must use 30-minute increments" });
      }
      if (diffMinutes > SHORT_LEAVE_MAX_MINUTES) {
        return res
          .status(400)
          .json({ message: "Short leave duration cannot exceed 2 hours of absence" });
      }
      const calculatedHours = diffMinutes / 60;
      const normalizedExpected = Math.round(normalizedDurationHours * 2) / 2;
      const normalizedCalculated = Math.round(calculatedHours * 2) / 2;
      if (Math.abs(normalizedCalculated - normalizedExpected) > 0.001) {
        return res.status(400).json({ message: "Short leave hours must match the selected range" });
      }
      normalizedDurationHours = normalizedCalculated;
      normalizedDurationDays = SHORT_LEAVE_DURATION;
      normalizedShortLeaveWindow = {
        startTime,
        endTime,
      };
    } else if (leaveType === "half") {
      if (!halfDaySession || typeof halfDaySession !== "string") {
        return res.status(400).json({ message: "Half-day session selection is required" });
      }
      if (!HALF_DAY_SESSIONS.includes(halfDaySession)) {
        return res.status(400).json({ message: "Invalid half-day session provided" });
      }
      normalizedHalfDaySession = halfDaySession;
      normalizedDurationDays = HALF_DAY_DURATION;
    }

    const rawTasksDuringAbsence =
      tasksDuringAbsence !== undefined
        ? tasksDuringAbsence
        : req.body?.tasksDuringAbsence;
    const sanitizedTasksDuringAbsence = toStringOrEmpty(rawTasksDuringAbsence);

    const rawBackupStaffName =
      (backupStaff && typeof backupStaff === "object" && backupStaff.name !== undefined
        ? backupStaff.name
        : undefined) ?? req.body?.backupStaffName;
    const sanitizedBackupStaff = {
      name: toStringOrEmpty(rawBackupStaffName),
    };

    if (req.user.role === "employee") {
      if (!sanitizedTasksDuringAbsence) {
        return res.status(400).json({ message: "Tasks during absence are required" });
      }
      if (!sanitizedBackupStaff.name) {
        return res.status(400).json({ message: "Primary backup colleague is required" });
      }
    }

    const sanitizedTeamLead = {
      remarks: "",
      status: "pending",
      reviewedAt: null,
      reviewer: null,
    };

    if (teamLead && typeof teamLead === "object" && isAdmin(req.user.role)) {
      sanitizedTeamLead.remarks = toStringOrEmpty(teamLead.remarks ?? req.body.teamLeadRemarks);
      if (TEAM_LEAD_REVIEW_STATUSES.includes(teamLead.status)) {
        sanitizedTeamLead.status = teamLead.status;
        if (teamLead.status !== "pending") {
          sanitizedTeamLead.reviewedAt = new Date();
          sanitizedTeamLead.reviewer = new mongoose.Types.ObjectId(req.user.id);
        }
      }
    }

    const leave = new Leave({
      user: targetUser._id,
      employeeSnapshot: {
        fullName: targetUser.fullName,
        employeeId: targetUser.employeeId,
        email: targetUser.email,
      department: targetUser.department || "",
      branch: targetUser.branch || "",
      city: targetUser.city || "",
      joiningDate: targetUser.joiningDate || null,
      role: targetUser.role || "",
      profileImageUrl: toPublicUrl(targetUser.profileImageUrl),
      signatureImageUrl: targetUser.signatureImageUrl || null,
    },
      employerName: toStringOrEmpty(employerName),
      designation: toStringOrEmpty(designation),
      contactNumber: toStringOrEmpty(contactNumber),
      leaveType,
      leaveCategory,
      fromDate: start,
      toDate: end,
      durationDays: normalizedDurationDays,
      durationHours: normalizedDurationHours,
      shortLeaveWindow: normalizedShortLeaveWindow,
      halfDaySession: normalizedHalfDaySession,
      leaveReason: String(leaveReason),
      tasksDuringAbsence: sanitizedTasksDuringAbsence,
      applicantSignedAt: new Date(),
      teamLeadAssignee: assignedTeamLeadId,
      backupStaff: sanitizedBackupStaff,
      teamLead: sanitizedTeamLead,
      attachments: Array.isArray(attachments) ? attachments.map((a) => String(a)) : [],
      statusHistory: [
        {
          status: "pending",
          remark: toStringOrEmpty(statusRemark) || "Leave request created",
          changedBy: new mongoose.Types.ObjectId(requesterId),
          changedAt: new Date(),
        },
      ],
      createdBy: new mongoose.Types.ObjectId(requesterId),
    });

    if (hrSection && isAdmin(req.user.role)) {
      applyHrSectionUpdates(leave, hrSection);
    }

    await leave.save();

    if (assignedTeamLeadId) {
      const notification = {
        leaveId: String(leave._id),
        employeeName:
          leave.employeeSnapshot?.fullName || targetUser.fullName || "",
        leaveType: leave.leaveType,
        leaveCategory: leave.leaveCategory,
        fromDate: leave.fromDate,
        toDate: leave.toDate,
        submittedAt: leave.createdAt,
        teamLeadStatus: leave.teamLead?.status || "pending",
        teamLeadAssignee: String(assignedTeamLeadId),
      };
      emitToUser(assignedTeamLeadId, "leave:new", notification);
    }

    return res.status(201).json(leave);
  } catch (err) {
    console.error("applyLeave error:", err);
    return res.status(500).json({ message: "Failed to submit leave request" });
  }
}

async function listLeaves(req, res) {
  try {
    const { status, userId, scope, teamLeadStatus } = req.query;
    const filter = {};

    if (status) {
      if (!leaveStatuses.includes(status)) {
        return res.status(400).json({ message: "Invalid status value" });
      }
      filter.status = status;
    }

    if (teamLeadStatus) {
      if (!TEAM_LEAD_REVIEW_STATUSES.includes(teamLeadStatus)) {
        return res.status(400).json({ message: "Invalid team lead status value" });
      }
      filter["teamLead.status"] = teamLeadStatus;
    }

    if (scope === "team_lead") {
      const actor = await User.findById(req.user.id).select("isTeamLead");
      if (!actor?.isTeamLead) {
        return res.status(403).json({ message: "Forbidden" });
      }
      filter.teamLeadAssignee = req.user.id;
    } else if (req.user?.role === "employee") {
      filter.user = req.user.id;
    } else if (userId) {
      filter.user = userId;
    }

    const leaves = await Leave.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const allowanceCache = new Map();
    const allowanceOverrideCache = new Map();
    const enriched = [];
    for (const leave of leaves) {
      const allowance = await getAnnualAllowance(
        leave.user,
        leave.fromDate,
        allowanceCache,
        allowanceOverrideCache
      );
      enriched.push({
        ...leave,
        annualAllowance: allowance ? { ...allowance } : { allowed: ALLOWED_LEAVES_PER_YEAR, used: 0, remaining: ALLOWED_LEAVES_PER_YEAR },
      });
    }

    return res.json(enriched);
  } catch (err) {
    console.error("listLeaves error:", err);
    return res.status(500).json({ message: "Failed to fetch leaves" });
  }
}

async function getLeave(req, res) {
  try {
    const { id } = req.params;
    const leave = await Leave.findById(id);
    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }

    if (req.user?.role === "employee") {
      const isOwner = String(leave.user) === String(req.user.id);
      if (!isOwner) {
        const actor = await User.findById(req.user.id).select("isTeamLead");
        const isAssigned =
          actor?.isTeamLead && leave.teamLeadAssignee && String(leave.teamLeadAssignee) === String(req.user.id);
        if (!isAssigned) {
          return res.status(403).json({ message: "Forbidden" });
        }
      }
    }

    const allowance = await getAnnualAllowance(leave.user, leave.fromDate, new Map(), new Map());
    const payload = leave.toObject();
    payload.annualAllowance = allowance;
    return res.json(payload);
  } catch (err) {
    console.error("getLeave error:", err);
    return res.status(500).json({ message: "Failed to fetch leave" });
  }
}

async function updateLeaveStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, remark } = req.body;

    if (!status || !leaveStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const leave = await Leave.findById(id);
    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }

    const baseUsage = await computeYearlyUsage(leave.user, leave.fromDate, [leave._id]);
    const currentDuration = computeDurationDays(leave);
    const year = new Date(leave.fromDate || Date.now()).getUTCFullYear();
    const override = await LeaveAllowance.findOne({
      user: leave.user,
      year,
    }).lean();

    const allowedValue = override?.allowed ?? ALLOWED_LEAVES_PER_YEAR;
    const manualUsed = override?.used;
    const baselineUsed = manualUsed !== undefined && manualUsed !== null
      ? Math.max(manualUsed, 0)
      : baseUsage;
    const effectiveUsed = Math.max(baselineUsed, baseUsage);

    let resultingUsed = effectiveUsed;

    if (status === "accepted") {
      const prospectiveUsed = effectiveUsed + currentDuration;
      if (prospectiveUsed > allowedValue) {
        const remaining = Math.max(allowedValue - effectiveUsed, 0);
        return res
          .status(400)
          .json({ message: `Annual leave limit exceeded. Remaining leaves: ${remaining}` });
      }
      resultingUsed = prospectiveUsed;
    } else {
      resultingUsed = effectiveUsed;
    }

    const resultingRemaining = Math.max(allowedValue - resultingUsed, 0);

    leave.hrSection = leave.hrSection || {};
    leave.hrSection.annualAllowance = {
      allowed: allowedValue,
      used: resultingUsed,
      remaining: resultingRemaining,
    };

    if (override || status === "accepted") {
      await LeaveAllowance.findOneAndUpdate(
        { user: leave.user, year },
        {
          $set: {
            allowed: allowedValue,
            used: resultingUsed,
            remaining: resultingRemaining,
            updatedBy: new mongoose.Types.ObjectId(req.user.id),
          },
        },
        { upsert: true, new: false, setDefaultsOnInsert: true }
      );
    }

    leave.status = status;
    leave.statusHistory.push({
      status,
      remark: toStringOrEmpty(remark),
      changedBy: new mongoose.Types.ObjectId(req.user.id),
      changedAt: new Date(),
    });
    leave.updatedBy = new mongoose.Types.ObjectId(req.user.id);
    leave.reviewedBy = new mongoose.Types.ObjectId(req.user.id);

    await leave.save();
    return res.json(leave);
  } catch (err) {
    console.error("updateLeaveStatus error:", err);
    return res.status(500).json({ message: "Failed to update status" });
  }
}

async function updateLeave(req, res) {
  try {
    const { id } = req.params;
    const leave = await Leave.findById(id);
    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }

  const {
      employerName,
      designation,
      contactNumber,
      tasksDuringAbsence,
      applicantSignedAt,
      backupStaff = {},
      teamLead = {},
      teamLeadAssignee,
      attachments,
      hrSection,
    } = req.body || {};

    leave.teamLead = leave.teamLead || {};
    leave.backupStaff = leave.backupStaff || {};

    if (employerName !== undefined) leave.employerName = toStringOrEmpty(employerName);
    if (designation !== undefined) leave.designation = toStringOrEmpty(designation);
    if (contactNumber !== undefined) leave.contactNumber = toStringOrEmpty(contactNumber);
    if (tasksDuringAbsence !== undefined) leave.tasksDuringAbsence = toStringOrEmpty(tasksDuringAbsence);
    if (applicantSignedAt !== undefined) leave.applicantSignedAt = toDateOrNull(applicantSignedAt);

    if (backupStaff && typeof backupStaff === "object") {
      if (backupStaff.name !== undefined) leave.backupStaff.name = toStringOrEmpty(backupStaff.name);
    }

    if (teamLeadAssignee !== undefined) {
      if (!teamLeadAssignee) {
        leave.teamLeadAssignee = null;
      } else {
        if (!mongoose.Types.ObjectId.isValid(teamLeadAssignee)) {
          return res.status(400).json({ message: "Invalid team lead identifier" });
        }
        const assigned = await User.findOne({
          _id: teamLeadAssignee,
          isTeamLead: true,
          isApproved: true,
        }).select("_id");
        if (!assigned) {
          return res.status(400).json({ message: "Team lead not available" });
        }
        leave.teamLeadAssignee = assigned._id;
      }
    }

    if (teamLead && typeof teamLead === "object") {
      if (teamLead.remarks !== undefined) leave.teamLead.remarks = toStringOrEmpty(teamLead.remarks);
      if (teamLead.status !== undefined) {
        if (!TEAM_LEAD_REVIEW_STATUSES.includes(teamLead.status)) {
          return res.status(400).json({ message: "Invalid team lead status" });
        }
        leave.teamLead.status = teamLead.status;
        if (teamLead.status === "pending") {
          leave.teamLead.reviewedAt = null;
          leave.teamLead.reviewer = null;
        } else {
          leave.teamLead.reviewedAt = new Date();
          leave.teamLead.reviewer = new mongoose.Types.ObjectId(req.user.id);
        }
      }
      if (teamLead.reviewedAt !== undefined) {
        const dt = toDateOrNull(teamLead.reviewedAt);
        leave.teamLead.reviewedAt = dt;
      }
      if (teamLead.reviewer !== undefined) {
        leave.teamLead.reviewer = mongoose.Types.ObjectId.isValid(teamLead.reviewer)
          ? new mongoose.Types.ObjectId(teamLead.reviewer)
          : leave.teamLead.reviewer;
      }
    }

    if (Array.isArray(attachments)) {
      leave.attachments = attachments.map((a) => String(a));
    }

    if (hrSection) {
      applyHrSectionUpdates(leave, hrSection);
    }

    leave.updatedBy = new mongoose.Types.ObjectId(req.user.id);
    await leave.save();
    return res.json(leave);
  } catch (err) {
    console.error("updateLeave error:", err);
    return res.status(500).json({ message: "Failed to update leave" });
  }
}

async function updateLeaveTeamLead(req, res) {
  try {
    const { id } = req.params;
    const leave = await Leave.findById(id);
    if (!leave) {
      return res.status(404).json({ message: "Leave not found" });
    }

    const actor = await User.findById(req.user.id).select("isTeamLead");
    if (!actor?.isTeamLead) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (!leave.teamLeadAssignee || String(leave.teamLeadAssignee) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not assigned to this leave" });
    }

    const {
      tasksDuringAbsence,
      backupStaff = {},
      teamLead = {},
    } = req.body || {};

    leave.teamLead = leave.teamLead || {};
    leave.backupStaff = leave.backupStaff || {};

    if (tasksDuringAbsence !== undefined) {
      leave.tasksDuringAbsence = toStringOrEmpty(tasksDuringAbsence);
    }

    if (backupStaff && typeof backupStaff === "object") {
      if (backupStaff.name !== undefined) {
        leave.backupStaff.name = toStringOrEmpty(backupStaff.name);
      }
    }

    if (teamLead && typeof teamLead === "object") {
      if (teamLead.remarks !== undefined) {
        leave.teamLead.remarks = toStringOrEmpty(teamLead.remarks);
      }
      if (teamLead.status !== undefined) {
        if (!TEAM_LEAD_REVIEW_STATUSES.includes(teamLead.status)) {
          return res.status(400).json({ message: "Invalid review status" });
        }
        leave.teamLead.status = teamLead.status;
        if (teamLead.status === "pending") {
          leave.teamLead.reviewedAt = null;
          leave.teamLead.reviewer = null;
        } else {
          leave.teamLead.reviewedAt = new Date();
          leave.teamLead.reviewer = new mongoose.Types.ObjectId(req.user.id);
        }
      }
    }

    leave.updatedBy = new mongoose.Types.ObjectId(req.user.id);

    await leave.save();
    return res.json(leave);
  } catch (err) {
    console.error("updateLeaveTeamLead error:", err);
    return res.status(500).json({ message: "Failed to update leave" });
  }
}

function applyHrSectionUpdates(leave, hrSection) {
  if (!hrSection || typeof hrSection !== "object") return;

  const section = leave.hrSection || {};

  if (hrSection.receivedBy !== undefined) section.receivedBy = toStringOrEmpty(hrSection.receivedBy);
  if (hrSection.receivedAt !== undefined) section.receivedAt = toDateOrNull(hrSection.receivedAt);
  if (hrSection.employmentStatus !== undefined) section.employmentStatus = hrSection.employmentStatus || null;
  if (hrSection.decisionForForm !== undefined) section.decisionForForm = hrSection.decisionForForm;

  if (hrSection.annualAllowance && typeof hrSection.annualAllowance === "object") {
    const allowanceSection = section.annualAllowance || {};
    const allowedValue = toNumberOrNull(hrSection.annualAllowance.allowed);
    const remainingValue = toNumberOrNull(hrSection.annualAllowance.remaining);
    const usedValue = toNumberOrNull(hrSection.annualAllowance.used);

    if (allowedValue !== null) {
      allowanceSection.allowed = Math.max(allowedValue, 0);
    }
    if (usedValue !== null) {
      allowanceSection.used = Math.max(usedValue, 0);
    }
    if (remainingValue !== null) {
      allowanceSection.remaining = Math.max(remainingValue, 0);
    }

    if (allowanceSection.allowed !== undefined) {
      if (allowanceSection.remaining === undefined && allowanceSection.used !== undefined) {
        allowanceSection.remaining = Math.max(allowanceSection.allowed - allowanceSection.used, 0);
      } else if (allowanceSection.used === undefined && allowanceSection.remaining !== undefined) {
        allowanceSection.used = Math.max(allowanceSection.allowed - allowanceSection.remaining, 0);
      }
      allowanceSection.used = Math.min(allowanceSection.used || 0, allowanceSection.allowed);
      allowanceSection.remaining = Math.max(
        allowanceSection.allowed - (allowanceSection.used || 0),
        0
      );
    }

    section.annualAllowance = allowanceSection;
  }

  leave.hrSection = section;
}

async function reportLeaveMonthly(req, res) {
  try {
    const { userId, year, month } = req.query;
    if (!year || !month) {
      return res.status(400).json({ message: "year and month are required" });
    }

    const { targetId, user, error } = await resolveTargetUser(req, userId);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const rng = monthRangeUTC(year, month);
    if (!rng) {
      return res.status(400).json({ message: "Invalid year/month" });
    }

    const leaves = await Leave.find({
      user: targetId,
      fromDate: { $gte: rng.start, $lt: rng.end },
    })
      .sort({ fromDate: 1 })
      .lean();

    const allowance = await getAnnualAllowance(targetId, rng.start, new Map(), new Map());

    let requested = 0;
    let approved = 0;
  const entries = leaves.map((doc) => {
    const duration = computeDurationDays(doc);
    requested += duration;
    if (doc.status === "accepted") approved += duration;

    return {
      id: String(doc._id),
      status: doc.status,
      leaveType: doc.leaveType,
      leaveCategory: doc.leaveCategory,
      fromDate: doc.fromDate,
      toDate: doc.toDate,
      durationDays: doc.durationDays,
      durationHours: doc.durationHours,
      reason: doc.leaveReason,
      employerName: doc.employerName,
      designation: doc.designation,
      contactNumber: doc.contactNumber,
      tasksDuringAbsence: doc.tasksDuringAbsence,
      backupStaff: doc.backupStaff,
      teamLead: doc.teamLead,
      applicantSignedAt: doc.applicantSignedAt,
      hrSection: doc.hrSection || null,
      createdAt: doc.createdAt,
      hrDecision: doc.hrSection?.decisionForForm || null,
    };
    });

    return res.json({
      user: {
        id: String(user._id),
        fullName: user.fullName,
        employeeId: user.employeeId,
        department: user.department,
        branch: user.branch,
        city: user.city,
        joiningDate: user.joiningDate,
        signatureImageUrl: user.signatureImageUrl || null,
      },
      period: {
        year: parseInt(year, 10),
        month: parseInt(month, 10),
        range: {
          start: rng.start.toISOString(),
          end: rng.end.toISOString(),
        },
      },
      allowance,
      totals: {
        requested,
        approved,
        remaining: allowance ? allowance.remaining : null,
      },
      entries,
    });
  } catch (err) {
    console.error("reportLeaveMonthly error:", err);
    return res.status(500).json({ message: "Failed to build monthly report" });
  }
}

async function reportLeaveYearly(req, res) {
  try {
    const { userId, year } = req.query;
    if (!year) {
      return res.status(400).json({ message: "year is required" });
    }

    const { targetId, user, error } = await resolveTargetUser(req, userId);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const y = parseInt(year, 10);
    if (Number.isNaN(y)) {
      return res.status(400).json({ message: "Invalid year" });
    }

    const start = new Date(Date.UTC(y, 0, 1));
    const end = new Date(Date.UTC(y + 1, 0, 1));

    const leaves = await Leave.find({
      user: targetId,
      fromDate: { $gte: start, $lt: end },
    })
      .sort({ fromDate: 1 })
      .lean();

    const months = Array.from({ length: 12 }, (_, idx) => ({
      month: idx + 1,
      requested: 0,
      approved: 0,
    }));

    let totalRequested = 0;
    let totalApproved = 0;

    for (const doc of leaves) {
      const duration = computeDurationDays(doc);
      const m = new Date(doc.fromDate).getUTCMonth();
      months[m].requested += duration;
      totalRequested += duration;
      if (doc.status === "accepted") {
        months[m].approved += duration;
        totalApproved += duration;
      }
    }

    let allowed = ALLOWED_LEAVES_PER_YEAR;
    let remaining = Math.max(ALLOWED_LEAVES_PER_YEAR - totalApproved, 0);
    const override = await LeaveAllowance.findOne({
      user: targetId,
      year: y,
    }).lean();
    if (override) {
      if (Number.isFinite(override.allowed)) {
        allowed = override.allowed;
      }
      if (Number.isFinite(override.remaining)) {
        remaining = Math.max(override.remaining, 0);
      } else if (Number.isFinite(override.used)) {
        remaining = Math.max(allowed - override.used, 0);
      }
    }

    return res.json({
      user: {
        id: String(user._id),
        fullName: user.fullName,
        employeeId: user.employeeId,
        department: user.department,
        branch: user.branch,
        city: user.city,
        joiningDate: user.joiningDate,
        signatureImageUrl: user.signatureImageUrl || null,
      },
      year: y,
      months,
      totals: {
        requested: totalRequested,
        approved: totalApproved,
        allowed,
        remaining,
      },
    });
  } catch (err) {
    console.error("reportLeaveYearly error:", err);
    return res.status(500).json({ message: "Failed to build yearly report" });
  }
}

async function updateLeaveAllowance(req, res) {
  try {
    if (!isAdmin(req.user?.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { userId, year, allowed, remaining } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user reference" });
    }
    const parsedYear = parseInt(year, 10);
    if (!Number.isInteger(parsedYear) || parsedYear < 1970) {
      return res.status(400).json({ message: "Invalid year value" });
    }
    const allowedValue = Number(allowed);
    const remainingValue = Number(remaining);
    if (!Number.isFinite(allowedValue) || allowedValue < 0) {
      return res.status(400).json({ message: "Allowed leaves must be a non-negative number" });
    }
    if (!Number.isFinite(remainingValue) || remainingValue < 0) {
      return res.status(400).json({ message: "Remaining balance must be a non-negative number" });
    }
    if (remainingValue > allowedValue) {
      return res.status(400).json({ message: "Remaining balance cannot exceed total allowance" });
    }

    const usedValue = Math.max(allowedValue - remainingValue, 0);
    const referenceDate = new Date(Date.UTC(parsedYear, 0, 1));
    const actualUsage = await computeYearlyUsage(userId, referenceDate);
    const epsilon = 0.0001;
    if (usedValue + epsilon < actualUsage) {
      const maxRemaining = Math.max(allowedValue - actualUsage, 0);
      const approvedText =
        actualUsage === 1
          ? "1 day has already been approved this year"
          : `${formatDaysValue(actualUsage)} days have already been approved this year`;
      return res.status(400).json({
        message: `Remaining balance cannot exceed ${formatDaysValue(maxRemaining)} day(s) because ${approvedText}.`,
        details: {
          actualUsed: actualUsage,
          maxRemaining,
        },
      });
    }

    const updated = await LeaveAllowance.findOneAndUpdate(
      { user: userId, year: parsedYear },
      {
        $set: {
          allowed: allowedValue,
          remaining: remainingValue,
          used: usedValue,
          updatedBy: new mongoose.Types.ObjectId(req.user.id),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({
      userId: String(updated.user),
      year: updated.year,
      allowed: updated.allowed,
      remaining: updated.remaining,
      used: updated.used,
      actualUsed: actualUsage,
      maxRemaining: Math.max(updated.allowed - actualUsage, 0),
      updatedAt: updated.updatedAt,
    });
  } catch (err) {
    console.error("updateLeaveAllowance error:", err);
    return res.status(500).json({ message: "Failed to update allowance" });
  }
}

module.exports = {
  applyLeave,
  listLeaves,
  getLeave,
  updateLeaveStatus,
  updateLeave,
  updateLeaveTeamLead,
  reportLeaveMonthly,
  reportLeaveYearly,
  updateLeaveAllowance,
};


