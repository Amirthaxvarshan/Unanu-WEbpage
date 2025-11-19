const { body, validationResult } = require('express-validator');
const { JSDOM } = require('jsdom');
const DOMPurify = require('dompurify');

// Create a DOM for DOMPurify
const window = new JSDOM('').window;
const purify = DOMPurify(window);

/**
 * Middleware to validate contact form submission
 */
const validateContactSubmission = [
  // Name validation
  body('name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters')
    .matches(/^[a-zA-Z\s\-'\.]+$/)
    .withMessage('Name can only contain letters, spaces, hyphens, apostrophes, and periods')
    .customSanitizer(value => purify.sanitize(value)),

  // Email validation
  body('email')
    .trim()
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail({ all_lowercase: true })
    .isLength({ max: 254 })
    .withMessage('Email address is too long'),

  // Company validation (optional)
  body('company')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Company name cannot exceed 200 characters')
    .customSanitizer(value => value ? purify.sanitize(value) : ''),

  // Phone validation (optional)
  body('phone')
    .optional()
    .trim()
    .custom((value, { req }) => {
      if (!value) return true; // Optional field

      // Remove all non-digit characters except + for validation
      const cleanPhone = value.replace(/[^\d+]/g, '');

      // Validate phone format (E.164 format: + followed by 10-15 digits)
      if (!/^\+?[1-9]\d{9,14}$/.test(cleanPhone)) {
        throw new Error('Please provide a valid phone number (include country code)');
      }

      return true;
    }),

  // Message validation
  body('message')
    .trim()
    .isLength({ min: 10, max: 2000 })
    .withMessage('Message must be between 10 and 2000 characters')
    .customSanitizer(value => purify.sanitize(value, {
      ALLOWED_TAGS: [],
      ALLOWED_ATTR: []
    })),

  // Consent validation (GDPR)
  body('consent')
    .isBoolean()
    .withMessage('Consent field is required')
    .custom(value => {
      if (value !== true) {
        throw new Error('You must consent to data processing to submit this form');
      }
      return true;
    }),

  // Honeypot validation (must be empty)
  body('honeypot')
    .optional()
    .custom(value => {
      if (value && value.trim() !== '') {
        throw new Error('Honeypot field must be empty');
      }
      return true;
    }),

  // Custom validation for request size
  body().custom((value, { req }) => {
    const contentLength = parseInt(req.get('Content-Length') || '0');
    const maxSize = 1024 * 1024; // 1MB

    if (contentLength > maxSize) {
      throw new Error('Request size too large');
    }

    return true;
  })
];

/**
 * Middleware to validate admin login
 */
const validateAdminLogin = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail({ all_lowercase: true }),

  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character')
];

/**
 * Middleware to validate admin user creation
 */
const validateAdminUserCreation = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail({ all_lowercase: true })
    .custom(async (value) => {
      // Check if email already exists
      // This would require database access - implement as needed
      return true;
    }),

  body('password')
    .isLength({ min: 12 })
    .withMessage('Password must be at least 12 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'),

  body('role')
    .isIn(['admin', 'moderator'])
    .withMessage('Role must be either admin or moderator')
];

/**
 * Middleware to validate submission status updates
 */
const validateStatusUpdate = [
  body('status')
    .isIn(['new', 'in_progress', 'resolved', 'spam'])
    .withMessage('Invalid status value'),

  body('notes')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Notes cannot exceed 1000 characters')
    .customSanitizer(value => value ? purify.sanitize(value) : '')
];

/**
 * Middleware to check validation results
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const formattedErrors = {};

    errors.array().forEach(error => {
      if (!formattedErrors[error.path]) {
        formattedErrors[error.path] = [];
      }
      formattedErrors[error.path].push(error.msg);
    });

    return res.status(400).json({
      success: false,
      errors: formattedErrors,
      message: 'Validation failed'
    });
  }

  next();
};

/**
 * Middleware to validate and sanitize text fields
 */
const sanitizeText = (fields = []) => {
  return (req, res, next) => {
    try {
      fields.forEach(field => {
        if (req.body[field]) {
          req.body[field] = purify.sanitize(req.body[field], {
            ALLOWED_TAGS: [],
            ALLOWED_ATTR: []
          });
        }
      });
      next();
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Sanitization failed'
      });
    }
  };
};

/**
 * Middleware to validate content type
 */
const validateContentType = (allowedTypes = ['application/json']) => {
  return (req, res, next) => {
    const contentType = req.get('Content-Type');

    if (!contentType) {
      return res.status(400).json({
        success: false,
        message: 'Content-Type header is required'
      });
    }

    const isAllowed = allowedTypes.some(type =>
      contentType.toLowerCase().includes(type.toLowerCase())
    );

    if (!isAllowed) {
      return res.status(400).json({
        success: false,
        message: `Content-Type must be one of: ${allowedTypes.join(', ')}`
      });
    }

    next();
  };
};

/**
 * Middleware to validate file uploads (if needed in future)
 */
const validateFileUpload = (maxSize = 5 * 1024 * 1024, allowedTypes = []) => {
  return (req, res, next) => {
    if (!req.file) {
      return next();
    }

    // Check file size
    if (req.file.size > maxSize) {
      return res.status(400).json({
        success: false,
        message: `File size cannot exceed ${maxSize / 1024 / 1024}MB`
      });
    }

    // Check file type
    if (allowedTypes.length > 0 && !allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: `File type must be one of: ${allowedTypes.join(', ')}`
      });
    }

    next();
  };
};

/**
 * Custom validator for XSS prevention
 */
const preventXSS = (req, res, next) => {
  try {
    // Check for common XSS patterns in request body
    const xssPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      /<iframe\b[^>]*>/gi,
      /<object\b[^>]*>/gi,
      /<embed\b[^>]*>/gi,
      /vbscript:/gi,
      /data:text\/html/gi
    ];

    const checkForXSS = (obj) => {
      for (const key in obj) {
        if (typeof obj[key] === 'string') {
          xssPatterns.forEach(pattern => {
            if (pattern.test(obj[key])) {
              throw new Error(`Potential XSS attack detected in field: ${key}`);
            }
          });
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          checkForXSS(obj[key]);
        }
      }
    };

    if (req.body) {
      checkForXSS(req.body);
    }

    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  validateContactSubmission,
  validateAdminLogin,
  validateAdminUserCreation,
  validateStatusUpdate,
  handleValidationErrors,
  sanitizeText,
  validateContentType,
  validateFileUpload,
  preventXSS
};