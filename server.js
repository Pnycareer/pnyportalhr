require('dotenv').config()
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const mongoose = require('mongoose')
const path = require('path')

const app = express()
app.use(express.json())
app.use(cookieParser())

// --- CORS ---
const allowlist = [
  'http://localhost:5173',
  'https://pnyportalhr.vercel.app',
  'https://hr.pnytrainings.com',          // <— add your prod origin     // (optional if you call from main site)
]
const corsOptions = {
  origin: function (origin, cb) {
    // allow server-to-server / curl (no Origin header)
    if (!origin) return cb(null, true)
    if (allowlist.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  },
  credentials: true,
  methods: 'GET,POST,PUT,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type,Authorization',
}

app.use(cors(corsOptions))

// health + test
app.get('/health', (req, res) => res.json({ ok: true }))
app.get('/test', (req, res) => res.send('Server is alive')) // no wildcard header

// static
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))

// routes
app.use('/api/auth', require('./routes/auth.routes'))
app.use('/api/users', require('./routes/users.routes'))
app.use('/api/attendance', require('./routes/attendance.routes'))

// start after DB connects
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ Database is Connected')
    const port = process.env.PORT || 8001   // must read env
    app.listen(port, () => console.log('🚀 API listening on ' + port))
  })
  .catch((err) => {
    console.error('❌ Mongo error:', err)
    process.exit(1)
  })
