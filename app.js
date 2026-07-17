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
  const persistentNonceKey = 'teacherPwaPendingLineAuthNonce';
  const persistentProfileKey = 'teacherPwaLineProfile';
  const authChannelName = 'teacher-pwa-line-auth';
  const bridgeMessageType = 'teacher-pwa-auth-bridge';
  const pageUrl = new URL(window.location.href);
  const popupContext = readPopupContext(pageUrl);
  const authChannel = 'BroadcastChannel' in window ? new BroadcastChannel(authChannelName) : null;
  let deferredInstallPrompt = null;
  let activeAuthWindow = null;
  let authBridgeFrame = null;
  let authPollTimer = null;
  let authPollExpiryTimer = null;
  let pendingPopupProfile = null;

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

  function storePendingNonce(nonce) {
    sessionStorage.setItem(authNonceKey, nonce);
    try { localStorage.setItem(persistentNonceKey, nonce); } catch (error) { console.warn('Unable to persist LINE authorization state.', error); }
  }

  function getPendingNonce() {
    return sessionStorage.getItem(authNonceKey) || (() => {
      try { return localStorage.getItem(persistentNonceKey); } catch (error) { return ''; }
    })() || '';
  }

  function clearPendingNonce() {
    sessionStorage.removeItem(authNonceKey);
    try { localStorage.removeItem(persistentNonceKey); } catch (error) { console.warn('Unable to clear LINE authorization state.', error); }
  }

  function normalizeProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const userId = String(profile.userId || '').trim();
    if (!/^U[0-9a-f]{32}$/i.test(userId)) return null;
    return {
      userId,
      displayName: String(profile.displayName || '').trim().slice(0, 120)
    };
  }

  function rememberAuthorizedProfile(profile) {
    const normalized = normalizeProfile(profile);
    if (!normalized) return null;
    try {
      localStorage.setItem(persistentProfileKey, JSON.stringify({
        version: 1,
        profile: normalized,
        authorizedAt: Date.now()
      }));
    } catch (error) {
      console.warn('Unable to persist LINE authorization profile.', error);
    }
    return normalized;
  }

  function getRememberedProfile() {
    try {
      const saved = JSON.parse(localStorage.getItem(persistentProfileKey) || 'null');
      return saved && saved.version === 1 ? normalizeProfile(saved.profile) : null;
    } catch (error) {
      console.warn('Unable to restore LINE authorization profile.', error);
      return null;
    }
  }

  function clearRememberedProfile() {
    try { localStorage.removeItem(persistentProfileKey); } catch (error) { console.warn('Unable to clear LINE authorization profile.', error); }
  }

  function expectedNonce() {
    return popupContext.isPopup ? popupContext.nonce : getPendingNonce();
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
    const normalizedProfile = normalizeProfile(profile);
    if (!normalizedProfile) throw new Error('Invalid LINE user profile.');
    frame.src = buildProviderUrl(normalizedProfile);
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

  function clearBridgeFrame() {
    if (authBridgeFrame) authBridgeFrame.remove();
    authBridgeFrame = null;
  }

  function stopAuthPolling() {
    if (authPollTimer) window.clearInterval(authPollTimer);
    if (authPollExpiryTimer) window.clearTimeout(authPollExpiryTimer);
    authPollTimer = null;
    authPollExpiryTimer = null;
    clearBridgeFrame();
  }

  function createAuthBridge(mode, nonce, profile) {
    clearBridgeFrame();
    const target = new URL(config.gasUrl);
    target.searchParams.set('pwa_auth_bridge', mode);
    target.searchParams.set('auth_nonce', nonce);
    target.searchParams.set('cache_bust', String(Date.now()));
    if (mode === 'complete' && profile) {
      target.searchParams.set('uid', profile.userId || '');
      target.searchParams.set('name', profile.displayName || '');
    }
    authBridgeFrame = document.createElement('iframe');
    // 部分手機瀏覽器不會執行 display:none iframe 的 GAS 腳本；保留極小的可載入框架。
    authBridgeFrame.style.cssText = 'position:fixed;width:1px;height:1px;right:-2px;bottom:-2px;border:0;opacity:0;pointer-events:none;';
    authBridgeFrame.setAttribute('aria-hidden', 'true');
    authBridgeFrame.src = target.toString();
    document.body.appendChild(authBridgeFrame);
  }

  function pollAuthRelay() {
    const nonce = getPendingNonce();
    if (!nonce || popupContext.isPopup) return;
    createAuthBridge('poll', nonce);
  }

  function beginAuthPolling(nonce) {
    if (!nonce || popupContext.isPopup) return;
    stopAuthPolling();
    storePendingNonce(nonce);
    pollAuthRelay();
    authPollTimer = window.setInterval(pollAuthRelay, 3500);
    authPollExpiryTimer = window.setTimeout(() => {
      stopAuthPolling();
      clearPendingNonce();
      loginButton.disabled = false;
      loginButton.textContent = '使用 LINE 登入';
      setStatus('LINE 授權已逾時，請重新登入。', 'error');
    }, 10 * 60 * 1000);
  }

  function openLineAuthorization() {
    const nonce = createNonce();
    storePendingNonce(nonce);
    beginAuthPolling(nonce);
    loginButton.disabled = true;
    loginButton.textContent = '正在等待 LINE 授權…';
    setStatus('請在 LINE 完成授權；回到此 App 後會自動載入師資系統。');

    activeAuthWindow = window.open(
      buildAuthUrl(nonce),
      'teacher-pwa-line-auth',
      'popup=yes,width=440,height=720,resizable=yes,scrollbars=yes'
    );

    if (!activeAuthWindow) {
      stopAuthPolling();
      clearPendingNonce();
      loginButton.disabled = false;
      loginButton.textContent = '使用 LINE 登入';
      setStatus('無法開啟 LINE 授權視窗，請允許此 App 開啟視窗後重試。', 'error');
    }
  }

  function isExpectedAuthResult(data) {
    if (!data || data.type !== 'teacher-pwa-line-auth' || !data.profile || !data.profile.userId) return false;
    const nonce = expectedNonce();
    return Boolean(nonce && data.nonce && data.nonce === nonce);
  }

  async function receiveAuthResult(data) {
    if (!isExpectedAuthResult(data)) return;
    const profile = rememberAuthorizedProfile(data.profile);
    if (!profile) return;
    stopAuthPolling();
    clearPendingNonce();
    activeAuthWindow = null;
    loginButton.disabled = true;
    loginButton.textContent = 'LINE 授權完成';
    try {
      await launchProvider(profile);
    } catch (error) {
      console.error('Unable to load provider after LINE authorization.', error);
      loginButton.disabled = false;
      loginButton.textContent = '重新嘗試 LINE 登入';
      setStatus('授權已完成，但師資工作區載入失敗，請重新嘗試。', 'error');
    }
  }

  function notifyPwaParent(profile) {
    const payload = {
      type: 'teacher-pwa-line-auth',
      nonce: popupContext.nonce,
      profile: { userId: profile.userId, displayName: profile.displayName || '' }
    };
    if (authChannel) authChannel.postMessage(payload);
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
    }
  }

  function closeAuthorizationWindow() {
    // LINE 內嵌瀏覽器可由 SDK 關閉；外部瀏覽器則只能嘗試關閉由 PWA 開啟的視窗。
    try {
      if (window.liff && typeof window.liff.isInClient === 'function' && window.liff.isInClient() && typeof window.liff.closeWindow === 'function') {
        window.liff.closeWindow();
        return;
      }
    } catch (error) {
      console.warn('Unable to close the LIFF authorization window.', error);
    }
    try { window.close(); } catch (error) { console.warn('Unable to close the authorization window.', error); }
    window.setTimeout(() => {
      try { window.close(); } catch (error) { /* The mobile browser may block programmatic closing. */ }
    }, 250);
  }

  function handleBridgeMessage(event) {
    const data = event.data;
    const isGoogleBridge = /^https:\/\/(?:script\.google\.com|(?:[a-z0-9-]+\.)*googleusercontent\.com)$/i.test(event.origin || '');
    if (!data || data.type !== bridgeMessageType || !isGoogleBridge) return;
    if (!data.nonce || data.nonce !== expectedNonce()) return;

    if (popupContext.isPopup && data.mode === 'complete') {
      if (data.error) {
        setStatus('LINE 授權已完成，但同步回 App 失敗，請回到師資 App 後重新登入。', 'error');
        return;
      }
      if (data.stored && pendingPopupProfile) {
        notifyPwaParent(pendingPopupProfile);
        setStatus('LINE 授權完成，請回到師資 App。');
        window.setTimeout(closeAuthorizationWindow, 350);
      }
      return;
    }

    if (!popupContext.isPopup && data.mode === 'poll' && data.profile) {
      receiveAuthResult({ type: 'teacher-pwa-line-auth', nonce: data.nonce, profile: data.profile });
    }
  }

  async function initialisePopupAuthorization() {
    loginButton.hidden = true;
    setStatus('正在確認 LINE 授權…');
    await window.liff.init({ liffId: config.liffId, withLoginOnExternalBrowser: true });
    if (!window.liff.isLoggedIn()) {
      setStatus('LINE 授權尚未完成，請回到師資 App 後重新登入。', 'error');
      return;
    }
    pendingPopupProfile = await readProfile();
    setStatus('LINE 授權完成，正在同步至師資 App…');
    createAuthBridge('complete', popupContext.nonce, pendingPopupProfile);
  }

  async function initialiseMainApp() {
    const rememberedProfile = getRememberedProfile();
    if (rememberedProfile) {
      setStatus('正在恢復已授權的師資登入狀態…');
      await launchProvider(rememberedProfile);
      return;
    }

    // 手機桌面 PWA 不初始化 LIFF，避免登入流程取代 App 視窗。
    if (!window.liff.isInClient || !window.liff.isInClient()) {
      const pendingNonce = getPendingNonce();
      if (pendingNonce) {
        loginButton.disabled = true;
        loginButton.textContent = '正在確認 LINE 授權…';
        setStatus('正在確認剛完成的 LINE 授權…');
        beginAuthPolling(pendingNonce);
        return;
      }
      setStatus('請點擊下方按鈕，以 LINE 完成身分驗證。');
      loginButton.disabled = false;
      return;
    }

    // 從 LINE 的 LIFF 連結直接開啟時，仍保留原本的直接載入能力。
    await window.liff.init({ liffId: config.liffId, withLoginOnExternalBrowser: false });
    if (window.liff.isLoggedIn()) {
      await launchProvider(rememberAuthorizedProfile(await readProfile()));
      return;
    }
    setStatus('LINE 授權尚未完成，請重新從師資 App 開啟。', 'error');
    loginButton.disabled = false;
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
    try {
      if (window.liff && window.liff.isLoggedIn && window.liff.isLoggedIn()) window.liff.logout();
    } catch (error) {
      console.warn('Unable to clear LIFF browser session.', error);
    }
    stopAuthPolling();
    clearPendingNonce();
    clearRememberedProfile();
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
    handleBridgeMessage(event);
    if (event.origin !== window.location.origin) return;
    if (activeAuthWindow && event.source !== activeAuthWindow) return;
    receiveAuthResult(event.data);
  });
  if (authChannel) authChannel.addEventListener('message', (event) => receiveAuthResult(event.data));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getPendingNonce()) pollAuthRelay();
  });
  window.addEventListener('online', updateInstallState);
  window.addEventListener('offline', () => setStatus('目前離線。請恢復網路後再登入或讀取資料。', 'error'));
  initialise();
})();
