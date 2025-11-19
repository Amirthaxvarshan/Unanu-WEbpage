const winston = require('winston');
const { isRedisAvailable, getRedisClient } = require('../config/redis');
const { pool } = require('../config/database');
const { encryptData } = require('./encryption');

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
});

// Spam detection patterns
const SPAM_PATTERNS = {
  // Common spam keywords
  keywords: [
    'viagra', 'cialis', 'casino', 'lottery', 'winner', 'congratulations',
    'click here', 'free money', 'make money', 'work from home', 'urgent',
    'limited time', 'act now', 'special promotion', 'exclusive offer',
    'weight loss', 'diet pills', 'forex', 'binary options', 'crypto',
    'bitcoin', 'investment opportunity', 'guaranteed', 'risk free',
    'no cost', 'zero risk', 'million dollars', 'prize', 'award',
    'claim now', 'instant', 'quick cash', 'easy money', 'loan'
  ],

  // Suspicious URLs and domains
  suspiciousUrls: [
    'bit.ly', 'tinyurl.com', 'short.link', 't.co',
    'suspicious-domain.com', 'spam-site.com'
  ],

  // Phone number patterns commonly used in spam
  phonePatterns: [
    /^\+?[0-9]{10,15}$/, // Valid looking but suspicious
    /0000000000/, // All zeros
    /1111111111/, // All ones
    /9999999999/, // All nines
    /1234567890/  // Sequential
  ],

  // Email patterns commonly used in spam
  emailPatterns: [
    /^[a-z]+\d+@[a-z]+\d+\.(com|net|org)$/, // Random letters+numbers
    /@(gmail\.com|yahoo\.com|hotmail\.com)$/i, // Common free providers (not suspicious alone)
    /^[a-z]{1,2}\d{2,}@[a-z]{1,2}\d{2,}\.(com|net)$/i // Very short username/domain
  ],

  // Text patterns indicating spam
  textPatterns: [
    /\b(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?\b/gi, // Multiple URLs
    /\$[0-9,]+/g, // Money amounts
    /\b\d{1,3}%\b/g, // Percentage mentions
    /[!]{3,}/g, // Multiple exclamation marks
    /[A-Z]{10,}/g, // All caps long words
    /\b(CALL|CLICK|DOWNLOAD|FREE|GUARANTEED|INSTANT|LIMITED|OFFER|PRIZE|WIN|URGENT)\b/gi
  ]
};

// Reputation scoring weights
const SCORE_WEIGHTS = {
  honeypot_filled: 100,     // Immediate spam
  known_spam_ip: 80,        // High confidence
  suspicious_keywords: 15,  // Per keyword
  suspicious_patterns: 20,  // Per pattern match
  multiple_urls: 25,        // Multiple URLs
  money_mentions: 10,       // Per money mention
  excessive_caps: 15,       // Excessive capitalization
  repeated_chars: 10,       // Repeated characters
  suspicious_email: 20,     // Suspicious email format
  suspicious_phone: 30,     // Suspicious phone format
  rapid_requests: 40,       // Multiple submissions in short time
  malformed_request: 25     // Malformed request data
};

// Spam threshold
const SPAM_THRESHOLD = 60; // Mark as spam if score >= 60
const HIGH_SPAM_THRESHOLD = 90; // Auto-reject if score >= 90

/**
 * Spam detection and scoring service
 */
class SpamProtection {
  constructor() {
    this.knownSpamIPs = new Set();
    this.loadKnownSpammers();
  }

  /**
   * Load known spammer IPs and patterns
   */
  async loadKnownSpammers() {
    try {
      // Load known spam IPs from database or external service
      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT DISTINCT ip_address FROM contact_submissions WHERE status = $1 ORDER BY created_at DESC LIMIT 1000',
          ['spam']
        );

        result.rows.forEach(row => {
          if (row.ip_address) {
            this.knownSpamIPs.add(row.ip_address);
          }
        });

        logger.info(`Loaded ${this.knownSpamIPs.size} known spam IPs`);
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Failed to load known spammers:', error);
    }
  }

  /**
   * Analyze submission for spam
   */
  async analyzeSubmission(data, ipAddress, userAgent) {
    const score = { total: 0, details: {} };
    const reasons = [];

    try {
      // 1. Honeypot check
      if (data.honeypot && data.honeypot.trim() !== '') {
        score.total += SCORE_WEIGHTS.honeypot_filled;
        score.details.honeypot_filled = SCORE_WEIGHTS.honeypot_filled;
        reasons.push('Honeypot field filled');
        logger.warn('Spam detected: Honeypot filled', { ip: ipAddress });
      }

      // 2. Known spammer IP check
      if (this.knownSpamIPs.has(ipAddress)) {
        score.total += SCORE_WEIGHTS.known_spam_ip;
        score.details.known_spam_ip = SCORE_WEIGHTS.known_spam_ip;
        reasons.push('Known spam IP address');
      }

      // 3. Email analysis
      if (data.email) {
        const emailScore = this.analyzeEmail(data.email);
        if (emailScore > 0) {
          score.total += emailScore;
          score.details.suspicious_email = emailScore;
          reasons.push('Suspicious email format');
        }
      }

      // 4. Phone analysis
      if (data.phone) {
        const phoneScore = this.analyzePhone(data.phone);
        if (phoneScore > 0) {
          score.total += phoneScore;
          score.details.suspicious_phone = phoneScore;
          reasons.push('Suspicious phone format');
        }
      }

      // 5. Name analysis
      if (data.name) {
        const nameScore = this.analyzeName(data.name);
        if (nameScore > 0) {
          score.total += nameScore;
          score.details.suspicious_name = nameScore;
          reasons.push('Suspicious name format');
        }
      }

      // 6. Message analysis
      if (data.message) {
        const messageAnalysis = this.analyzeMessage(data.message);
        score.total += messageAnalysis.total;
        Object.assign(score.details, messageAnalysis.details);
        reasons.push(...messageAnalysis.reasons);
      }

      // 7. Rapid submission check
      const rapidScore = await this.checkRapidSubmissions(ipAddress, data.email);
      if (rapidScore > 0) {
        score.total += rapidScore;
        score.details.rapid_requests = rapidScore;
        reasons.push('Rapid submissions detected');
      }

      // 8. Request data analysis
      const requestScore = this.analyzeRequestData(data);
      if (requestScore > 0) {
        score.total += requestScore;
        score.details.malformed_request = requestScore;
        reasons.push('Malformed request data');
      }

      // Determine spam status
      let isSpam = false;
      let shouldReject = false;

      if (score.total >= HIGH_SPAM_THRESHOLD) {
        isSpam = true;
        shouldReject = true;
      } else if (score.total >= SPAM_THRESHOLD) {
        isSpam = true;
      }

      const result = {
        isSpam,
        shouldReject,
        score: Math.min(100, score.total), // Cap at 100
        reasons,
        details: score.details,
        confidence: this.calculateConfidence(score.total)
      };

      logger.info('Spam analysis completed', {
        ip: ipAddress,
        score: result.score,
        isSpam: result.isSpam,
        shouldReject: result.shouldReject,
        reasons: reasons.slice(0, 3) // Log top 3 reasons
      });

      return result;

    } catch (error) {
      logger.error('Spam analysis failed:', error);
      // Fail open - don't mark as spam on error
      return {
        isSpam: false,
        shouldReject: false,
        score: 0,
        reasons: [],
        details: {},
        confidence: 0
      };
    }
  }

  /**
   * Analyze email for spam indicators
   */
  analyzeEmail(email) {
    let score = 0;
    const emailLower = email.toLowerCase();

    // Check against suspicious email patterns
    SPAM_PATTERNS.emailPatterns.forEach(pattern => {
      if (pattern.test(emailLower)) {
        score += SCORE_WEIGHTS.suspicious_email;
      }
    });

    // Check for disposable email domains
    const disposableDomains = [
      '10minutemail.com', 'guerrillamail.com', 'tempmail.org',
      'mailinator.com', 'yopmail.com', 'throwaway.email'
    ];

    const domain = emailLower.split('@')[1];
    if (disposableDomains.some(d => domain.includes(d))) {
      score += SCORE_WEIGHTS.suspicious_email;
    }

    // Check for excessive numbers in email
    const numbersCount = (email.match(/\d/g) || []).length;
    if (numbersCount > 5) {
      score += SCORE_WEIGHTS.suspicious_email / 2;
    }

    return score;
  }

  /**
   * Analyze phone number for spam indicators
   */
  analyzePhone(phone) {
    let score = 0;
    const cleanPhone = phone.replace(/\D/g, '');

    SPAM_PATTERNS.phonePatterns.forEach(pattern => {
      if (pattern.test(cleanPhone)) {
        score += SCORE_WEIGHTS.suspicious_phone;
      }
    });

    // Check for repeated digits
    if (/(\d)\1{6,}/.test(cleanPhone)) {
      score += SCORE_WEIGHTS.suspicious_phone;
    }

    return score;
  }

  /**
   * Analyze name for spam indicators
   */
  analyzeName(name) {
    let score = 0;
    const cleanName = name.trim();

    // Single character names
    if (cleanName.length <= 1) {
      score += SCORE_WEIGHTS.suspicious_keywords / 2;
    }

    // All uppercase names
    if (cleanName === cleanName.toUpperCase() && cleanName.length > 5) {
      score += SCORE_WEIGHTS.excessive_caps;
    }

    // Random looking names (lots of consonants together)
    if (/[bcdfghjklmnpqrstvwxyz]{5,}/i.test(cleanName)) {
      score += SCORE_WEIGHTS.suspicious_keywords / 2;
    }

    return score;
  }

  /**
   * Analyze message content for spam indicators
   */
  analyzeMessage(message) {
    const score = { total: 0, details: {} };
    const reasons = [];
    const messageLower = message.toLowerCase();

    // Check for spam keywords
    const keywordMatches = [];
    SPAM_PATTERNS.keywords.forEach(keyword => {
      if (messageLower.includes(keyword.toLowerCase())) {
        keywordMatches.push(keyword);
      }
    });

    if (keywordMatches.length > 0) {
      const keywordScore = keywordMatches.length * SCORE_WEIGHTS.suspicious_keywords;
      score.total += keywordScore;
      score.details.suspicious_keywords = keywordScore;
      reasons.push(`Spam keywords: ${keywordMatches.slice(0, 3).join(', ')}`);
    }

    // Check for multiple URLs
    const urls = message.match(/https?:\/\/[^\s]+/gi) || [];
    if (urls.length > 2) {
      const urlScore = urls.length * SCORE_WEIGHTS.multiple_urls;
      score.total += urlScore;
      score.details.multiple_urls = urlScore;
      reasons.push(`Multiple URLs: ${urls.length}`);
    }

    // Check for suspicious URLs
    urls.forEach(url => {
      const urlLower = url.toLowerCase();
      if (SPAM_PATTERNS.suspiciousUrls.some(domain => urlLower.includes(domain))) {
        score.total += SCORE_WEIGHTS.suspicious_patterns;
        reasons.push('Suspicious URL detected');
      }
    });

    // Check for money mentions
    const moneyMatches = message.match(/\$[0-9,]+/g) || [];
    if (moneyMatches.length > 1) {
      const moneyScore = moneyMatches.length * SCORE_WEIGHTS.money_mentions;
      score.total += moneyScore;
      score.details.money_mentions = moneyScore;
      reasons.push('Multiple money mentions');
    }

    // Check for excessive capitalization
    const capsWords = message.match(/[A-Z]{10,}/g) || [];
    if (capsWords.length > 0) {
      const capsScore = capsWords.length * SCORE_WEIGHTS.excessive_caps;
      score.total += capsScore;
      score.details.excessive_caps = capsScore;
      reasons.push('Excessive capitalization');
    }

    // Check for repeated characters
    if (/[!]{3,}|[?]{3,}|[.]{4,}/.test(message)) {
      score.total += SCORE_WEIGHTS.repeated_chars;
      score.details.repeated_chars = SCORE_WEIGHTS.repeated_chars;
      reasons.push('Repeated punctuation');
    }

    return { total: score.total, details: score.details, reasons };
  }

  /**
   * Check for rapid submissions from same IP/email
   */
  async checkRapidSubmissions(ipAddress, email) {
    try {
      const client = await pool.connect();
      try {
        // Check for submissions in last 5 minutes
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const result = await client.query(
          `SELECT COUNT(*) as count
           FROM contact_submissions
           WHERE (ip_address = $1 OR email_encrypted = $2)
           AND created_at > $3`,
          [ipAddress, email ? encryptData(email) : null, fiveMinutesAgo]
        );

        const count = parseInt(result.rows[0].count);
        if (count >= 3) {
          return SCORE_WEIGHTS.rapid_requests * (count - 2); // Exponential increase
        }

        return 0;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Rapid submission check failed:', error);
      return 0;
    }
  }

  /**
   * Analyze request data for anomalies
   */
  analyzeRequestData(data) {
    let score = 0;

    // Check for missing required fields
    const requiredFields = ['name', 'email', 'message'];
    const missingFields = requiredFields.filter(field => !data[field] || data[field].trim() === '');
    if (missingFields.length > 0) {
      score += missingFields.length * (SCORE_WEIGHTS.malformed_request / 2);
    }

    // Check for unusually long field values
    if (data.message && data.message.length > 1500) {
      score += SCORE_WEIGHTS.malformed_request / 3;
    }

    // Check for suspicious character combinations
    if (data.message && /[<>'"&]/.test(data.message)) {
      score += SCORE_WEIGHTS.malformed_request / 2;
    }

    return score;
  }

  /**
   * Calculate confidence score for spam detection
   */
  calculateConfidence(spamScore) {
    if (spamScore >= HIGH_SPAM_THRESHOLD) {
      return 'high';
    } else if (spamScore >= SPAM_THRESHOLD) {
      return 'medium';
    } else if (spamScore > 20) {
      return 'low';
    }
    return 'none';
  }

  /**
   * Report spam to improve detection
   */
  async reportSpam(ipAddress, email, characteristics) {
    try {
      // Add to known spam IPs
      this.knownSpamIPs.add(ipAddress);

      // Store in database for future reference
      const client = await pool.connect();
      try {
        // This could be enhanced with a dedicated spam_reports table
        logger.info('Spam reported', { ip: ipAddress, email, characteristics });
      } finally {
        client.release();
      }

      // Could also integrate with external spam reporting services
    } catch (error) {
      logger.error('Failed to report spam:', error);
    }
  }
}

// Create singleton instance
const spamProtection = new SpamProtection();

module.exports = {
  spamProtection,
  analyzeSubmission: (data, ip, userAgent) => spamProtection.analyzeSubmission(data, ip, userAgent),
  reportSpam: (ip, email, characteristics) => spamProtection.reportSpam(ip, email, characteristics),
  SPAM_THRESHOLD,
  HIGH_SPAM_THRESHOLD,
  SCORE_WEIGHTS
};