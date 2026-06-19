import type { FastifyBaseLogger } from 'fastify';

/**
 * The email seam. A clean interface so a real SMTP/provider transport drops in later without touching
 * route code. The dev transport LOGS the link (and captures it) so verification + reset flows work end
 * to end locally with no provider. Secrets-in-links are dev-only; production swaps the implementation.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  /** The actionable link (verify/reset). Kept as a field so tests + dev can read it directly. */
  link: string;
  kind: 'verify_email' | 'password_reset' | 'org_invitation';
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}

/** Dev transport: logs the link via the Fastify logger and retains the last N for test assertions. */
export class DevLogEmailTransport implements EmailTransport {
  private readonly sent: EmailMessage[] = [];
  constructor(private readonly log?: Pick<FastifyBaseLogger, 'info'>) {}

  send(msg: EmailMessage): Promise<void> {
    this.log?.info(
      { to: msg.to, kind: msg.kind, link: msg.link },
      'dev email (link logged, not delivered)',
    );
    this.sent.push(msg);
    return Promise.resolve();
  }

  /** Test/dev helper: the most recent message to an address of a given kind. */
  lastFor(to: string, kind: EmailMessage['kind']): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to && m.kind === kind);
  }
}
