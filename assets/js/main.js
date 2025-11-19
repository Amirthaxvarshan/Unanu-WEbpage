// Mobile menu toggle with active class
const hamburger = document.querySelector('.hamburger');
const menu = document.querySelector('.menu');

if (hamburger && menu) {
	hamburger.addEventListener('click', () => {
		const isActive = menu.classList.contains('active');
		if (isActive) {
			menu.classList.remove('active');
			hamburger.setAttribute('aria-expanded', 'false');
		} else {
			menu.classList.add('active');
			hamburger.setAttribute('aria-expanded', 'true');
		}
	});
	
	// Close menu when clicking outside
	document.addEventListener('click', (e) => {
		if (!hamburger.contains(e.target) && !menu.contains(e.target)) {
			menu.classList.remove('active');
			hamburger.setAttribute('aria-expanded', 'false');
		}
	});
	
	// Close menu when clicking a link
	menu.querySelectorAll('a').forEach(link => {
		link.addEventListener('click', () => {
			menu.classList.remove('active');
			hamburger.setAttribute('aria-expanded', 'false');
		});
	});
}

// Smooth scroll for internal links
document.querySelectorAll('a[href^="#"]').forEach((a) => {
	a.addEventListener('click', (e) => {
		const id = a.getAttribute('href');
		const el = document.querySelector(id);
		if (el) {
			e.preventDefault();
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			if (history && history.pushState) history.pushState(null, '', id);
		}
	});
});

// Enhanced Contact Form API Integration
const contactForm = document.getElementById('contactForm');
const formStatus = document.getElementById('formStatus');
const submitBtn = document.getElementById('submitBtn');

// API configuration
const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
	? 'http://localhost:3000/api/contact'
	: '/api/contact';

// Client-side validation
const validateField = (field) => {
	const value = field.value.trim();
	const errorElement = field.parentElement.querySelector(`[data-error="${field.name}"]`);
	let error = '';

	switch (field.name) {
		case 'name':
			if (!value) {
				error = 'Name is required';
			} else if (value.length < 2) {
				error = 'Name must be at least 2 characters';
			} else if (value.length > 100) {
				error = 'Name must be less than 100 characters';
			} else if (!/^[a-zA-Z\s\-'\.]+$/.test(value)) {
				error = 'Name can only contain letters, spaces, hyphens, apostrophes, and periods';
			}
			break;

		case 'email':
			if (!value) {
				error = 'Email is required';
			} else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
				error = 'Please enter a valid email address';
			}
			break;

		case 'company':
			if (value && value.length > 200) {
				error = 'Company name must be less than 200 characters';
			}
			break;

		case 'phone':
			if (value && !/^\+?[1-9]\d{9,14}$/.test(value.replace(/[\s\-\(\)]/g, ''))) {
				error = 'Please enter a valid phone number (include country code)';
			}
			break;

		case 'message':
			if (!value) {
				error = 'Message is required';
			} else if (value.length < 10) {
				error = 'Message must be at least 10 characters';
			} else if (value.length > 2000) {
				error = 'Message must be less than 2000 characters';
			}
			break;

		case 'consent':
			if (!field.checked) {
				error = 'You must consent to data processing to submit this form';
			}
			break;
	}

	if (errorElement) {
		if (error) {
			errorElement.textContent = error;
			errorElement.classList.add('show');
			field.classList.add('invalid');
		} else {
			errorElement.textContent = '';
			errorElement.classList.remove('show');
			field.classList.remove('invalid');
		}
	}

	return !error;
};

// Show form status message
const showStatus = (message, type = 'success') => {
	if (!formStatus) return;

	formStatus.className = `form-status ${type}`;
	formStatus.textContent = message;
	formStatus.style.display = 'block';

	// Auto-hide success messages after 5 seconds
	if (type === 'success') {
		setTimeout(() => {
			formStatus.style.display = 'none';
		}, 5000);
	}
};

// Set loading state
const setLoading = (loading) => {
	if (!submitBtn) return;

	if (loading) {
		submitBtn.classList.add('loading');
		submitBtn.disabled = true;
	} else {
		submitBtn.classList.remove('loading');
		submitBtn.disabled = false;
	}
};

// Handle form submission
if (contactForm) {
	// Add real-time validation
	const fields = contactForm.querySelectorAll('input, textarea');
	fields.forEach(field => {
		field.addEventListener('blur', () => validateField(field));
		field.addEventListener('input', () => {
			if (field.classList.contains('invalid')) {
				validateField(field);
			}
		});
	});

	contactForm.addEventListener('submit', async (e) => {
		e.preventDefault();

		// Validate all fields
		let isValid = true;
		fields.forEach(field => {
			if (!validateField(field)) {
				isValid = false;
			}
		});

		if (!isValid) {
			showStatus('Please correct the errors below and try again.', 'error');
			return;
		}

		// Prepare form data
		const formData = new FormData(contactForm);
		const data = {
			name: formData.get('name')?.trim(),
			email: formData.get('email')?.trim(),
			company: formData.get('company')?.trim() || null,
			phone: formData.get('phone')?.trim() || null,
			message: formData.get('message')?.trim(),
			consent: formData.get('consent') === 'on',
			honeypot: formData.get('honeypot')?.trim() || ''
		};

		try {
			setLoading(true);
			showStatus('Submitting your message...', '');

			const response = await fetch(`${API_BASE_URL}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(data)
			});

			const result = await response.json();

			if (result.success) {
				// Success
				showStatus('Thank you! Your message has been received successfully. We will contact you shortly.', 'success');
				contactForm.reset();

				// Clear any validation errors
				fields.forEach(field => {
					const errorElement = field.parentElement.querySelector(`[data-error="${field.name}"]`);
					if (errorElement) {
						errorElement.textContent = '';
						errorElement.classList.remove('show');
					}
					field.classList.remove('invalid');
				});

			} else {
				// Error from server
				if (result.errors) {
					// Show field-specific errors
					Object.keys(result.errors).forEach(fieldName => {
						const field = contactForm.querySelector(`[name="${fieldName}"]`);
						if (field) {
							const errorElement = field.parentElement.querySelector(`[data-error="${fieldName}"]`);
							if (errorElement) {
								errorElement.textContent = result.errors[fieldName][0];
								errorElement.classList.add('show');
								field.classList.add('invalid');
							}
						}
					});
					showStatus('Please correct the errors below and try again.', 'error');
				} else {
					showStatus(result.message || 'Submission failed. Please try again.', 'error');
				}
			}

		} catch (error) {
			console.error('Form submission error:', error);
			showStatus('Network error. Please check your connection and try again.', 'error');
		} finally {
			setLoading(false);
		}
	});
}

// Mobile navigation toggle
(function () {
	const toggle = document.getElementById('nav-toggle');
	const nav = document.getElementById('primary-nav');
	if (!toggle || !nav) return;
	toggle.addEventListener('click', function () {
		const open = nav.classList.toggle('open');
		toggle.setAttribute('aria-expanded', String(open));
	});
})();

// Smooth scroll enhancement for internal links
(function () {
	const links = document.querySelectorAll('a[href^="#"]');
	for (const link of links) {
		link.addEventListener('click', function (e) {
			const targetId = this.getAttribute('href');
			if (!targetId || targetId === '#') return;
			const el = document.querySelector(targetId);
			if (!el) return;
			e.preventDefault();
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			history.pushState(null, '', targetId);
		});
	}
})();

// Contact form (demo only)
(function () {
	const form = document.querySelector('[data-form]');
	if (!form) return;
	const status = form.querySelector('.form-status');
	form.addEventListener('submit', async function (e) {
		e.preventDefault();
		if (status) status.textContent = 'Sending...';
		// Simulate async submission
		await new Promise(r => setTimeout(r, 900));
		if (status) status.textContent = 'Thanks! We will get back to you shortly.';
		form.reset();
	});
})();


