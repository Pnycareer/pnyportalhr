const jwt = require('jsonwebtoken');


module.exports = function auth(required = true) {
return (req, res, next) => {
const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ', '');
if (!token) return required ? res.status(401).json({ message: 'Unauthorized' }) : next();
try {
const payload = jwt.verify(token, process.env.JWT_SECRET);
req.user = payload; // { id, role }
next();
} catch (e) {
return res.status(401).json({ message: 'Invalid token' });
}
}
}