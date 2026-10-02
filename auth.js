(() => {
  const page = document.currentScript?.dataset.page;
  try {
    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark');
    const expiry = Number(sessionStorage.getItem('rr_session_expiry'));
    const authenticated = Boolean(sessionStorage.getItem('rr_session') && expiry > Date.now());
    if (['dashboard', 'business', 'settings', 'notifications'].includes(page) && !authenticated)
      location.replace('login.html');
    else if (['landing', 'login'].includes(page) && authenticated) location.replace('dashboard.html');
  } catch {
    if (['dashboard', 'business', 'settings', 'notifications'].includes(page)) location.replace('login.html');
  }
})();
