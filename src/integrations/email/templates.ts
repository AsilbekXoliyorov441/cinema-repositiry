import { env } from '../../config/env.js';

export type EmailTemplate =
  | { template: 'verify-email'; data: { name: string; token: string } }
  | { template: 'email-change'; data: { name: string; token: string; newEmail: string } }
  | { template: 'password-reset'; data: { name: string; token: string } }
  | { template: 'password-changed'; data: { name: string } }
  | { template: 'welcome'; data: { name: string } }
  | { template: 'subscription-activated'; data: { name: string; planName: string; periodEnd: string } }
  | { template: 'subscription-canceled'; data: { name: string; planName: string; accessUntil: string | null } }
  | { template: 'subscription-expiring'; data: { name: string; planName: string; periodEnd: string } }
  | { template: 'payment-succeeded'; data: { name: string; amount: string; planName: string } }
  | { template: 'payment-failed'; data: { name: string; amount: string; planName: string } };

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:Arial,sans-serif;background:#0f1115;color:#e8e8e8;padding:24px">
<div style="max-width:560px;margin:auto;background:#171a21;border-radius:12px;padding:32px">
<h1 style="color:#ff4d5a;margin-top:0">CineWave</h1>${bodyHtml}
<p style="color:#888;font-size:12px;margin-top:32px">If you did not request this email you can ignore it.</p>
</div></body></html>`;
}

function button(url: string, label: string): string {
  return `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#ff4d5a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${escapeHtml(label)}</a></p>
<p style="font-size:12px;color:#888">Or open: ${escapeHtml(url)}</p>`;
}

export function renderEmail(t: EmailTemplate): { subject: string; html: string; text: string } {
  const front = env.FRONTEND_URL.replace(/\/$/, '');
  switch (t.template) {
    case 'verify-email': {
      const url = `${front}/auth/verify-email?token=${encodeURIComponent(t.data.token)}`;
      return {
        subject: 'Confirm your CineWave email',
        html: layout('Confirm email', `<p>Hi ${escapeHtml(t.data.name)},</p><p>Please confirm your email address. The link is valid for 24 hours.</p>${button(url, 'Confirm email')}`),
        text: `Hi ${t.data.name}, confirm your email: ${url}`,
      };
    }
    case 'email-change': {
      const url = `${front}/auth/confirm-email-change?token=${encodeURIComponent(t.data.token)}`;
      return {
        subject: 'Confirm your new CineWave email',
        html: layout('Confirm new email', `<p>Hi ${escapeHtml(t.data.name)},</p><p>Confirm that <b>${escapeHtml(t.data.newEmail)}</b> should become your login email. Valid for 24 hours.</p>${button(url, 'Confirm new email')}`),
        text: `Confirm your new email ${t.data.newEmail}: ${url}`,
      };
    }
    case 'password-reset': {
      const url = `${front}/auth/reset-password?token=${encodeURIComponent(t.data.token)}`;
      return {
        subject: 'Reset your CineWave password',
        html: layout('Reset password', `<p>Hi ${escapeHtml(t.data.name)},</p><p>Use the button below to choose a new password. The link expires in 30 minutes and can be used once.</p>${button(url, 'Reset password')}`),
        text: `Reset your password: ${url} (valid 30 minutes)`,
      };
    }
    case 'password-changed':
      return {
        subject: 'Your CineWave password was changed',
        html: layout('Password changed', `<p>Hi ${escapeHtml(t.data.name)},</p><p>Your password was just changed and other sessions were signed out. If this wasn't you, reset your password immediately.</p>`),
        text: 'Your CineWave password was changed. If this was not you, reset it immediately.',
      };
    case 'welcome':
      return {
        subject: 'Welcome to CineWave',
        html: layout('Welcome', `<p>Hi ${escapeHtml(t.data.name)}, welcome aboard! 🎬</p>${button(front, 'Start watching')}`),
        text: `Welcome to CineWave, ${t.data.name}! ${front}`,
      };
    case 'subscription-activated':
      return {
        subject: `Your ${t.data.planName} subscription is active`,
        html: layout('Subscription active', `<p>Hi ${escapeHtml(t.data.name)},</p><p>Your <b>${escapeHtml(t.data.planName)}</b> subscription is active until ${escapeHtml(t.data.periodEnd)}.</p>`),
        text: `Your ${t.data.planName} subscription is active until ${t.data.periodEnd}.`,
      };
    case 'subscription-canceled':
      return {
        subject: 'Your CineWave subscription was canceled',
        html: layout('Subscription canceled', `<p>Hi ${escapeHtml(t.data.name)},</p><p>Your <b>${escapeHtml(t.data.planName)}</b> subscription was canceled.${t.data.accessUntil ? ` You keep access until ${escapeHtml(t.data.accessUntil)}.` : ''}</p>`),
        text: `Your ${t.data.planName} subscription was canceled.`,
      };
    case 'subscription-expiring':
      return {
        subject: 'Your CineWave subscription ends soon',
        html: layout('Subscription ending', `<p>Hi ${escapeHtml(t.data.name)},</p><p>Your <b>${escapeHtml(t.data.planName)}</b> subscription ends on ${escapeHtml(t.data.periodEnd)}.</p>${button(`${front}/account/subscription`, 'Manage subscription')}`),
        text: `Your ${t.data.planName} subscription ends on ${t.data.periodEnd}.`,
      };
    case 'payment-succeeded':
      return {
        subject: 'Payment received',
        html: layout('Payment received', `<p>Hi ${escapeHtml(t.data.name)},</p><p>We received your payment of <b>${escapeHtml(t.data.amount)}</b> for ${escapeHtml(t.data.planName)}. Thank you!</p>`),
        text: `Payment of ${t.data.amount} for ${t.data.planName} received.`,
      };
    case 'payment-failed':
      return {
        subject: 'Payment failed',
        html: layout('Payment failed', `<p>Hi ${escapeHtml(t.data.name)},</p><p>Your payment of <b>${escapeHtml(t.data.amount)}</b> for ${escapeHtml(t.data.planName)} failed. Please update your payment method.</p>${button(`${front}/account/subscription`, 'Update payment')}`),
        text: `Your payment of ${t.data.amount} for ${t.data.planName} failed.`,
      };
  }
}
