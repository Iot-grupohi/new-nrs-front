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
    if (value.startsWith('/')) return value;
    return value;
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  function friendlyLoginError(err) {
    const msg = String(err?.message || err || 'Falha no login');
    if (/unauthorized-domain/i.test(msg)) {
      return 'Login indisponível neste endereço. Contacte o suporte técnico.';
    }
    if (/network|failed to fetch|load/i.test(msg)) {
      return 'Sem conexão com o servidor ou com o Firebase. Verifique a rede e se o painel está rodando.';
    }
    if (/invalid|wrong|password|user|credential/i.test(msg)) {
      return 'E-mail ou senha inválidos.';
    }
    return msg;
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
    const params = new URLSearchParams(window.location.search);
    if (params.get('reason') === 'idle') {
      showError('Sessão encerrada por inatividade. Faça login novamente.');
    }

    try {
      const cfg = await Lav60Auth.fetchAuthConfig();

      if (!cfg.enabled) {
        hintEl.textContent = 'Login não configurado — redirecionando…';
        hintEl.classList.remove('hidden');
        window.location.replace(returnPath());
        return;
      }

      if (cfg.verify_mode === 'none') {
        hintEl.textContent = 'Login indisponível. Contacte o suporte técnico.';
        hintEl.classList.remove('hidden');
      }

      Lav60Auth.ensureFirebase().catch(() => {});

      const session = await Lav60Auth.getSessionUser();
      if (session.authenticated) {
        window.location.replace(returnPath());
      }
    } catch (e) {
      showError(friendlyLoginError(e));
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
      showError(friendlyLoginError(e));
    } finally {
      setLoading(false);
    }
  });

  boot();
})();
