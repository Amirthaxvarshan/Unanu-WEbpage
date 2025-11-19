const crypto = require('crypto');
const winston = require('winston');
require('dotenv').config();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() })
  ]
);

// Validate encryption key
const getEncryptionKey = () => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }

  // Ensure key is 32 bytes for AES-256
  if (key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)');
  }

  return Buffer.from(key, 'hex');
};

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bit IV
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;

/**
 * Encrypts sensitive data using AES-256-GCM
 * @param {string} data - The data to encrypt
 * @returns {Buffer} - Encrypted data as buffer
 */
const encryptData = (data) => {
  try {
    if (!data || typeof data !== 'string') {
      throw new Error('Data must be a non-empty string');
    }

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);

    // Create cipher with key derivation
    const cipher = crypto.createCipher(ALGORITHM, key);
    cipher.setAAD(Buffer.from('unanu-contact-system', 'utf8'));

    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();

    // Combine salt + iv + tag + encrypted data
    const combined = Buffer.concat([
      salt,
      iv,
      tag,
      Buffer.from(encrypted, 'hex')
    ]);

    logger.debug('Data encrypted successfully', {
      length: data.length,
      algorithm: ALGORITHM
    });

    return combined;
  } catch (error) {
    logger.error('Encryption failed:', error);
    throw new Error('Failed to encrypt sensitive data');
  }
};

/**
 * Decrypts sensitive data using AES-256-GCM
 * @param {Buffer} encryptedData - The encrypted data buffer
 * @returns {string} - Decrypted data
 */
const decryptData = (encryptedData) => {
  try {
    if (!Buffer.isBuffer(encryptedData)) {
      throw new Error('Encrypted data must be a buffer');
    }

    const key = getEncryptionKey();

    // Extract components from combined buffer
    const salt = encryptedData.slice(0, SALT_LENGTH);
    const iv = encryptedData.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = encryptedData.slice(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = encryptedData.slice(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    // Create decipher
    const decipher = crypto.createDecipher(ALGORITHM, key);
    decipher.setAAD(Buffer.from('unanu-contact-system', 'utf8'));
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');

    logger.debug('Data decrypted successfully');

    return decrypted;
  } catch (error) {
    logger.error('Decryption failed:', error);
    throw new Error('Failed to decrypt sensitive data');
  }
};

/**
 * Encrypts email addresses with additional validation
 * @param {string} email - Email address to encrypt
 * @returns {Buffer} - Encrypted email
 */
const encryptEmail = (email) => {
  if (!email || typeof email !== 'string') {
    throw new Error('Valid email is required');
  }

  // Normalize email (lowercase, trim)
  const normalizedEmail = email.toLowerCase().trim();

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    throw new Error('Invalid email format');
  }

  return encryptData(normalizedEmail);
};

/**
 * Encrypts phone numbers with format validation
 * @param {string} phone - Phone number to encrypt
 * @returns {Buffer} - Encrypted phone number
 */
const encryptPhone = (phone) => {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Valid phone number is required');
  }

  // Normalize phone (remove spaces, dashes, parentheses)
  const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');

  // Basic phone validation (10-15 digits, optional +)
  const phoneRegex = /^\+?[1-9]\d{9,14}$/;
  if (!phoneRegex.test(normalizedPhone)) {
    throw new Error('Invalid phone number format');
  }

  return encryptData(normalizedPhone);
};

/**
 * Encrypts text fields with length validation
 * @param {string} text - Text to encrypt
 * @param {number} maxLength - Maximum allowed length
 * @returns {Buffer} - Encrypted text
 */
const encryptText = (text, maxLength = 2000) => {
  if (!text || typeof text !== 'string') {
    throw new Error('Valid text is required');
  }

  const trimmedText = text.trim();

  if (trimmedText.length === 0) {
    throw new Error('Text cannot be empty');
  }

  if (trimmedText.length > maxLength) {
    throw new Error(`Text exceeds maximum length of ${maxLength} characters`);
  }

  return encryptData(trimmedText);
};

/**
 * Sanitizes and encrypts names
 * @param {string} name - Name to encrypt
 * @returns {Buffer} - Encrypted name
 */
const encryptName = (name) => {
  if (!name || typeof name !== 'string') {
    throw new Error('Valid name is required');
  }

  // Remove HTML tags and normalize
  const cleanName = name.replace(/<[^>]*>/g, '').trim();

  if (cleanName.length < 2 || cleanName.length > 100) {
    throw new Error('Name must be between 2 and 100 characters');
  }

  return encryptData(cleanName);
};

/**
 * Batch encrypt multiple fields for performance
 * @param {Object} data - Object containing fields to encrypt
 * @returns {Object} - Object with encrypted fields
 */
const encryptSubmissionData = (data) => {
  try {
    const encrypted = {};

    if (data.name) {
      encrypted.name_encrypted = encryptName(data.name);
    }

    if (data.email) {
      encrypted.email_encrypted = encryptEmail(data.email);
    }

    if (data.company) {
      encrypted.company_encrypted = encryptText(data.company, 200);
    }

    if (data.phone) {
      encrypted.phone_encrypted = encryptPhone(data.phone);
    }

    if (data.message) {
      encrypted.message_encrypted = encryptText(data.message, 2000);
    }

    return encrypted;
  } catch (error) {
    logger.error('Batch encryption failed:', error);
    throw new Error('Failed to encrypt submission data');
  }
};

/**
 * Batch decrypt multiple fields
 * @param {Object} encryptedData - Object containing encrypted fields
 * @returns {Object} - Object with decrypted fields
 */
const decryptSubmissionData = (encryptedData) => {
  try {
    const decrypted = {};

    if (encryptedData.name_encrypted) {
      decrypted.name = decryptData(encryptedData.name_encrypted);
    }

    if (encryptedData.email_encrypted) {
      decrypted.email = decryptData(encryptedData.email_encrypted);
    }

    if (encryptedData.company_encrypted) {
      decrypted.company = decryptData(encryptedData.company_encrypted);
    }

    if (encryptedData.phone_encrypted) {
      decrypted.phone = decryptData(encryptedData.phone_encrypted);
    }

    if (encryptedData.message_encrypted) {
      decrypted.message = decryptData(encryptedData.message_encrypted);
    }

    return decrypted;
  } catch (error) {
    logger.error('Batch decryption failed:', error);
    throw new Error('Failed to decrypt submission data');
  }
};

/**
 * Masks email addresses for display (e.g., j***@example.com)
 * @param {string} email - Email to mask
 * @returns {string} - Masked email
 */
const maskEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return '';
  }

  const [localPart, domain] = email.split('@');
  if (localPart.length <= 2) {
    return `${localPart[0]}***@${domain}`;
  }

  return `${localPart[0]}${'*'.repeat(localPart.length - 2)}${localPart[localPart.length - 1]}@${domain}`;
};

/**
 * Masks phone numbers for display (e.g., +1 ***-***-1234)
 * @param {string} phone - Phone to mask
 * @returns {string} - Masked phone
 */
const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return '';
  }

  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length <= 4) {
    return '*'.repeat(cleaned.length);
  }

  const visible = cleaned.slice(-4);
  return `${'*'.repeat(cleaned.length - 4)}${visible}`;
};

module.exports = {
  encryptData,
  decryptData,
  encryptEmail,
  encryptPhone,
  encryptText,
  encryptName,
  encryptSubmissionData,
  decryptSubmissionData,
  maskEmail,
  maskPhone
};