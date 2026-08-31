import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import crypto from 'crypto';

const router = Router();

// ─── Lazy initialisers ────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

function getResend() {
  return new Resend(process.env.RESEND_API_KEY!);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUnsubscribeToken(email: string): string {
  return crypto
    .createHmac('sha256', process.env.UNSUBSCRIBE_SECRET ?? 'change-me-in-env')
    .update(email.toLowerCase().trim())
    .digest('hex');
}

function buildUnsubscribeUrl(email: string): string {
  const token = makeUnsubscribeToken(email);
  const base  = (process.env.BACKEND_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  return `${base}/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
}

// From header with a display name — bare addresses read as less legitimate to
// both inboxes and spam filters.
function getFromHeader(): string {
  const name  = process.env.SITE_NAME ?? 'CryptoMoney';
  const email = process.env.RESEND_FROM_EMAIL ?? 'newsletter@yourdomain.com';
  return `${name} <${email}>`;
}

// RFC 2369 + RFC 8058 one-click unsubscribe headers. Gmail/Yahoo expect these
// on bulk mail — without them, recipients hit "report spam" instead of the
// unsubscribe link, which hurts sender reputation.
function getListUnsubscribeHeaders(unsubscribeLink: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeLink}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// ─── POST /subscribe ──────────────────────────────────────────────────────────

router.post('/subscribe', async (req, res) => {
  const { email } = req.body as { email?: string };

  if (
    !email ||
    !/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(email)
  ) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  const normalised = email.toLowerCase().trim();
  const supabase   = getSupabase();

  const { data: existing } = await supabase
    .from('newsletter_subscribers')
    .select('is_active')
    .eq('email', normalised)
    .single();

  const isResubscribe = existing && !existing.is_active;

  const { error: dbError } = await supabase
    .from('newsletter_subscribers')
    .upsert(
      { email: normalised, is_active: true },
      { onConflict: 'email', ignoreDuplicates: false }
    );

  if (dbError) {
    console.error('[newsletter] Supabase upsert error:', dbError);
    return res.status(500).json({ error: 'Could not save your subscription. Please try again.' });
  }

  sendWelcomeEmail(normalised, !!isResubscribe).catch((err) =>
    console.error('[newsletter] Welcome email failed:', err)
  );

  return res.status(200).json({ message: "You've been subscribed to our newsletter." });
});

// ─── Unsubscribe (GET for the link in the email body, POST for RFC 8058 ───────
// one-click unsubscribe, which mail clients call automatically without a
// redirect) ─────────────────────────────────────────────────────────────────

async function deactivateSubscriber(
  email: string,
  token: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const expected = makeUnsubscribeToken(email);
  if (token !== expected) {
    return { ok: false, status: 403, message: 'Invalid or expired unsubscribe link.' };
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('newsletter_subscribers')
    .update({ is_active: false })
    .eq('email', email.toLowerCase().trim());

  if (error) {
    console.error('[newsletter] Unsubscribe DB error:', error);
    return { ok: false, status: 500, message: 'Something went wrong. Please try again later.' };
  }

  return { ok: true };
}

router.get('/unsubscribe', async (req, res) => {
  const { email, token } = req.query as { email?: string; token?: string };

  if (!email || !token) {
    return res.status(400).send('Missing email or token.');
  }

  const result = await deactivateSubscriber(email, token);
  if (result.ok === false) {
    return res.status(result.status).send(result.message);
  }

  const frontendBase = (process.env.FRONTEND_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  return res.redirect(`${frontendBase}/newsletter?unsubscribed=true`);
});

router.post('/unsubscribe', async (req, res) => {
  const { email, token } = req.query as { email?: string; token?: string };

  if (!email || !token) {
    return res.status(400).json({ error: 'Missing email or token.' });
  }

  const result = await deactivateSubscriber(email, token);
  if (result.ok === false) {
    return res.status(result.status).json({ error: result.message });
  }

  return res.status(200).json({ ok: true });
});

// ─── GET /blast/stats ─────────────────────────────────────────────────────────
// Returns active subscriber count — used by the admin UI before sending.

router.get('/blast/stats', async (_req, res) => {
  const supabase = getSupabase();

  const { count, error } = await supabase
    .from('newsletter_subscribers')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  if (error) {
    console.error('[newsletter/blast] Stats error:', error);
    return res.status(500).json({ error: 'Could not fetch subscriber count.' });
  }

  return res.json({ activeSubscribers: count ?? 0 });
});

// ─── POST /blast ──────────────────────────────────────────────────────────────
// Fetches all active subscribers in pages of 500 and sends via Resend batch API.
// Resend batch allows up to 100 emails per call — we chunk automatically.
//
// The blast is a free-form composer (subject + intro copy) that can optionally
// feature one or more published posts as "read more" cards — same shape as a
// Substack/Mailchimp campaign, rather than being tied to exactly one post.

interface FeaturedPost {
  slug:      string;
  title:     string;
  excerpt:   string;
  category?: string;
}

interface BlastPayload {
  subject:  string;
  bodyText?: string;
  posts?:   FeaturedPost[];
}

router.post('/blast', async (req, res) => {
  const { subject, bodyText, posts } = req.body as BlastPayload;
  const featuredPosts = Array.isArray(posts) ? posts : [];

  if (!subject || !subject.trim()) {
    return res.status(400).json({ error: 'subject is required.' });
  }
  if (!bodyText?.trim() && featuredPosts.length === 0) {
    return res.status(400).json({
      error: 'Provide body text and/or at least one featured post.',
    });
  }

  const supabase = getSupabase();
  const resend   = getResend();

  // ── Fetch all active subscribers (paginated) ─────────────────────────────
  const PAGE_SIZE  = 500;
  let   page       = 0;
  const allEmails: string[] = [];

  while (true) {
    const { data, error } = await supabase
      .from('newsletter_subscribers')
      .select('email')
      .eq('is_active', true)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) {
      console.error('[newsletter/blast] Supabase fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch subscribers.' });
    }

    if (!data || data.length === 0) break;
    allEmails.push(...data.map((r) => r.email));
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  if (allEmails.length === 0) {
    return res.status(200).json({ sent: 0, message: 'No active subscribers.' });
  }

  console.log(`[newsletter/blast] Starting blast — ${allEmails.length} subscribers, subject: "${subject}"`);

  // ── Send in batches of 100 (Resend batch limit) ──────────────────────────
  const BATCH_SIZE = 100;
  let totalSent   = 0;
  let totalFailed = 0;

  for (let i = 0; i < allEmails.length; i += BATCH_SIZE) {
    const batch = allEmails.slice(i, i + BATCH_SIZE);

    const emails = batch.map((email) => {
      const unsubscribeLink = buildUnsubscribeUrl(email);
      return {
        from:    getFromHeader(),
        to:      email,
        subject,
        html:    buildBlastHtml({ subject, bodyText, posts: featuredPosts, unsubscribeLink }),
        text:    buildBlastText({ subject, bodyText, posts: featuredPosts, unsubscribeLink }),
        headers: getListUnsubscribeHeaders(unsubscribeLink),
      };
    });

    try {
      await resend.batch.send(emails);
      totalSent += batch.length;
      console.log(
        `[newsletter/blast] Batch ${Math.floor(i / BATCH_SIZE) + 1} sent — ${totalSent}/${allEmails.length}`,
      );
    } catch (err) {
      totalFailed += batch.length;
      console.error(`[newsletter/blast] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err);
    }

    // 300ms pause between batches to respect Resend rate limits
    if (i + BATCH_SIZE < allEmails.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log(`[newsletter/blast] ✅ Done — sent: ${totalSent}, failed: ${totalFailed}`);

  return res.json({
    sent:    totalSent,
    failed:  totalFailed,
    total:   allEmails.length,
    message: `Blast sent to ${totalSent} subscriber${totalSent !== 1 ? 's' : ''}.`,
  });
});

// ─── Welcome email HTML ───────────────────────────────────────────────────────

async function sendWelcomeEmail(to: string, isResubscribe: boolean) {
  const unsubscribeLink = buildUnsubscribeUrl(to);

  await getResend().emails.send({
    from:    getFromHeader(),
    to,
    subject: isResubscribe ? 'Welcome back to the newsletter' : 'Subscription confirmed',
    html:    buildWelcomeHtml({ to, isResubscribe, unsubscribeLink }),
    text:    buildWelcomeText({ isResubscribe, unsubscribeLink }),
    headers: getListUnsubscribeHeaders(unsubscribeLink),
  });
}

export function buildWelcomeHtml({
  to,
  isResubscribe,
  unsubscribeLink,
}: {
  to: string;
  isResubscribe: boolean;
  unsubscribeLink: string;
}): string {
  const siteUrl  = (process.env.FRONTEND_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const siteName = process.env.SITE_NAME ?? 'CryptoMoney';
  const siteHost = siteUrl.replace(/https?:\/\//, '');
  const postalAddress = process.env.SITE_POSTAL_ADDRESS ?? '';

  const headline = isResubscribe ? 'Welcome back.' : 'Subscription confirmed.';
  const subhead  = isResubscribe
    ? `Your weekly briefing resumes with the next issue.`
    : `You're now subscribed to the ${siteName} newsletter.`;
  const bodyText = isResubscribe
    ? `Your subscription has been reactivated. You'll continue receiving our weekly market analysis, security intelligence, and curated insights from across the crypto space.`
    : `Each week you'll receive a focused briefing covering market analysis, security intelligence, and platform updates. No noise. No spam. Unsubscribe any time.`;

  const features: Array<{ label: string; desc: string }> = [
    { label: 'Market Analysis',    desc: 'Weekly breakdowns of trends, price action, and opportunities across crypto markets.' },
    { label: 'Security Briefings', desc: 'Timely alerts on scams, exploits, and best practices to protect your assets.' },
    { label: 'Platform Updates',   desc: 'First access to new guides, tools, and features before public release.' },
    { label: 'Exclusive Research', desc: 'In-depth content and resources available only to newsletter subscribers.' },
  ];

  const featureRows = features.map((f) => `
    <tr>
      <td style="padding: 0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding: 13px 0; border-top: 1px solid #1c2030;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align: top; width: 148px; padding-right: 20px;">
                    <span style="font-size: 12px; font-weight: 600;
                                 color: #dde0e8; letter-spacing: -0.01em;">
                      ${f.label}
                    </span>
                  </td>
                  <td style="vertical-align: top;">
                    <span style="font-size: 12px; color: #5e6577; line-height: 1.65;">
                      ${f.desc}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');

  return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>${headline}</title>
  <!--[if mso]>
  <noscript>
    <xml><o:OfficeDocumentSettings>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings></xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #0c0e13;
             font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
             -webkit-font-smoothing: antialiased;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="background-color: #0c0e13; padding: 48px 16px;">
    <tr>
      <td align="center">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
          style="max-width: 560px; background-color: #141720;
                 border-radius: 10px; border: 1px solid #222736; overflow: hidden;">

          <tr>
            <td style="height: 2px; background: #4f8ef7; line-height: 2px; font-size: 2px;">&nbsp;</td>
          </tr>

          <tr>
            <td style="padding: 32px 40px 28px; border-bottom: 1px solid #222736;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size: 15px; font-weight: 700; letter-spacing: -0.03em; color: #dde0e8;">${siteName}</span><span style="font-size: 15px; font-weight: 700; color: #4f8ef7;">.</span>
                  </td>
                  <td align="right">
                    <span style="font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #3d4254;">Weekly Newsletter</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 36px 40px 32px;
                       background: linear-gradient(160deg, #191d26 0%, #141720 100%);
                       border-bottom: 1px solid #222736;">
              <h1 style="margin: 0 0 8px; font-size: 26px; font-weight: 700;
                         color: #dde0e8; letter-spacing: -0.04em; line-height: 1.2;">
                ${headline}
              </h1>
              <p style="margin: 0 0 20px; font-size: 14px; color: #4f8ef7; line-height: 1.4;">
                ${subhead}
              </p>
              <p style="margin: 0; font-size: 14px; color: #9aa0b4; line-height: 1.75;">
                ${bodyText}
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding: 28px 40px 8px;">
              <p style="margin: 0 0 4px; font-size: 10px; font-weight: 600;
                        letter-spacing: 0.1em; text-transform: uppercase; color: #3d4254;">
                What you'll receive
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${featureRows}
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 28px 40px 36px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <a href="${siteUrl}"
                       style="display: inline-block; padding: 10px 24px;
                              background: #4f8ef7; color: #ffffff; font-size: 13px;
                              font-weight: 600; letter-spacing: -0.01em;
                              text-decoration: none; border-radius: 5px;">
                      Go to ${siteName}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 20px 40px 24px; border-top: 1px solid #1c2030; background: #0f1117;">
              <p style="margin: 0 0 6px; font-size: 11px; color: #3d4254; line-height: 1.65;">
                You received this email because you subscribed at
                <a href="${siteUrl}" style="color: #3d4254; text-decoration: underline;">${siteHost}</a>.
                We will never share your address with third parties.
              </p>
              <p style="margin: 0; font-size: 11px; color: #3d4254; line-height: 1.65;">
                To stop receiving these emails,
                <a href="${unsubscribeLink}" style="color: #9aa0b4; text-decoration: underline;">unsubscribe here</a>.
              </p>
            </td>
          </tr>

        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
          style="max-width: 560px; margin-top: 16px;">
          <tr>
            <td style="text-align: center; font-size: 11px; color: #3d4254; padding: 0 16px;">
              &copy; ${new Date().getFullYear()} ${siteName}. All rights reserved.${postalAddress ? `<br />${postalAddress}` : ''}
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();
}

// ─── Welcome email plain-text alternative ────────────────────────────────────

function buildWelcomeText({
  isResubscribe,
  unsubscribeLink,
}: {
  isResubscribe: boolean;
  unsubscribeLink: string;
}): string {
  const siteUrl  = (process.env.FRONTEND_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const siteName = process.env.SITE_NAME ?? 'CryptoMoney';
  const postalAddress = process.env.SITE_POSTAL_ADDRESS ?? '';

  const headline = isResubscribe ? 'Welcome back.' : 'Subscription confirmed.';
  const bodyText = isResubscribe
    ? `Your subscription has been reactivated. You'll continue receiving our weekly market analysis, security intelligence, and curated insights from across the crypto space.`
    : `Each week you'll receive a focused briefing covering market analysis, security intelligence, and platform updates. No noise. No spam. Unsubscribe any time.`;

  return [
    headline,
    '',
    bodyText,
    '',
    `Visit ${siteName}: ${siteUrl}`,
    '',
    '---',
    `You received this email because you subscribed at ${siteUrl}. We will never share your address with third parties.`,
    `Unsubscribe: ${unsubscribeLink}`,
    '',
    `${siteName}${postalAddress ? ` — ${postalAddress}` : ''}`,
  ].join('\n');
}

// ─── Blast email HTML ─────────────────────────────────────────────────────────
// escapeHtml guards admin-typed subject/body copy — post title/excerpt come
// from the CMS and keep the original unescaped behaviour.

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildBlastHtml({
  subject,
  bodyText,
  posts,
  unsubscribeLink,
}: {
  subject:         string;
  bodyText?:       string;
  posts:           FeaturedPost[];
  unsubscribeLink: string;
}): string {
  const siteUrl      = (process.env.FRONTEND_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const siteName     = process.env.SITE_NAME ?? 'CryptoMoney';
  const siteHost     = siteUrl.replace(/https?:\/\//, '');
  const postalAddress = process.env.SITE_POSTAL_ADDRESS ?? '';

  const bodyParagraphs = (bodyText ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const introHtml = bodyParagraphs.length
    ? `
          <tr>
            <td style="padding: 14px 40px 28px; border-bottom: 1px solid #222736;">
              <h1 style="margin: 0 0 14px; font-size: 22px; font-weight: 700;
                         color: #dde0e8; letter-spacing: -0.04em; line-height: 1.3;">
                ${escapeHtml(subject)}
              </h1>
              ${bodyParagraphs
                .map(
                  (p) => `
              <p style="margin: 0 0 14px; font-size: 14px; color: #9aa0b4; line-height: 1.75;">
                ${escapeHtml(p)}
              </p>`,
                )
                .join('')}
            </td>
          </tr>`
    : `
          <tr>
            <td style="padding: 14px 40px 28px; border-bottom: 1px solid #222736;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 700;
                         color: #dde0e8; letter-spacing: -0.04em; line-height: 1.3;">
                ${escapeHtml(subject)}
              </h1>
            </td>
          </tr>`;

  const postCards = posts
    .map((post) => {
      const postUrl = `${siteUrl}/blog/${post.slug}`;
      const categoryLabel = post.category
        ? post.category.charAt(0).toUpperCase() + post.category.slice(1)
        : 'Analysis';
      return `
          <tr>
            <td style="padding: 20px 40px; border-bottom: 1px solid #222736;">
              <span style="display: inline-block; margin-bottom: 10px;
                           background: rgba(79,142,247,0.10);
                           border: 1px solid rgba(79,142,247,0.22);
                           border-radius: 999px; padding: 3px 11px;
                           font-size: 10px; font-weight: 600;
                           letter-spacing: 0.08em; text-transform: uppercase;
                           color: #4f8ef7;">
                ${categoryLabel}
              </span>
              <h2 style="margin: 0 0 8px; font-size: 16px; font-weight: 700;
                         color: #dde0e8; letter-spacing: -0.02em; line-height: 1.35;">
                ${post.title}
              </h2>
              <p style="margin: 0 0 14px; font-size: 13px; color: #9aa0b4; line-height: 1.7;">
                ${post.excerpt}
              </p>
              <a href="${postUrl}"
                 style="display: inline-block; padding: 8px 18px;
                        background: #4f8ef7; color: #ffffff;
                        font-size: 12px; font-weight: 600;
                        text-decoration: none; border-radius: 5px;
                        letter-spacing: -0.01em;">
                Read article
              </a>
            </td>
          </tr>`;
    })
    .join('');

  const postsSection = posts.length
    ? `
          <tr>
            <td style="padding: 20px 40px 0;">
              <p style="margin: 0; font-size: 10px; font-weight: 600;
                        letter-spacing: 0.1em; text-transform: uppercase; color: #3d4254;">
                Featured reads
              </p>
            </td>
          </tr>
          ${postCards}`
    : '';

  return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>${escapeHtml(subject)}</title>
  <!--[if mso]>
  <noscript>
    <xml><o:OfficeDocumentSettings>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings></xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #0c0e13;
             font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
             -webkit-font-smoothing: antialiased;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="background-color: #0c0e13; padding: 48px 16px;">
    <tr>
      <td align="center">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
          style="max-width: 560px; background-color: #141720;
                 border-radius: 10px; border: 1px solid #222736; overflow: hidden;">

          <!-- Blue top rule -->
          <tr>
            <td style="height: 2px; background: #4f8ef7; line-height: 2px; font-size: 2px;">&nbsp;</td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding: 24px 40px 20px; border-bottom: 1px solid #222736;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size: 15px; font-weight: 700; letter-spacing: -0.03em; color: #dde0e8;">${siteName}</span><span style="font-size: 15px; font-weight: 700; color: #4f8ef7;">.</span>
                  </td>
                  <td align="right">
                    <span style="font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
                                 text-transform: uppercase; color: #3d4254;">
                      Weekly Briefing
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Intro / subject -->
          ${introHtml}

          <!-- Featured posts (optional) -->
          ${postsSection}

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 40px 24px; background: #0f1117;">
              <p style="margin: 0 0 6px; font-size: 11px; color: #3d4254; line-height: 1.65;">
                You received this because you subscribed at
                <a href="${siteUrl}" style="color: #3d4254; text-decoration: underline;">${siteHost}</a>.
                We will never share your address with third parties.
              </p>
              <p style="margin: 0; font-size: 11px; color: #3d4254; line-height: 1.65;">
                To stop receiving these emails,
                <a href="${unsubscribeLink}" style="color: #9aa0b4; text-decoration: underline;">unsubscribe here</a>.
              </p>
            </td>
          </tr>

        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
          style="max-width: 560px; margin-top: 16px;">
          <tr>
            <td style="text-align: center; font-size: 11px; color: #3d4254; padding: 0 16px;">
              &copy; ${new Date().getFullYear()} ${siteName}. All rights reserved.${postalAddress ? `<br />${postalAddress}` : ''}
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();
}

// ─── Blast email plain-text alternative ──────────────────────────────────────

function buildBlastText({
  subject,
  bodyText,
  posts,
  unsubscribeLink,
}: {
  subject:         string;
  bodyText?:       string;
  posts:           FeaturedPost[];
  unsubscribeLink: string;
}): string {
  const siteUrl  = (process.env.FRONTEND_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const siteName = process.env.SITE_NAME ?? 'CryptoMoney';
  const postalAddress = process.env.SITE_POSTAL_ADDRESS ?? '';

  const lines: string[] = [subject, ''];

  if (bodyText?.trim()) {
    lines.push(bodyText.trim(), '');
  }

  if (posts.length) {
    lines.push('FEATURED READS', '');
    for (const post of posts) {
      const categoryLabel = post.category
        ? post.category.charAt(0).toUpperCase() + post.category.slice(1)
        : 'Analysis';
      const postUrl = `${siteUrl}/blog/${post.slug}`;
      lines.push(`[${categoryLabel}] ${post.title}`, post.excerpt, postUrl, '');
    }
  }

  lines.push(
    '---',
    `You received this because you subscribed at ${siteUrl}. We will never share your address with third parties.`,
    `Unsubscribe: ${unsubscribeLink}`,
    '',
    `${siteName}${postalAddress ? ` — ${postalAddress}` : ''}`,
  );

  return lines.join('\n');
}

export { router as newsletterRouter };