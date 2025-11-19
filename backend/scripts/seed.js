#!/usr/bin/env node

const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/database');
const { encryptData } = require('../src/services/encryption');

const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  success: (msg) => console.log(`[SUCCESS] ${msg}`)
};

async function seedDatabase() {
  try {
    logger.info('Seeding database with initial data...');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create default admin user
      const adminEmail = 'admin@unanu.com';
      const adminPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'ChangeMe123!@#';
      const hashedPassword = await bcrypt.hash(adminPassword, 12);
      const encryptedEmail = encryptData(adminEmail);

      // Check if admin user already exists
      const existingAdmin = await client.query(
        'SELECT id FROM admin_users WHERE email_encrypted = $1',
        [encryptedEmail]
      );

      if (existingAdmin.rows.length === 0) {
        await client.query(`
          INSERT INTO admin_users (
            email_encrypted,
            password_hash,
            role,
            is_active
          ) VALUES ($1, $2, $3, $4)
        `, [encryptedEmail, hashedPassword, 'admin', true]);

        logger.success('Default admin user created');
        logger.info(`Email: ${adminEmail}`);
        logger.info(`Password: ${adminPassword}`);
        logger.warning('Please change the default password after first login!');
      } else {
        logger.info('Admin user already exists');
      }

      // Create sample moderator user
      const moderatorEmail = 'moderator@unanu.com';
      const moderatorPassword = process.env.MODERATOR_DEFAULT_PASSWORD || 'ModChange123!@#';
      const moderatorHashedPassword = await bcrypt.hash(moderatorPassword, 12);
      const encryptedModeratorEmail = encryptData(moderatorEmail);

      const existingModerator = await client.query(
        'SELECT id FROM admin_users WHERE email_encrypted = $1',
        [encryptedModeratorEmail]
      );

      if (existingModerator.rows.length === 0) {
        await client.query(`
          INSERT INTO admin_users (
            email_encrypted,
            password_hash,
            role,
            is_active
          ) VALUES ($1, $2, $3, $4)
        `, [encryptedModeratorEmail, moderatorHashedPassword, 'moderator', true]);

        logger.success('Default moderator user created');
        logger.info(`Email: ${moderatorEmail}`);
        logger.info(`Password: ${moderatorPassword}`);
      } else {
        logger.info('Moderator user already exists');
      }

      await client.query('COMMIT');
      logger.success('Database seeding completed successfully!');

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    logger.error(`Seeding failed: ${error.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Check if this script is being run directly
if (require.main === module) {
  seedDatabase();
}

module.exports = { seedDatabase };