(() => {
  'use strict';

  const FIREBASE_VERSION = '10.14.1';
  const AUTH_CONFIG_URL = '/api/auth/config';
  const AUTH_ME_URL = '/api/auth/me';
  const AUTH_SESSION_URL = '/api/auth/session';
  const AUTH_LOGOUT_URL = '/api/auth/logout';

  let authConfig = null;
  let currentUser = null;
  let firebaseReady = false;

  function panelFetch(url, options = {}) {
    return fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
  }

  async function parseJson(res) {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
      document.head.appendChild(script);
    });
  }

  async function fetchAuthConfig() {
    if (authConfig) return authConfig;
    const res = await panelFetch(AUTH_CONFIG_URL);
    if (res.status === 404) {
      throw new Error(
        'Rotas de login não encontradas. Reinicie o painel: .\\serve.ps1 ou python backend/panel_server.py'
      );
    }
    if (!res.ok) throw new Error('Não foi possível carregar configuração de login');
    authConfig = await res.json();
    return authConfig;
  }

  async function ensureFirebase() {
    if (firebaseReady) return;
    const cfg = await fetchAuthConfig();
    if (!cfg.enabled || !cfg.firebase) return;
    await loadScript(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth-compat.js`);
    if (!firebase.apps.length) {
      firebase.initializeApp(cfg.firebase);
    }
    firebaseReady = true;
  }

  function loginUrl(returnPath) {
    const url = new URL('login.html', window.location.href);
    if (returnPath && returnPath !== 'login.html') {
      url.searchParams.set('return', returnPath);
    }
    return url.pathname + url.search;
  }

  async function getSessionUser() {
    const cfg = await fetchAuthConfig();
    if (!cfg.enabled) {
      currentUser = null;
      return { authenticated: true, auth_disabled: true, user: null };
    }
    const res = await panelFetch(AUTH_ME_URL);
    const data = await parseJson(res);
    if (!res.ok) throw new Error('Erro ao verificar sessão');
    if (!data.authenticated) {
      currentUser = null;
      return { authenticated: false, user: null };
    }
    currentUser = data.user || null;
    return data;
  }

  async function createServerSession(idToken) {
    const res = await panelFetch(AUTH_SESSION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const data = await parseJson(res);
    if (!res.ok) {
      throw new Error(data.detail || data.message || `Login recusado (HTTP ${res.status})`);
    }
    currentUser = data.user || null;
    return data;
  }

  async function guardPage(options = {}) {
    const cfg = await fetchAuthConfig();
    if (!cfg.enabled) {
      document.body.classList.remove('auth-pending');
      return true;
    }

    const session = await getSessionUser();
    if (session.authenticated) {
      document.body.classList.remove('auth-pending');
      return true;
    }

    const returnPath =
      options.returnPath ||
      `${window.location.pathname.split('/').pop() || 'index.html'}${window.location.search}`;
    window.location.replace(loginUrl(returnPath));
    return false;
  }

  async function signInWithEmail(email, password) {
    const cfg = await fetchAuthConfig();
    if (!cfg.enabled) throw new Error('Login não configurado no servidor');
    await ensureFirebase();
    const credential = await firebase.auth().signInWithEmailAndPassword(email.trim(), password);
    const idToken = await credential.user.getIdToken();
    await createServerSession(idToken);
    return currentUser;
  }

  async function signOut() {
    try {
      await panelFetch(AUTH_LOGOUT_URL, { method: 'POST' });
    } catch {
      /* ignore */
    }
    if (firebaseReady && firebase.auth) {
      try {
        await firebase.auth().signOut();
      } catch {
        /* ignore */
      }
    }
    currentUser = null;
    window.location.href = 'login.html';
  }

  function getUser() {
    return currentUser;
  }

  async function authEnabled() {
    const cfg = await fetchAuthConfig();
    return Boolean(cfg.enabled);
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function mountSidebarUser(container) {
    if (!container) return;
    const enabled = await authEnabled();
    if (!enabled) {
      container.innerHTML = '';
      return;
    }
    const session = await getSessionUser();
    if (!session.authenticated) return;
    const email = session.user?.email || '';
    if (!email) return;

    container.innerHTML = `
      <div class="sidebar-user">
        <span class="sidebar-user__label">Conectado como</span>
        <span class="sidebar-user__email" title="${escapeHtml(email)}">${escapeHtml(email)}</span>
        <button type="button" class="btn btn--sm btn--ghost sidebar-user__logout" id="sidebarLogout">Sair</button>
      </div>`;

    container.querySelector('#sidebarLogout')?.addEventListener('click', () => {
      signOut().catch(() => {
        window.location.href = 'login.html';
      });
    });
  }

  async function mountUserMenu(container) {
    if (!container) return;
    const enabled = await authEnabled();
    if (!enabled) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return;
    }
    container.classList.remove('hidden');
    const session = await getSessionUser();
    if (!session.authenticated) return;
    const email = session.user?.email || '';
    if (!email) return;

    container.innerHTML = `
      <div class="user-menu user-menu--compact">
        <button type="button" class="user-menu__trigger" id="userMenuTrigger" aria-haspopup="true" aria-expanded="false">
          <span class="user-menu__email">${escapeHtml(email)}</span>
        </button>
        <div class="user-menu__dropdown hidden" id="userMenuDropdown" role="menu">
          <div class="user-menu__summary">
            <span>${escapeHtml(email)}</span>
          </div>
          <button type="button" class="user-menu__item user-menu__item--btn user-menu__item--danger" id="userMenuLogout" role="menuitem">Sair</button>
        </div>
      </div>`;

    const trigger = container.querySelector('#userMenuTrigger');
    const dropdown = container.querySelector('#userMenuDropdown');
    trigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = dropdown?.classList.toggle('hidden') === false;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', () => {
      dropdown?.classList.add('hidden');
      trigger?.setAttribute('aria-expanded', 'false');
    });
    dropdown?.addEventListener('click', (e) => e.stopPropagation());
    container.querySelector('#userMenuLogout')?.addEventListener('click', () => {
      signOut().catch(() => {
        window.location.href = 'login.html';
      });
    });
  }

  window.Lav60Auth = {
    guardPage,
    signInWithEmail,
    signOut,
    getUser,
    authEnabled,
    getSessionUser,
    fetchAuthConfig,
    ensureFirebase,
    panelFetch,
    mountUserMenu,
    mountSidebarUser,
  };
})();
