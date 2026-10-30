// Credentials are exchanged only with a nonce-bound GAS frame over postMessage.
(() => {
  const googleOrigin = value => /^https:\/\/(?:script\.google\.com|[a-z0-9-]+-script\.googleusercontent\.com)$/.test(value || '');
  const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
  window.SecureGAS = {
    request(gasUrl, action, payload) {
      return new Promise((resolve, reject) => {
        const channel = nonce(), frame = document.createElement('iframe'), url = new URL(gasUrl);
        let source = null, origin = '';
        url.searchParams.set('secure_bridge', '1');url.searchParams.set('channel', channel);
        frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-5px;bottom:0;border:0;opacity:0;pointer-events:none';
        frame.setAttribute('aria-hidden', 'true');frame.referrerPolicy = 'no-referrer';
        const clean = () => { clearTimeout(timer);window.removeEventListener('message', receive);frame.remove(); };
        const receive = event => {
          const data = event.data;
          if (!googleOrigin(event.origin) || !data || data.channel !== channel) return;
          if (data.type === 'gugo-secure-bridge-ready' && !source && event.source) {
            source = event.source;origin = event.origin;
            source.postMessage({ type:'gugo-secure-bridge-request', channel, action, payload }, origin);
          } else if (data.type === 'gugo-secure-bridge-result' && event.source === source && event.origin === origin) {
            clean();if (data.error) reject(new Error(data.error));else resolve(data.result);
          }
        };
        const timer = setTimeout(() => { clean();reject(new Error('通知驗證連線逾時，請重新嘗試。')); }, 45000);
        window.addEventListener('message', receive);frame.src = url.toString();document.body.append(frame);
      });
    }
  };
})();
