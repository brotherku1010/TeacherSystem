(() => {
  'use strict';

  const config = window.PROVIDER_PWA_CONFIG || {};
  const shell = document.getElementById('pwa-shell');
  const status = document.getElementById('status');
  const loginButton = document.getElementById('line-login-button');
  const logoutButton = document.getElementById('logout-button');
  const installButton = document.getElementById('install-button');
  const installState = document.getElementById('install-state');
  const frame = document.getElementById('provider-frame');
  let deferredInstallPrompt = null;
  let authFlowPending = false;

  function setStatus(message, state) {
    status.textContent = message || '';
    status.dataset.state = state || '';
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function updateInstallState() {
    installState.textContent = isStandalone() ? '已在 App 模式執行' : '可加入手機桌面使用';
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('./sw.js', { scope: './' });
    } catch (error) {
      console.warn('PWA service worker registration failed.', error);
    }
  }

  function buildProviderUrl(profile) {
    const target = new URL(config.gasUrl);
    target.searchParams.set('uid', profile.userId || '');
    target.searchParams.set('page', 'provider');
    target.searchParams.set('source', 'teacher-pwa');
    return target.toString();
  }

  async function launchProvider(profile) {
    if (!profile || !profile.userId) throw new Error('無法取得 LINE 使用者識別資料。');
    frame.src = buildProviderUrl(profile);
    frame.addEventListener('load', () => {
      shell.classList.add('is-ready');
      logoutButton.hidden = false;
    }, { once: true });
    setStatus('正在載入師資工作區…');
  }

  async function readProfile() {
    try {
      return await window.liff.getProfile();
    } catch (error) {
      const decoded = window.liff.getDecodedIDToken && window.liff.getDecodedIDToken();
      if (decoded && decoded.sub) return { userId: decoded.sub, displayName: decoded.name || '' };
      throw error;
    }
  }

  function beginLineLogin() {
    if (!window.liff || !config.liffId) return;
    if (window.liff.isInClient && window.liff.isInClient()) {
      setStatus('LINE 正在確認授權狀態…');
      return;
    }
    loginButton.disabled = true;
    loginButton.textContent = '正在前往 LINE…';
    setStatus('正在開啟 LINE 授權頁…');
    authFlowPending = true;
    sessionStorage.setItem('teacherPwaLineAuthPending', '1');
    const returnUrl = new URL(window.location.href);
    returnUrl.searchParams.delete('liff.state');
    window.liff.login({ redirectUri: returnUrl.toString() });
  }

  async function initialise() {
    updateInstallState();
    await registerServiceWorker();
    if (!config.liffId || !config.gasUrl) {
      setStatus('PWA 設定尚未完成，請聯絡系統管理員。', 'error');
      return;
    }
    if (!window.liff) {
      setStatus('LINE 登入元件載入失敗，請確認網路後重新開啟。', 'error');
      return;
    }
    try {
      // 師資專用 LIFF 端點與 PWA URL 相同；外部瀏覽器會一次完成 LINE 授權，
      // 不再先進入會員系統的 LIFF 入口而要求第二次點擊。
      authFlowPending = sessionStorage.getItem('teacherPwaLineAuthPending') === '1';
      if (!window.liff.isInClient || !window.liff.isInClient()) {
        authFlowPending = true;
        sessionStorage.setItem('teacherPwaLineAuthPending', '1');
      }
      await window.liff.init({ liffId: config.liffId, withLoginOnExternalBrowser: true });
      if (!window.liff.isLoggedIn()) {
        setStatus('尚未完成 LINE 授權，請重新嘗試。', 'error');
        loginButton.textContent = '重新嘗試 LINE 登入';
        loginButton.disabled = false;
        return;
      }
      sessionStorage.removeItem('teacherPwaLineAuthPending');
      await launchProvider(await readProfile());
    } catch (error) {
      console.error('Provider PWA initialisation failed.', error);
      setStatus('LINE 授權未完成，請重新嘗試。', 'error');
      loginButton.textContent = '重新嘗試 LINE 登入';
      loginButton.disabled = false;
    }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt();
    deferredInstallPrompt = null;
    installButton.hidden = true;
    updateInstallState();
  });

  logoutButton.addEventListener('click', () => {
    if (window.liff && window.liff.isLoggedIn && window.liff.isLoggedIn()) window.liff.logout();
    frame.removeAttribute('src');
    shell.classList.remove('is-ready');
    logoutButton.hidden = true;
    loginButton.disabled = false;
    setStatus('已登出，請重新使用 LINE 登入。');
  });

  loginButton.addEventListener('click', beginLineLogin);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && authFlowPending && !shell.classList.contains('is-ready')) {
      window.location.reload();
    }
  });
  window.addEventListener('online', updateInstallState);
  window.addEventListener('offline', () => setStatus('目前離線。請恢復網路後再登入或讀取資料。', 'error'));
  initialise();
})();
