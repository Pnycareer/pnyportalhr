const express = require('express');
const router = express.Router();
const { register, login, logout, verifyEmailOtp, resendEmailOtp, getMe } = require('../controllers/auth.controller');
const auth = require('../middleware/auth');
const { uploadAvatar } = require("../middleware/uploadAvatar");


router.post("/register", uploadAvatar, register);

router.post('/verify-otp', verifyEmailOtp);
router.post('/resend-otp', resendEmailOtp);

router.get('/me', auth(), getMe) 

router.post('/login', login);
router.post('/logout', logout);


module.exports = router;
