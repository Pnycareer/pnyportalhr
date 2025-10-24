const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const allow = require("../middleware/rbac");
const {
  mark,
  markSelf,
  bulk,
  byMonth,
  byDate,
  reportMonthlyByBranch,
  reportUserMonth,
} = require("../controllers/attendance.controller");

router.post("/mark", auth(), allow("superadmin", "admin", "hr"), mark);
router.post(
  "/self/mark",
  auth(),
  allow("employee"),
  markSelf
);
router.post("/bulk", auth(), allow("superadmin", "admin", "hr"), bulk);
router.get(
  "/report/monthly",
  auth(),
  allow("superadmin", "admin", "hr"),
  reportMonthlyByBranch
);
router.get(
  "/report/user-month",
  auth(),
  allow("superadmin", "admin", "hr", "employee"),
  reportUserMonth
);
router.get("/by-month", auth(), byMonth);
router.get("/by-date", auth(), byDate);

module.exports = router;
