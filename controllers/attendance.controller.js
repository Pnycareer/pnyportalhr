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
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}



const ALLOWED = ['present','absent','leave','late','official_off','short_leave'];
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
  x.setUTCHours(0,0,0,0);
  return x;
}

function parseTimeOnDateUtc(baseUtcMidnight, val) {
  if (!val) return null;
  if (/^\d{2}:\d{2}$/.test(val)) {
    const [hh, mm] = val.split(':').map(Number);
    const dt = new Date(baseUtcMidnight);
    dt.setUTCHours(hh, mm, 0, 0);
    return dt;
  }
  const iso = new Date(val);
  return isNaN(iso) ? null : iso;
}

function validateTimes(baseUtcMidnight, checkIn, checkOut) {
  if (!checkIn && !checkOut) return null;
  const dayStart = new Date(baseUtcMidnight);
  const dayEnd = new Date(baseUtcMidnight);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
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
  const set = { status, note: note || '', markedBy };
  if (isOff) {
    set.checkIn = null;
    set.checkOut = null;
    set.workedHours = null;
  } else {
    if (checkIn !== undefined) set.checkIn = checkIn;
    if (checkOut !== undefined) set.checkOut = checkOut;
    const wh = diffHours(checkIn ?? null, checkOut ?? null);
    set.workedHours = wh;
  }
  return set;
}

// --- mark ---
async function mark(req, res) {
  try {
    let { userId, date, status, note, checkIn, checkOut } = req.body;

    status = normalizeStatus(status);
    if (!ALLOWED.includes(status)) return res.status(400).json({ message: 'Invalid status' });

    const targetUser = await User.findById(userId);
    if (!targetUser || !targetUser.isApproved) {
      return res.status(400).json({ message: 'User not approvable/exists' });
    }

    const base = startOfDayUtc(date);
    if (!base) return res.status(400).json({ message: 'Invalid date' });

    const isOff = OFF.has(status);
    const ci = isOff ? null : parseTimeOnDateUtc(base, checkIn);
    const co = isOff ? null : parseTimeOnDateUtc(base, checkOut);

    const timeErr = validateTimes(base, ci, co);
    if (timeErr) return res.status(400).json({ message: timeErr });

    const set = buildSetPayload({ status, note, checkIn: ci, checkOut: co, markedBy: req.user.id, isOff });

    const upsert = await Attendance.findOneAndUpdate(
      { user: userId, date: base },
      { $set: set },
      { new: true, upsert: true }
    );
    res.json(upsert);
  } catch (err) {
    console.error('mark error:', err);
    res.status(500).json({ message: 'Server error' });
  }
}

// --- bulk ---
async function bulk(req, res) {
  try {
    const { date, records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ message: 'No records' });
    }

    const base = startOfDayUtc(date);
    if (!base) return res.status(400).json({ message: 'Invalid date' });

    for (const r of records) {
      const st = normalizeStatus(r.status);
      if (!ALLOWED.includes(st)) return res.status(400).json({ message: `Invalid status for user ${r.userId}` });
      const isOff = OFF.has(st);
      const ci = isOff ? null : parseTimeOnDateUtc(base, r.checkIn);
      const co = isOff ? null : parseTimeOnDateUtc(base, r.checkOut);
      const timeErr = validateTimes(base, ci, co);
      if (timeErr) return res.status(400).json({ message: `User ${r.userId}: ${timeErr}` });
    }

    const ops = records.map(r => {
      const st = normalizeStatus(r.status);
      const isOff = OFF.has(st);
      const ci = isOff ? null : parseTimeOnDateUtc(base, r.checkIn);
      const co = isOff ? null : parseTimeOnDateUtc(base, r.checkOut);
      const set = buildSetPayload({ status: st, note: r.note || '', checkIn: ci, checkOut: co, markedBy: req.user.id, isOff });

      return {
        updateOne: {
          filter: { user: r.userId, date: base },
          update: { $set: set },
          upsert: true,
        }
      };
    });

    const result = await Attendance.bulkWrite(ops);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('bulk error:', err);
    res.status(500).json({ message: 'Server error' });
  }
}

// --- byDate: include workedHours ---
async function byDate(req, res) {
  try {
    const q = req.query?.date;
    if (!q) return res.status(400).json({ message: 'Missing date' });

    const base = startOfDayUtc(`${q}T00:00:00Z`);
    if (!base) return res.status(400).json({ message: 'Invalid date' });

    const rows = await Attendance.find({ date: base }).lean();
    const records = rows.map(r => ({
      userId: String(r.user),
      status: r.status,
      note: r.note || '',
      checkIn: r.checkIn ? r.checkIn.toISOString() : null,
      checkOut: r.checkOut ? r.checkOut.toISOString() : null,
      workedHours: Number.isFinite(r.workedHours) ? r.workedHours : null,
    }));
    res.json({ records });
  } catch (err) {
    console.error('byDate error:', err);
    res.status(500).json({ message: 'Server error' });
  }
}


async function byMonth(req, res) {
const { userId, year, month } = req.query; // month: 1-12
const forUser = userId && (req.user.role !== 'employee') ? userId : req.user.id;
const y = parseInt(year, 10), m = parseInt(month, 10) - 1;
if (isNaN(y) || isNaN(m)) return res.status(400).json({ message: 'Invalid y/m' });


const start = new Date(Date.UTC(y, m, 1));
const end = new Date(Date.UTC(y, m + 1, 1));


const rows = await Attendance.find({ user: forUser, date: { $gte: start, $lt: end } })
.select('date status note')
.sort({ date: 1 });


res.json({ year: y, month: m + 1, days: rows });
}


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
          department: { $ifNull: ['$department', '—'] },
          branch: { $ifNull: ['$branch', '—'] },
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
    res.status(500).json({ message: e.message || 'Failed to build report' });
  }
}


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
      user: new mongoose.Types.ObjectId(targetUserId),
      date: { $gte: rng.start, $lt: rng.end }
    })
      .lean()
      .sort({ date: 1 });

    // summarize
    const totals = {
      present: 0, absent: 0, leave: 0, late: 0, official_off: 0, short_leave: 0
    };
    let workedHours = 0;

    for (const r of rows) {
      if (totals[r.status] != null) totals[r.status] += 1;
      if (Number.isFinite(r.workedHours)) workedHours += r.workedHours;
    }

    // consider "productive days" as present + late (tweak if you want)
    const productiveDays = totals.present + totals.late;
    const avgHours = productiveDays > 0 ? Math.round((workedHours / productiveDays) * 100) / 100 : 0;

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
      meta: {
        user: {
          id: String(targetUserId),
          fullName: user.fullName,
          employeeId: user.employeeId,
          department: user.department || '—',
          branch: user.branch || '—',
        },
        year: parseInt(year, 10),
        month: parseInt(month, 10),
        range: { start: rng.start.toISOString(), end: rng.end.toISOString() }
      },
      summary: {
        totals,
        daysMarked: rows.length,
        workedHours: Math.round(workedHours * 100) / 100,
        avgHours,
      },
      days
    });
  } catch (err) {
    console.error('reportUserMonth error:', err);
    res.status(500).json({ message: 'Server error' });
  }
}


module.exports = { mark, bulk, byMonth , byDate , reportMonthlyByBranch , reportUserMonth};