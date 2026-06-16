(() => {
  'use strict';

  const form = document.getElementById('loginForm');
  const emailInput = document.getElementById('loginEmail');
  const passwordInput = document.getElementById('loginPassword');
  const errorEl = document.getElementById('loginError');
  const submitBtn = document.getElementById('loginSubmit');
  const hintEl = document.getElementById('loginHint');

  function returnPath() {
    const params = new URLSearchParams(window.location.search);
    const value = (params.get('return') || 'index.html').trim();
    if (!value || value.includes('login.html')) return 'index.html';
    return value;
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitBtn.textContent = loading ? 'Entrando…' : 'Entrar';
    emailInput.disabled = loading;
    passwordInput.disabled = loading;
  }

  async function boot() {
    try {
      const cfg = await Lav60Auth.fetchAuthConfig();
      document.body.classList.remove('auth-pending');

      if (!cfg.enabled) {
        hintEl.textContent = 'Login não configurado — redirecionando…';
        hintEl.classList.remove('hidden');
        window.location.replace(returnPath());
        return;
      }

      if (cfg.verify_mode === 'none') {
        hintEl.textContent = 'Login indisponível — verifique FIREBASE_API_KEY no .env.';
        hintEl.classList.remove('hidden');
      }

      const session = await Lav60Auth.getSessionUser();
      if (session.authenticated) {
        window.location.replace(returnPath());
      }
    } catch (e) {
      showError(e.message || 'Erro ao iniciar login');
      document.body.classList.remove('auth-pending');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showError('Informe e-mail e senha.');
      return;
    }
    setLoading(true);
    try {
      await Lav60Auth.signInWithEmail(email, password);
      window.location.replace(returnPath());
    } catch (e) {
      const msg = e.message || 'Falha no login';
      if (/invalid|wrong|password|user/i.test(msg)) {
        showError('E-mail ou senha inválidos.');
      } else {
        showError(msg);
      }
    } finally {
      setLoading(false);
    }
  });

  boot();
})();
