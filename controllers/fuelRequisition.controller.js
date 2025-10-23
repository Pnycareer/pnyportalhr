const FuelRequisition = require("../models/FuelRequisition.model");
const User = require("../models/User");

function normalizeItems(items = []) {
  return items.map((r) => ({
    srNo: Number(r.srNo) || undefined, // we'll re-number
    description: (r.description || "").trim(),
    km: Number(r.km) || 0,
    rate: Number(r.rate) || 0,
    amount: Number.isFinite(r.amount) ? Number(r.amount) : undefined,
    date: r.date ? new Date(r.date) : undefined,
    verified: Boolean(r.verified),
  }));
}

function renumber(items) {
  return items.map((it, i) => ({ ...it.toObject?.() || it, srNo: i + 1 }));
}

// CREATE or APPEND (same user + month + year)
exports.createFuelReq = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const hasUser = await User.exists({ _id: userId });
    if (!hasUser) return res.status(404).json({ message: "User not found" });

    const { month, year, items = [], status, remarks } = req.body;
    if (!month || !year) return res.status(400).json({ message: "month and year are required" });

    const newItems = normalizeItems(items);

    let doc = await FuelRequisition.findOne({ user: userId, month, year });

    if (doc) {
      // Optional business rule:
      // if (doc.status === "approved") return res.status(409).json({ message: "Approved requisition cannot be modified" });

      doc.items = renumber([...(doc.items || []), ...newItems]);
      if (status) doc.status = status;
      if (typeof remarks === "string") doc.remarks = remarks;
      await doc.validate();
      await doc.save();
    } else {
      doc = await FuelRequisition.create({
        user: userId,
        month,
        year,
        status: status || "submitted",
        remarks: typeof remarks === "string" ? remarks : undefined,
        items: renumber(newItems),
      });
    }

    await doc.populate({ path: "user", select: "fullName email employeeId department designation branch city" });
    res.status(201).json(doc);
  } catch (err) {
    // unique index race -> retry append once
    if (err?.code === 11000) {
      try {
        const userId = req.user?.id;
        const { month, year, items = [], status, remarks } = req.body;
        const newItems = normalizeItems(items);
        let doc = await FuelRequisition.findOne({ user: userId, month, year });
        if (!doc) throw err;
        doc.items = renumber([...(doc.items || []), ...newItems]);
        if (status) doc.status = status;
        if (typeof remarks === "string") doc.remarks = remarks;
        await doc.validate();
        await doc.save();
        await doc.populate({ path: "user", select: "fullName email employeeId department designation branch city" });
        return res.status(201).json(doc);
      } catch (e2) {
        console.error("createFuelReq retry error:", e2);
        return res.status(500).json({ message: e2.message || "Server error" });
      }
    }
    console.error("createFuelReq error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
};

// LIST — admins see all / employees see their own
exports.listFuelReq = async (req, res) => {
  try {
    const { role, id: userId } = req.user || {};
    const adminRoles = ["superadmin", "admin", "hr"];

    const { page = 1, limit = 20, user, month, year, status, q } = req.query;
    const filter = {};

    if (adminRoles.includes(role)) {
      if (user) filter.user = user;
    } else {
      filter.user = userId;
    }

    if (month) filter.month = month;
    if (year) filter.year = Number(year);
    if (status) filter.status = status;
    if (q) filter.remarks = { $regex: q, $options: "i" };

    const skip = (Number(page) - 1) * Number(limit);

    const [rows, total] = await Promise.all([
      FuelRequisition.find(filter)
        .populate({ path: "user", select: "fullName email employeeId department designation branch city" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      FuelRequisition.countDocuments(filter),
    ]);

    res.json({ data: rows, page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit) || 1) });
  } catch (err) {
    console.error("listFuelReq error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// READ single — owner or admin
exports.getFuelReqById = async (req, res) => {
  try {
    const { role, id: userId } = req.user || {};
    const adminRoles = ["superadmin", "admin", "hr"];

    const doc = await FuelRequisition.findById(req.params.id)
      .populate({ path: "user", select: "fullName email employeeId department designation branch city" });
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!adminRoles.includes(role) && String(doc.user._id) !== String(userId)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    res.json(doc);
  } catch (err) {
    console.error("getFuelReqById error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// UPDATE — owner or admin; never allow changing user
exports.updateFuelReq = async (req, res) => {
  try {
    const { role, id: userId } = req.user || {};
    const adminRoles = ["superadmin", "admin", "hr"];

    const existing = await FuelRequisition.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (!adminRoles.includes(role) && String(existing.user) !== String(userId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const payload = { ...req.body };
    delete payload.user; // do not change ownership

    const doc = await FuelRequisition.findOneAndUpdate(
      { _id: req.params.id },
      { $set: payload },
      { new: true, runValidators: true }
    ).populate({ path: "user", select: "fullName email employeeId department designation branch city" });

    res.json(doc);
  } catch (err) {
    console.error("updateFuelReq error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
};

// DELETE — owner or admin
exports.deleteFuelReq = async (req, res) => {
  try {
    const { role, id: userId } = req.user || {};
    const adminRoles = ["superadmin", "admin", "hr"];

    const doc = await FuelRequisition.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!adminRoles.includes(role) && String(doc.user) !== String(userId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await FuelRequisition.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("deleteFuelReq error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// OPTIONAL add/remove line items with same ownership checks
exports.addLineItem = async (req, res) => {
  try {
    const { role, id: userId } = req.user || {};
    const adminRoles = ["superadmin", "admin", "hr"];
    const doc = await FuelRequisition.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!adminRoles.includes(role) && String(doc.user) !== String(userId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { srNo, description, km, rate, amount, date } = req.body;
    doc.items.push({ srNo, description, km, rate, amount, date, verified: false });
    doc.items = renumber(doc.items);
    await doc.validate();
    await doc.save();
    await doc.populate({ path: "user", select: "fullName email employeeId department designation branch city" });

    res.status(201).json(doc);
  } catch (err) {
    console.error("addLineItem error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
};

exports.removeLineItem = async (req, res) => {
  try {
    const { role, id: userId } = req.user || {};
    const adminRoles = ["superadmin", "admin", "hr"];
    const doc = await FuelRequisition.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!adminRoles.includes(role) && String(doc.user) !== String(userId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const srNo = Number(req.params.srNo);
    const before = doc.items.length;
    doc.items = renumber(doc.items.filter((it) => Number(it.srNo) !== srNo));
    if (doc.items.length === before) return res.status(404).json({ message: "Line item not found" });

    await doc.validate();
    await doc.save();
    await doc.populate({ path: "user", select: "fullName email employeeId department designation branch city" });

    res.json(doc);
  } catch (err) {
    console.error("removeLineItem error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
};

exports.setLineItemVerification = async (req, res) => {
  try {
    const { role } = req.user || {};
    const adminRoles = ["superadmin", "admin", "hr"];
    if (!adminRoles.includes(role)) {
      return res.status(403).json({ message: "Only admins can verify requisitions" });
    }

    const doc = await FuelRequisition.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Not found" });

    const srNo = Number(req.params.srNo);
    const item = doc.items.find((it) => Number(it.srNo) === srNo);
    if (!item) return res.status(404).json({ message: "Line item not found" });

    const rawValue = req.body?.verified;
    const nextState = typeof rawValue === "string"
      ? rawValue.toLowerCase() === "true"
      : Boolean(rawValue);
    item.verified = nextState;
    await doc.save();
    await doc.populate({ path: "user", select: "fullName email employeeId department designation branch city" });

    res.json(doc);
  } catch (err) {
    console.error("setLineItemVerification error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
};
