// UNANU Admin Dashboard Application
class AdminDashboard {
    constructor() {
        this.apiBase = this.getApiBaseUrl();
        this.token = localStorage.getItem('adminToken');
        this.user = null;
        this.currentPage = 'dashboard';
        this.submissions = [];
        this.stats = {};
        this.pagination = {
            page: 1,
            limit: 12,
            total: 0,
            totalPages: 0
        };
        this.filters = {
            search: '',
            status: '',
            dateFrom: '',
            dateTo: ''
        };

        this.init();
    }

    getApiBaseUrl() {
        const hostname = window.location.hostname;
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return 'http://localhost:3000/api/contact';
        }
        return '/api/contact';
    }

    async init() {
        try {
            // Check authentication
            if (this.token) {
                await this.validateToken();
                if (this.user) {
                    this.showDashboard();
                    await this.loadDashboardData();
                } else {
                    this.showLogin();
                }
            } else {
                this.showLogin();
            }

            // Setup event listeners
            this.setupEventListeners();

        } catch (error) {
            console.error('Dashboard initialization error:', error);
            this.showToast('Failed to initialize dashboard', 'error');
            this.showLogin();
        }
    }

    setupEventListeners() {
        // Login form
        document.getElementById('loginForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLogin();
        });

        // Logout
        document.getElementById('logoutBtn')?.addEventListener('click', () => {
            this.handleLogout();
        });

        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const page = item.dataset.page;
                this.navigateToPage(page);
            });
        });

        // Modal
        document.getElementById('closeModalBtn')?.addEventListener('click', () => {
            this.closeModal();
        });

        // Dashboard actions
        document.getElementById('refreshBtn')?.addEventListener('click', () => {
            this.loadDashboardData();
        });

        document.getElementById('exportBtn')?.addEventListener('click', () => {
            this.exportSubmissions();
        });

        document.getElementById('testEmailBtn')?.addEventListener('click', () => {
            this.testEmail();
        });

        // Filters
        document.getElementById('applyFiltersBtn')?.addEventListener('click', () => {
            this.applyFilters();
        });

        document.getElementById('clearFiltersBtn')?.addEventListener('click', () => {
            this.clearFilters();
        });

        document.getElementById('searchInput')?.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                this.applyFilters();
            }
        });

        // Pagination
        document.getElementById('prevPageBtn')?.addEventListener('click', () => {
            if (this.pagination.page > 1) {
                this.pagination.page--;
                this.loadSubmissions();
            }
        });

        document.getElementById('nextPageBtn')?.addEventListener('click', () => {
            if (this.pagination.page < this.pagination.totalPages) {
                this.pagination.page++;
                this.loadSubmissions();
            }
        });

        // Modal actions
        document.getElementById('updateStatusBtn')?.addEventListener('click', () => {
            this.updateSubmissionStatus();
        });

        document.getElementById('markSpamBtn')?.addEventListener('click', () => {
            this.markAsSpam();
        });

        document.getElementById('deleteBtn')?.addEventListener('click', () => {
            this.deleteSubmission();
        });

        // Settings
        document.getElementById('changePasswordBtn')?.addEventListener('click', () => {
            this.changePassword();
        });

        // Close modal on backdrop click
        document.getElementById('submissionModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'submissionModal') {
                this.closeModal();
            }
        });

        // Toast close
        document.getElementById('toastClose')?.addEventListener('click', () => {
            this.hideToast();
        });
    }

    // Authentication
    async validateToken() {
        try {
            const response = await fetch(`${this.apiBase}/admin/system/status`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                // Token is valid, decode to get user info
                const payload = this.parseJWT(this.token);
                this.user = {
                    id: payload.id,
                    email: payload.email,
                    role: payload.role
                };
                return true;
            } else {
                localStorage.removeItem('adminToken');
                this.token = null;
                return false;
            }
        } catch (error) {
            console.error('Token validation error:', error);
            localStorage.removeItem('adminToken');
            this.token = null;
            return false;
        }
    }

    parseJWT(token) {
        try {
            const base64Url = token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(atob(base64).split('').map((c) => {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
            return JSON.parse(jsonPayload);
        } catch (error) {
            console.error('JWT parsing error:', error);
            return {};
        }
    }

    async handleLogin() {
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const loginBtn = document.getElementById('loginBtn');

        if (!email || !password) {
            this.showToast('Please enter email and password', 'error');
            return;
        }

        try {
            loginBtn.classList.add('loading');
            loginBtn.disabled = true;

            const response = await fetch(`${this.apiBase}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email, password })
            });

            const result = await response.json();

            if (result.success) {
                this.token = result.token;
                this.user = result.user;
                localStorage.setItem('adminToken', this.token);
                this.showDashboard();
                await this.loadDashboardData();
                this.showToast('Login successful', 'success');
            } else {
                this.showToast(result.message || 'Login failed', 'error');
            }

        } catch (error) {
            console.error('Login error:', error);
            this.showToast('Network error during login', 'error');
        } finally {
            loginBtn.classList.remove('loading');
            loginBtn.disabled = false;
        }
    }

    handleLogout() {
        if (confirm('Are you sure you want to sign out?')) {
            localStorage.removeItem('adminToken');
            this.token = null;
            this.user = null;
            this.showLogin();
            this.showToast('Signed out successfully', 'success');
        }
    }

    // UI Navigation
    showLogin() {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('loginScreen').style.display = 'flex';
        document.getElementById('dashboard').style.display = 'none';
    }

    showDashboard() {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('dashboard').style.display = 'flex';

        // Update user info
        if (this.user) {
            document.getElementById('userName').textContent = this.user.email;
            document.getElementById('userEmail').textContent = this.user.email;
            document.getElementById('userRole').textContent = this.user.role.charAt(0).toUpperCase() + this.user.role.slice(1);
        }
    }

    navigateToPage(page) {
        // Update navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-page="${page}"]`).classList.add('active');

        // Update page content
        document.querySelectorAll('.page').forEach(p => {
            p.classList.remove('active');
        });
        document.getElementById(`${page}Page`).classList.add('active');

        this.currentPage = page;

        // Load page-specific data
        switch (page) {
            case 'dashboard':
                this.loadDashboardData();
                break;
            case 'submissions':
                this.loadSubmissions();
                break;
            case 'analytics':
                this.loadAnalytics();
                break;
            case 'settings':
                this.loadSettings();
                break;
        }
    }

    // API Calls
    async apiCall(endpoint, options = {}) {
        const url = `${this.apiBase}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        try {
            const response = await fetch(url, {
                ...options,
                headers
            });

            if (response.status === 401) {
                // Token expired or invalid
                this.handleLogout();
                throw new Error('Authentication required');
            }

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || `HTTP error! status: ${response.status}`);
            }

            return data;
        } catch (error) {
            console.error(`API call error (${endpoint}):`, error);
            throw error;
        }
    }

    // Data Loading
    async loadDashboardData() {
        try {
            // Load stats
            const statsResponse = await this.apiCall('/admin/stats');
            this.stats = statsResponse.data.stats;

            // Update stats cards
            this.updateStatsCards();

            // Load recent submissions
            const submissionsResponse = await this.apiCall('/admin/submissions?limit=6');
            this.displayRecentSubmissions(submissionsResponse.data.submissions);

            // Update new count badge
            this.updateNewCount();

        } catch (error) {
            console.error('Dashboard data loading error:', error);
            this.showToast('Failed to load dashboard data', 'error');
        }
    }

    updateStatsCards() {
        const stats = this.stats;
        document.getElementById('totalSubmissions').textContent = stats.total_submissions || 0;
        document.getElementById('newToday').textContent = stats.submissions_today || 0;
        document.getElementById('inProgress').textContent = stats.in_progress_submissions || 0;
        document.getElementById('resolved').textContent = stats.resolved_submissions || 0;

        // Update change indicators (placeholder logic)
        document.getElementById('totalChange').textContent = 'All time';
        document.getElementById('newChange').textContent = stats.submissions_today > 0 ? 'Today' : 'None today';
        document.getElementById('progressChange').textContent = stats.in_progress_submissions > 0 ? 'Active' : 'None';
        document.getElementById('resolvedChange').textContent = `${Math.round((stats.resolved_submissions / stats.total_submissions) * 100)}% resolved`;
    }

    displayRecentSubmissions(submissions) {
        const container = document.getElementById('recentSubmissions');

        if (!submissions || submissions.length === 0) {
            container.innerHTML = '<div class="loading-placeholder">No recent submissions found</div>';
            return;
        }

        container.innerHTML = submissions.map(submission => this.createSubmissionCard(submission)).join('');

        // Add click handlers
        container.querySelectorAll('.submission-card').forEach(card => {
            card.addEventListener('click', () => {
                const submissionId = card.dataset.id;
                this.viewSubmission(submissionId);
            });
        });
    }

    createSubmissionCard(submission) {
        const statusColor = this.getStatusColor(submission.status);
        const statusText = this.getStatusText(submission.status);
        const date = new Date(submission.created_at).toLocaleDateString();

        return `
            <div class="submission-card" data-id="${submission.id}">
                <div class="card-header">
                    <div>
                        <div class="card-title">Submission #${submission.id.slice(0, 8)}</div>
                        <div class="card-email">j***@example.com</div>
                    </div>
                    <span class="status-badge ${statusColor}">${statusText}</span>
                </div>
                <div class="card-message">
                    Contact form submission received...
                </div>
                <div class="card-footer">
                    <span class="card-date">${date}</span>
                    <div class="card-actions">
                        <button class="btn btn-sm primary" onclick="event.stopPropagation(); dashboard.viewSubmission('${submission.id}')">View</button>
                    </div>
                </div>
            </div>
        `;
    }

    async loadSubmissions() {
        try {
            this.showLoading('submissionsGrid');

            const params = new URLSearchParams({
                page: this.pagination.page,
                limit: this.pagination.limit,
                ...this.filters
            });

            const response = await this.apiCall(`/admin/submissions?${params}`);
            const data = response.data;

            this.submissions = data.submissions;
            this.pagination = data.pagination;

            this.displaySubmissions();
            this.updatePagination();
            this.updateNewCount();

        } catch (error) {
            console.error('Submissions loading error:', error);
            this.showToast('Failed to load submissions', 'error');
        }
    }

    displaySubmissions() {
        const container = document.getElementById('submissionsGrid');

        if (!this.submissions || this.submissions.length === 0) {
            container.innerHTML = '<div class="loading-placeholder">No submissions found</div>';
            return;
        }

        container.innerHTML = this.submissions.map(submission => this.createSubmissionCard(submission)).join('');

        // Add click handlers
        container.querySelectorAll('.submission-card').forEach(card => {
            card.addEventListener('click', () => {
                const submissionId = card.dataset.id;
                this.viewSubmission(submissionId);
            });
        });
    }

    updatePagination() {
        const { page, total, totalPages, limit } = this.pagination;

        document.getElementById('paginationInfo').textContent = `Showing ${Math.min((page - 1) * limit + 1, total)}-${Math.min(page * limit, total)} of ${total} submissions`;
        document.getElementById('pageInfo').textContent = `Page ${page} of ${totalPages}`;

        document.getElementById('prevPageBtn').disabled = page <= 1;
        document.getElementById('nextPageBtn').disabled = page >= totalPages;
    }

    updateNewCount() {
        // Get count of new submissions (this would ideally come from the API)
        const newCount = this.stats?.new_submissions || 0;
        const badge = document.getElementById('newCount');

        if (newCount > 0) {
            badge.textContent = newCount;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }

    async viewSubmission(submissionId) {
        try {
            const response = await this.apiCall(`/admin/submissions/${submissionId}`);
            const submission = response.data;

            this.showSubmissionModal(submission);

        } catch (error) {
            console.error('View submission error:', error);
            this.showToast('Failed to load submission details', 'error');
        }
    }

    showSubmissionModal(submission) {
        const modal = document.getElementById('submissionModal');
        const modalBody = document.getElementById('modalBody');

        modalBody.innerHTML = `
            <div class="submission-details">
                <div class="detail-group">
                    <label>Status:</label>
                    <span class="status-badge ${this.getStatusColor(submission.status)}">${this.getStatusText(submission.status)}</span>
                </div>

                <div class="detail-group">
                    <label>Name:</label>
                    <span>${submission.name}</span>
                </div>

                <div class="detail-group">
                    <label>Email:</label>
                    <span>${submission.email}</span>
                </div>

                ${submission.company ? `
                <div class="detail-group">
                    <label>Company:</label>
                    <span>${submission.company}</span>
                </div>
                ` : ''}

                ${submission.phone ? `
                <div class="detail-group">
                    <label>Phone:</label>
                    <span>${submission.phone}</span>
                </div>
                ` : ''}

                <div class="detail-group">
                    <label>Message:</label>
                    <div class="message-content">${submission.message}</div>
                </div>

                <div class="detail-group">
                    <label>Submitted:</label>
                    <span>${new Date(submission.createdAt).toLocaleString()}</span>
                </div>

                <div class="detail-group">
                    <label>IP Address:</label>
                    <span>${submission.ipAddress}</span>
                </div>

                <div class="detail-group">
                    <label>Spam Score:</label>
                    <span>${submission.spamScore || 0}/100</span>
                </div>
            </div>
        `;

        // Set current status
        document.getElementById('statusSelect').value = submission.status;

        // Store current submission ID
        modal.dataset.submissionId = submission.id;

        modal.style.display = 'flex';
    }

    closeModal() {
        document.getElementById('submissionModal').style.display = 'none';
    }

    async updateSubmissionStatus() {
        const modal = document.getElementById('submissionModal');
        const submissionId = modal.dataset.submissionId;
        const newStatus = document.getElementById('statusSelect').value;

        if (!submissionId) return;

        try {
            await this.apiCall(`/admin/submissions/${submissionId}/status`, {
                method: 'PATCH',
                body: JSON.stringify({
                    status: newStatus,
                    notes: `Status updated to ${newStatus}`
                })
            });

            this.showToast('Status updated successfully', 'success');
            this.closeModal();
            this.loadSubmissions();
            this.loadDashboardData();

        } catch (error) {
            console.error('Status update error:', error);
            this.showToast('Failed to update status', 'error');
        }
    }

    async markAsSpam() {
        const modal = document.getElementById('submissionModal');
        const submissionId = modal.dataset.submissionId;

        if (!submissionId) return;

        if (!confirm('Are you sure you want to mark this submission as spam?')) return;

        try {
            await this.apiCall(`/admin/submissions/${submissionId}/status`, {
                method: 'PATCH',
                body: JSON.stringify({
                    status: 'spam',
                    notes: 'Marked as spam by admin'
                })
            });

            this.showToast('Marked as spam', 'success');
            this.closeModal();
            this.loadSubmissions();
            this.loadDashboardData();

        } catch (error) {
            console.error('Mark as spam error:', error);
            this.showToast('Failed to mark as spam', 'error');
        }
    }

    async deleteSubmission() {
        const modal = document.getElementById('submissionModal');
        const submissionId = modal.dataset.submissionId;

        if (!submissionId) return;

        if (!confirm('Are you sure you want to delete this submission? This action cannot be undone.')) return;

        try {
            await this.apiCall(`/admin/submissions/${submissionId}`, {
                method: 'DELETE'
            });

            this.showToast('Submission deleted successfully', 'success');
            this.closeModal();
            this.loadSubmissions();
            this.loadDashboardData();

        } catch (error) {
            console.error('Delete submission error:', error);
            this.showToast('Failed to delete submission', 'error');
        }
    }

    // Filters
    applyFilters() {
        this.filters.search = document.getElementById('searchInput').value.trim();
        this.filters.status = document.getElementById('statusFilter').value;
        this.filters.dateFrom = document.getElementById('dateFromFilter').value;
        this.filters.dateTo = document.getElementById('dateToFilter').value;

        this.pagination.page = 1;
        this.loadSubmissions();
    }

    clearFilters() {
        document.getElementById('searchInput').value = '';
        document.getElementById('statusFilter').value = '';
        document.getElementById('dateFromFilter').value = '';
        document.getElementById('dateToFilter').value = '';

        this.filters = {
            search: '',
            status: '',
            dateFrom: '',
            dateTo: ''
        };

        this.pagination.page = 1;
        this.loadSubmissions();
    }

    // Export
    async exportSubmissions() {
        try {
            const params = new URLSearchParams(this.filters);
            const response = await fetch(`${this.apiBase}/admin/export?${params}`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `submissions-${new Date().toISOString().split('T')[0]}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);

                this.showToast('Submissions exported successfully', 'success');
            } else {
                throw new Error('Export failed');
            }

        } catch (error) {
            console.error('Export error:', error);
            this.showToast('Failed to export submissions', 'error');
        }
    }

    // Email test
    async testEmail() {
        const email = prompt('Enter email address to send test email:');
        if (!email) return;

        try {
            await this.apiCall('/admin/test-email', {
                method: 'POST',
                body: JSON.stringify({ email })
            });

            this.showToast('Test email sent successfully', 'success');

        } catch (error) {
            console.error('Test email error:', error);
            this.showToast('Failed to send test email', 'error');
        }
    }

    // Settings
    async loadSettings() {
        try {
            const response = await this.apiCall('/admin/system/status');
            const status = response.data;

            // Update system status
            document.getElementById('dbStatus').className = `status-indicator ${status.database.connected ? 'online' : 'offline'}`;
            document.getElementById('dbStatus').textContent = status.database.connected ? 'Connected' : 'Disconnected';

            document.getElementById('emailStatus').className = `status-indicator ${status.email.initialized ? 'online' : 'offline'}`;
            document.getElementById('emailStatus').textContent = status.email.initialized ? 'Configured' : 'Not configured';

            document.getElementById('rateLimitStatus').className = `status-indicator ${status.redis ? 'online' : 'offline'}`;
            document.getElementById('rateLimitStatus').textContent = status.redis ? 'Active' : 'Disabled';

            // Update user info
            if (this.user) {
                document.getElementById('userLastLogin').textContent = this.user.lastLogin ?
                    new Date(this.user.lastLogin).toLocaleString() : 'First login';
            }

        } catch (error) {
            console.error('Settings loading error:', error);
            this.showToast('Failed to load settings', 'error');
        }
    }

    async changePassword() {
        const currentPassword = prompt('Enter current password:');
        if (!currentPassword) return;

        const newPassword = prompt('Enter new password (min 12 characters):');
        if (!newPassword) return;

        if (newPassword.length < 12) {
            this.showToast('Password must be at least 12 characters', 'error');
            return;
        }

        try {
            await this.apiCall('/admin/users/me/password', {
                method: 'PATCH',
                body: JSON.stringify({
                    currentPassword,
                    newPassword
                })
            });

            this.showToast('Password changed successfully', 'success');

        } catch (error) {
            console.error('Password change error:', error);
            this.showToast('Failed to change password', 'error');
        }
    }

    // Analytics (placeholder)
    async loadAnalytics() {
        // This would integrate with charting libraries
        this.showToast('Analytics feature coming soon', 'info');
    }

    // Utility functions
    getStatusColor(status) {
        const colors = {
            'new': 'new',
            'in_progress': 'in-progress',
            'resolved': 'resolved',
            'spam': 'spam'
        };
        return colors[status] || 'new';
    }

    getStatusText(status) {
        const texts = {
            'new': 'New',
            'in_progress': 'In Progress',
            'resolved': 'Resolved',
            'spam': 'Spam'
        };
        return texts[status] || status;
    }

    showLoading(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            element.innerHTML = '<div class="loading-placeholder">Loading...</div>';
        }
    }

    showToast(message, type = 'success') {
        const toast = document.getElementById('alertToast');
        const toastMessage = document.getElementById('toastMessage');

        toast.className = `toast ${type}`;
        toastMessage.textContent = message;
        toast.style.display = 'flex';

        // Auto-hide after 5 seconds
        setTimeout(() => {
            this.hideToast();
        }, 5000);
    }

    hideToast() {
        const toast = document.getElementById('alertToast');
        toast.style.display = 'none';
    }
}

// Initialize dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new AdminDashboard();
});

// Add CSS for submission details
const style = document.createElement('style');
style.textContent = `
    .submission-details {
        display: grid;
        gap: 16px;
    }

    .detail-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .detail-group label {
        font-weight: 600;
        color: var(--neutral-gray);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .detail-group span {
        font-size: 15px;
        color: var(--black);
    }

    .message-content {
        background: var(--light-gray);
        padding: 16px;
        border-radius: var(--radius-md);
        white-space: pre-wrap;
        line-height: 1.6;
        max-height: 200px;
        overflow-y: auto;
    }

    .btn-sm {
        padding: 6px 12px;
        font-size: 12px;
    }
`;
document.head.appendChild(style);