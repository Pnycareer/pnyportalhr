// controllers/users.controller.js
const User = require('../models/User');
const { toPublicUrl } = require('../utils/url');

function normalizeOfficialOffDays(input) {
  if (!input) return [];
  const raw = Array.isArray(input)
    ? input
    : String(input).split(/[,;\n]/);

  return raw
    .map((day) => String(day || '').trim())
    .filter(Boolean)
    .map((day) => day.charAt(0).toUpperCase() + day.slice(1).toLowerCase());
}

function normalizeDutyRoster(value) {
  const roster = String(value || '').trim();
  return roster || '10am to 7pm';
}

function normalizeSalary(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100) / 100;
}

async function updateUser(req, res) {
  const { id } = req.params;

  const ALLOWED = [
    'fullName',
    'email',
    'department',
    'designation',
    'branch',
    'city',
    'joiningDate',
    'bloodGroup',
    'dutyRoster',
    'officialOffDays',
    'contactNumber',
    'isApproved',
    'role',
    'isTeamLead',
    'salary',
  ];

  const patch = {};
  for (const key of ALLOWED) {
    if (!(key in req.body)) continue;
    const value = req.body[key];
    switch (key) {
      case 'officialOffDays': {
        patch[key] = normalizeOfficialOffDays(value);
        break;
      }
      case 'dutyRoster': {
        patch[key] = normalizeDutyRoster(value);
        break;
      }
      case 'bloodGroup': {
        const group = String(value || '').trim().toUpperCase();
        patch[key] = group || null;
        break;
      }
      case 'designation':
      case 'branch':
      case 'city':
      case 'contactNumber': {
        patch[key] = typeof value === 'string' ? value.trim() : value;
        break;
      }
      case 'salary': {
        const num = normalizeSalary(value);
        if (Number.isNaN(num)) {
          return res
            .status(400)
            .json({ message: 'Invalid salary. Must be a non-negative number.' });
        }
        patch[key] = num;
        break;
      }
      default: {
        patch[key] = value;
      }
    }
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ message: 'No valid fields provided.' });
  }

  if ('role' in patch) {
    if (req.user.role !== 'superadmin') {
      return res
        .status(403)
        .json({ message: 'Only a superadmin can change roles.' });
    }
    if (String(req.user.id) === String(id)) {
      return res
        .status(400)
        .json({ message: 'You cannot change your own role.' });
    }
  }

  const user = await User.findByIdAndUpdate(id, patch, { new: true });
  if (!user) return res.status(404).json({ message: 'Not found' });

  return res.json({
    message: 'Updated',
    user: {
      id: user._id,
      fullName: user.fullName,
      email: user.email,
      employeeId: user.employeeId,
      department: user.department,
      role: user.role,
      isApproved: user.isApproved,
      isTeamLead: user.isTeamLead,
      branch: user.branch,
      city: user.city,
      joiningDate: user.joiningDate,
      designation: user.designation,
      dutyRoster: user.dutyRoster,
      officialOffDays: user.officialOffDays || [],
      bloodGroup: user.bloodGroup || null,
      contactNumber: user.contactNumber,
      salary: user.salary ?? null,
      profileImageUrl: toPublicUrl(user.profileImageUrl),
      signatureImageUrl: user.signatureImageUrl || null,
    },
  });
}

async function listUsers(req, res) {
  const { q, role } = req.query;
  const filter = {};
  if (q) {
    filter.fullName = { $regex: q, $options: 'i' };
  }
  if (role) {
    filter.role = role;
  }
  const users = await User.find(filter)
    .select(
      'fullName email role employeeId department designation branch city joiningDate isApproved isTeamLead signatureImageUrl profileImageUrl dutyRoster officialOffDays bloodGroup contactNumber salary'
    )
    .lean();
  const hydrated = users.map((user) => ({
    ...user,
    profileImageUrl: toPublicUrl(user.profileImageUrl),
  }));
  res.json(hydrated);
}

async function deleteUser(req, res) {
  try {
    const { id } = req.params;

    if (String(req.user.id) === String(id)) {
      return res
        .status(400)
        .json({ message: 'You cannot delete your own account.' });
    }

    const target = await User.findById(id);
    if (!target) return res.status(404).json({ message: 'Not found' });

    if (target.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res
        .status(403)
        .json({ message: 'Only a superadmin can delete a superadmin.' });
    }

    await User.deleteOne({ _id: target._id });
    return res.json({ message: 'Deleted', id: target._id });
  } catch (err) {
    return res
      .status(500)
      .json({ message: err.message || 'Failed to delete user' });
  }
}

async function listTeamLeads(req, res) {
  try {
    const leads = await User.find({ isTeamLead: true, isApproved: true })
      .sort({ fullName: 1 })
      .select(
        'fullName email employeeId department branch city signatureImageUrl profileImageUrl'
      )
      .lean();
    const hydrated = leads.map((lead) => ({
      ...lead,
      profileImageUrl: toPublicUrl(lead.profileImageUrl),
    }));
    return res.json(hydrated);
  } catch (err) {
    return res
      .status(500)
      .json({ message: err.message || 'Failed to load team leads' });
  }
}

async function updateSelfTeamLeadStatus(req, res) {
  try {
    const { isTeamLead } = req.body || {};
    if (typeof isTeamLead !== 'boolean') {
      return res
        .status(400)
        .json({ message: 'isTeamLead boolean is required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.isTeamLead = isTeamLead;
    await user.save();

    return res.json({
      message: isTeamLead
        ? 'Registered as team lead'
        : 'Team lead access removed',
      isTeamLead: user.isTeamLead,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: err.message || 'Failed to update team lead status' });
  }
}

module.exports = {
  updateUser,
  listUsers,
  deleteUser,
  listTeamLeads,
  updateSelfTeamLeadStatus,
};
