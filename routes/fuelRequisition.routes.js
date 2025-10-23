const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/fuelRequisition.controller");
const auth = require("../middleware/auth"); // your JWT middleware

router.post("/", auth(true), ctrl.createFuelReq);
router.get("/", auth(true), ctrl.listFuelReq);
router.get("/:id", auth(true), ctrl.getFuelReqById);
router.patch("/:id", auth(true), ctrl.updateFuelReq);
router.delete("/:id", auth(true), ctrl.deleteFuelReq);

router.post("/:id/items", auth(true), ctrl.addLineItem);
router.delete("/:id/items/:srNo", auth(true), ctrl.removeLineItem);
router.patch("/:id/items/:srNo/verification", auth(true), ctrl.setLineItemVerification);

module.exports = router;
