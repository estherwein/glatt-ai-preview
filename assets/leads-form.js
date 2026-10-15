(function (root) {
  'use strict';
  const core = root.GlattLeads;
  const STORAGE_KEY = 'glatt-lead-request-preview-v1';
  const MESSAGES = {
    name: 'נא להזין שם מלא (לפחות שני תווים).',
    phone: 'נא להזין מספר טלפון תקין. למספר מחוץ לישראל יש להוסיף קידומת מדינה עם +.',
    email: 'נא להזין כתובת אימייל תקינה, או להשאיר את השדה ריק.',
    process: 'נא לקצר את תיאור התהליך ל־1,500 תווים לכל היותר.',
    RATE_LIMITED: 'נשלחו מספר פניות בזמן קצר. נא להמתין דקה ולנסות שוב.',
    SPAM_REJECTED: 'לא ניתן לשלוח כרגע. נא להמתין רגע ולנסות שוב.',
    UNAVAILABLE: 'שליחת הטופס אינה זמינה כרגע. הפרטים נשמרו בטופס; אפשר לנסות שוב בהמשך.',
    ID_CONFLICT: 'לא ניתן לאמת את הפנייה. הפרטים נשמרו בטופס; נא לנסות שוב בהמשך.',
    DEFAULT: 'לא הצלחנו לאמת שהפנייה נשמרה. הפרטים נשארו בטופס; אפשר לנסות שוב ללא יצירת פנייה כפולה.'
  };

  async function digest(value) {
    const bytes = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }

  // Kept separate from DOM rendering so retries, double clicks and failures can be tested.
  function createSubmission(options) {
    let busy = false;
    let saved = false;
    let pending = null;
    const storage = options.storage;
    const notify = (name, value) => { if (options[name]) options[name](value); };
    const now = options.now || Date.now;
    function remember(record) {
      pending = record;
      try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(record)); } catch (_) { /* Memory fallback, no personal data persisted. */ }
    }
    async function submit(input, origin) {
      if (busy || saved) return {ignored:true};
      busy = true;
      notify('onBusy', true);
      notify('onError', null);
      try {
        const lead = core.lead(input.lead, origin);
        core.spam(input);
        const fingerprint = await (options.digest || digest)(JSON.stringify({origin, lead}));
        if (!pending) {
          try { pending = JSON.parse(storage && storage.getItem(STORAGE_KEY)); } catch (_) { pending = null; }
        }
        if (!pending || pending.fingerprint !== fingerprint || !Number.isFinite(pending.createdAt) ||
            now() - pending.createdAt > 86400000 || pending.createdAt > now()) {
          remember({requestId:options.uuid(), fingerprint, createdAt:now()});
        }
        try { core.requestId(pending.requestId); }
        catch (_) { remember({requestId:options.uuid(), fingerprint, createdAt:now()}); }
        const payload = {requestId:pending.requestId, lead, website:input.website, elapsedMs:input.elapsedMs};
        const result = await options.send(payload);
        if (!result || result.ok !== true || result.saved !== true || result.requestId !== pending.requestId ||
            typeof result.leadId !== 'string' || !/^[0-9a-f-]{36}$/i.test(result.leadId)) core.fail('UNCONFIRMED');
        saved = true;
        notify('onSaved', result);
        return result;
      } catch (error) {
        const problem = {code:error.code || 'NETWORK_ERROR', field:error.field};
        notify('onError', problem);
        return {ok:false, ...problem};
      } finally {
        busy = false;
        notify('onBusy', false);
      }
    }
    function reset() {
      if (busy) return;
      pending = null;
      saved = false;
      try { if (storage) storage.removeItem(STORAGE_KEY); } catch (_) { /* optional storage */ }
    }
    return {submit, reset};
  }

  function init() {
    const document = root.document;
    const form = document.getElementById('fitForm');
    if (!form || form.dataset.leadsBound) return;
    form.dataset.leadsBound = 'true';
    const config = root.GLATT_LEADS_CONFIG || {};
    const status = document.getElementById('leadStatus');
    const button = form.querySelector('[type="submit"]');
    const buttonHTML = button.innerHTML;
    const success = document.getElementById('formSuccess');
    const back = document.getElementById('successBack');
    const fields = {name:'fname', phone:'fphone', email:'fmail', process:'fproc'};
    let startedAt = Date.now();
    let storage;
    try { storage = root.sessionStorage; } catch (_) { /* private browsing may disable it */ }

    const privacy = document.getElementById('leadPrivacy');
    if (config.privacy && config.privacy.text) {
      privacy.textContent = config.privacy.text;
      privacy.hidden = false;
      if (config.privacy.url) {
        try {
          const url = new URL(config.privacy.url, root.location.href);
          if (url.origin === root.location.origin && /^https?:$/.test(url.protocol)) {
            const link = document.createElement('a');
            link.href = url.href;
            link.textContent = ' מדיניות פרטיות';
            privacy.appendChild(link);
          }
        } catch (_) { /* Unconfigured policy link is not rendered. */ }
      }
    }

    const submission = createSubmission({
      storage,
      uuid: () => root.crypto.randomUUID(),
      async send(payload) {
        if (!config.enabled || config.environment !== 'preview' ||
            !core.allowedOrigin(root.location.origin, config.allowedOrigins) ||
            !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/leads$/.test(config.endpoint || '')) core.fail('UNAVAILABLE');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs || 25000);
        try {
          const response = await root.fetch(config.endpoint, {
            method:'POST', mode:'cors', credentials:'omit', cache:'no-store',
            headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:controller.signal
          });
          if (response.type === 'opaque') core.fail('UNCONFIRMED');
          const result = await response.json();
          if (!response.ok) core.fail(result && result.code || 'NETWORK_ERROR');
          return result;
        } finally { clearTimeout(timer); }
      },
      onBusy(busy) {
        form.setAttribute('aria-busy', String(busy));
        form.querySelectorAll('input,textarea,button').forEach(el => { el.disabled = busy; });
        if (busy) button.textContent = 'שולחים את הפנייה…';
        else button.innerHTML = buttonHTML;
      },
      onError(error) {
        Object.values(fields).forEach(id => document.getElementById(id).removeAttribute('aria-invalid'));
        status.hidden = !error;
        status.textContent = error ? (MESSAGES[error.field] || MESSAGES[error.code] || MESSAGES.DEFAULT) : '';
        if (error && fields[error.field]) {
          const field = document.getElementById(fields[error.field]);
          field.setAttribute('aria-invalid', 'true');
          // onBusy(false) runs before this callback so the field can receive focus.
          setTimeout(() => field.focus(), 0);
        }
      },
      onSaved() {
        status.hidden = true;
        success.classList.add('show');
        success.setAttribute('aria-hidden', 'false');
        form.inert = true;
        back.focus();
      }
    });

    form.addEventListener('submit', event => {
      event.preventDefault();
      const selected = document.querySelector('#bgRadios .sel');
      submission.submit({
        lead: {
          name:document.getElementById('fname').value,
          phone:document.getElementById('fphone').value,
          email:document.getElementById('fmail').value,
          background:selected ? selected.dataset.v : '',
          process:document.getElementById('fproc').value,
          page:root.location.origin + root.location.pathname
        },
        website:document.getElementById('leadWebsite').value,
        elapsedMs:Math.min(Date.now() - startedAt, 86400000)
      }, root.location.origin);
    });
    back.addEventListener('click', () => {
      success.classList.remove('show');
      success.setAttribute('aria-hidden', 'true');
      form.inert = false;
      form.reset();
      document.querySelectorAll('#bgRadios .radio-pill').forEach((el, index) => el.classList.toggle('sel', index === 0));
      submission.reset();
      startedAt = Date.now();
      button.focus();
      const lenis = root.__qa && root.__qa.lenis;
      if (lenis) lenis.scrollTo('#opener');
      else document.getElementById('opener').scrollIntoView({behavior:root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    });
  }
  root.GlattLeadForm = Object.freeze({createSubmission, init});
  if (root.document) init();
})(globalThis);
