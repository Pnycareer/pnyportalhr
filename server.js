require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cookieParser());

const allowedOrigins = [
  "http://localhost:5173",
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

// Apply CORS middleware early
app.use(cors(corsOptions));



app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/attendance", require("./routes/attendance.routes"));

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ Database is Connected");
    const port = process.env.PORT || 4000;
    app.listen(port, () => console.log("🚀 API listening on " + port));
  })
  .catch((err) => {
    console.error("❌ Mongo error:", err);
    process.exit(1);
  });
