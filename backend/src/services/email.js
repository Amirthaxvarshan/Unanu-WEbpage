const nodemailer = require('nodemailer');
const { pool } = require('../config/database');
const { decryptSubmissionData } = require('./encryption');
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
});

class EmailService {
  constructor() {
    this.transporter = null;
    this.initialized = false;
    this.initializeTransporter();
  }

  /**
   * Initialize email transporter
   */
  initializeTransporter() {
    try {
      const config = {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      };

      // Validate required configuration
      if (!config.host || !config.auth.user || !config.auth.pass) {
        logger.warn('Email service not configured - missing SMTP settings');
        return;
      }

      this.transporter = nodemailer.createTransporter(config);
      this.initialized = true;

      // Verify connection
      this.transporter.verify((error, success) => {
        if (error) {
          logger.error('Email transporter verification failed:', error);
          this.initialized = false;
        } else {
          logger.info('Email transporter ready');
        }
      });

    } catch (error) {
      logger.error('Failed to initialize email service:', error);
      this.initialized = false;
    }
  }

  /**
   * Send new submission notification to admins
   */
  async sendNewSubmissionNotification(submissionId) {
    if (!this.initialized) {
      logger.warn('Email service not initialized - skipping notification');
      return false;
    }

    try {
      const client = await pool.connect();
      try {
        // Get submission details
        const result = await client.query(`
          SELECT
            id,
            name_encrypted,
            email_encrypted,
            company_encrypted,
            message_encrypted,
            status,
            created_at,
            spam_score
          FROM contact_submissions
          WHERE id = $1
        `, [submissionId]);

        if (result.rows.length === 0) {
          logger.warn('Submission not found for email notification', { submissionId });
          return false;
        }

        const submission = result.rows[0];
        const decryptedData = decryptSubmissionData(submission);

        // Don't send notifications for spam submissions
        if (submission.status === 'spam') {
          logger.debug('Skipping email notification for spam submission', { submissionId });
          return false;
        }

        const adminEmails = process.env.ADMIN_EMAILS?.split(',') || [];
        if (adminEmails.length === 0) {
          logger.warn('No admin emails configured');
          return false;
        }

        const subject = `New Contact Form Submission - ${decryptedData.name}`;
        const htmlContent = this.generateSubmissionEmail(submission, decryptedData);

        // Send to all admin emails
        const promises = adminEmails.map(email =>
          this.sendEmail(email, subject, htmlContent)
        );

        const results = await Promise.allSettled(promises);
        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        if (successful > 0) {
          logger.info('New submission notifications sent', {
            submissionId,
            successful,
            failed,
            totalAdmins: adminEmails.length
          });
          return true;
        } else {
          logger.error('All notification emails failed', { submissionId, failed });
          return false;
        }

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to send new submission notification:', error);
      return false;
    }
  }

  /**
   * Send email with error handling and rate limiting
   */
  async sendEmail(to, subject, htmlContent, options = {}) {
    if (!this.initialized) {
      throw new Error('Email service not initialized');
    }

    try {
      const mailOptions = {
        from: {
          name: process.env.FROM_NAME || 'UNANU Contact System',
          address: process.env.FROM_EMAIL || 'noreply@unanu.com'
        },
        to: Array.isArray(to) ? to.join(', ') : to,
        subject,
        html: htmlContent,
        ...options
      };

      const result = await this.transporter.sendMail(mailOptions);

      logger.debug('Email sent successfully', {
        to: mailOptions.to,
        subject,
        messageId: result.messageId
      });

      return result;

    } catch (error) {
      logger.error('Failed to send email:', {
        to,
        subject,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Generate HTML email for new submission
   */
  generateSubmissionEmail(submission, decryptedData) {
    const submissionUrl = `${process.env.ADMIN_BASE_URL || 'https://unanu.com/admin'}/submissions/${submission.id}`;
    const dashboardUrl = process.env.ADMIN_BASE_URL || 'https://unanu.com/admin';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Contact Form Submission</title>
        <style>
          body { font-family: 'Inter', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .header { background: #005B96; color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; }
          .content { padding: 30px 20px; }
          .field { margin-bottom: 20px; }
          .field-label { font-weight: 600; color: #666; margin-bottom: 5px; }
          .field-value { font-size: 16px; margin-bottom: 10px; }
          .button { display: inline-block; background: #005B96; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-right: 10px; }
          .button:hover { background: #004575; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
          .spam-warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 5px; margin-bottom: 20px; }
          .message-content { background: #f8f9fa; padding: 15px; border-radius: 5px; white-space: pre-wrap; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>New Contact Form Submission</h1>
          </div>

          <div class="content">
            ${submission.spam_score > 30 ? `
              <div class="spam-warning">
                <strong>⚠️ Possible Spam:</strong> This submission has a spam score of ${submission.spam_score}/100. Please review carefully.
              </div>
            ` : ''}

            <div class="field">
              <div class="field-label">From:</div>
              <div class="field-value"><strong>${decryptedData.name}</strong></div>
              <div class="field-value">${decryptedData.email}</div>
              ${decryptedData.company ? `<div class="field-value">${decryptedData.company}</div>` : ''}
            </div>

            <div class="field">
              <div class="field-label">Submitted:</div>
              <div class="field-value">${new Date(submission.created_at).toLocaleString()}</div>
            </div>

            <div class="field">
              <div class="field-label">Message:</div>
              <div class="message-content">${decryptedData.message}</div>
            </div>

            <div style="margin-top: 30px;">
              <a href="${submissionUrl}" class="button">View Full Submission</a>
              <a href="${dashboardUrl}" class="button" style="background: #6c757d;">Go to Dashboard</a>
            </div>
          </div>

          <div class="footer">
            <p>This notification was sent from the UNANU Contact System.</p>
            <p>If you're receiving this in error, please contact your system administrator.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Send status change notification
   */
  async sendStatusChangeNotification(submissionId, oldStatus, newStatus, notes) {
    if (!this.initialized) {
      return false;
    }

    try {
      const client = await pool.connect();
      try {
        // Get submission details
        const result = await client.query(`
          SELECT
            id,
            name_encrypted,
            email_encrypted,
            status,
            updated_at
          FROM contact_submissions
          WHERE id = $1
        `, [submissionId]);

        if (result.rows.length === 0) {
          return false;
        }

        const submission = result.rows[0];
        const decryptedData = decryptSubmissionData(submission);

        // Send email to original submitter if status changed to resolved
        if (newStatus === 'resolved' && decryptedData.email) {
          const subject = 'Your inquiry with UNANU has been resolved';
          const htmlContent = this.generateResolutionEmail(submission, decryptedData, notes);

          try {
            await this.sendEmail(decryptedData.email, subject, htmlContent);
            logger.info('Resolution notification sent to customer', {
              submissionId,
              email: decryptedData.email
            });
          } catch (emailError) {
            logger.error('Failed to send resolution notification:', emailError);
          }
        }

        return true;

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to send status change notification:', error);
      return false;
    }
  }

  /**
   * Generate resolution email to customer
   */
  generateResolutionEmail(submission, decryptedData, notes) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Your UNANU Inquiry Has Been Resolved</title>
        <style>
          body { font-family: 'Inter', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .header { background: #28a745; color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; }
          .content { padding: 30px 20px; }
          .button { display: inline-block; background: #005B96; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✓ Your Inquiry Has Been Resolved</h1>
          </div>

          <div class="content">
            <p>Dear ${decryptedData.name},</p>

            <p>Thank you for contacting UNANU. We're pleased to inform you that your recent inquiry has been resolved by our team.</p>

            ${notes ? `
              <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <strong>Resolution Details:</strong><br>
                ${notes}
              </div>
            ` : ''}

            <p>If you have any further questions or need additional assistance, please don't hesitate to contact us again.</p>

            <div style="margin-top: 30px;">
              <a href="https://unanu.com/contact-us.html" class="button">Contact Us Again</a>
            </div>
          </div>

          <div class="footer">
            <p>This email was sent from the UNANU Contact System.</p>
            <p>UNANU Technologies Private Ltd. | Chennai, India</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Send test email for configuration verification
   */
  async sendTestEmail(to) {
    if (!this.initialized) {
      throw new Error('Email service not initialized');
    }

    const subject = 'UNANU Contact System - Email Test';
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #005B96;">Email Configuration Test</h2>
        <p>This is a test email to verify that the UNANU Contact System email service is working correctly.</p>
        <p><strong>Sent:</strong> ${new Date().toLocaleString()}</p>
        <p><strong>To:</strong> ${to}</p>
        <hr style="margin: 30px 0;">
        <p style="color: #666; font-size: 14px;">If you received this email, the configuration is working properly.</p>
      </div>
    `;

    return await this.sendEmail(to, subject, htmlContent);
  }

  /**
   * Reinitialize transporter (useful for configuration changes)
   */
  reinitialize() {
    this.initializeTransporter();
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
    };
  }
}

// Create singleton instance
const emailService = new EmailService();

module.exports = {
  emailService,
  sendNewSubmissionNotification: (submissionId) => emailService.sendNewSubmissionNotification(submissionId),
  sendStatusChangeNotification: (submissionId, oldStatus, newStatus, notes) =>
    emailService.sendStatusChangeNotification(submissionId, oldStatus, newStatus, notes),
  sendTestEmail: (to) => emailService.sendTestEmail(to),
  getStatus: () => emailService.getStatus()
};