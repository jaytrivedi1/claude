import { Resend } from 'resend';

// Environment variables for Resend configuration
// RESEND_API_KEY - Your Resend API key from https://resend.com/api-keys
// RESEND_FROM_EMAIL - The verified sender email address (e.g., "invoices@yourdomain.com")

let cachedClient: Resend | null = null;

function getResendApiKey(): string {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is not set. Get your API key from https://resend.com/api-keys');
  }
  return apiKey;
}

function getFromEmail(): string {
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error('RESEND_FROM_EMAIL environment variable is not set. Use a verified sender email address.');
  }
  return fromEmail;
}

/**
 * Get a Resend client instance.
 * The client is cached for performance since the API key doesn't expire.
 */
export function getResendClient(): Resend {
  if (!cachedClient) {
    cachedClient = new Resend(getResendApiKey());
  }
  return cachedClient;
}

/**
 * Get the configured "from" email address for sending emails.
 */
export function getResendFromEmail(): string {
  return getFromEmail();
}

/**
 * Legacy function for backward compatibility.
 * Returns both the client and fromEmail in the same format as before.
 */
export async function getUncachableResendClient() {
  return {
    client: getResendClient(),
    fromEmail: getResendFromEmail()
  };
}

/**
 * Send an email using Resend.
 * @param to - Recipient email address(es)
 * @param subject - Email subject
 * @param html - HTML content of the email
 * @param attachments - Optional attachments
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  attachments,
}: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}) {
  const client = getResendClient();
  const fromEmail = getResendFromEmail();

  const response = await client.emails.send({
    from: fromEmail,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
    attachments: attachments?.map(att => ({
      filename: att.filename,
      content: att.content,
    })),
  });

  return response;
}
