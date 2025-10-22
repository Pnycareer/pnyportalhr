const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const allow = require("../middleware/rbac");
const {
  applyLeave,
  listLeaves,
  getLeave,
  updateLeaveStatus,
  updateLeave,
  updateLeaveTeamLead,
  reportLeaveMonthly,
  reportLeaveYearly,
  updateLeaveAllowance,
} = require("../controllers/leaves.controller");

router.post(
  "/",
  auth(),
  allow("superadmin", "admin", "hr", "employee"),
  applyLeave
);

router.get(
  "/",
  auth(),
  allow("superadmin", "admin", "hr", "employee"),
  listLeaves
);

router.get(
  "/:id",
  auth(),
  allow("superadmin", "admin", "hr", "employee"),
  getLeave
);

router.patch(
  "/:id",
  auth(),
  allow("superadmin", "admin", "hr"),
  updateLeave
);

router.patch(
  "/:id/team-lead",
  auth(),
  allow("superadmin", "admin", "hr", "employee"),
  updateLeaveTeamLead
);

router.patch(
  "/:id/status",
  auth(),
  allow("superadmin", "admin", "hr"),
  updateLeaveStatus
);

router.get(
  "/report/monthly",
  auth(),
  allow("superadmin", "admin", "hr", "employee"),
  reportLeaveMonthly
);

router.get(
  "/report/yearly",
  auth(),
  allow("superadmin", "admin", "hr", "employee"),
  reportLeaveYearly
);

router.put(
  "/allowance",
  auth(),
  allow("superadmin", "admin", "hr"),
  updateLeaveAllowance
);

module.exports = router;
