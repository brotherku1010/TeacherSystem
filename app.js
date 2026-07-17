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
  const authNonceKey = 'teacherPwaLineAuthNonce';
  const authChannelName = 'teacher-pwa-line-auth';
  const pageUrl = new URL(window.location.href);
  const popupContext = readPopupContext(pageUrl);
  const authChannel = 'BroadcastChannel' in window ? new BroadcastChannel(authChannelName) : null;
  let deferredInstallPrompt = null;
  let activeAuthWindow = null;

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

  function readPopupContext(url) {
    const direct = url.searchParams;
    const rawLiffState = direct.get('liff.state');
    let liffState = new URLSearchParams();
    if (rawLiffState) {
      try {
        liffState = new URL(rawLiffState, window.location.origin).searchParams;
      } catch (error) {
        console.warn('Unable to parse LIFF state.', error);
      }
    }
    return {
      isPopup: direct.get('pwa_auth') === '1' || liffState.get('pwa_auth') === '1',
      nonce: direct.get('auth_nonce') || liffState.get('auth_nonce') || ''
    };
  }

  function createNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
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

  function buildAuthUrl(nonce) {
    const target = new URL(`https://liff.line.me/${encodeURIComponent(config.liffId)}/`);
    target.searchParams.set('pwa_auth', '1');
    target.searchParams.set('auth_nonce', nonce);
    return target.toString();
  }

  function openLineAuthorization() {
    const nonce = createNonce();
    sessionStorage.setItem(authNonceKey, nonce);
    loginButton.disabled = true;
    loginButton.textContent = '正在開啟 LINE…';
    setStatus('請在 LINE 完成授權；此 App 會保持開啟並自動接收結果。');

    activeAuthWindow = window.open(
      buildAuthUrl(nonce),
      'teacher-pwa-line-auth',
      'popup=yes,width=440,height=720,resizable=yes,scrollbars=yes'
    );

    if (!activeAuthWindow) {
      sessionStorage.removeItem(authNonceKey);
      loginButton.disabled = false;
      loginButton.textContent = '使用 LINE 登入';
      setStatus('無法開啟 LINE 授權視窗，請允許此 App 開啟視窗後重試。', 'error');
    }
  }

  function isExpectedAuthResult(data) {
    if (!data || data.type !== 'teacher-pwa-line-auth' || !data.profile || !data.profile.userId) return false;
    const expectedNonce = sessionStorage.getItem(authNonceKey);
    return Boolean(expectedNonce && data.nonce && data.nonce === expectedNonce);
  }

  async function receiveAuthResult(data) {
    if (!isExpectedAuthResult(data)) return;
    sessionStorage.removeItem(authNonceKey);
    activeAuthWindow = null;
    loginButton.disabled = true;
    loginButton.textContent = 'LINE 授權完成';
    try {
      await launchProvider(data.profile);
    } catch (error) {
      console.error('Unable to load provider after LINE authorization.', error);
      loginButton.disabled = false;
      loginButton.textContent = '重新嘗試 LINE 登入';
      setStatus('授權已完成，但師資工作區載入失敗，請重新嘗試。', 'error');
    }
  }

  function sendAuthResultToParent(profile) {
    const payload = {
      type: 'teacher-pwa-line-auth',
      nonce: popupContext.nonce,
      profile: { userId: profile.userId, displayName: profile.displayName || '' }
    };
    if (authChannel) authChannel.postMessage(payload);
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
      setStatus('LINE 授權完成，正在回到師資 App…');
      window.setTimeout(() => window.close(), 350);
      return true;
    }
    return false;
  }

  async function initialisePopupAuthorization() {
    loginButton.hidden = true;
    setStatus('正在確認 LINE 授權…');
    await window.liff.init({ liffId: config.liffId, withLoginOnExternalBrowser: true });
    if (!window.liff.isLoggedIn()) {
      setStatus('LINE 授權尚未完成，請回到師資 App 後重新登入。', 'error');
      return;
    }
    const profile = await readProfile();
    if (sendAuthResultToParent(profile)) return;

    // 部分 iOS 環境不保留 opener；保留瀏覽器端可使用的安全後備流程。
    setStatus('LINE 授權已完成，正在開啟師資系統…');
    await launchProvider(profile);
  }

  async function initialiseMainApp() {
    // 主 PWA 不直接導向外部瀏覽器；登入由使用者點擊後在獨立授權視窗完成。
    await window.liff.init({ liffId: config.liffId, withLoginOnExternalBrowser: false });
    if (!window.liff.isLoggedIn()) {
      setStatus('請點擊下方按鈕，以 LINE 完成身分驗證。');
      loginButton.disabled = false;
      return;
    }
    await launchProvider(await readProfile());
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
      if (popupContext.isPopup) {
        await initialisePopupAuthorization();
      } else {
        await initialiseMainApp();
      }
    } catch (error) {
      console.error('Teacher PWA initialisation failed.', error);
      loginButton.hidden = false;
      loginButton.disabled = false;
      loginButton.textContent = '重新嘗試 LINE 登入';
      setStatus('LINE 授權未完成，請重新嘗試。', 'error');
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
    loginButton.hidden = false;
    loginButton.disabled = false;
    loginButton.textContent = '使用 LINE 登入';
    setStatus('已登出，請重新使用 LINE 登入。');
  });

  loginButton.addEventListener('click', openLineAuthorization);
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (activeAuthWindow && event.source !== activeAuthWindow) return;
    receiveAuthResult(event.data);
  });
  if (authChannel) authChannel.addEventListener('message', (event) => receiveAuthResult(event.data));
  window.addEventListener('online', updateInstallState);
  window.addEventListener('offline', () => setStatus('目前離線。請恢復網路後再登入或讀取資料。', 'error'));
  initialise();
})();
