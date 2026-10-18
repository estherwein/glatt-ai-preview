/* Shared, dependency-free validation. Also copy this file into Apps Script as Core.gs. */
(function (root) {
  'use strict';
  const BACKGROUNDS = ['אין רקע', 'קצת ניסיון', 'מתכנת'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function fail(code, field) {
    const error = new Error(code);
    error.code = code;
    if (field) error.field = field;
    throw error;
  }
  function text(value, max, field, required) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('INVALID_INPUT', field);
    const result = value.trim();
    if (required && !result) fail('INVALID_INPUT', field);
    return result;
  }
  function phone(value) {
    const raw = text(value, 40, 'phone', true);
    if (!/^\+?[\d\s().-]+$/.test(raw)) fail('INVALID_INPUT', 'phone');
    let digits = raw.replace(/[\s().-]/g, '');
    if (/^0\d{8,9}$/.test(digits)) digits = '+972' + digits.slice(1);
    if (/^972\d{8,9}$/.test(digits)) digits = '+' + digits;
    if (!/^\+[1-9]\d{7,14}$/.test(digits)) fail('INVALID_INPUT', 'phone');
    if (digits.startsWith('+972') && !/^\+972[1-9]\d{7,8}$/.test(digits)) fail('INVALID_INPUT', 'phone');
    return digits;
  }
  function email(value) {
    const result = text(value, 254, 'email', false);
    if (result && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result)) fail('INVALID_INPUT', 'email');
    return result;
  }
  // Deliberately preview-only. A production rollout requires a separate reviewed change.
  function previewOrigin(origin) {
    return typeof origin === 'string' && (
      /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin) ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)
    );
  }
  function allowedOrigin(origin, allowed) {
    return previewOrigin(origin) && Array.isArray(allowed) && allowed.indexOf(origin) !== -1;
  }
  function lead(input, origin) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT');
    const name = text(input.name, 120, 'name', true).replace(/\s+/g, ' ');
    if (name.length < 2) fail('INVALID_INPUT', 'name');
    const background = text(input.background, 40, 'background', true);
    if (BACKGROUNDS.indexOf(background) === -1) fail('INVALID_INPUT', 'background');
    const page = text(input.page, 2048, 'page', true);
    if (!previewOrigin(origin) || !page.startsWith(origin + '/') || /[\s?#\\]/.test(page)) fail('INVALID_INPUT', 'page');
    return {
      name: name, phone: phone(input.phone), email: email(input.email),
      background: background, process: text(input.process, 1500, 'process', false), page: page
    };
  }
  function requestId(value) {
    if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_REQUEST_ID');
    return value.toLowerCase();
  }
  function spam(input) {
    if (typeof input.website !== 'string' || input.website !== '' ||
        !Number.isFinite(input.elapsedMs) || input.elapsedMs < 1500 || input.elapsedMs > 86400000) fail('SPAM_REJECTED');
  }
  function signingText(envelope) {
    return ['glatt-leads-v1', envelope.environment, String(envelope.timestamp), envelope.requestId, envelope.payload].join('\n');
  }
  function html(value) {
    return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
  }
  root.GlattLeads = Object.freeze({BACKGROUNDS, fail, phone, email, previewOrigin, allowedOrigin, lead, requestId, spam, signingText, html});
})(globalThis);
