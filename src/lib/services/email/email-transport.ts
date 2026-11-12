import "server-only";

import nodemailer, { type Transporter } from "nodemailer";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
};

let mockTransport: Transporter | null = null;

/** Test hook. Never set this in production code paths. */
export function setEmailTransportForTesting(transport: Transporter | null): void {
  mockTransport = transport;
}

export function getEmailTransport(config: SmtpConfig): Transporter {
  if (mockTransport) return mockTransport;
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export type EmailSendOptions = {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
};

export type EmailSendResult = {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
};
