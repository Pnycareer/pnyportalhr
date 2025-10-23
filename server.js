require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const path = require("path");
const { corsOptions, allowlist } = require("./config/cors");
const { initSocket } = require("./services/socket.service");

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(cookieParser());
app.set("trust proxy", 1); // or true
app.use(cors(corsOptions));

// health + test
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/test", (req, res) => res.send("Server is alive")); // no wildcard header

// static
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// routes
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/attendance", require("./routes/attendance.routes"));
app.use("/api/leaves", require("./routes/leaves.routes"));
app.use("/api/instructor-overtime", require("./routes/instructorOvertime.routes"));
app.use("/api/fuel-requisitions", require("./routes/fuelRequisition.routes"));

// sockets
const io = initSocket(server, allowlist);
app.set("io", io);

// start after DB connects
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("Database is Connected");
    const port = process.env.PORT || 8001; // must read env
    server.listen(port, () => console.log("API listening on " + port));
  })
  .catch((err) => {
    console.error("�?O Mongo error:", err);
    process.exit(1);
  });
