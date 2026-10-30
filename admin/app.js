(() => {
  'use strict';
  const config = window.ADMIN_PWA_CONFIG || {};
  const frame = document.getElementById('admin-frame');
  const installButton = document.getElementById('install-button');
  const pushButton = document.getElementById('push-button');
  const appState = document.getElementById('app-state');
  const loading = document.getElementById('loading');
  const pushDeviceStorageKey = 'gugoAdminPushDeviceKeyV1';
  const channel = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
  const pushTasks = new Map();
  let deferredInstallPrompt = null, sessionToken = '', oneSignalClient = null, oneSignalInitPromise = null;
  let trustedSource = null, trustedOrigin = '', pushTail = Promise.resolve(), pushError = '';

  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const setAppState = message => { appState.textContent = message; };
  const googleOrigin = value => /^https:\/\/(?:script\.google\.com|[a-z0-9-]+-script\.googleusercontent\.com)$/.test(value || '');
  const isValidSessionToken = value => /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/.test(String(value || ''));
  function normalizePushId(value) {
    const id = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) ? id : '';
  }
  function pushDeviceKey() {
    const saved = localStorage.getItem(pushDeviceStorageKey);
    if (/^[a-f0-9]{64}$/.test(saved || '')) return saved;
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(pushDeviceStorageKey, key);
    if (localStorage.getItem(pushDeviceStorageKey) !== key) throw new Error('請允許網站儲存空間，以安全綁定通知裝置。');
    return key;
  }
  function queuePushTask(key, work) {
    if (pushTasks.has(key)) return pushTasks.get(key);
    const task = pushTail.catch(() => {}).then(work);
    pushTail = task.catch(() => {});pushTasks.set(key, task);
    task.then(() => pushTasks.delete(key), () => pushTasks.delete(key));
    return task;
  }
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
      registration.update().catch(() => {});
    } catch (_) { setAppState('離線快取準備失敗，可連線使用管理中心'); }
  }
  function buildAdminUrl() {
    const target = new URL(config.gasUrl);
    target.searchParams.set('page', 'admin');target.searchParams.set('source', 'admin-pwa');
    target.searchParams.set('admin_push_channel', channel);target.searchParams.set('pwa_origin', window.location.origin);
    return target.toString();
  }
  function requestPushRegistration(mode, subscriptionId, token) {
    const id = normalizePushId(subscriptionId), appId = normalizePushId(config.oneSignalAppId);
    if (!id || !appId || !isValidSessionToken(token)) return Promise.resolve(null);
    return queuePushTask([mode, token, appId, id].join('|'), async () => {
      if (mode === 'register' && sessionToken !== token) return { skipped: true };
      const result = await SecureGAS.request(config.gasUrl, 'admin-subscribe', {
        adminSessionToken: token, subscriptionId: id, appId, active: mode === 'register', deviceKey: pushDeviceKey()
      });
      if (!result || !result.success) throw new Error('管理通知綁定尚未完成，請點擊通知按鈕重試。');
      pushError = '';return result;
    });
  }
  function syncPushSubscription(mode) {
    if (!oneSignalClient || !sessionToken) return Promise.resolve(null);
    const current = oneSignalClient.User && oneSignalClient.User.PushSubscription;
    return requestPushRegistration(mode || (current && current.optedIn === true ? 'register' : 'unregister'), current && current.id, sessionToken);
  }
  function updatePushButton() {
    pushButton.hidden = !sessionToken;
    if (!sessionToken) return;
    pushButton.disabled = false;
    const current = oneSignalClient && oneSignalClient.User && oneSignalClient.User.PushSubscription;
    pushButton.textContent = pushError ? '通知綁定待重試' : !oneSignalClient ? '重試通知準備' : current && current.optedIn ? '通知已啟用' : '啟用通知';
  }
  function showPushFailure(error) { pushError = error && error.message || '通知連線失敗';updatePushButton(); }
  function initialiseOneSignal() {
    if (!sessionToken || !config.oneSignalAppId) return Promise.resolve(false);
    if (oneSignalInitPromise) return oneSignalInitPromise.then(async ready => {
      if (ready && sessionToken) await syncPushSubscription();updatePushButton();return ready;
    });
    oneSignalInitPromise = new Promise(resolve => {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(async OneSignal => {
        try {
          await OneSignal.init({ appId: config.oneSignalAppId, autoResubscribe: true, serviceWorkerPath: './sw.js', serviceWorkerParam: { scope: './' } });
          oneSignalClient = OneSignal;
          OneSignal.User.PushSubscription.addEventListener('change', () => { void syncPushSubscription().then(updatePushButton).catch(showPushFailure); });
          await syncPushSubscription();updatePushButton();resolve(true);
        } catch (error) {
          showPushFailure(error);if (!oneSignalClient) oneSignalInitPromise = null;resolve(!!oneSignalClient);
        }
      });
    });
    return oneSignalInitPromise;
  }
  async function enablePush() {
    pushButton.disabled = true;pushButton.textContent = '通知啟用中…';
    try {
      await initialiseOneSignal();if (!oneSignalClient || !sessionToken) return;
      if (oneSignalClient.Notifications && !oneSignalClient.Notifications.permission) await oneSignalClient.Notifications.requestPermission();
      const current = oneSignalClient.User && oneSignalClient.User.PushSubscription;
      if (current && !current.optedIn && current.optIn) await current.optIn();
      await syncPushSubscription();
    } catch (error) { showPushFailure(error); }
    finally { updatePushButton(); }
  }
  function handleAdminSession(event) {
    const data = event && event.data;
    if (!data || data.channel !== channel || !event.source || !googleOrigin(event.origin)) return;
    if (data.type === 'gugo-admin-pwa-ready') {
      trustedSource = event.source;trustedOrigin = event.origin;
      trustedSource.postMessage({ type: 'gugo-admin-pwa-connect', channel }, trustedOrigin);return;
    }
    if (data.type !== 'gugo-admin-pwa-session' || event.source !== trustedSource || event.origin !== trustedOrigin) return;
    const incomingToken = String(data.token || '').trim();
    if (data.loggedOut) {
      // GAS confirms server-side logout before emitting this message. Ignore a
      // delayed logout from an earlier administrator session.
      if (sessionToken && incomingToken !== sessionToken) return;
      sessionToken = '';updatePushButton();setAppState('管理中心已登出');return;
    }
    if (!isValidSessionToken(incomingToken)) return;
    sessionToken = incomingToken;
    setAppState(isStandalone() ? '管理 App 已登入' : '可加入手機桌面使用');
    void initialiseOneSignal().catch(showPushFailure);updatePushButton();
  }
  function bindInstall() {
    window.addEventListener('beforeinstallprompt', event => { event.preventDefault();deferredInstallPrompt=event;installButton.hidden=false; });
    installButton.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);deferredInstallPrompt=null;installButton.hidden=true;
    });
  }
  function initialise() {
    setAppState(isStandalone() ? '已在 App 模式執行' : '可加入手機桌面使用');bindInstall();
    pushButton.addEventListener('click', enablePush);window.addEventListener('message', handleAdminSession);
    frame.addEventListener('load', () => { loading.hidden=true; }, { once:true });frame.src=buildAdminUrl();void registerServiceWorker();
    window.addEventListener('online', () => { if (sessionToken) void initialiseOneSignal().catch(showPushFailure); });
  }
  document.addEventListener('DOMContentLoaded', initialise);
})();
