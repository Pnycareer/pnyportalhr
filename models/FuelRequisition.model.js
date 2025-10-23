const mongoose = require("mongoose");

const LineItemSchema = new mongoose.Schema(
  {
    srNo: { type: Number, required: true, min: 1 },
    description: { type: String, required: true, trim: true },
    km: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    amount: { type: Number, min: 0 }, // auto calc if not provided
    date: { type: Date }, // optional
    verified: { type: Boolean, default: false },
  },
  { _id: false }
);

const FuelRequisitionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    month: { type: String, required: true, trim: true }, // "September"
    year: { type: Number, required: true },              // 2025
    items: {
      type: [LineItemSchema],
      validate: [(arr) => Array.isArray(arr) && arr.length > 0, "At least one line item is required"],
    },
    totalKm: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    status: { type: String, enum: ["draft", "submitted", "approved", "rejected"], default: "draft" },
    remarks: { type: String, trim: true },
  },
  { timestamps: true }
);

// ---- helpers ----
function recalc(doc) {
  if (!doc.items) return;
  let totalKm = 0;
  let totalAmount = 0;
  doc.items = doc.items.map((it) => {
    const km = Number(it.km) || 0;
    const rate = Number(it.rate) || 0;
    const amount = Number.isFinite(it.amount) ? Number(it.amount) : km * rate;
    totalKm += km;
    totalAmount += amount;
    return { ...it.toObject?.() || it, amount };
  });
  doc.totalKm = totalKm;
  doc.totalAmount = totalAmount;
}

FuelRequisitionSchema.pre("validate", function (next) {
  recalc(this);
  next();
});

FuelRequisitionSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate() || {};
  const items = update.items || update.$set?.items;
  if (items) {
    const fake = { items };
    recalc(fake);
    update.$set = { ...(update.$set || {}), items: fake.items, totalKm: fake.totalKm, totalAmount: fake.totalAmount };
    delete update.items;
  }
  next();
});

// one doc per user-month-year
FuelRequisitionSchema.index({ user: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model("FuelRequisition", FuelRequisitionSchema);
