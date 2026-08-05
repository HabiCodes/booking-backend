-- Run this once with your admin's bcrypt hash to create an admin user.
-- Generate a bcrypt hash with:
-- node -e "console.log(require('bcrypt').hashSync('your_password', 12))"

INSERT INTO admins (email, password_hash, name)
VALUES ('admin@yourdomain.com', '<REPLACE_WITH_BCRYPT_HASH>', 'Admin');