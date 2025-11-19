# UNANU Contact System - Secure Backend

A production-ready, secure contact form backend system with spam protection, rate limiting, encryption, and admin dashboard for the UNANU trucking/logistics platform.

## 🚀 Features

### Security & Protection
- **End-to-End Encryption**: AES-256-GCM encryption for all PII data
- **Rate Limiting**: Redis-based with IP and email tracking
- **Spam Protection**: Multi-layer detection with honeypot and pattern analysis
- **Input Validation**: Comprehensive validation and XSS prevention
- **CSRF Protection**: Cross-site request forgery prevention
- **Audit Logging**: Complete audit trail for all actions

### Admin Features
- **Card-Based Dashboard**: Modern, responsive admin interface
- **Real-Time Statistics**: Submission metrics and analytics
- **Submission Management**: View, update status, export submissions
- **User Management**: Role-based access control (Admin/Moderator)
- **Email Notifications**: Automated alerts for new submissions

### Technical Features
- **JWT Authentication**: Secure token-based authentication
- **Database**: PostgreSQL with encrypted data storage
- **Caching**: Redis integration for performance
- **Email**: SendGrid/SMTP integration with templates
- **API Documentation**: RESTful API with comprehensive documentation
- **Docker Support**: Complete containerization with Docker Compose

## 📋 Prerequisites

- Node.js 18+
- PostgreSQL 13+
- Redis 6+
- npm or yarn

## 🛠️ Quick Start

### 1. Clone and Setup

```bash
cd backend
npm install
```

### 2. Environment Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit with your configuration
nano .env
```

### 3. Database Setup

```bash
# Run database migrations
npm run migrate

# Seed admin users
npm run seed
```

### 4. Start Development Server

```bash
npm run dev
```

The API will be available at `http://localhost:3000`
Admin dashboard at `http://localhost:3000/admin`

## 🐳 Docker Deployment

### Using Docker Compose (Recommended)

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

Services included:
- **PostgreSQL**: Database with automated migrations
- **Redis**: Rate limiting and caching
- **Backend API**: Node.js application
- **Nginx**: Reverse proxy and static file serving
- **Mailhog**: Email testing (development only)

### Manual Docker Build

```bash
# Build image
docker build -t unanu-contact-backend .

# Run container
docker run -p 3000:3000 --env-file .env unanu-contact-backend
```

## 📡 API Documentation

### Authentication

```bash
# Login
POST /api/contact/auth/login
{
  "email": "admin@unanu.com",
  "password": "your_password"
}

# Response
{
  "success": true,
  "token": "jwt_token_here",
  "user": {
    "id": "user_id",
    "email": "admin@unanu.com",
    "role": "admin"
  }
}
```

### Contact Form Submission

```bash
# Submit contact form
POST /api/contact
{
  "name": "John Doe",
  "email": "john@example.com",
  "company": "Example Corp",
  "phone": "+1234567890",
  "message": "I need help with logistics...",
  "consent": true,
  "honeypot": ""
}
```

### Admin Endpoints

```bash
# Get all submissions
GET /api/contact/admin/submissions
Authorization: Bearer {token}

# Get submission details
GET /api/contact/admin/submissions/{id}
Authorization: Bearer {token}

# Update submission status
PATCH /api/contact/admin/submissions/{id}/status
{
  "status": "resolved",
  "notes": "Customer contacted via phone"
}
Authorization: Bearer {token}
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection | Required |
| `ENCRYPTION_KEY` | 32-byte hex key | Required |
| `JWT_SECRET` | JWT signing secret | Required |
| `RATE_LIMIT_REDIS_URL` | Redis connection | Required |
| `SMTP_HOST` | Email server host | Required |

### Security Configuration

```bash
# Generate encryption key (32 bytes, 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate JWT secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## 📊 Monitoring

### Health Checks

```bash
# API health check
GET /health

# System status (admin only)
GET /api/contact/admin/system/status
```

### Logging

- **Access Logs**: Nginx access logs
- **Error Logs**: Application error logs
- **Audit Logs**: Database audit trail
- **Security Events**: Spam detection, rate limiting

## 🧪 Testing

```bash
# Run unit tests
npm test

# Run integration tests
npm run test:integration

# Run with coverage
npm run test:coverage

# Run E2E tests
npm run test:e2e
```

## 📚 Documentation

- [API Reference](./docs/api.md)
- [Security Guide](./docs/security.md)
- [Deployment Guide](./docs/deployment.md)
- [Admin Guide](./docs/admin.md)

## 🔒 Security Features

### Data Protection
- All PII encrypted at rest using AES-256-GCM
- Encrypted data transmission (HTTPS)
- Data retention policies (2 years default)
- GDPR compliance features

### Access Control
- Role-based permissions (Admin/Moderator)
- JWT token authentication with 30-minute expiry
- Session management with secure storage
- Failed login attempt tracking

### Spam Prevention
- Honeypot field detection
- Pattern-based spam scoring
- IP reputation checking
- Rate limiting per IP/email
- Content filtering and validation

### Rate Limiting
- IP-based: 3 submissions/hour, 20/day
- Email-based: 5 submissions/day
- Admin actions: 30 requests/minute
- Redis-based with fallback to database

## 🚀 Deployment

### Production Deployment

1. **Environment Setup**
   ```bash
   export NODE_ENV=production
   cp .env.production .env
   # Edit production configuration
   ```

2. **Database Migration**
   ```bash
   npm run migrate
   ```

3. **Start Application**
   ```bash
   npm start
   # Or with PM2
   pm2 start ecosystem.config.js
   ```

### Docker Production Deployment

```bash
# Production compose file
docker-compose -f docker-compose.prod.yml up -d

# With scaling
docker-compose -f docker-compose.prod.yml up -d --scale backend=3
```

## 🛠️ Maintenance

### Database Maintenance

```bash
# Cleanup old data (retention policy)
npm run cleanup

# Backup database
npm run backup

# Optimize database
npm run optimize
```

### Log Management

```bash
# Rotate logs
npm run logs:rotate

# Archive old logs
npm run logs:archive
```

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is proprietary to UNANU Technologies Private Ltd.

## 📞 Support

For technical support:
- Email: tech@unanu.com
- Internal: Create ticket in project management system

## 🔗 Related Projects

- [UNANU Frontend](../Unanu-WEbpage/) - Main website
- [UNANU Platform](../platform/) - Core logistics platform
- [UNANU Analytics](../analytics/) - Data analytics system

---

**Security Notice**: This system handles sensitive personal data. Ensure proper security practices and follow company data protection policies.