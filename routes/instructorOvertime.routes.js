const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const allow = require("../middleware/rbac");
const {
  createInstructorOvertime,
  listInstructorOvertime,
  getInstructorOvertime,
  updateInstructorOvertime,
  getMonthlyOvertimeReport,
  deleteInstructorOvertime,
} = require("../controllers/instructorOvertime.controller");

const ACCESS_ROLES = ["superadmin", "admin", "hr", "employee"];
const REPORT_ROLES = ["superadmin", "admin", "hr"];

router.post("/", auth(), allow(...ACCESS_ROLES), createInstructorOvertime);

router.get("/", auth(), allow(...ACCESS_ROLES), listInstructorOvertime);

router.get(
  "/reports/monthly",
  auth(),
  allow(...REPORT_ROLES),
  getMonthlyOvertimeReport
);

router.get("/:id", auth(), allow(...ACCESS_ROLES), getInstructorOvertime);

router.patch("/:id", auth(), allow(...ACCESS_ROLES), updateInstructorOvertime);
router.delete("/:id", auth(), allow(...ACCESS_ROLES), deleteInstructorOvertime); // NEW
module.exports = router;
