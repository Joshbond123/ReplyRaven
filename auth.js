/* Runs synchronously, before any page is drawn. A local gate, not server-side security. */
(() => {
  try {
    const page = document.currentScript.dataset.page;
    const valid =
      localStorage.getItem('auth') === 'true' && Number(localStorage.getItem('auth_expiry')) > Date.now();
    const theme = localStorage.getItem('rr_theme') || 'light';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.dataset.theme = theme;
    if (!localStorage.getItem('dashboard_password'))
      localStorage.setItem('dashboard_password', 'ReplyRaven123');
    if (valid && ['landing', 'login'].includes(page)) {
      document.documentElement.style.visibility = 'hidden';
      window.location.replace('dashboard.html');
    } else if (!valid && ['dashboard', 'business', 'settings'].includes(page)) {
      localStorage.removeItem('auth');
      localStorage.removeItem('auth_expiry');
      document.documentElement.style.visibility = 'hidden';
      window.location.replace('login.html');
    }
  } catch {
    /* Login explains disabled browser storage; public pages remain readable. */
  }
})();
