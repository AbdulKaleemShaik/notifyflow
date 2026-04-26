// apps/worker/src/dispatchers/emailDispatcher.js
// Sends notification emails via Nodemailer SMTP.
// Uses tenant-specific SMTP config if available, falls back to global env vars.

import nodemailer from 'nodemailer';
import { classifyError } from '../utils/retry.js';

/**
 * Send an email notification.
 *
 * @param {object} payload
 * @param {object} tenant          - Tenant document (for SMTP config)
 * @param {string} renderedBody    - Final HTML body after template rendering
 * @param {string} renderedSubject - Final subject after template rendering
 * @returns {Promise<{ messageId: string }>}
 */
export async function dispatch(payload, tenant, renderedBody, renderedSubject) {
  // Prefer tenant-level SMTP config; fall back to global env vars.
  const emailConfig = tenant?.emailConfig;

  const smtpConfig = {
    host: emailConfig?.smtpHost || process.env.SMTP_HOST,
    port: Number(emailConfig?.smtpPort || process.env.SMTP_PORT) || 587,
    secure: false, // Use STARTTLS — set to true only for port 465
    auth: {
      user: emailConfig?.smtpUser || process.env.SMTP_USER,
      pass: emailConfig?.smtpPass || process.env.SMTP_PASS,
    },
  };

  const fromAddress = emailConfig?.fromAddress || process.env.SMTP_FROM || 'notifications@notifyflow.local';
  const toAddress = payload.userEmail;

  if (!toAddress) {
    throw Object.assign(
      new Error('No recipient email address provided in payload.userEmail or payload.data.email'),
      { shouldRetry: false }
    );
  }

  let transporter;
  try {
    transporter = nodemailer.createTransport(smtpConfig);
  } catch (err) {
    const { shouldRetry } = classifyError(err, 'email');
    throw Object.assign(err, { shouldRetry });
  }

  try {
    const info = await transporter.sendMail({
      from: fromAddress,
      to: toAddress,
      subject: renderedSubject || '(No Subject)',
      html: renderedBody,
    });

    return { messageId: info.messageId };
  } catch (err) {
    const { shouldRetry, reason } = classifyError(err, 'email');

    // Attach classification to the error so the worker can decide whether to throw
    // (allow BullMQ retry) or resolve with a failure status (no retry).
    err.shouldRetry = shouldRetry;
    err.reason = reason;
    throw err;
  }
}

export default { dispatch };
