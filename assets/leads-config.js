/* Public settings only. Populate exact preview origins after manual account setup. */
window.GLATT_LEADS_CONFIG = Object.freeze({
  environment: 'preview',
  enabled: true,
  allowedOrigins: ['https://glatt-ai-preview.vercel.app'],
  endpoint: 'https://glattai-leads-review.esterwein1.workers.dev/leads',
  timeoutMs: 25000,
  privacy: { text: '', url: '' }
});
