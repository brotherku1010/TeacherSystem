(() => {
  'use strict';

  const config = window.PROVIDER_PWA_CONFIG || {};
  const shell = document.getElementById('pwa-shell');
  const status = document.getElementById('status');
  const loginButton = document.getElementById('line-login-button');
  const logoutButton = document.getElementById('logout-button');
  const installButton = document.getElementById('install-button');
  const pushButton = document.getElementById('push-button');
  const installState = document.getElementById('install-state');
  const frame = document.getElementById('provider-frame');
  const authNonceKey = 'teacherPwaLineAuthNonce';
  const persistentNonceKey = 'teacherPwaPendingLineAuthNonce';
  const persistentProfileKey = 'teacherPwaLineProfile';
  const persistentAuthResultKey = 'teacherPwaLineAuthResult';
  const authResultMaxAgeMs = 10 * 60 * 1000;
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
  let authPollWatchdog = null;
  let authPollInFlight = false;
  let authApiRequest = null;
  let pendingPopupProfile = null;
  let oneSignalClient = null;
  let oneSignalProfile = null;
  let oneSignalInitPromise = null;
  let oneSignalJsonpSerial = 0;

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
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      // 每次開啟都檢查新版，避免桌面瀏覽器長期使用舊授權流程的快取。
      registration.update().catch(() => {});
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
    // LINE may remove query parameters during a desktop-browser redirect.
    // window.name survives that cross-origin round trip, so retain the
    // one-time nonce there as a final, same-window fallback.
    const popupName = String(window.name || '');
    const popupNameMatch = /^teacher-pwa-line-auth-([a-f0-9]{48})$/i.exec(popupName);
    const nonce = direct.get('auth_nonce') || liffState.get('auth_nonce') || (popupNameMatch ? popupNameMatch[1].toLowerCase() : '');
    return {
      isPopup: direct.get('pwa_auth') === '1' || liffState.get('pwa_auth') === '1' || Boolean(popupNameMatch),
      nonce: nonce
    };
  }

  function createNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function storePendingNonce(nonce) {
    sessionStorage.setItem(authNonceKey, nonce);
    try {
      clearAuthorizationResult();
      localStorage.setItem(persistentNonceKey, nonce);
    } catch (error) { console.warn('Unable to persist LINE authorization state.', error); }
  }

  function getPendingNonce() {
    return sessionStorage.getItem(authNonceKey) || (() => {
      try { return localStorage.getItem(persistentNonceKey); } catch (error) { return ''; }
    })() || '';
  }

  function clearPendingNonce() {
    sessionStorage.removeItem(authNonceKey);
    try {
      localStorage.removeItem(persistentNonceKey);
      clearAuthorizationResult();
    } catch (error) { console.warn('Unable to clear LINE authorization state.', error); }
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

  // 桌面版在外部 LINE 視窗完成授權後，優先透過同網域 localStorage 回傳結果。
  // GAS nonce 中繼仍保留作為跨網域或瀏覽器隔離情境的備援。
  function storeAuthorizationResult(nonce, profile) {
    const normalizedProfile = normalizeProfile(profile);
    const normalizedNonce = String(nonce || '').trim().toLowerCase();
    if (!normalizedProfile || !/^[a-f0-9]{48}$/.test(normalizedNonce)) return null;
    try {
      localStorage.setItem(persistentAuthResultKey, JSON.stringify({
        version: 1,
        nonce: normalizedNonce,
        profile: normalizedProfile,
        completedAt: Date.now()
      }));
    } catch (error) {
      console.warn('Unable to persist completed LINE authorization.', error);
      return null;
    }
    return normalizedProfile;
  }

  function getAuthorizationResult(nonce) {
    const normalizedNonce = String(nonce || '').trim().toLowerCase();
    if (!/^[a-f0-9]{48}$/.test(normalizedNonce)) return null;
    try {
      const result = JSON.parse(localStorage.getItem(persistentAuthResultKey) || 'null');
      if (!result || result.version !== 1 || result.nonce !== normalizedNonce || Date.now() - Number(result.completedAt || 0) > authResultMaxAgeMs) {
        return null;
      }
      return normalizeProfile(result.profile);
    } catch (error) {
      console.warn('Unable to restore completed LINE authorization.', error);
      return null;
    }
  }

  function clearAuthorizationResult(nonce) {
    try {
      if (nonce) {
        const result = JSON.parse(localStorage.getItem(persistentAuthResultKey) || 'null');
        if (result && result.nonce !== String(nonce).trim().toLowerCase()) return;
      }
      localStorage.removeItem(persistentAuthResultKey);
    } catch (error) {
      console.warn('Unable to clear completed LINE authorization.', error);
    }
  }

  function expectedNonce() {
    return popupContext.isPopup ? popupContext.nonce : getPendingNonce();
  }

  function requestPushRegistration(mode, profile, subscriptionId) {
    const normalizedProfile = normalizeProfile(profile);
    const normalizedMode = mode === 'unregister' ? 'unregister' : 'register';
    const normalizedSubscriptionId = String(subscriptionId || '').trim();
    if (!normalizedProfile || !normalizedSubscriptionId || !config.gasUrl) return Promise.resolve(null);

    const callback = '__teacherPwaPushJsonp_' + (++oneSignalJsonpSerial) + '_' + Date.now();
    const target = new URL(config.gasUrl);
    target.searchParams.set('pwa_push_api', normalizedMode);
    target.searchParams.set('uid', normalizedProfile.userId);
    target.searchParams.set('subscription_id', normalizedSubscriptionId);
    target.searchParams.set('callback', callback);

    return new Promise((resolve) => {
      const script = document.createElement('script');
      const cleanup = () => {
        window.clearTimeout(timer);
        try { delete window[callback]; } catch (error) { window[callback] = undefined; }
        script.remove();
      };
      const timer = window.setTimeout(() => { cleanup(); resolve(null); }, 7000);
      window[callback] = (result) => { cleanup(); resolve(result || null); };
      script.async = true;
      script.src = target.toString();
      script.onerror = () => { cleanup(); resolve(null); };
      document.head.appendChild(script);
    });
  }

  async function syncOneSignalPushSubscription(subscription) {
    if (!oneSignalClient || !oneSignalProfile) return null;
    const current = subscription || oneSignalClient.User.PushSubscription || {};
    const subscriptionId = String(current.id || '').trim();
    if (!subscriptionId) return null;
    const isOptedIn = current.optedIn !== false;
    return requestPushRegistration(isOptedIn ? 'register' : 'unregister', oneSignalProfile, subscriptionId);
  }

  function updatePushButton() {
    if (!pushButton) return;
    pushButton.hidden = !config.oneSignalAppId;
    if (!config.oneSignalAppId || !oneSignalClient) {
      pushButton.disabled = true;
      pushButton.textContent = '通知準備中';
      return;
    }
    const subscription = oneSignalClient.User && oneSignalClient.User.PushSubscription;
    pushButton.disabled = false;
    pushButton.textContent = subscription && subscription.optedIn ? '通知已啟用' : '啟用通知';
  }

  function initialiseOneSignalPush(profile) {
    oneSignalProfile = normalizeProfile(profile);
    if (!oneSignalProfile || !config.oneSignalAppId || popupContext.isPopup) return Promise.resolve(false);
    if (pushButton) {
      pushButton.hidden = false;
      pushButton.disabled = true;
      pushButton.textContent = '通知準備中';
    }
    if (oneSignalInitPromise) return oneSignalInitPromise;

    oneSignalInitPromise = new Promise((resolve) => {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(async function (OneSignal) {
        try {
          // Reuse the existing origin-level OneSignal worker. The PWA cache
          // worker remains scoped to /TeacherSystem/ and is not replaced.
          await OneSignal.init({ appId: config.oneSignalAppId, autoResubscribe: true });
          oneSignalClient = OneSignal;
          OneSignal.User.PushSubscription.addEventListener('change', (event) => {
            const current = event && event.current ? event.current : OneSignal.User.PushSubscription;
            void syncOneSignalPushSubscription(current).then(updatePushButton);
          });
          await syncOneSignalPushSubscription();
          updatePushButton();
          resolve(true);
        } catch (error) {
          console.warn('OneSignal initialisation failed.', error);
          updatePushButton();
          resolve(false);
        }
      });
    });
    return oneSignalInitPromise;
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
    void initialiseOneSignalPush(normalizedProfile);
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

  function finishAuthPoll() {
    if (authPollWatchdog) window.clearTimeout(authPollWatchdog);
    authPollWatchdog = null;
    authPollInFlight = false;
    clearBridgeFrame();
  }

  function stopAuthPolling() {
    if (authPollTimer) window.clearInterval(authPollTimer);
    if (authPollExpiryTimer) window.clearTimeout(authPollExpiryTimer);
    authPollTimer = null;
    authPollExpiryTimer = null;
    finishAuthPoll();
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

  // JSONP 可直接跨網域載入 GAS 回應，避開 HtmlService iframe 在桌面瀏覽器的延遲與訊息隔層。
  function requestPwaAuthApi(mode, nonce, profile) {
    if (authApiRequest && authApiRequest.cancel) authApiRequest.cancel();
    return new Promise((resolve, reject) => {
      const callbackName = '__teacherPwaAuthJsonp_' + createNonce();
      const target = new URL(config.gasUrl);
      target.searchParams.set('pwa_auth_api', mode);
      target.searchParams.set('auth_nonce', nonce || '');
      target.searchParams.set('callback', callbackName);
      target.searchParams.set('cache_bust', String(Date.now()));
      if (mode === 'complete' && profile) {
        target.searchParams.set('uid', profile.userId || '');
        target.searchParams.set('name', profile.displayName || '');
      }

      const script = document.createElement('script');
      let settled = false;
      const settle = (error, result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        script.remove();
        try { delete window[callbackName]; } catch (deleteError) { window[callbackName] = undefined; }
        if (authApiRequest && authApiRequest.callbackName === callbackName) authApiRequest = null;
        if (error) reject(error); else resolve(result || {});
      };
      const timeout = window.setTimeout(() => settle(new Error('LINE 授權中繼逾時。')), 4000);
      authApiRequest = {
        callbackName,
        cancel: () => settle(new Error('LINE 授權中繼已取消。'))
      };
      window[callbackName] = (result) => settle(null, result);
      script.async = true;
      script.src = target.toString();
      script.onerror = () => settle(new Error('LINE 授權中繼無法連線。'));
      document.head.appendChild(script);
    });
  }

  function pollAuthRelay() {
    const nonce = getPendingNonce();
    if (!nonce || popupContext.isPopup || authPollInFlight) return;
    authPollInFlight = true;
    requestPwaAuthApi('claim', nonce)
      .then((result) => {
        if (result && result.error) throw new Error(result.error);
        if (result && result.profile) {
          receiveAuthResult({ type: 'teacher-pwa-line-auth', nonce: result.nonce || nonce, profile: result.profile });
        }
      })
      .catch((error) => console.warn('Unable to poll LINE authorization result.', error))
      .finally(() => { authPollInFlight = false; });
  }

  function beginAuthPolling(nonce) {
    if (!nonce || popupContext.isPopup) return;
    stopAuthPolling();
    storePendingNonce(nonce);
    if (receiveStoredAuthorization(nonce)) return;
    pollAuthRelay();
    authPollTimer = window.setInterval(pollAuthRelay, 1200);
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
      'teacher-pwa-line-auth-' + nonce,
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

  function receiveStoredAuthorization(nonce) {
    const profile = getAuthorizationResult(nonce);
    if (!profile) return false;
    receiveAuthResult({ type: 'teacher-pwa-line-auth', nonce: nonce, profile: profile });
    return true;
  }

  async function resumeRememberedSession() {
    if (popupContext.isPopup) return false;
    const profile = getRememberedProfile();
    if (!profile) return false;
    stopAuthPolling();
    clearPendingNonce();
    activeAuthWindow = null;
    loginButton.disabled = true;
    loginButton.textContent = '正在恢復登入…';
    await launchProvider(profile);
    return true;
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

    if (!popupContext.isPopup && data.mode === 'poll') {
      finishAuthPoll();
      if (data.profile) receiveAuthResult({ type: 'teacher-pwa-line-auth', nonce: data.nonce, profile: data.profile });
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
    pendingPopupProfile = rememberAuthorizedProfile(await readProfile());
    if (!pendingPopupProfile) throw new Error('Unable to store the verified LINE profile.');
    setStatus('LINE 授權完成，正在同步至師資 App…');
    try {
      const result = await requestPwaAuthApi('complete', popupContext.nonce, pendingPopupProfile);
      if (!result || result.error || !result.stored) throw new Error((result && result.error) || 'LINE 授權資料儲存失敗。');
      storeAuthorizationResult(popupContext.nonce, pendingPopupProfile);
      notifyPwaParent(pendingPopupProfile);
      setStatus('LINE 授權完成，正在返回師資 App…');
      window.setTimeout(closeAuthorizationWindow, 250);
    } catch (error) {
      // 個別網路環境若阻擋 JSONP，退回既有 HtmlService 中繼，確保手機版仍可完成登入。
      console.warn('Direct LINE authorization relay failed; falling back to HtmlService bridge.', error);
      createAuthBridge('complete', popupContext.nonce, pendingPopupProfile);
    }
  }

  async function initialiseMainApp() {
    const pendingNonce = getPendingNonce();
    if (pendingNonce && receiveStoredAuthorization(pendingNonce)) return;
    if (await resumeRememberedSession()) return;

    // 手機桌面 PWA 不初始化 LIFF，避免登入流程取代 App 視窗。
    if (!window.liff.isInClient || !window.liff.isInClient()) {
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
    const profileToUnregister = oneSignalProfile || getRememberedProfile();
    const subscription = oneSignalClient && oneSignalClient.User && oneSignalClient.User.PushSubscription;
    if (profileToUnregister && subscription && subscription.id) {
      void requestPushRegistration('unregister', profileToUnregister, subscription.id);
    }
    oneSignalProfile = null;
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
  if (pushButton) {
    pushButton.addEventListener('click', async () => {
      if (!oneSignalClient) return;
      pushButton.disabled = true;
      try {
        if (!oneSignalClient.Notifications.isPushSupported()) {
          pushButton.textContent = '此裝置不支援通知';
          return;
        }
        const subscription = oneSignalClient.User.PushSubscription;
        if (!oneSignalClient.Notifications.permission) {
          if (oneSignalClient.Slidedown && typeof oneSignalClient.Slidedown.promptPush === 'function') {
            await oneSignalClient.Slidedown.promptPush();
          } else {
            await oneSignalClient.Notifications.requestPermission();
          }
        } else if (subscription && !subscription.optedIn) {
          await subscription.optIn();
        }
        await syncOneSignalPushSubscription();
      } catch (error) {
        console.warn('Unable to request push permission.', error);
      } finally {
        updatePushButton();
      }
    });
  }
  window.addEventListener('message', (event) => {
    handleBridgeMessage(event);
    if (event.origin !== window.location.origin) return;
    if (activeAuthWindow && event.source !== activeAuthWindow) return;
    receiveAuthResult(event.data);
  });
  if (authChannel) authChannel.addEventListener('message', (event) => receiveAuthResult(event.data));
  window.addEventListener('storage', (event) => {
    if (popupContext.isPopup || event.key !== persistentAuthResultKey || !event.newValue) return;
    const nonce = getPendingNonce();
    if (nonce) receiveStoredAuthorization(nonce);
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || popupContext.isPopup) return;
    if (receiveStoredAuthorization(getPendingNonce())) return;
    try {
      if (await resumeRememberedSession()) return;
    } catch (error) {
      console.error('Unable to restore the LINE session after returning to the PWA.', error);
    }
    if (getPendingNonce()) pollAuthRelay();
  });
  window.addEventListener('online', updateInstallState);
  window.addEventListener('offline', () => setStatus('目前離線。請恢復網路後再登入或讀取資料。', 'error'));
  initialise();
})();
