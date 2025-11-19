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

// Contact form mock submit
const form = document.getElementById('contactForm');
const statusEl = document.getElementById('formStatus');

if (form && statusEl) {
	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		statusEl.textContent = 'Submitting...';
		try {
			// Simulate async request (replace with your endpoint)
			await new Promise((r) => setTimeout(r, 800));
			form.reset();
			statusEl.textContent = 'Thanks! We will contact you shortly.';
			setTimeout(() => (statusEl.textContent = ''), 3000);
		} catch (err) {
			statusEl.textContent = 'Something went wrong. Please try again.';
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


