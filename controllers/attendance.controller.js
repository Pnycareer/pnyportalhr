const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { OFF } = require('../models/Attendance');
const mongoose = require('mongoose')

function monthRangeUTC(year, month1to12) {
  const y = parseInt(year, 10);
  const m = parseInt(month1to12, 10) - 1;
  if (isNaN(y) || isNaN(m)) return null;
  const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

function isoToHHMM(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

const ALLOWED = ['present','absent','leave','late','official_off','short_leave' , "public_holiday"];
const LEGACY_MAP = { 'official off': 'official_off', 'Short leave': 'short_leave' };

function normalizeStatus(s) {
  if (!s) return s;
  const raw = String(s).trim();
  const lowered = raw.toLowerCase().replace(/\s+/g, '_');
  return LEGACY_MAP[raw] || LEGACY_MAP[lowered] || lowered;
}

function startOfDayUtc(d) {
  const x = new Date(d);
  if (isNaN(x)) return null;
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function endOfDayUtc(d) {
  const x = new Date(d);
  if (isNaN(x)) return null;
  x.setUTCHours(24, 0, 0, 0);
  return x;
}

function validateSameDayUTC(anchorDate, checkIn, checkOut) {
  if (!anchorDate) return 'date is required';
  const date = new Date(anchorDate);
  if (isNaN(date)) return 'Invalid date';
  const dayStart = startOfDayUtc(date);
  const dayEnd = endOfDayUtc(date);
  if (checkIn && (checkIn < dayStart || checkIn >= dayEnd)) return 'checkIn must be on the same calendar day as `date` (UTC)';
  if (checkOut && (checkOut < dayStart || checkOut >= dayEnd)) return 'checkOut must be on the same calendar day as `date` (UTC)';
  if (checkIn && checkOut && checkOut < checkIn) return 'checkOut cannot be earlier than checkIn';
  return null;
}

function diffHours(a, b) {
  if (!a || !b) return null;
  const ms = b - a;
  if (!Number.isFinite(ms) || ms < 0) return null;
  const hours = ms / 3600000;
  return Math.round(hours * 100) / 100; // 2 decimals
}

function buildSetPayload({ status, note, checkIn, checkOut, markedBy, isOff }) {
  const set = { status, note: note || null, markedBy };
  if (isOff) {
    set.checkIn = null;
    set.checkOut = null;
    set.workedHours = null;
  } else {
    set.checkIn = checkIn || null;
    set.checkOut = checkOut || null;
    set.workedHours = (checkIn && checkOut) ? diffHours(checkIn, checkOut) : null;
  }
  return set;
}

/**
 * POST /api/attendance/mark
 * body: { userId, date (YYYY-MM-DD), status, note, checkIn('HH:MM'), checkOut('HH:MM') }
 */
async function mark(req, res) {
  try {
    const { userId, date, status: rawStatus, note, checkIn: hhmmIn, checkOut: hhmmOut } = req.body || {};
    if (!userId || !isValidObjectId(userId)) return res.status(400).json({ message: 'Valid userId required' });

    const status = normalizeStatus(rawStatus);
    if (!ALLOWED.includes(status)) return res.status(400).json({ message: `Invalid status. Allowed: ${ALLOWED.join(', ')}` });

    const day = startOfDayUtc(date);
    if (!day) return res.status(400).json({ message: 'Invalid date' });

    // build checkIn/checkOut
    let checkIn = null, checkOut = null;
    if (!OFF.has(status)) {
      if (hhmmIn) {
        const [h1, m1] = String(hhmmIn).split(':').map(Number);
        if (Number.isInteger(h1) && Number.isInteger(m1)) {
          checkIn = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h1, m1, 0, 0));
        }
      }
      if (hhmmOut) {
        const [h2, m2] = String(hhmmOut).split(':').map(Number);
        if (Number.isInteger(h2) && Number.isInteger(m2)) {
          checkOut = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h2, m2, 0, 0));
        }
      }
    }

    const sameDayErr = validateSameDayUTC(day, checkIn, checkOut);
    if (sameDayErr) return res.status(400).json({ message: sameDayErr });

    const set = buildSetPayload({
      status,
      note,
      checkIn,
      checkOut,
      markedBy: req.user && req.user.id ? req.user.id : null,
      isOff: OFF.has(status)
    });

    const doc = await Attendance.findOneAndUpdate(
      { user: userId, date: day },
      { $set: set, $setOnInsert: { user: userId, date: day } },
      { upsert: true, new: true }
    );

    res.json({ message: 'Marked', doc });
  } catch (e) {
    console.error('mark error:', e);
    res.status(500).json({ message: 'Server error' });
  }
}

/**
 * POST /api/attendance/bulk
 * body: { items: [{ userId, date, status, note, checkIn, checkOut }...] }
 */
async function bulk(req, res) {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ message: 'No items' });

    const ops = [];
    for (const item of items) {
      const { userId, date, status: rawStatus, note, checkIn: inStr, checkOut: outStr } = item || {};
      if (!userId || !isValidObjectId(userId)) continue;

      const status = normalizeStatus(rawStatus);
      if (!ALLOWED.includes(status)) continue;

      const day = startOfDayUtc(date);
      if (!day) continue;

      let checkIn = null, checkOut = null;
      if (!OFF.has(status)) {
        if (inStr) {
          const [h1, m1] = String(inStr).split(':').map(Number);
          if (Number.isInteger(h1) && Number.isInteger(m1)) {
            checkIn = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h1, m1, 0, 0));
          }
        }
        if (outStr) {
          const [h2, m2] = String(outStr).split(':').map(Number);
          if (Number.isInteger(h2) && Number.isInteger(m2)) {
            checkOut = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h2, m2, 0, 0));
          }
        }
      }

      const sameDayErr = validateSameDayUTC(day, checkIn, checkOut);
      if (sameDayErr) continue;

      const set = buildSetPayload({
        status,
        note,
        checkIn,
        checkOut,
        markedBy: req.user && req.user.id ? req.user.id : null,
        isOff: OFF.has(status)
      });

      ops.push({
        updateOne: {
          filter: { user: userId, date: day },
          update: { $set: set, $setOnInsert: { user: userId, date: day } },
          upsert: true
        }
      });
    }

    if (!ops.length) return res.status(400).json({ message: 'No valid items to process' });

    const result = await Attendance.bulkWrite(ops, { ordered: false });
    res.json({ message: 'Bulk mark complete', result });
  } catch (e) {
    console.error('bulk error:', e);
    res.status(500).json({ message: 'Server error' });
  }
}

/**
 * GET /api/attendance/by-month?userId=&year=&month=
 */
async function byMonth(req, res) {
  try {
    const { userId, year, month } = req.query;
    if (!userId || !isValidObjectId(userId)) return res.status(400).json({ message: 'Valid userId required' });
    const rng = monthRangeUTC(year, month);
    if (!rng) return res.status(400).json({ message: 'Invalid year/month' });

    const rows = await Attendance.find({
      user: userId,
      date: { $gte: rng.start, $lt: rng.end }
    }).sort({ date: 1 }).lean();

    res.json({ year: parseInt(year, 10), month: parseInt(month, 10), userId, rows });
  } catch (e) {
    console.error('byMonth error:', e);
    res.status(500).json({ message: 'Server error' });
  }
}

/**
 * GET /api/attendance/by-date?userId=&date=YYYY-MM-DD
 */
async function byDate(req, res) {
  try {
    const { userId, date } = req.query;
    if (!userId || !isValidObjectId(userId)) return res.status(400).json({ message: 'Valid userId required' });
    const day = startOfDayUtc(date);
    if (!day) return res.status(400).json({ message: 'Invalid date' });

    const doc = await Attendance.findOne({ user: userId, date: day }).lean();
    res.json({ date: day.toISOString().slice(0, 10), userId, doc });
  } catch (e) {
    console.error('byDate error:', e);
    res.status(500).json({ message: 'Server error' });
  }
}

/**
 * GET /api/attendance/report/monthly-by-branch?branch=all|Name&year=&month=
 */
async function reportMonthlyByBranch(req, res) {
  try {
    const { branch = 'all', year, month } = req.query;
    const rng = monthRangeUTC(year, month);
    if (!rng) return res.status(400).json({ message: 'Invalid year/month' });

    // Build user match: only approved; optional branch filter
    const userMatch = { isApproved: true };
    if (branch && branch !== 'all') userMatch.branch = branch;

    // Aggregate users -> lookup attendance in range -> compute counts per status
    const rows = await User.aggregate([
      { $match: userMatch },
      {
        $project: {
          fullName: 1,
          employeeId: 1,
          department: 1,
          branch: 1,
        }
      },
      {
        $lookup: {
          from: 'attendances',
          let: { uid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$user', '$$uid'] },
                    { $gte: ['$date', rng.start] },
                    { $lt: ['$date', rng.end] },
                  ]
                }
              }
            },
            {
              // squeeze to 1 doc w/ counts to reduce data transfer
              $group: {
                _id: '$user',
                present:      { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
                absent:       { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
                leave:        { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
                late:         { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
                official_off: { $sum: { $cond: [{ $eq: ['$status', 'official_off'] }, 1, 0] } },
                short_leave:  { $sum: { $cond: [{ $eq: ['$status', 'short_leave'] }, 1, 0] } },
                public_holiday: { $sum: { $cond: [{ $eq: ['$status', 'public_holiday'] }, 1, 0] } },
              }
            }
          ],
          as: 'agg'
        }
      },
      {
        $addFields: {
          agg: { $ifNull: [{ $first: '$agg' }, {}] }
        }
      },
      {
        $project: {
          fullName: 1,
          employeeId: 1,
          department: 1,
          branch: 1,
          present:      { $ifNull: ['$agg.present', 0] },
          absent:       { $ifNull: ['$agg.absent', 0] },
          leave:        { $ifNull: ['$agg.leave', 0] },
          late:         { $ifNull: ['$agg.late', 0] },
          official_off: { $ifNull: ['$agg.official_off', 0] },
          short_leave:  { $ifNull: ['$agg.short_leave', 0] },
          public_holiday: { $ifNull: ['$agg.public_holiday', 0] },
          paid_days: {
            $add: [
              { $ifNull: ['$agg.present', 0] },
              { $ifNull: ['$agg.leave', 0] },
              { $ifNull: ['$agg.official_off', 0] },
              { $ifNull: ['$agg.public_holiday', 0] }
            ]
          },
        }
      },
      { $sort: { department: 1, fullName: 1 } }
    ]);

    // group client-friendly: { department: [{row}...] }
    res.json({
      year: parseInt(year, 10),
      month: parseInt(month, 10),
      branch: branch || 'all',
      rows
    });
  } catch (e) {
    res.status(500).json({ message: e.message || 'Failed to build branch report' });
  }
}

/**
 * GET /api/attendance/report/user-month?userId=&year=&month=
 * - If caller is employee, userId is ignored and their own data is returned.
 */
async function reportUserMonth(req, res) {
  try {
    let { userId, year, month } = req.query;
    if (!year || !month) return res.status(400).json({ message: 'year/month required' });

    // enforce visibility
    const isEmployee = req.user?.role === 'employee';
    const targetUserId = isEmployee ? req.user.id : (userId || req.user.id);

    // validate user exists/approved (optional but helpful)
    const user = await User.findById(targetUserId).select('fullName employeeId department branch isApproved').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.isApproved && !['superadmin','admin','hr'].includes(req.user.role)) {
      return res.status(403).json({ message: 'User not approved' });
    }

    const rng = monthRangeUTC(year, month);
    if (!rng) return res.status(400).json({ message: 'Invalid year/month' });

    const rows = await Attendance.find({
      user: targetUserId,
      date: { $gte: rng.start, $lt: rng.end }
    }).sort({ date: 1 });

    // summarize
    const totals = {
      present: 0, absent: 0, leave: 0, late: 0, official_off: 0, short_leave: 0, public_holiday: 0
    };
    let workedHours = 0;

    for (const r of rows) {
      if (totals[r.status] != null) totals[r.status] += 1;
      if (Number.isFinite(r.workedHours)) workedHours += r.workedHours;
    }

    // consider "productive days" as present + late (tweak if you want)
    const productiveDays = totals.present + totals.late;
    const avgHours = productiveDays > 0 ? Math.round((workedHours / productiveDays) * 100) / 100 : 0;
    const paidDays = totals.present + totals.leave + totals.official_off + totals.public_holiday;

    // per-day listing for the table
    const days = rows.map(r => ({
      _id: String(r._id),
      date: r.date.toISOString().slice(0, 10), // YYYY-MM-DD
      status: r.status,
      note: r.note || '',
      checkIn: isoToHHMM(r.checkIn ? r.checkIn.toISOString() : null),
      checkOut: isoToHHMM(r.checkOut ? r.checkOut.toISOString() : null),
      workedHours: Number.isFinite(r.workedHours) ? r.workedHours : null,
    }));

    res.json({
      year: parseInt(year, 10),
      month: parseInt(month, 10),
      user: {
        _id: String(targetUserId),
        fullName: user.fullName,
        employeeId: user.employeeId,
        department: user.department,
        branch: user.branch
      },
      summary: {
        totals,
        daysMarked: rows.length,
        workedHours: Math.round(workedHours * 100) / 100,
        avgHours,
        paidDays,
      },
      days
    });
  } catch (err) {
    console.error('reportUserMonth error:', err);
    res.status(500).json({ message: 'Server error' });
  }
}


module.exports = { mark, bulk, byMonth , byDate , reportMonthlyByBranch , reportUserMonth};
