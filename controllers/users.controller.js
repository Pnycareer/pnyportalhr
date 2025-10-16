// controllers/users.controller.js
const User = require('../models/User');

async function updateUser(req, res) {
  const { id } = req.params;

  // only allow these fields to be set via general updates
  const ALLOWED = [
    'fullName',
    'email',
    'department',
    'branch',
    'city',
    'joiningDate',
    'isApproved', // approve / reject
    'role',       // role change (extra-guarded below)
  ];

  const patch = {};
  for (const k of ALLOWED) {
    if (k in req.body) patch[k] = req.body[k];
  }

  // guard: only superadmin can change role
  if ('role' in patch && req.user.role !== 'superadmin') {
    return res.status(403).json({ message: 'Only a superadmin can change roles.' });
  }

  // guard: prevent self-demotion/delete-like behavior if you want (optional)
  if (String(req.user._id) === String(id) && 'role' in patch) {
    return res.status(400).json({ message: 'You cannot change your own role.' });
  }

  const user = await User.findByIdAndUpdate(id, patch, { new: true });
  if (!user) return res.status(404).json({ message: 'Not found' });

  res.json({
    message: 'Updated',
    user: {
      id: user._id,
      fullName: user.fullName,
      email: user.email,
      employeeId: user.employeeId,
      department: user.department,
      role: user.role,
      isApproved: user.isApproved,
      branch: user.branch,
      city: user.city,
      joiningDate: user.joiningDate,
    },
  });
}

async function listUsers(req, res) {
  const { q } = req.query;
  const filter = q ? { fullName: { $regex: q, $options: 'i' } } : {};
  const users = await User.find(filter)
    .select('fullName email role employeeId department branch city joiningDate isApproved');
  res.json(users);
}

async function deleteUser(req, res) {
  try {
    const { id } = req.params;

    if (String(req.user._id) === String(id)) {
      return res.status(400).json({ message: 'You cannot delete your own account.' });
    }

    const target = await User.findById(id);
    if (!target) return res.status(404).json({ message: 'Not found' });

    if (target.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Only a superadmin can delete a superadmin.' });
    }

    await User.deleteOne({ _id: target._id });
    return res.json({ message: 'Deleted', id: target._id });
  } catch (err) {
    return res.status(500).json({ message: err.message || 'Failed to delete user' });
  }
}

module.exports = { updateUser, listUsers, deleteUser };
