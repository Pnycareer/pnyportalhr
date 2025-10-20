const mongoose = require("mongoose");
const InstructorOvertime = require("../models/InstructorOvertime");
const User = require("../models/User");

const ADMIN_ROLES = ["superadmin", "admin", "hr"];

function isAdmin(role) {
  return ADMIN_ROLES.includes(role);
}

function normalizeDateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseTimeLabel(raw) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;

  // 24h format HH:mm
  const match24 = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    return hours * 60 + minutes;
  }

  // 12h format h:mm am/pm or h am/pm
  const match12 = value.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/);
  if (match12) {
    let hours = parseInt(match12[1], 10);
    const minutes = parseInt(match12[2] || "0", 10);
    const period = match12[3];
    if (hours === 12) {
      hours = period === "am" ? 0 : 12;
    } else if (period === "pm") {
      hours += 12;
    }
    return hours * 60 + minutes;
  }

  return null;
}

function materializeDateTime(baseDate, minutesFromMidnight) {
  const dt = new Date(baseDate);
  dt.setUTCHours(
    Math.floor(minutesFromMidnight / 60),
    minutesFromMidnight % 60,
    0,
    0
  );
  return dt;
}

function buildOvertimeSlots(dateInput, rawSlots) {
  const normalizedDate = normalizeDateOnly(dateInput);
  if (!normalizedDate) {
    throw new Error("Invalid date supplied for overtime claim");
  }
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
    throw new Error("At least one overtime slot is required");
  }

  const seen = [];
  const slots = rawSlots.map((slot, index) => {
    const startMinutes = parseTimeLabel(slot?.start ?? slot?.from);
    const endMinutes = parseTimeLabel(slot?.end ?? slot?.to);
    if (
      !Number.isFinite(startMinutes) ||
      !Number.isFinite(endMinutes) ||
      startMinutes < 0 ||
      endMinutes < 0
    ) {
      throw new Error(`Invalid time value in slot ${index + 1}`);
    }
    if (endMinutes <= startMinutes) {
      throw new Error(`Overtime slot ${index + 1} must end after it starts`);
    }
    const durationMinutes = endMinutes - startMinutes;
    const from = materializeDateTime(normalizedDate, startMinutes);
    const to = materializeDateTime(normalizedDate, endMinutes);
    seen.push({ startMinutes, endMinutes });
    return {
      from,
      to,
      durationMinutes,
    };
  });

  // optional: detect overlaps
  seen
    .sort((a, b) => a.startMinutes - b.startMinutes)
    .reduce((prev, current, idx) => {
      if (idx === 0) return current;
      if (current.startMinutes < prev.endMinutes) {
        throw new Error("Overtime slots cannot overlap");
      }
      return current;
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

  const user = await User.findById(targetId);
  if (!user) {
    return { error: { status: 404, message: "User not found" } };
  }

  if (isEmployee && String(user._id) !== String(req.user.id)) {
    return { error: { status: 403, message: "Forbidden" } };
  }

  return { user };
}

async function createInstructorOvertime(req, res) {
  try {
    const { userId, date, overtimeSlots, branchName, notes, salary } = req.body;
    const { user, error } = await resolveTargetUser(req, userId);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    let parsedSlots;
    try {
      const parsed = buildOvertimeSlots(date, overtimeSlots);
      parsedSlots = parsed;
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const branchValue =
      branchName !== undefined && branchName !== null
        ? String(branchName).trim()
        : String(user.branch || "").trim();
    if (!branchValue) {
      return res.status(400).json({ message: "Branch name is required" });
    }

    const noteValue =
      notes === undefined || notes === null ? "" : String(notes).trim();

    const instructorNameValue = String(user.fullName || "").trim();
    if (!instructorNameValue) {
      return res.status(400).json({ message: "Instructor name is missing on user profile" });
    }

    const designationValue = String(user.designation || "").trim();
    if (!designationValue) {
      return res.status(400).json({ message: "Instructor designation is required on user profile" });
    }

    const claim = new InstructorOvertime({
      instructor: user._id,
      instructorName: instructorNameValue,
      date: parsedSlots.normalizedDate,
      designation: designationValue,
      branchName: branchValue,
      overtimeSlots: parsedSlots.slots,
      notes: noteValue,
    });

    if (isAdmin(req.user?.role) && salary !== undefined) {
      const numericSalary = Number(salary);
      if (!Number.isFinite(numericSalary) || numericSalary < 0) {
        return res.status(400).json({ message: "Salary must be a positive number" });
      }
      claim.salary = numericSalary;
    }

    await claim.save();
    await claim.populate({
      path: "instructor",
      select: "fullName designation branch email employeeId role",
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
      if (!normalized) {
        return res.status(400).json({ message: "Invalid date filter" });
      }
      const nextDay = new Date(normalized);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      query.date = { $gte: normalized, $lt: nextDay };
    }

    const results = await InstructorOvertime.find(query)
      .sort({ date: -1, createdAt: -1 })
      .populate({
        path: "instructor",
        select: "fullName designation branch email employeeId role",
      });

    return res.json(results);
  } catch (err) {
    console.error("listInstructorOvertime error:", err);
    return res.status(500).json({ message: "Failed to list overtime claims" });
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
      select: "fullName designation branch email employeeId role",
    });
    if (!claim) {
      return res.status(404).json({ message: "Overtime claim not found" });
    }
    if (
      req.user?.role === "employee" &&
      String(claim.instructor?._id || claim.instructor) !== String(req.user.id)
    ) {
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
      select: "fullName designation branch email employeeId role",
    });
    if (!claim) {
      return res.status(404).json({ message: "Overtime claim not found" });
    }
    if (
      req.user?.role === "employee" &&
      String(claim.instructor?._id || claim.instructor) !== String(req.user.id)
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const updates = {};

    if (req.body.date) {
      const normalizedDate = normalizeDateOnly(req.body.date);
      if (!normalizedDate) {
        return res.status(400).json({ message: "Invalid date provided" });
      }
      updates.date = normalizedDate;
      // shift existing slots to new date if no new slots provided
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
      try {
        parsed = buildOvertimeSlots(req.body.date || claim.date, req.body.overtimeSlots);
      } catch (err) {
        return res.status(400).json({ message: err.message });
      }
      updates.overtimeSlots = parsed.slots;
      updates.date = parsed.normalizedDate;
    }

    if (req.body.branchName !== undefined) {
      const branchValue = String(req.body.branchName).trim();
      if (!branchValue) {
        return res.status(400).json({ message: "Branch name cannot be empty" });
      }
      updates.branchName = branchValue;
    }

    if (req.body.notes !== undefined) {
      updates.notes = String(req.body.notes || "").trim();
    }

    if (req.body.salary !== undefined) {
      if (!isAdmin(req.user?.role)) {
        return res.status(403).json({ message: "Only admin roles can update salary" });
      }
      const numericSalary = Number(req.body.salary);
      if (!Number.isFinite(numericSalary) || numericSalary < 0) {
        return res.status(400).json({ message: "Salary must be a positive number" });
      }
      updates.salary = numericSalary;
    }

    const keys = Object.keys(updates);
    if (!keys.length) {
      return res.json(claim);
    }

    keys.forEach((key) => {
      claim[key] = updates[key];
    });

    // refresh snapshot info from user if required
    if (claim.instructor) {
      const userSnapshot =
        claim.instructor.fullName !== undefined ? claim.instructor : await User.findById(claim.instructor);
      if (userSnapshot) {
        const fullName = String(userSnapshot.fullName || "").trim();
        if (fullName) {
          claim.instructorName = fullName;
        }
        const designation = String(userSnapshot.designation || "").trim();
        if (designation) {
          claim.designation = designation;
        }
        if (!req.body.branchName) {
          const branch = String(userSnapshot.branch || "").trim();
          if (branch) {
            claim.branchName = branch;
          }
        }
      }
    }

    await claim.save();
    await claim.populate({
      path: "instructor",
      select: "fullName designation branch email employeeId role",
    });

    return res.json(claim);
  } catch (err) {
    console.error("updateInstructorOvertime error:", err);
    return res.status(500).json({ message: "Failed to update overtime claim" });
  }
}

module.exports = {
  createInstructorOvertime,
  listInstructorOvertime,
  getInstructorOvertime,
  updateInstructorOvertime,
};
