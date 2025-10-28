const requestIp = require('request-ip');
require('dotenv').config();

const allowedIP = process.env.ALLOWED_IP;

const checkIP = (req, res, next) => {
    const clientIp = requestIp.getClientIp(req);

    // console.log('Client IP:', clientIp);
    // console.log('Allowed IP:', allowedIP);

    if (clientIp === allowedIP) {
        next();
    } else {
        res.status(403).json({ message: 'Access denied: Unauthorized IP address' });
    }
};

module.exports = checkIP;
