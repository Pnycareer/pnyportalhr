// controllers/instructorOvertime.controller.js
const mongoose = require("mongoose");
const InstructorOvertime = require("../models/InstructorOvertime");
const User = require("../models/User");

const ADMIN_ROLES = ["superadmin", "admin", "hr"];
function isAdmin(role) { return ADMIN_ROLES.includes(role); }

function normalizeDateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseTimeLabel(raw) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;

  const match24 = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    return hours * 60 + minutes;
  }
  const match12 = value.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/);
  if (match12) {
    let hours = parseInt(match12[1], 10);
    const minutes = parseInt(match12[2] || "0", 10);
    const period = match12[3];
    if (hours === 12) hours = period === "am" ? 0 : 12;
    else if (period === "pm") hours += 12;
    return hours * 60 + minutes;
  }
  return null;
}

function materializeDateTime(baseDate, minutesFromMidnight) {
  const dt = new Date(baseDate);
  dt.setUTCHours(Math.floor(minutesFromMidnight / 60), minutesFromMidnight % 60, 0, 0);
  return dt;
}

function toNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getDaysInMonthFromDate(dateLike) {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function calcOvertimePayoutValue(claim) {
  if (!claim) return null;
  const monthlyFromClaim = toNumberOrNull(claim.salary);
  const monthlyFromProfile = toNumberOrNull(claim?.instructor?.salary);
  const monthly = monthlyFromClaim ?? monthlyFromProfile;
  const minutes = toNumberOrNull(claim.totalDurationMinutes);
  const days = getDaysInMonthFromDate(claim.date);
  if (
    monthly === null ||
    minutes === null ||
    !Number.isFinite(days) ||
    days <= 0
  ) {
    return null;
  }
  const perMinute = monthly / days / 9 / 60;
  return perMinute * minutes;
}

function buildOvertimeSlots(dateInput, rawSlots) {
  const normalizedDate = normalizeDateOnly(dateInput);
  if (!normalizedDate) throw new Error("Invalid date supplied for overtime claim");
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
    throw new Error("At least one overtime slot is required");
  }

  const seen = [];
  const slots = rawSlots.map((slot, index) => {
    const startMinutes = parseTimeLabel(slot?.start ?? slot?.from);
    const endMinutes = parseTimeLabel(slot?.end ?? slot?.to);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || startMinutes < 0 || endMinutes < 0) {
      throw new Error(`Invalid time value in slot ${index + 1}`);
    }
    if (endMinutes <= startMinutes) throw new Error(`Overtime slot ${index + 1} must end after it starts`);
    const durationMinutes = endMinutes - startMinutes;
    const from = materializeDateTime(normalizedDate, startMinutes);
    const to = materializeDateTime(normalizedDate, endMinutes);
    seen.push({ startMinutes, endMinutes });
    return { from, to, durationMinutes };
  });

  seen.sort((a,b)=>a.startMinutes-b.startMinutes).reduce((prev,curr,idx)=>{
    if (idx === 0) return curr;
    if (curr.startMinutes < prev.endMinutes) throw new Error("Overtime slots cannot overlap");
    return curr;
  }, null);

  return { normalizedDate, slots };
}

async function resolveTargetUser(req, explicitUserId) {
  const requesterRole = req.user?.role;
  const isEmployee = requesterRole === "employee";
  const targetId = isEmployee ? req.user.id : explicitUserId || req.user.id;
  if (!mongoose.isValidObjectId(targetId)) {
    return { error: { status: 400, message: "Invalid user reference" } };
  }
  const user = await User.findById(targetId).select("+salary");
  if (!user) return { error: { status: 404, message: "User not found" } };
  if (isEmployee && String(user._id) !== String(req.user.id)) {
    return { error: { status: 403, message: "Forbidden" } };
  }
  return { user };
}

async function createInstructorOvertime(req, res) {
  try {
    const { userId, date, overtimeSlots, branchName, notes, salary } = req.body;
    const { user, error } = await resolveTargetUser(req, userId);
    if (error) return res.status(error.status).json({ message: error.message });

    let parsedSlots;
    try { parsedSlots = buildOvertimeSlots(date, overtimeSlots); }
    catch (err) { return res.status(400).json({ message: err.message }); }

    const branchValue =
      branchName !== undefined && branchName !== null
        ? String(branchName).trim()
        : String(user.branch || "").trim();
    if (!branchValue) return res.status(400).json({ message: "Branch name is required" });

    const noteValue = notes === undefined || notes === null ? "" : String(notes).trim();
    const instructorNameValue = String(user.fullName || "").trim();
    const salaryinfo = String(user.salary || "").trim();
    if (!instructorNameValue) return res.status(400).json({ message: "Instructor name is missing on user profile" });
    if (!salaryinfo) return res.status(400).json({ message: "Salary missing on user profile" });

    const designationValue = String(user.designation || "").trim();
    if (!designationValue) return res.status(400).json({ message: "Instructor designation is required on user profile" });

    const claim = new InstructorOvertime({
      instructor: user._id,
      instructorName: instructorNameValue,
      salary: salaryinfo,
      date: parsedSlots.normalizedDate,
      designation: designationValue,
      branchName: branchValue,
      overtimeSlots: parsedSlots.slots,
      notes: noteValue,
    });

    if (isAdmin(req.user?.role) && salary !== undefined) {
      const numericSalary = Number(salary);
      if (!Number.isFinite(numericSalary) || numericSalary < 0) {
        return res.status(400).json({ message: "Salary must be a non-negative number" });
      }
      claim.salary = numericSalary;
    }

    if (claim.salary === undefined || claim.salary === null) {
      const numericProfileSalary = Number(user.salary);
      if (Number.isFinite(numericProfileSalary) && numericProfileSalary >= 0) {
        claim.salary = numericProfileSalary;
      }
    }

    await claim.save();
    await claim.populate({
      path: "instructor",
      select: "fullName designation branch email employeeId role +salary",
    });

    return res.status(201).json(claim);
  } catch (err) {
    console.error("createInstructorOvertime error:", err);
    return res.status(500).json({ message: "Failed to create overtime claim" });
  }
}

async function listInstructorOvertime(req, res) {
  try {
    const query = {};
    if (req.user?.role === "employee") {
      query.instructor = req.user.id;
    } else if (req.query.userId && mongoose.isValidObjectId(req.query.userId)) {
      query.instructor = req.query.userId;
    }
    if (req.query.date) {
      const normalized = normalizeDateOnly(req.query.date);
      if (!normalized) return res.status(400).json({ message: "Invalid date filter" });
      const nextDay = new Date(normalized);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      query.date = { $gte: normalized, $lt: nextDay };
    }
    if (req.query.verified === "true") query.verified = true;
    if (req.query.verified === "false") query.verified = false;

    const results = await InstructorOvertime.find(query)
      .sort({ date: -1, createdAt: -1 })
      .populate({
        path: "instructor",
        select: "fullName designation branch email employeeId role +salary",
      });

    return res.json(results);
  } catch (err) {
    console.error("listInstructorOvertime error:", err);
    return res.status(500).json({ message: "Failed to list overtime claims" });
  }
}

async function getMonthlyOvertimeReport(req, res) {
  try {
    const requesterRole = req.user?.role;
    if (!isAdmin(requesterRole)) {
      return res.status(403).json({ message: "Only admin roles can view overtime reports" });
    }

    const rawYear = Number(req.query.year);
    const rawMonth = Number(req.query.month);
    if (!Number.isInteger(rawYear) || !Number.isInteger(rawMonth) || rawMonth < 1 || rawMonth > 12) {
      return res.status(400).json({ message: "Provide numeric year and month (1-12)" });
    }

    const start = new Date(Date.UTC(rawYear, rawMonth - 1, 1));
    const end = new Date(Date.UTC(rawYear, rawMonth, 1));

    const match = { date: { $gte: start, $lt: end } };
    let instructorObjectId = null;
    if (req.query.instructorId) {
      if (!mongoose.isValidObjectId(req.query.instructorId)) {
        return res.status(400).json({ message: "Invalid instructor reference" });
      }
      instructorObjectId = new mongoose.Types.ObjectId(req.query.instructorId);
    }
    if (req.query.branchName) {
      match.branchName = { $regex: new RegExp(`^${String(req.query.branchName).trim()}`, "i") };
    }
    if (req.query.verified === "true") match.verified = true;
    if (req.query.verified === "false") match.verified = false;

    const groups = await InstructorOvertime.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$instructor",
          instructorId: { $first: "$instructor" },
          instructorName: { $last: "$instructorName" },
          designation: { $last: "$designation" },
          branchName: { $last: "$branchName" },
          totalClaims: { $sum: 1 },
          totalMinutes: { $sum: { $ifNull: ["$totalDurationMinutes", 0] } },
          verifiedClaims: {
            $sum: {
              $cond: [{ $eq: ["$verified", true] }, 1, 0],
            },
          },
          latestClaimDate: { $max: "$date" },
        },
      },
      {
        $sort: { totalClaims: -1, instructorName: 1 },
      },
    ]);

    const totals = groups.reduce(
      (acc, item) => {
        acc.totalClaims += item.totalClaims;
        acc.totalMinutes += item.totalMinutes || 0;
        acc.totalVerifiedClaims += item.verifiedClaims || 0;
        return acc;
      },
      { totalClaims: 0, totalMinutes: 0, totalVerifiedClaims: 0 }
    );

    const summary = {
      period: {
        year: rawYear,
        month: rawMonth,
        label: start.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      },
      filters: {
        branchName: req.query.branchName || null,
        verified: req.query.verified ?? null,
      },
      totals: {
        uniqueInstructors: groups.length,
        totalClaims: totals.totalClaims,
        totalMinutes: totals.totalMinutes,
        totalHours: Math.round((totals.totalMinutes / 60) * 100) / 100,
        totalVerifiedClaims: totals.totalVerifiedClaims,
      },
      instructors: groups.map((item) => ({
        instructorId: item.instructorId,
        instructorName: item.instructorName || "Unknown",
        designation: item.designation || "",
        branchName: item.branchName || "",
        totalClaims: item.totalClaims,
        verifiedClaims: item.verifiedClaims,
        totalMinutes: item.totalMinutes,
        totalHours: Math.round((item.totalMinutes / 60) * 100) / 100,
        latestClaimDate: item.latestClaimDate,
      })),
    };

    if (instructorObjectId) {
      const claims = await InstructorOvertime.find({
        instructor: instructorObjectId,
        date: { $gte: start, $lt: end },
      })
        .sort({ date: -1, createdAt: -1 })
        .lean();

      const aggregateEntry = groups.find(
        (item) => item.instructorId && String(item.instructorId) === String(instructorObjectId)
      );

      const claimsWithPayout = claims.map((claim) => {
        const computedPayout = calcOvertimePayoutValue(claim);
        return {
          ...claim,
          calculatedPayout: Number.isFinite(computedPayout) ? computedPayout : null,
        };
      });

      const instructorTotals = claimsWithPayout.reduce(
        (acc, claim) => {
          const salaryValue = toNumberOrNull(claim.salary);
          if (salaryValue !== null) acc.totalSalary += salaryValue;
          if (claim.verified && Number.isFinite(claim.calculatedPayout)) {
            acc.totalCalculatedPayout += claim.calculatedPayout;
          }
          return acc;
        },
        { totalSalary: 0, totalCalculatedPayout: 0 }
      );

      summary.selectedInstructor = aggregateEntry
        ? {
            instructorId: aggregateEntry.instructorId,
            instructorName: aggregateEntry.instructorName || "Unknown",
            designation: aggregateEntry.designation || "",
            branchName: aggregateEntry.branchName || "",
            totalClaims: aggregateEntry.totalClaims,
            verifiedClaims: aggregateEntry.verifiedClaims,
            totalMinutes: aggregateEntry.totalMinutes,
            totalHours: Math.round((aggregateEntry.totalMinutes / 60) * 100) / 100,
            claims: claimsWithPayout,
            totals: {
              totalSalary: instructorTotals.totalSalary,
              totalCalculatedPayout: Math.round(instructorTotals.totalCalculatedPayout * 100) / 100,
            },
          }
        : {
            instructorId: instructorObjectId,
            instructorName: "Unknown",
            designation: "",
            branchName: "",
            totalClaims: 0,
            verifiedClaims: 0,
            totalMinutes: 0,
            totalHours: 0,
            claims: [],
            totals: {
              totalSalary: 0,
              totalCalculatedPayout: 0,
            },
          };
    } else {
      summary.selectedInstructor = null;
    }

    return res.json(summary);
  } catch (err) {
    console.error("getMonthlyOvertimeReport error:", err);
    return res.status(500).json({ message: "Failed to build overtime report" });
  }
}

async function getInstructorOvertime(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid overtime identifier" });
    }
    const claim = await InstructorOvertime.findById(id).populate({
      path: "instructor",
      select: "fullName designation branch email employeeId role +salary",
    });
    if (!claim) return res.status(404).json({ message: "Overtime claim not found" });
    if (req.user?.role === "employee" && String(claim.instructor?._id || claim.instructor) !== String(req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    return res.json(claim);
  } catch (err) {
    console.error("getInstructorOvertime error:", err);
    return res.status(500).json({ message: "Failed to fetch overtime claim" });
  }
}

async function updateInstructorOvertime(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid overtime identifier" });
    }

    const claim = await InstructorOvertime.findById(id).populate({
      path: "instructor",
      select: "fullName designation branch email employeeId role +salary",
    });
    if (!claim) return res.status(404).json({ message: "Overtime claim not found" });
    if (req.user?.role === "employee" && String(claim.instructor?._id || claim.instructor) !== String(req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const updates = {};

    if (req.body.date) {
      const normalizedDate = normalizeDateOnly(req.body.date);
      if (!normalizedDate) return res.status(400).json({ message: "Invalid date provided" });
      updates.date = normalizedDate;
      if (!req.body.overtimeSlots && Array.isArray(claim.overtimeSlots)) {
        updates.overtimeSlots = claim.overtimeSlots.map((slot) => {
          const durationMinutes = slot.durationMinutes;
          const fromDate = slot.from instanceof Date ? slot.from : new Date(slot.from);
          const startMinutes = Number.isNaN(fromDate.getTime())
            ? 0
            : fromDate.getUTCHours() * 60 + fromDate.getUTCMinutes();
          const endMinutes = startMinutes + durationMinutes;
          return {
            from: materializeDateTime(normalizedDate, startMinutes),
            to: materializeDateTime(normalizedDate, endMinutes),
            durationMinutes,
          };
        });
      }
    }

    if (req.body.overtimeSlots) {
      let parsed;
      try { parsed = buildOvertimeSlots(req.body.date || claim.date, req.body.overtimeSlots); }
      catch (err) { return res.status(400).json({ message: err.message }); }
      updates.overtimeSlots = parsed.slots;
      updates.date = parsed.normalizedDate;
    }

    if (req.body.branchName !== undefined) {
      const branchValue = String(req.body.branchName).trim();
      if (!branchValue) return res.status(400).json({ message: "Branch name cannot be empty" });
      updates.branchName = branchValue;
    }

    if (req.body.notes !== undefined) updates.notes = String(req.body.notes || "").trim();

    if (req.body.salary !== undefined) {
      if (!isAdmin(req.user?.role)) return res.status(403).json({ message: "Only admin roles can update salary" });
      const numericSalary = Number(req.body.salary);
      if (!Number.isFinite(numericSalary) || numericSalary < 0) {
        return res.status(400).json({ message: "Salary must be a non-negative number" });
      }
      updates.salary = numericSalary;
    }

    if (req.body.verified !== undefined) {
      if (!isAdmin(req.user?.role)) return res.status(403).json({ message: "Only admin roles can verify" });
      updates.verified = !!req.body.verified;
    }

    const keys = Object.keys(updates);
    if (!keys.length) return res.json(claim);

    keys.forEach((k) => { claim[k] = updates[k]; });

    if (claim.instructor) {
      const userSnapshot =
        claim.instructor.fullName !== undefined ? claim.instructor : await User.findById(claim.instructor).select("+salary");
      if (userSnapshot) {
        const fullName = String(userSnapshot.fullName || "").trim();
        if (fullName) claim.instructorName = fullName;
        const designation = String(userSnapshot.designation || "").trim();
        if (designation) claim.designation = designation;
        if (updates.branchName === undefined) {
          const branch = String(userSnapshot.branch || "").trim();
          if (branch) claim.branchName = branch;
        }
      }
    }

    await claim.save();
    await claim.populate({
      path: "instructor",
      select: "fullName designation branch email employeeId role +salary",
    });

    return res.json(claim);
  } catch (err) {
    console.error("updateInstructorOvertime error:", err);
    return res.status(500).json({ message: "Failed to update overtime claim" });
  }
}

async function deleteInstructorOvertime(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid overtime identifier" });
    }

    const claim = await InstructorOvertime.findById(id).select("instructor verified");
    if (!claim) return res.status(404).json({ message: "Overtime claim not found" });

    // employee can only delete own; admins can delete any
    if (req.user?.role === "employee" && String(claim.instructor) !== String(req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // (Optional hard rule) don’t let anyone delete verified claims unless admin
    if (claim.verified && !isAdmin(req.user?.role)) {
      return res.status(403).json({ message: "Verified claims can only be deleted by admin" });
    }

    await InstructorOvertime.deleteOne({ _id: id });

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteInstructorOvertime error:", err);
    return res.status(500).json({ message: "Failed to delete overtime claim" });
  }
}

module.exports = {
  createInstructorOvertime,
  listInstructorOvertime,
  getMonthlyOvertimeReport,
  getInstructorOvertime,
  updateInstructorOvertime,
  deleteInstructorOvertime, // NEW
};
