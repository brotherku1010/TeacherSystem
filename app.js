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
  const authNonceKey = 'teacherPwaLineAuthNonceV2';
  const persistentNonceKey = 'teacherPwaPendingLineAuthNonceV2';
  const persistentProfileKey = 'teacherPwaLineProfile';
  const persistentAuthResultKey = 'teacherPwaLineAuthResult';
  const authResultMaxAgeMs = 10 * 60 * 1000;
  const authChannelName = 'teacher-pwa-line-auth';
  const bridgeMessageType = 'teacher-pwa-auth-bridge';
  const pageUrl = new URL(window.location.href);
  const popupContext = readPopupContext(pageUrl);
  const authChannel = 'BroadcastChannel' in window ? new BroadcastChannel(authChannelName) : null;
  let deferredInstallPrompt = null;
  let disconnectApp = null;
  let completingAuthorization = false;
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
    const popupNameMatch = /^teacher-pwa-line-auth-([a-f0-9]{64})$/i.exec(popupName);
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
    if (getPendingNonce() === nonce) return;
    const record = JSON.stringify({version:2,nonce:nonce,expiresAt:Date.now()+10*60*1000});
    sessionStorage.setItem(authNonceKey, record);
    try {
      clearAuthorizationResult();
      localStorage.setItem(persistentNonceKey, record);
    } catch (error) { console.warn('Unable to persist LINE authorization state.', error); }
  }

  function getPendingNonce() {
    for (const [storage,key] of [[sessionStorage,authNonceKey],[localStorage,persistentNonceKey]]) {
      try {
        const record = JSON.parse(storage.getItem(key) || 'null');
        if (record && record.version === 2 && /^[a-f0-9]{48}$/.test(record.nonce) && record.expiresAt > Date.now()) return record.nonce;
        storage.removeItem(key);
      } catch (_) { /* 舊格式、已過期或被封鎖的儲存不視為待授權。 */ }
    }
    return '';
  }

  function clearPendingNonce() {
    sessionStorage.removeItem(authNonceKey);
    try {
      localStorage.removeItem(persistentNonceKey);
      clearAuthorizationResult();
    } catch (error) { console.warn('Unable to clear LINE authorization state.', error); }
  }

  function normalizeProfile(profile) { if(!profile || !/^U[a-f0-9]{32}$/i.test(String(profile.userId||'')) || !/^[a-f0-9]{64}$/.test(String(profile.sessionToken||'')) || !(Number(profile.expiresAt)>Date.now()))return null;return {userId:profile.userId,displayName:String(profile.displayName||'').slice(0,120),sessionToken:profile.sessionToken,expiresAt:Number(profile.expiresAt)}; }

  function rememberAuthorizedProfile(profile) {
    const normalized = normalizeProfile(profile);
    if (!normalized) return null;
    try {
      localStorage.setItem(persistentProfileKey, JSON.stringify({
        version: 2,
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
      return saved && saved.version === 2 ? normalizeProfile(saved.profile) : null;
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
    if (!normalizedProfile || !/^[a-f0-9]{64}$/.test(normalizedNonce)) return null;
    try {
      localStorage.setItem(persistentAuthResultKey, JSON.stringify({
        version: 2,
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
    if (!/^[a-f0-9]{64}$/.test(normalizedNonce)) return null;
    try {
      const result = JSON.parse(localStorage.getItem(persistentAuthResultKey) || 'null');
      if (!result || result.version !== 2 || result.nonce !== normalizedNonce || Date.now() - Number(result.completedAt || 0) > authResultMaxAgeMs) {
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

  async function requestPushRegistration(mode,profile,subscriptionId) {const normalized=normalizeProfile(profile);if(!normalized||!subscriptionId)return null;return SecureGAS.request(config.gasUrl,'subscribe',{sessionToken:normalized.sessionToken,subscriptionId,appId:config.oneSignalAppId,active:mode==='register'});}

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
          await OneSignal.init({
            appId: config.oneSignalAppId,
            autoResubscribe: true,
            // The PWA already owns ./sw.js for offline caching.  Tell
            // OneSignal to use that worker (which imports the OneSignal
            // worker SDK) instead of installing a second competing worker.
            serviceWorkerPath: './sw.js',
            serviceWorkerParam: { scope: './' }
          });
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

  function buildProviderUrl() { return config.gasUrl; }

  async function launchProvider(profile) { const normalized=normalizeProfile(profile);if(!normalized)throw new Error('請重新使用 LINE 登入。');const verified=await SecureGAS.request(config.gasUrl,'session',{sessionToken:normalized.sessionToken});rememberAuthorizedProfile(verified);if(disconnectApp)disconnectApp();disconnectApp=SecureGAS.connectApp(config.gasUrl,frame,verified,()=>{clearRememberedProfile();frame.removeAttribute('src');shell.classList.remove('is-ready');loginButton.hidden=false;loginButton.disabled=false;setStatus('登入已失效，請重新使用 LINE 登入。','error');});void initialiseOneSignalPush(verified);frame.addEventListener('load',()=>{shell.classList.add('is-ready');logoutButton.hidden=false;},{once:true});setStatus('正在載入已驗證的師資工作區…'); }

  async function readProfile() { return SecureGAS.request(config.gasUrl,'login',{idToken:window.liff.getIDToken&&window.liff.getIDToken(),accessToken:window.liff.getAccessToken&&window.liff.getAccessToken()}); }

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

  function createAuthBridge(mode,nonce,profile) {requestPwaAuthApi(mode==='poll'?'claim':mode,nonce,profile).then(result=>{if(result.stored&&profile){notifyPwaParent(profile);window.setTimeout(closeAuthorizationWindow,250);}else if(result.profile)receiveAuthResult({type:'teacher-pwa-line-auth',nonce:result.nonce,profile:result.profile});}).catch(()=>setStatus('驗證同步失敗，請重新登入。','error'));}

  // 安全中繼使用 postMessage，URL 僅有隨機通道，不含登入憑證。
  async function requestPwaAuthApi(mode,nonce,profile) {if(mode==='complete')return {...await SecureGAS.request(config.gasUrl,'relay-store',{challenge:nonce,sessionToken:profile.sessionToken}),nonce};return {...await SecureGAS.request(config.gasUrl,'relay-claim',{verifier:nonce}),nonce:await SecureGAS.hash(nonce)};}

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
      .catch((error) => {
        // 等待 LINE 授權期間的暫時逾時會自動輪詢下一次，不需在 F12 重複留下警告。
        const message = String((error && error.message) || error || '');
        if (!/授權中繼(?:逾時|已取消)/.test(message)) console.warn('Unable to poll LINE authorization result.', error);
      })
      .finally(() => { authPollInFlight = false; });
  }

  async function beginAuthPolling(nonce) {
    if (!nonce || popupContext.isPopup) return;
    stopAuthPolling();
    storePendingNonce(nonce);
    if (await receiveStoredAuthorization(nonce)) return;
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

  async function openLineAuthorization() {const nonce=createNonce();activeAuthWindow=window.open('about:blank','teacher-pwa-line-auth-start','popup=yes,width=440,height=720,resizable=yes,scrollbars=yes');if(!activeAuthWindow){setStatus('請允許開啟 LINE 登入視窗後重試。','error');return;}const challenge=await SecureGAS.hash(nonce);activeAuthWindow.name='teacher-pwa-line-auth-'+challenge;storePendingNonce(nonce);void beginAuthPolling(nonce);loginButton.disabled=true;loginButton.textContent='正在等待 LINE 授權…';setStatus('請在 LINE 完成授權；回到 App 後會自動同步。');activeAuthWindow.location.replace(buildAuthUrl(challenge));}

  async function isExpectedAuthResult(data) {if(!data||data.type!=='teacher-pwa-line-auth'||!normalizeProfile(data.profile))return false;const nonce=getPendingNonce();return Boolean(nonce&&data.nonce===await SecureGAS.hash(nonce));}

  async function receiveAuthResult(data) {
    if (completingAuthorization || !await isExpectedAuthResult(data) || completingAuthorization) return;
    const profile = rememberAuthorizedProfile(data.profile);
    if (!profile) return;
    completingAuthorization = true;
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
    } finally {
      completingAuthorization = false;
    }
  }

  async function receiveStoredAuthorization(nonce) {if(!nonce)return false;const challenge=await SecureGAS.hash(nonce),profile=getAuthorizationResult(challenge);if(!profile)return false;await receiveAuthResult({type:'teacher-pwa-line-auth',nonce:challenge,profile});return true;}

  async function resumeRememberedSession() {
    if (popupContext.isPopup) return false;
    const profile = getRememberedProfile();
    if (!profile) return false;
    stopAuthPolling();
    clearPendingNonce();
    activeAuthWindow = null;
    loginButton.disabled = true;
    loginButton.textContent = '正在恢復登入…';
    try {await launchProvider(profile);return true;} catch (_) {clearRememberedProfile();loginButton.disabled=false;return false;}
  }

  function notifyPwaParent(profile) {const payload={type:'teacher-pwa-line-auth',nonce:popupContext.nonce,profile:normalizeProfile(profile)};if(authChannel)authChannel.postMessage(payload);if(window.opener&&!window.opener.closed)window.opener.postMessage(payload,window.location.origin);}

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

  function handleBridgeMessage() { /* 舊 UID／萬用 origin 中繼已停用。 */ }

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
    if (pendingNonce && await receiveStoredAuthorization(pendingNonce)) return;
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

  logoutButton.addEventListener('click', async () => {
    const profileToUnregister = oneSignalProfile || getRememberedProfile();
    const subscription = oneSignalClient && oneSignalClient.User && oneSignalClient.User.PushSubscription;
    if (profileToUnregister && subscription && subscription.id) {
      try {await requestPushRegistration('unregister', profileToUnregister, subscription.id);} catch (_) {}
    }
    if(profileToUnregister){try{await SecureGAS.request(config.gasUrl,'logout',{sessionToken:profileToUnregister.sessionToken});}catch(_){setStatus('登出驗證尚未完成，請確認網路後重試。','error');return;}}
    if(disconnectApp){disconnectApp();disconnectApp=null;}
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
    if (await receiveStoredAuthorization(getPendingNonce())) return;
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
