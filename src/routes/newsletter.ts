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

// ─── GET /unsubscribe ─────────────────────────────────────────────────────────

router.get('/unsubscribe', async (req, res) => {
  const { email, token } = req.query as { email?: string; token?: string };

  if (!email || !token) {
    return res.status(400).send('Missing email or token.');
  }

  const expected = makeUnsubscribeToken(email);
  if (token !== expected) {
    return res.status(403).send('Invalid or expired unsubscribe link.');
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('newsletter_subscribers')
    .update({ is_active: false })
    .eq('email', email.toLowerCase().trim());

  if (error) {
    console.error('[newsletter] Unsubscribe DB error:', error);
    return res.status(500).send('Something went wrong. Please try again later.');
  }

  const frontendBase = (process.env.FRONTEND_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  return res.redirect(`${frontendBase}/newsletter?unsubscribed=true`);
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

interface BlastPayload {
  postSlug:     string;
  postTitle:    string;
  postExcerpt:  string;
  postCategory?: string;
}

router.post('/blast', async (req, res) => {
  const { postSlug, postTitle, postExcerpt, postCategory } =
    req.body as BlastPayload;

  if (!postSlug || !postTitle || !postExcerpt) {
    return res.status(400).json({
      error: 'postSlug, postTitle, and postExcerpt are required.',
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

  console.log(`[newsletter/blast] Starting blast — ${allEmails.length} subscribers, post: "${postTitle}"`);

  // ── Send in batches of 100 (Resend batch limit) ──────────────────────────
  const BATCH_SIZE = 100;
  let totalSent   = 0;
  let totalFailed = 0;

  for (let i = 0; i < allEmails.length; i += BATCH_SIZE) {
    const batch = allEmails.slice(i, i + BATCH_SIZE);

    const emails = batch.map((email) => ({
      from:    process.env.RESEND_FROM_EMAIL ?? 'newsletter@yourdomain.com',
      to:      email,
      subject: postTitle,
      html:    buildBlastHtml({
        postSlug,
        postTitle,
        postExcerpt,
        postCategory,
        unsubscribeLink: buildUnsubscribeUrl(email),
      }),
    }));

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
    from:    process.env.RESEND_FROM_EMAIL ?? 'newsletter@yourdomain.com',
    to,
    subject: isResubscribe ? 'Welcome back to the newsletter' : 'Subscription confirmed',
    html:    buildWelcomeHtml({ to, isResubscribe, unsubscribeLink }),
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
              &copy; ${new Date().getFullYear()} ${siteName}. All rights reserved.
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

// ─── Blast email HTML ─────────────────────────────────────────────────────────

function buildBlastHtml({
  postSlug,
  postTitle,
  postExcerpt,
  postCategory,
  unsubscribeLink,
}: {
  postSlug:        string;
  postTitle:       string;
  postExcerpt:     string;
  postCategory?:   string;
  unsubscribeLink: string;
}): string {
  const siteUrl      = (process.env.FRONTEND_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const siteName     = process.env.SITE_NAME ?? 'CryptoMoney';
  const siteHost     = siteUrl.replace(/https?:\/\//, '');
  const postUrl      = `${siteUrl}/blog/${postSlug}`;
  const categoryLabel = postCategory
    ? postCategory.charAt(0).toUpperCase() + postCategory.slice(1)
    : 'Analysis';

  return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>${postTitle}</title>
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

          <!-- Category pill -->
          <tr>
            <td style="padding: 28px 40px 0;">
              <span style="display: inline-block;
                           background: rgba(79,142,247,0.10);
                           border: 1px solid rgba(79,142,247,0.22);
                           border-radius: 999px; padding: 3px 11px;
                           font-size: 10px; font-weight: 600;
                           letter-spacing: 0.08em; text-transform: uppercase;
                           color: #4f8ef7;">
                ${categoryLabel}
              </span>
            </td>
          </tr>

          <!-- Post title + excerpt -->
          <tr>
            <td style="padding: 14px 40px 28px; border-bottom: 1px solid #222736;">
              <h1 style="margin: 0 0 12px; font-size: 22px; font-weight: 700;
                         color: #dde0e8; letter-spacing: -0.04em; line-height: 1.3;">
                ${postTitle}
              </h1>
              <p style="margin: 0; font-size: 14px; color: #9aa0b4; line-height: 1.75;">
                ${postExcerpt}
              </p>
            </td>
          </tr>

          <!-- Read CTA row -->
          <tr>
            <td style="padding: 18px 40px; border-bottom: 1px solid #222736;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size: 11px; color: #3d4254; vertical-align: middle;">
                    Full analysis on ${siteName}
                  </td>
                  <td align="right">
                    <a href="${postUrl}"
                       style="display: inline-block; padding: 9px 20px;
                              background: #4f8ef7; color: #ffffff;
                              font-size: 12px; font-weight: 600;
                              text-decoration: none; border-radius: 5px;
                              letter-spacing: -0.01em;">
                      Read article
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

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
              &copy; ${new Date().getFullYear()} ${siteName}. All rights reserved.
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

export { router as newsletterRouter };