"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateBody = validateBody;
exports.sanitizeString = sanitizeString;
exports.validateEmail = validateEmail;
exports.validatePhone = validatePhone;
exports.validateAge = validateAge;
exports.validateGender = validateGender;
function validateBody(schema) {
    return (req, res, next) => {
        try {
            schema(req, res, next);
        }
        catch (err) {
            next(err);
        }
    };
}
function sanitizeString(str) {
    return str.trim().replace(/\s+/g, ' ');
}
function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validatePhone(phone) {
    return /^[+]?[\d\s\-()]{7,15}$/.test(phone);
}
function validateAge(age) {
    if (!age)
        return true;
    const n = parseInt(age, 10);
    return !isNaN(n) && n >= 1 && n <= 120;
}
function validateGender(gender) {
    if (!gender)
        return true;
    return ['male', 'female', 'other'].includes(gender.toLowerCase());
}
