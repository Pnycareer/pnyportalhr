// routes/users.js
const router = require('express').Router();
const auth = require('../middleware/auth');
const allow = require('../middleware/rbac');
const {
  updateUser,
  listUsers,
  deleteUser,
  listTeamLeads,
  updateSelfTeamLeadStatus,
} = require('../controllers/users.controller');

// ONE route to update anything (including isApproved, role, etc)
router.patch('/edit/:id', auth(), allow('superadmin','admin'), updateUser);

// list + delete
router.get('/',    auth(), allow('superadmin','admin','hr'), listUsers);
router.get('/team-leads', auth(), allow('superadmin','admin','hr','employee'), listTeamLeads);
router.patch('/me/team-lead', auth(), allow('superadmin','admin','hr','employee'), updateSelfTeamLeadStatus);
router.delete('/:id', auth(), allow('superadmin','admin'), deleteUser);

module.exports = router;
