import { randomInt } from 'crypto';

export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'Gpt2api@2026';

const ADMIN_USERNAME_MIN_LENGTH = 3;
const ADMIN_USERNAME_MAX_LENGTH = 32;
const ADMIN_USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

const ADMIN_PASSWORD_MIN_LENGTH = 12;
const ADMIN_PASSWORD_HAS_UPPERCASE = /[A-Z]/;
const ADMIN_PASSWORD_HAS_LOWERCASE = /[a-z]/;
const ADMIN_PASSWORD_HAS_DIGIT = /[0-9]/;
const ADMIN_PASSWORD_HAS_SYMBOL = /[^a-zA-Z0-9]/;

const WEAK_ADMIN_PASSWORDS = new Set([
  'admin123',
  '12345678',
  'password',
  'change-this-admin-password',
  'replace-with-strong-admin-password'
]);

const UPPERCASE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE_CHARS = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT_CHARS = '23456789';
const SYMBOL_CHARS = '!@#$%^&*()-_=+[]{}?';
const ALL_PASSWORD_CHARS = `${UPPERCASE_CHARS}${LOWERCASE_CHARS}${DIGIT_CHARS}${SYMBOL_CHARS}`;

function pickRandomChar(charset) {
  return charset[randomInt(0, charset.length)];
}

function shuffleChars(chars) {
  const cloned = [...chars];
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned;
}

export function validateAdminUsername(username) {
  const normalized = String(username || '').trim();
  if (!normalized) {
    return { valid: false, normalized, message: 'ADMIN_USERNAME 不能为空' };
  }
  if (normalized.length < ADMIN_USERNAME_MIN_LENGTH || normalized.length > ADMIN_USERNAME_MAX_LENGTH) {
    return {
      valid: false,
      normalized,
      message: `ADMIN_USERNAME 长度需在 ${ADMIN_USERNAME_MIN_LENGTH}-${ADMIN_USERNAME_MAX_LENGTH} 位之间`
    };
  }
  if (!ADMIN_USERNAME_PATTERN.test(normalized)) {
    return {
      valid: false,
      normalized,
      message: 'ADMIN_USERNAME 仅支持字母、数字、点、下划线和中划线'
    };
  }
  return { valid: true, normalized, message: '' };
}

export function validateAdminPassword(password, username = '') {
  const normalized = String(password || '');
  const normalizedUsername = String(username || '').trim().toLowerCase();

  if (normalized.length < ADMIN_PASSWORD_MIN_LENGTH) {
    return { valid: false, message: `密码长度至少 ${ADMIN_PASSWORD_MIN_LENGTH} 位` };
  }
  if (!ADMIN_PASSWORD_HAS_UPPERCASE.test(normalized)) {
    return { valid: false, message: '密码需至少包含 1 个大写字母' };
  }
  if (!ADMIN_PASSWORD_HAS_LOWERCASE.test(normalized)) {
    return { valid: false, message: '密码需至少包含 1 个小写字母' };
  }
  if (!ADMIN_PASSWORD_HAS_DIGIT.test(normalized)) {
    return { valid: false, message: '密码需至少包含 1 个数字' };
  }
  if (!ADMIN_PASSWORD_HAS_SYMBOL.test(normalized)) {
    return { valid: false, message: '密码需至少包含 1 个特殊字符' };
  }

  if (WEAK_ADMIN_PASSWORDS.has(normalized.toLowerCase())) {
    return { valid: false, message: '密码命中弱口令，请更换为更复杂的密码' };
  }

  if (normalizedUsername && normalized.toLowerCase().includes(normalizedUsername)) {
    return { valid: false, message: '密码不能包含用户名' };
  }

  return { valid: true, message: '' };
}

export function generateStrongAdminPassword(length = 20) {
  const safeLength = Math.max(Number.parseInt(length, 10) || 20, ADMIN_PASSWORD_MIN_LENGTH);
  const chars = [
    pickRandomChar(UPPERCASE_CHARS),
    pickRandomChar(LOWERCASE_CHARS),
    pickRandomChar(DIGIT_CHARS),
    pickRandomChar(SYMBOL_CHARS)
  ];

  for (let i = chars.length; i < safeLength; i += 1) {
    chars.push(pickRandomChar(ALL_PASSWORD_CHARS));
  }

  return shuffleChars(chars).join('');
}
