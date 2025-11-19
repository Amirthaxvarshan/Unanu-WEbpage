const { authenticate, logout, refreshToken } = require('../services/auth');
const winston = require('winston');

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

/**
 * Admin login controller
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const ipAddress = req.ip;
    const userAgent = req.get('User-Agent');

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const result = await authenticate(email, password, ipAddress, userAgent);

    if (result.success) {
      logger.info('Admin login successful', {
        userId: result.user.id,
        email,
        ip: ipAddress
      });

      res.json({
        success: true,
        token: result.token,
        user: {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role,
          lastLogin: result.user.lastLogin
        }
      });

    } else {
      logger.warn('Admin login failed', {
        email,
        ip: ipAddress,
        reason: result.message
      });

      res.status(401).json({
        success: false,
        message: result.message
      });
    }

  } catch (error) {
    logger.error('Login controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
};

/**
 * Admin logout controller
 */
const logoutController = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token required for logout'
      });
    }

    const result = await logout(token);

    if (result.success) {
      logger.info('Admin logout successful', {
        userId: req.user?.id,
        ip: req.ip
      });

      res.json({
        success: true,
        message: result.message
      });

    } else {
      res.status(400).json({
        success: false,
        message: result.message
      });
    }

  } catch (error) {
    logger.error('Logout controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Logout failed'
    });
  }
};

/**
 * Token refresh controller
 */
const refreshTokenController = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token required for refresh'
      });
    }

    const result = await refreshToken(token, req.ip, req.get('User-Agent'));

    if (result.success) {
      logger.info('Token refreshed successfully', {
        userId: req.user?.id,
        ip: req.ip
      });

      res.json({
        success: true,
        token: result.token
      });

    } else {
      res.status(401).json({
        success: false,
        message: result.message
      });
    }

  } catch (error) {
    logger.error('Token refresh controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Token refresh failed'
    });
  }
};

module.exports = {
  login,
  logout: logoutController,
  refreshToken: refreshTokenController
};