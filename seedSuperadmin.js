const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/User');


(async () => {
await mongoose.connect(process.env.MONGO_URI);
const email = 'super@acme.com';
let u = await User.findOne({ email });
if (!u) {
u = new User({
fullName: 'Super Admin',
employeeId: 'EMP-000',
cnic: '00000-0000000-0',
email,
department: 'Management',
joiningDate: new Date(),
role: 'superadmin',
isApproved: true
});
await u.setPassword('change-me-now');
await u.save();
}
console.log('Superadmin ready:', email);
process.exit(0);
})();