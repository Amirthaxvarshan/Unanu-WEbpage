# UNANU Contact System - Deployment Guide

This comprehensive guide covers deploying the UNANU Contact System in various environments.

## 📋 Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Setup](#environment-setup)
3. [Database Setup](#database-setup)
4. [Application Deployment](#application-deployment)
5. [Docker Deployment](#docker-deployment)
6. [Production Deployment](#production-deployment)
7. [Monitoring & Maintenance](#monitoring--maintenance)
8. [Troubleshooting](#troubleshooting)

## 🚀 Prerequisites

### System Requirements

- **Operating System**: Ubuntu 20.04+ / CentOS 8+ / RHEL 8+
- **CPU**: Minimum 2 cores, Recommended 4 cores
- **Memory**: Minimum 4GB RAM, Recommended 8GB RAM
- **Storage**: Minimum 50GB SSD, Recommended 100GB SSD
- **Network**: Stable internet connection

### Software Requirements

- **Node.js**: 18.x LTS or higher
- **PostgreSQL**: 13.x or higher
- **Redis**: 6.x or higher
- **Nginx**: 1.18+ (for production)
- **SSL Certificate**: For HTTPS (Let's Encrypt recommended)

### External Services

- **Email Service**: SendGrid, AWS SES, or SMTP server
- **Domain**: Configured DNS for SSL and email
- **Monitoring**: Optional (New Relic, DataDog, Sentry)

## 🔧 Environment Setup

### 1. Server Preparation

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y curl wget git build-essential \
    postgresql-client redis-tools nginx certbot \
    python3-certbot-nginx

# Create application user
sudo useradd -m -s /bin/bash unanu
sudo usermod -aG sudo unanu
```

### 2. Node.js Installation

```bash
# Install Node.js 18.x LTS
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version  # Should be v18.x.x
npm --version   # Should be 9.x.x
```

### 3. PostgreSQL Setup

```bash
# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Start and enable service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Create database and user
sudo -u postgres psql << EOF
CREATE DATABASE unanu_contacts;
CREATE USER unanu_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE unanu_contacts TO unanu_user;
ALTER USER unanu_user CREATEDB;
\q
EOF
```

### 4. Redis Setup

```bash
# Install Redis
sudo apt install -y redis-server

# Configure Redis
sudo nano /etc/redis/redis.conf
# Update these settings:
# bind 127.0.0.1
# requirepass your_redis_password
# maxmemory 256mb
# maxmemory-policy allkeys-lru

# Restart Redis
sudo systemctl restart redis-server
sudo systemctl enable redis-server
```

## 🗄️ Database Setup

### 1. Clone Repository

```bash
# Switch to application user
sudo su - unanu

# Clone repository (replace with your repo URL)
git clone https://github.com/your-org/unanu-contact-backend.git
cd unanu-contact-backend/backend
```

### 2. Install Dependencies

```bash
# Install npm dependencies
npm install --production

# Install development dependencies (optional)
npm install
```

### 3. Environment Configuration

```bash
# Copy production environment template
cp .env.production .env

# Edit configuration
nano .env
```

**Critical Environment Variables:**

```bash
# Environment
NODE_ENV=production
PORT=3000

# Security (Generate new values!)
ENCRYPTION_KEY=your_32_byte_hex_key_here
JWT_SECRET=your_jwt_secret_here

# Database
DATABASE_URL=postgresql://unanu_user:your_secure_password@localhost:5432/unanu_contacts
DATABASE_SSL_MODE=require

# Redis
RATE_LIMIT_REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=your_redis_password

# Email
SMTP_HOST=smtp.sendgrid.net
SMTP_USER=apikey
SMTP_PASS=your_sendgrid_api_key
FROM_EMAIL=noreply@unanu.com
ADMIN_EMAILS=admin@unanu.com,ops@unanu.com
```

### 4. Database Migration

```bash
# Run database migrations
npm run migrate

# Seed admin users
npm run seed

# Verify setup
node -e "
const { testConnection } = require('./src/config/database');
testConnection().then(() => console.log('✅ Database connected successfully'))
  .catch(err => console.error('❌ Database connection failed:', err));
"
```

## 🚀 Application Deployment

### 1. PM2 Setup (Process Manager)

```bash
# Install PM2 globally
sudo npm install -g pm2

# Create PM2 ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'unanu-contact',
    script: 'src/server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    max_memory_restart: '1G',
    node_args: '--max-old-space-size=1024'
  }]
};
EOF

# Create logs directory
mkdir -p logs

# Start application
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 startup script
pm2 startup
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u unanu --hp /home/unanu
```

### 2. Nginx Configuration

```bash
# Create Nginx site configuration
sudo nano /etc/nginx/sites-available/unanu-contact
```

**Nginx Configuration:**

```nginx
server {
    listen 80;
    server_name unanu.com www.unanu.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name unanu.com www.unanu.com;

    # SSL Configuration
    ssl_certificate /etc/letsencrypt/live/unanu.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/unanu.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;
    ssl_prefer_server_ciphers off;

    # Security Headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Referrer-Policy "strict-origin-when-cross-origin";

    # Contact API
    location /api/contact/ {
        limit_req zone=api burst=20 nodelay;

        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
    }

    # Admin Dashboard
    location /admin/ {
        proxy_pass http://localhost:3000/admin/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Static Website
    location / {
        root /var/www/html;
        try_files $uri $uri/ /index.html;

        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }

    # Health Check
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}
```

### 3. SSL Certificate Setup

```bash
# Obtain SSL certificate
sudo certbot --nginx -d unanu.com -d www.unanu.com

# Test auto-renewal
sudo certbot renew --dry-run

# Add cron job for auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

### 4. Enable Site

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/unanu-contact /etc/nginx/sites-enabled/

# Test Nginx configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

## 🐳 Docker Deployment

### 1. Production Docker Compose

Create `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./backups:/backups
    networks:
      - unanu-network
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 512M

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    networks:
      - unanu-network
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M

  backend:
    build:
      context: .
      dockerfile: Dockerfile.prod
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      RATE_LIMIT_REDIS_URL: redis://redis:6379
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
      JWT_SECRET: ${JWT_SECRET}
    depends_on:
      - postgres
      - redis
    networks:
      - unanu-network
    restart: unless-stopped
    deploy:
      replicas: 3
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf
      - ./nginx/ssl:/etc/nginx/ssl
      - ../Unanu-WEbpage:/var/www/html
      - ./logs/nginx:/var/log/nginx
    depends_on:
      - backend
    networks:
      - unanu-network
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:

networks:
  unanu-network:
    driver: bridge
```

### 2. Deploy with Docker

```bash
# Set environment variables
export POSTGRES_DB=unanu_contacts
export POSTGRES_USER=unanu_user
export POSTGRES_PASSWORD=your_secure_password
export REDIS_PASSWORD=your_redis_password
export ENCRYPTION_KEY=your_32_byte_key
export JWT_SECRET=your_jwt_secret

# Deploy services
docker-compose -f docker-compose.prod.yml up -d

# Run database migrations
docker-compose -f docker-compose.prod.yml exec backend npm run migrate

# Seed admin users
docker-compose -f docker-compose.prod.yml exec backend npm run seed
```

## 🔍 Production Deployment

### 1. Health Checks

```bash
# Application health
curl https://unanu.com/health

# API health
curl https://unanu.com/api/contact/health

# Database connection test
docker-compose exec backend node -e "
const { testConnection } = require('./src/config/database');
testConnection().then(() => console.log('✅ DB OK')).catch(e => console.error('❌ DB Error', e));
"
```

### 2. Monitoring Setup

```bash
# Install monitoring tools
npm install -g @newrelic/native
npm install newrelic

# Create New Relic configuration
cat > newrelic.js << 'EOF'
exports.config = {
  app_name: ['UNANU Contact System'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  logging: {
    level: 'info'
  }
};
EOF
```

### 3. Backup Strategy

```bash
# Create backup script
cat > backup.sh << 'EOF'
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/home/unanu/backups"

# Database backup
pg_dump -h localhost -U unanu_user -d unanu_contacts > $BACKUP_DIR/db_backup_$DATE.sql

# Compress backup
gzip $BACKUP_DIR/db_backup_$DATE.sql

# Keep only last 30 days
find $BACKUP_DIR -name "db_backup_*.sql.gz" -mtime +30 -delete

# Upload to cloud storage (optional)
# aws s3 cp $BACKUP_DIR/db_backup_$DATE.sql.gz s3://unanu-backups/
EOF

chmod +x backup.sh

# Add to cron
crontab -e
# Add: 0 2 * * * /home/unanu/backup.sh
```

## 📊 Monitoring & Maintenance

### 1. Log Management

```bash
# Setup log rotation
sudo nano /etc/logrotate.d/unanu-contact

# Content:
/home/unanu/unanu-contact-backend/backend/logs/*.log {
    daily
    missingok
    rotate 52
    compress
    delaycompress
    notifempty
    create 644 unanu unanu
    postrotate
        pm2 reloadLogs
    endscript
}
```

### 2. Performance Monitoring

```bash
# Monitor application metrics
pm2 monit

# Check system resources
pm2 show unanu-contact

# Monitor logs in real-time
pm2 logs unanu-contact

# System monitoring
htop
iostat -x 1
```

### 3. Security Monitoring

```bash
# Monitor failed login attempts
sudo tail -f /var/log/auth.log | grep "Failed password"

# Monitor application security events
sudo tail -f /home/unanu/unanu-contact-backend/backend/logs/combined.log | grep -i "security\|spam\|rate.*limit"

# Check SSL certificate expiry
sudo certbot certificates
```

## 🔧 Troubleshooting

### Common Issues

#### Database Connection Errors
```bash
# Check PostgreSQL status
sudo systemctl status postgresql

# Check connection
psql -h localhost -U unanu_user -d unanu_contacts -c "SELECT 1;"

# Check logs
sudo tail -f /var/log/postgresql/postgresql-*.log
```

#### Redis Connection Errors
```bash
# Check Redis status
sudo systemctl status redis-server

# Test connection
redis-cli -a your_redis_password ping

# Check Redis logs
sudo tail -f /var/log/redis/redis-server.log
```

#### Application Errors
```bash
# Check PM2 status
pm2 status

# View application logs
pm2 logs unanu-contact --lines 100

# Restart application
pm2 restart unanu-contact

# Check system resources
free -h
df -h
```

#### Nginx Issues
```bash
# Test Nginx configuration
sudo nginx -t

# Check Nginx status
sudo systemctl status nginx

# View Nginx logs
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

### Performance Issues

#### High Memory Usage
```bash
# Check memory usage
pm2 show unanu-contact

# Optimize Node.js memory
pm2 delete unanu-contact
pm2 start ecosystem.config.js --node-args="--max-old-space-size=2048"
```

#### High CPU Usage
```bash
# Monitor CPU usage
top -p $(pgrep -f "src/server.js")

# Check for memory leaks
pm2 monit
```

#### Slow Database Queries
```bash
# Enable slow query logging
sudo nano /etc/postgresql/*/main/postgresql.conf
# Add: log_min_duration_statement = 1000

# Restart PostgreSQL
sudo systemctl restart postgresql
```

## 📞 Support

For deployment issues:
- **Documentation**: Check this guide and API documentation
- **Logs**: Review application and system logs
- **Monitoring**: Use PM2 monitoring and system metrics
- **Team**: Contact DevOps team for server-level issues

## 🔄 Updates & Maintenance

### Application Updates

```bash
# Pull latest code
git pull origin main

# Install new dependencies
npm install

# Run migrations
npm run migrate

# Restart application
pm2 restart unanu-contact
```

### Security Updates

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Update Node.js
nvm install --lts
nvm use --lts

# Update Nginx
sudo apt install --only-upgrade nginx
```

### Database Maintenance

```bash
# Vacuum and analyze database
psql -h localhost -U unanu_user -d unanu_contacts -c "VACUUM ANALYZE;"

# Update statistics
psql -h localhost -U unanu_user -d unanu_contacts -c "ANALYZE;"

# Check table sizes
psql -h localhost -U unanu_user -d unanu_contacts -c "
    SELECT
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
"
```

---

This deployment guide provides comprehensive instructions for deploying the UNANU Contact System in production. Follow all security best practices and regularly update and monitor the system.