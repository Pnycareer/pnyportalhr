const allowlist = [
  "http://localhost:5173",
  "https://pnyportalhr.vercel.app",
  "https://hr.pnytrainings.com",
];

const corsOptions = {
  origin: function validateOrigin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowlist.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  allowedHeaders: "Content-Type,Authorization",
};

module.exports = {
  allowlist,
  corsOptions,
};
