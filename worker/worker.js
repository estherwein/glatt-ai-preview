const ALLOWED_ORIGINS = new Set([
  'https://glattai.com',
  'https://www.glattai.com',
  'https://estherwein.github.io'
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin)
        ? origin
        : 'https://glattai.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };

    // Browser preflight request
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // Only our website should normally call this endpoint
    if (!ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse(
        { success: false, error: 'Forbidden' },
        403,
        corsHeaders
      );
    }

    if (request.method !== 'POST') {
      return jsonResponse(
        { success: false, error: 'Method not allowed' },
        405,
        corsHeaders
      );
    }

    try {
      const body = await request.json();

      const lead = {
        name: clean(body.name, 150),
        phone: clean(body.phone, 100),
        email: clean(body.email, 200),
        background: clean(body.background, 200),
        process: clean(body.process, 1500),
        source: clean(body.source, 100),
        page: clean(body.page, 500)
      };

      // Required fields
      if (!lead.name || !lead.phone) {
        return jsonResponse(
          {
            success: false,
            error: 'Name and phone are required'
          },
          400,
          corsHeaders
        );
      }

      const whatsappPayload = {
        messaging_product: 'whatsapp',
        to: env.OWNER_WHATSAPP_NUMBER,

        type: 'template',

        template: {
          name: env.WA_TEMPLATE_NAME,

          language: {
            code: env.WA_TEMPLATE_LANGUAGE
          },

          components: [
            {
              type: 'body',

              parameters: [
                {
                  type: 'text',
                  text: lead.name
                },
                {
                  type: 'text',
                  text: lead.phone
                },
                {
                  type: 'text',
                  text: lead.email || 'לא נמסר'
                },
                {
                  type: 'text',
                  text: lead.background || 'לא נמסר'
                },
                {
                  type: 'text',
                  text: lead.process || 'לא נמסר'
                }
              ]
            }
          ]
        }
      };

      const metaResponse = await fetch(
        `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',

          headers: {
            'Authorization': `Bearer ${env.WA_TOKEN}`,
            'Content-Type': 'application/json'
          },

          body: JSON.stringify(whatsappPayload)
        }
      );

      if (!metaResponse.ok) {
        const metaError = await metaResponse.text();

        // This will be visible in Cloudflare logs, not to the visitor
        console.error('WhatsApp API error:', metaError);

        return jsonResponse(
          {
            success: false,
            error: 'Could not send WhatsApp notification'
          },
          502,
          corsHeaders
        );
      }

      return jsonResponse(
        {
          success: true
        },
        200,
        corsHeaders
      );

    } catch (error) {
      console.error('Worker error:', error);

      return jsonResponse(
        {
          success: false,
          error: 'Server error'
        },
        500,
        corsHeaders
      );
    }
  }
};


// Clean data coming from the public form
function clean(value, maxLength) {
  if (typeof value !== 'string') return '';

  return value
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}


// Standard JSON response
function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,

    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=UTF-8'
    }
  });
}