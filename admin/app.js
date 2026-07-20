(() => {
  'use strict';

  const config = window.ADMIN_PWA_CONFIG || {};
  const frame = document.getElementById('admin-frame');
  const installButton = document.getElementById('install-button');
  const pushButton = document.getElementById('push-button');
  const appState = document.getElementById('app-state');
  const loading = document.getElementById('loading');
  let deferredInstallPrompt = null;
  let sessionToken = '';
  let oneSignalClient = null;
  let oneSignalInitPromise = null;
  let jsonpSerial = 0;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function setAppState(message) {
    appState.textContent = message;
  }

  function isValidSessionToken(value) {
    return /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/.test(String(value || ''));
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      registration.update().catch(() => {});
    } catch (error) {
      console.warn('Admin PWA service worker registration failed.', error);
    }
  }

  function buildAdminUrl() {
    const target = new URL(config.gasUrl);
    target.searchParams.set('page', 'admin');
    target.searchParams.set('source', 'admin-pwa');
    return target.toString();
  }

  function requestPushRegistration(mode, subscriptionId, token) {
    const normalizedId = String(subscriptionId || '').trim();
    const validToken = String(token || '').trim();
    if (!normalizedId || !isValidSessionToken(validToken) || !config.gasUrl || !config.oneSignalAppId) return Promise.resolve(null);
    const callback = '__gugoAdminPwaPushJsonp_' + (++jsonpSerial) + '_' + Date.now();
    const target = new URL(config.gasUrl);
    target.searchParams.set('admin_pwa_push_api', mode === 'unregister' ? 'unregister' : 'register');
    target.searchParams.set('session_token', validToken);
    target.searchParams.set('subscription_id', normalizedId);
    target.searchParams.set('app_id', String(config.oneSignalAppId));
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

  async function syncPushSubscription(mode) {
    if (!oneSignalClient || !sessionToken) return null;
    const subscription = oneSignalClient.User && oneSignalClient.User.PushSubscription;
    const subscriptionId = String(subscription && subscription.id || '').trim();
    if (!subscriptionId) return null;
    const selectedMode = mode || (subscription.optedIn === false ? 'unregister' : 'register');
    return requestPushRegistration(selectedMode, subscriptionId, sessionToken);
  }

  function updatePushButton() {
    if (!sessionToken) {
      pushButton.hidden = true;
      return;
    }
    pushButton.hidden = false;
    const subscription = oneSignalClient && oneSignalClient.User && oneSignalClient.User.PushSubscription;
    if (!oneSignalClient) {
      pushButton.disabled = true;
      pushButton.textContent = '通知準備中';
      return;
    }
    pushButton.disabled = false;
    pushButton.textContent = subscription && subscription.optedIn ? '通知已啟用' : '啟用通知';
  }

  function initialiseOneSignal() {
    if (!sessionToken || !config.oneSignalAppId) return Promise.resolve(false);
    if (oneSignalInitPromise) return oneSignalInitPromise;
    updatePushButton();
    oneSignalInitPromise = new Promise((resolve) => {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(async (OneSignal) => {
        try {
          await OneSignal.init({
            appId: config.oneSignalAppId,
            autoResubscribe: true,
            serviceWorkerPath: './sw.js',
            serviceWorkerParam: { scope: './' }
          });
          oneSignalClient = OneSignal;
          OneSignal.User.PushSubscription.addEventListener('change', () => { void syncPushSubscription().then(updatePushButton); });
          await syncPushSubscription();
          updatePushButton();
          resolve(true);
        } catch (error) {
          console.warn('Admin OneSignal initialisation failed.', error);
          updatePushButton();
          resolve(false);
        }
      });
    });
    return oneSignalInitPromise;
  }

  async function enablePush() {
    await initialiseOneSignal();
    if (!oneSignalClient || !sessionToken) return;
    pushButton.disabled = true;
    pushButton.textContent = '通知啟用中…';
    try {
      if (oneSignalClient.Notifications && !oneSignalClient.Notifications.permission) {
        await oneSignalClient.Notifications.requestPermission();
      }
      await syncPushSubscription('register');
    } catch (error) {
      console.warn('Admin push permission failed.', error);
    }
    updatePushButton();
  }

  function handleAdminSession(event) {
    const data = event && event.data;
    if (!data || data.type !== 'gugo-admin-pwa-session') return;
    const incomingToken = String(data.token || '').trim();
    if (data.loggedOut) {
      const tokenToRemove = isValidSessionToken(incomingToken) ? incomingToken : sessionToken;
      if (tokenToRemove) {
        sessionToken = tokenToRemove;
        void syncPushSubscription('unregister').finally(() => { sessionToken = ''; updatePushButton(); });
      } else {
        sessionToken = '';
        updatePushButton();
      }
      return;
    }
    if (!isValidSessionToken(incomingToken)) return;
    sessionToken = incomingToken;
    setAppState(isStandalone() ? '管理 App 已登入' : '可加入手機桌面使用');
    void initialiseOneSignal();
    updatePushButton();
  }

  function bindInstall() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      installButton.hidden = false;
    });
    installButton.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      deferredInstallPrompt = null;
      installButton.hidden = true;
    });
  }

  function initialise() {
    setAppState(isStandalone() ? '已在 App 模式執行' : '可加入手機桌面使用');
    bindInstall();
    pushButton.addEventListener('click', enablePush);
    window.addEventListener('message', handleAdminSession);
    frame.addEventListener('load', () => { loading.hidden = true; }, { once: true });
    frame.src = buildAdminUrl();
    void registerServiceWorker();
  }

  document.addEventListener('DOMContentLoaded', initialise);
})();
